// 轻量软件 3D 渲染：透视投影 + 画家算法，输出到 Canvas 2D。
// 场景只由盒体、地面与点标记组成，因此不需要 GPU / WebGL。

import { CUTAWAY, DIVIDER, FLOOR, GRID, MOVER, ROOM } from './config.js';
import { probeWorldPos } from './model.js';
import { clamp, lerp, mixRgb, rgbToCss, scaleRgb } from './util.js';

const NEAR = 0.12;

export class Camera {
  constructor() {
    this.yaw = 0.42;
    this.pitch = 0.74;
    this.dist = 15.2;
    this.target = { x: 0.4, y: 0.55, z: 0 };
    this.fov = (52 * Math.PI) / 180;
    this.width = 1;
    this.height = 1;
  }

  resize(w, h) {
    this.width = Math.max(1, w);
    this.height = Math.max(1, h);
  }

  get eye() {
    const cp = Math.cos(this.pitch);
    return {
      x: this.target.x + this.dist * cp * Math.sin(this.yaw),
      y: this.target.y + this.dist * Math.sin(this.pitch),
      z: this.target.z + this.dist * cp * Math.cos(this.yaw),
    };
  }

  basis() {
    const eye = this.eye;
    let fx = this.target.x - eye.x;
    let fy = this.target.y - eye.y;
    let fz = this.target.z - eye.z;
    const fl = Math.hypot(fx, fy, fz) || 1;
    fx /= fl; fy /= fl; fz /= fl;
    // right = normalize(forward × worldUp) = (-fz, 0, fx)
    let rx = -fz;
    let rz = fx;
    const rl = Math.hypot(rx, rz) || 1;
    rx /= rl; rz /= rl;
    // up = right × forward
    const ux = 0 * fz - rz * fy;
    const uy = rz * fx - rx * fz;
    const uz = rx * fy - 0 * fx;
    return { eye, f: { x: fx, y: fy, z: fz }, r: { x: rx, y: 0, z: rz }, u: { x: ux, y: uy, z: uz } };
  }

  focal() {
    return (this.height / 2) / Math.tan(this.fov / 2);
  }

  /** 世界坐标 → 相机坐标。z 为沿视线的深度。 */
  toCam(p, b = this.basis()) {
    const dx = p.x - b.eye.x;
    const dy = p.y - b.eye.y;
    const dz = p.z - b.eye.z;
    return {
      x: dx * b.r.x + dy * b.r.y + dz * b.r.z,
      y: dx * b.u.x + dy * b.u.y + dz * b.u.z,
      z: dx * b.f.x + dy * b.f.y + dz * b.f.z,
    };
  }

  projectCam(c) {
    const f = this.focal();
    return {
      x: this.width / 2 + (f * c.x) / c.z,
      y: this.height / 2 - (f * c.y) / c.z,
      z: c.z,
    };
  }

  project(p, b = this.basis()) {
    const cam = this.toCam(p, b);
    if (cam.z <= NEAR) return null;
    return this.projectCam(cam);
  }

  ray(sx, sy, b = this.basis()) {
    const f = this.focal();
    const nx = (sx - this.width / 2) / f;
    const ny = -(sy - this.height / 2) / f;
    const dx = b.f.x + b.r.x * nx + b.u.x * ny;
    const dy = b.f.y + b.r.y * nx + b.u.y * ny;
    const dz = b.f.z + b.r.z * nx + b.u.z * ny;
    const l = Math.hypot(dx, dy, dz) || 1;
    return { ox: b.eye.x, oy: b.eye.y, oz: b.eye.z, dx: dx / l, dy: dy / l, dz: dz / l };
  }

  intersectPlane(sx, sy, planeY) {
    const r = this.ray(sx, sy);
    if (Math.abs(r.dy) < 1e-6) return null;
    const t = (planeY - r.oy) / r.dy;
    if (t <= 0) return null;
    return { x: r.ox + r.dx * t, y: planeY, z: r.oz + r.dz * t };
  }
}

function clipNear(points, near = NEAR) {
  const out = [];
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const ain = a.z >= near;
    const bin = b.z >= near;
    if (ain) out.push(a);
    if (ain !== bin) {
      const t = (near - a.z) / (b.z - a.z);
      out.push({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), z: near });
    }
  }
  return out;
}

class Painter {
  constructor(ctx, cam) {
    this.ctx = ctx;
    this.cam = cam;
    this.items = [];
    this.basis = cam.basis();
  }

  addPoly(worldPts, style, depthBias = 0) {
    const camPts = worldPts.map((p) => this.toCam(p));
    if (camPts.every((p) => p.z < NEAR)) return;
    const clipped = clipNear(camPts);
    if (clipped.length < 3) return;
    const screen = clipped.map((p) => this.cam.projectCam(p));
    let sum = 0;
    for (const p of clipped) sum += p.z;
    this.items.push({
      kind: 'poly',
      pts: screen,
      z: sum / clipped.length + depthBias,
      style,
    });
  }

  addLine(worldPts, style, depthBias = 0) {
    const camPts = worldPts.map((p) => this.toCam(p));
    // 逐段裁剪到近平面，分段累积
    const segments = [];
    let run = [];
    let sum = 0;
    let count = 0;
    const flush = () => {
      if (run.length >= 2) segments.push({ pts: run, z: sum / count });
      run = [];
      sum = 0;
      count = 0;
    };
    for (let i = 0; i < camPts.length; i += 1) {
      const cur = camPts[i];
      if (i > 0) {
        const prev = camPts[i - 1];
        const curIn = cur.z >= NEAR;
        const prevIn = prev.z >= NEAR;
        if (curIn !== prevIn) {
          const t = (NEAR - prev.z) / (cur.z - prev.z);
          const inter = {
            x: lerp(prev.x, cur.x, t),
            y: lerp(prev.y, cur.y, t),
            z: NEAR,
          };
          if (prevIn) {
            run.push(inter);
            sum += NEAR;
            count += 1;
            flush();
          } else {
            run = [inter];
            sum = NEAR;
            count = 1;
          }
        }
      }
      if (cur.z >= NEAR) {
        run.push(cur);
        sum += cur.z;
        count += 1;
      } else {
        flush();
      }
    }
    flush();
    for (const seg of segments) {
      this.items.push({
        kind: 'line',
        pts: seg.pts.map((p) => this.cam.projectCam(p)),
        z: seg.z + depthBias,
        style,
      });
    }
  }

  addSprite(world, style, depthBias = 0) {
    const camP = this.toCam(world);
    if (camP.z < NEAR) return;
    const s = this.cam.projectCam(camP);
    this.items.push({ kind: 'sprite', x: s.x, y: s.y, z: camP.z + depthBias, style });
  }

  addLabel(world, text, style, depthBias = 0) {
    const camP = this.toCam(world);
    if (camP.z < NEAR) return;
    const s = this.cam.projectCam(camP);
    this.items.push({ kind: 'label', x: s.x, y: s.y, z: camP.z + depthBias, text, style });
  }

  toCam(p) {
    const b = this.basis;
    const dx = p.x - b.eye.x;
    const dy = p.y - b.eye.y;
    const dz = p.z - b.eye.z;
    return {
      x: dx * b.r.x + dy * b.r.y + dz * b.r.z,
      y: dx * b.u.x + dy * b.u.y + dz * b.u.z,
      z: dx * b.f.x + dy * b.f.y + dz * b.f.z,
    };
  }

  flush() {
    const ctx = this.ctx;
    // 先按图层（场景结构 → 探针/物体），同层内再按深度从远到近。
    // 这样剖切墙不会用整块四边形盖住实际可见的探针，读图更像透视预览。
    this.items.sort((a, b) => {
      const la = a.style.layer ?? 0;
      const lb = b.style.layer ?? 0;
      if (la !== lb) return la - lb;
      return b.z - a.z;
    });
    for (const item of this.items) {
      if (item.kind === 'poly') this.drawPoly(item);
      else if (item.kind === 'line') this.drawLine(item);
      else if (item.kind === 'sprite') this.drawSprite(item);
      else if (item.kind === 'label') this.drawLabel(item);
    }
    this.items.length = 0;
  }

  drawPoly(item) {
    const ctx = this.ctx;
    const { pts, style } = item;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i += 1) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    if (style.fill) {
      ctx.fillStyle = style.fill;
      ctx.fill();
    }
    if (style.stroke) {
      ctx.strokeStyle = style.stroke;
      ctx.lineWidth = style.lineWidth ?? 1;
      ctx.stroke();
    }
  }

  drawLine(item) {
    const ctx = this.ctx;
    const { pts, style } = item;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i += 1) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.strokeStyle = style.stroke;
    ctx.lineWidth = style.lineWidth ?? 1;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.setLineDash(style.dash ?? []);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  drawSprite(item) {
    const ctx = this.ctx;
    const { x, y, style } = item;
    const scale = clamp(15 / item.z, 0.45, 2.2);
    const r = (style.size ?? 4) * scale;
    if (style.glow) {
      const g = ctx.createRadialGradient(x, y, 0, x, y, r * 3.4);
      g.addColorStop(0, style.glow);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r * 3.4, 0, Math.PI * 2);
      ctx.fill();
    }
    if (style.shape === 'diamond') {
      ctx.save();
      ctx.translate(x, y);
      ctx.beginPath();
      ctx.moveTo(0, -r);
      ctx.lineTo(r, 0);
      ctx.lineTo(0, r);
      ctx.lineTo(-r, 0);
      ctx.closePath();
      ctx.fillStyle = style.fill;
      ctx.fill();
      if (style.stroke) {
        ctx.lineWidth = style.strokeWidth ?? 2;
        ctx.strokeStyle = style.stroke;
        ctx.stroke();
      }
      ctx.restore();
      return;
    }
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = style.fill;
    ctx.fill();
    if (style.stroke) {
      ctx.lineWidth = style.strokeWidth ?? 2;
      ctx.strokeStyle = style.stroke;
      ctx.stroke();
    }
  }

  drawLabel(item) {
    const ctx = this.ctx;
    ctx.font = item.style.font ?? '11px ui-sans-serif, system-ui, sans-serif';
    ctx.fillStyle = item.style.fill ?? '#f0efec';
    ctx.textAlign = item.style.align ?? 'center';
    ctx.textBaseline = 'middle';
    if (item.style.bg) {
      const w = ctx.measureText(item.text).width + 10;
      ctx.fillStyle = item.style.bg;
      ctx.fillRect(item.x - w / 2, item.y - 8, w, 16);
      ctx.fillStyle = item.style.fill ?? '#f0efec';
    }
    ctx.fillText(item.text, item.x, item.y);
  }
}

function shade(color, k) {
  return scaleRgb(color, k);
}

const SURFACE = {
  floorRoom: [0.16, 0.16, 0.17],
  floorOutside: [0.2, 0.2, 0.21],
  wall: [0.26, 0.255, 0.25],
  wallInner: [0.235, 0.23, 0.225],
  wallOuter: [0.3, 0.3, 0.31],
  frame: [0.35, 0.34, 0.32],
  door: [0.42, 0.33, 0.24],
  mover: [0.85, 0.85, 0.88],
};

/** 场景表面有一点方向性明暗，避免纯平涂。 */
function faceTint(normalY, factor = 1) {
  return 0.72 + 0.28 * clamp(normalY, 0, 1) + factor * 0.04;
}

export function drawScene(ctx, cam, model, sample, options = {}) {
  const { width, height } = cam;
  const painter = new Painter(ctx, cam);

  // 背景
  const sky = ctx.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, '#101012');
  sky.addColorStop(0.55, '#131315');
  sky.addColorStop(1, '#0b0b0c');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, height);

  drawOutsideFloor(ctx, cam);
  drawFloor(ctx, cam, model, sample, options);
  drawCellsOverlay(ctx, cam, model, options);

  // 地面之后的立体物
  drawWalls(painter, model);
  drawDoor(painter, model);
  drawPath(painter, model);
  if (options.showProbes !== false) drawProbes(painter, cam, model, sample, options);
  if (options.showRays) drawRays(painter, cam, model, sample, options);
  drawMover(painter, cam, model, sample, options);

  painter.flush();
}

/** 在着色地面上补格线、不可用格的斜线、以及选中高亮。 */
function drawCellsOverlay(ctx, cam, model, options) {
  const b = cam.basis();
  const selected = options.selectedCell;
  const lines = [];
  const pushLine = (x0, z0, x1, z1, style) => {
    lines.push({ a: { x: x0, y: 0.012, z: z0 }, b: { x: x1, y: 0.012, z: z1 }, style });
  };
  for (let col = 0; col <= GRID.cols; col += 1) {
    const x = GRID.originX + col * GRID.cell;
    pushLine(x, GRID.originZ, x, GRID.originZ + GRID.rows * GRID.cell, 'rgba(240,239,236,0.09)');
  }
  for (let row = 0; row <= GRID.rows; row += 1) {
    const z = GRID.originZ + row * GRID.cell;
    pushLine(GRID.originX, z, GRID.originX + GRID.cols * GRID.cell, z, 'rgba(240,239,236,0.09)');
  }
  for (const line of lines) {
    const a = cam.project(line.a, b);
    const bb = cam.project(line.b, b);
    if (!a || !bb) continue;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(bb.x, bb.y);
    ctx.strokeStyle = line.style;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // 不可用格：地面斜线
  ctx.save();
  for (const cell of model.cells) {
    if (!cell.blocked) continue;
    const x0 = GRID.originX + cell.col * GRID.cell;
    const z0 = GRID.originZ + cell.row * GRID.cell;
    ctx.beginPath();
    for (const [ax, az, bx, bz] of [
      [x0, z0, x0 + GRID.cell, z0 + GRID.cell],
      [x0 + GRID.cell, z0, x0, z0 + GRID.cell],
    ]) {
      const a = cam.project({ x: ax, y: 0.014, z: az }, b);
      const bb = cam.project({ x: bx, y: 0.014, z: bz }, b);
      if (!a || !bb) continue;
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(bb.x, bb.y);
    }
    ctx.strokeStyle = 'rgba(240,239,236,0.16)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  ctx.restore();

  if (selected) {
    const x0 = GRID.originX + selected.col * GRID.cell;
    const z0 = GRID.originZ + selected.row * GRID.cell;
    const corners = [
      { x: x0, y: 0.02, z: z0 },
      { x: x0 + GRID.cell, y: 0.02, z: z0 },
      { x: x0 + GRID.cell, y: 0.02, z: z0 + GRID.cell },
      { x: x0, y: 0.02, z: z0 + GRID.cell },
    ].map((p) => cam.project(p, b));
    if (corners.every(Boolean)) {
      ctx.beginPath();
      ctx.moveTo(corners[0].x, corners[0].y);
      for (let i = 1; i < corners.length; i += 1) ctx.lineTo(corners[i].x, corners[i].y);
      ctx.closePath();
      ctx.strokeStyle = 'rgba(240,239,236,0.82)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }
}

function drawFloor(ctx, cam, model, sample, options) {
  // 地面按探针解算着色：每个格子再切 2×2，得到连续的亮暗过渡。
  const sub = 2;
  const cell = GRID.cell;
  const mode = options.mode ?? 'restricted';
  const showFloor = options.floor !== false;
  const sampleAt = options.sampleAt;

  const b = cam.basis();
  for (let row = 0; row < GRID.rows; row += 1) {
    for (let col = 0; col < GRID.cols; col += 1) {
      const cellData = model.cells[row * GRID.cols + col];
      const x0 = GRID.originX + col * cell;
      const z0 = GRID.originZ + row * cell;
      for (let sz = 0; sz < sub; sz += 1) {
        for (let sx = 0; sx < sub; sx += 1) {
          const px = x0 + ((sx + 0.5) / sub) * cell;
          const pz = z0 + ((sz + 0.5) / sub) * cell;
          let color;
          if (!showFloor || !sampleAt) {
            color = cellData.zone === 'exterior' ? SURFACE.floorOutside : SURFACE.floorRoom;
          } else {
            const s = sampleAt(px, pz, mode);
            color = mixRgb([0.07, 0.075, 0.085], s.colors.up, 0.62);
            color = mixRgb(color, s.colors.sides.n, 0.18);
            if (cellData.blocked) color = mixRgb(color, [0.12, 0.12, 0.13], 0.7);
          }
          const alpha = cellData.zone === 'exterior' ? 0.92 : 1;
          const quad = [
            { x: x0 + (sx / sub) * cell, y: 0, z: z0 + (sz / sub) * cell },
            { x: x0 + ((sx + 1) / sub) * cell, y: 0, z: z0 + (sz / sub) * cell },
            { x: x0 + ((sx + 1) / sub) * cell, y: 0, z: z0 + ((sz + 1) / sub) * cell },
            { x: x0 + (sx / sub) * cell, y: 0, z: z0 + ((sz + 1) / sub) * cell },
          ];
          const projected = quad.map((p) => cam.toCam(p, b));
          if (projected.every((p) => p.z < NEAR)) continue;
          const clipped = clipNear(projected);
          if (clipped.length < 3) continue;
          const pts = clipped.map((p) => cam.projectCam(p));
          ctx.beginPath();
          ctx.moveTo(pts[0].x, pts[0].y);
          for (let i = 1; i < pts.length; i += 1) ctx.lineTo(pts[i].x, pts[i].y);
          ctx.closePath();
          ctx.fillStyle = rgbToCss(color, alpha);
          ctx.fill();
          // 每小格之间留极细的接缝，避免色带界限过于硬
          ctx.strokeStyle = rgbToCss(color, 0.35);
          ctx.lineWidth = 0.6;
          ctx.stroke();
        }
      }
    }
  }
}

/** 网格外的地面在网格地面之前铺好，避免被背景或网格盖住。 */
function drawOutsideFloor(ctx, cam) {
  const b = cam.basis();
  const outside = [
    { x: FLOOR.minX, y: -0.01, z: FLOOR.minZ },
    { x: FLOOR.maxX, y: -0.01, z: FLOOR.minZ },
    { x: FLOOR.maxX, y: -0.01, z: FLOOR.maxZ },
    { x: FLOOR.minX, y: -0.01, z: FLOOR.maxZ },
  ];
  const camPts = outside.map((p) => cam.toCam(p, b));
  if (camPts.every((p) => p.z < NEAR)) return;
  const clipped = clipNear(camPts);
  if (clipped.length < 3) return;
  const pts = clipped.map((p) => cam.projectCam(p));
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i += 1) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
  ctx.fillStyle = '#111113';
  ctx.fill();
}

function drawWalls(painter, model) {
  // 剖切：墙只画到 CUTAWAY.wallHeight，保证室内外同时可见。
  const h = CUTAWAY.wallHeight;
  const t = DIVIDER.thickness;
  const wallFill = rgbToCss(SURFACE.wallInner, 0.98);
  const wallOuter = rgbToCss(SURFACE.wallOuter, 0.98);
  const edge = 'rgba(255,255,255,0.07)';

  // 房间后墙 z = minZ
  painter.addPoly(
    [
      { x: ROOM.minX, y: 0, z: ROOM.minZ },
      { x: DIVIDER.x, y: 0, z: ROOM.minZ },
      { x: DIVIDER.x, y: h, z: ROOM.minZ },
      { x: ROOM.minX, y: h, z: ROOM.minZ },
    ],
    { fill: rgbToCss(shade(SURFACE.wall, faceTint(0.2)), 0.98), stroke: edge },
  );
  // 房间左墙 x = minX
  painter.addPoly(
    [
      { x: ROOM.minX, y: 0, z: ROOM.minZ },
      { x: ROOM.minX, y: 0, z: ROOM.maxZ },
      { x: ROOM.minX, y: h, z: ROOM.maxZ },
      { x: ROOM.minX, y: h, z: ROOM.minZ },
    ],
    { fill: rgbToCss(shade(SURFACE.wall, 0.78), 0.98), stroke: edge },
  );

  // 门洞固定为 doorHalf 宽；门扇在洞内旋转，门关时正好填满洞口。
  const half = DIVIDER.doorHalf;
  const doorH = CUTAWAY.doorHeight;
  const xa = DIVIDER.x - t / 2;
  const xb = DIVIDER.x + t / 2;

  const seg = (z0, z1, y0, y1, fill) => {
    if (z1 - z0 < 1e-4 || y1 - y0 < 1e-4) return;
    painter.addPoly(
      [
        { x: xa, y: y0, z: z0 },
        { x: xa, y: y0, z: z1 },
        { x: xa, y: y1, z: z1 },
        { x: xa, y: y1, z: z0 },
      ],
      { fill, stroke: edge },
    );
    painter.addPoly(
      [
        { x: xb, y: y0, z: z0 },
        { x: xb, y: y0, z: z1 },
        { x: xb, y: y1, z: z1 },
        { x: xb, y: y1, z: z0 },
      ],
      { fill: wallOuter, stroke: edge },
    );
  };

  seg(ROOM.minZ, -half, 0, h, wallFill);
  seg(half, ROOM.maxZ, 0, h, wallFill);
  seg(-half, half, doorH, h, wallFill);
  if (!model.door.hasOpening) {
    // 没有留门洞：整段补成实墙
    seg(-half, half, 0, doorH, wallFill);
  }

  // 墙顶
  painter.addPoly(
    [
      { x: xa, y: h, z: ROOM.minZ },
      { x: xb, y: h, z: ROOM.minZ },
      { x: xb, y: h, z: ROOM.maxZ },
      { x: xa, y: h, z: ROOM.maxZ },
    ],
    { fill: rgbToCss(shade(SURFACE.wall, 1.18), 1), stroke: edge },
  );

  // 门框
  const frameColor = rgbToCss(SURFACE.frame, 1);
  const frameW = 0.09;
  const frame = (z0, z1, y0, y1) => {
    painter.addPoly(
      [
        { x: xa - 0.02, y: y0, z: z0 },
        { x: xa - 0.02, y: y0, z: z1 },
        { x: xa - 0.02, y: y1, z: z1 },
        { x: xa - 0.02, y: y1, z: z0 },
      ],
      { fill: frameColor, stroke: 'rgba(0,0,0,0.25)' },
    );
  };
  frame(-half - frameW, -half, 0, doorH + frameW);
  frame(half, half + frameW, 0, doorH + frameW);
  frame(-half - frameW, half + frameW, doorH, doorH + frameW);
}

function drawDoor(painter, model) {
  const open = clamp(model.door.open, 0, 1);
  if (!model.door.hasOpening) {
    // 没有开口的墙——把整个门洞补成实墙
    return;
  }
  const h = CUTAWAY.doorHeight;
  const t = DIVIDER.thickness;
  // 门扇以铰链在 z = -doorHalf 处旋转：open = 0 时贴在墙面上，open = 1 时向室内转开 90°
  const hingeZ = -DIVIDER.doorHalf;
  const leafW = DIVIDER.doorHalf * 2;
  const angle = open * (Math.PI / 2);
  const dirZ = Math.cos(angle);
  const dirX = -Math.sin(angle);
  const x0 = DIVIDER.x - t / 2;
  const p0 = { x: x0, y: 0.02, z: hingeZ };
  const p1 = { x: x0 + dirX * leafW, y: 0.02, z: hingeZ + dirZ * leafW };
  const p2 = { x: x0 + dirX * leafW, y: h - 0.06, z: hingeZ + dirZ * leafW };
  const p3 = { x: x0, y: h - 0.06, z: hingeZ };
  const faceA = rgbToCss(SURFACE.door, 0.96);
  const faceB = rgbToCss(shade(SURFACE.door, 0.82), 0.96);
  painter.addPoly([p0, p1, p2, p3], { fill: faceA, stroke: 'rgba(0,0,0,0.35)' });
  painter.addPoly(
    [
      { x: p3.x + 0.035, y: p3.y, z: p3.z },
      { x: p2.x + 0.035, y: p2.y, z: p2.z },
      { x: p1.x + 0.035, y: p1.y, z: p1.z },
      { x: p0.x + 0.035, y: p0.y, z: p0.z },
    ],
    { fill: faceB, stroke: 'rgba(0,0,0,0.3)' },
  );
}

function drawPath(painter, model) {
  if (!model.path || model.path.length < 2) return;
  const y = 0.03;
  const pts = model.path.map((p) => ({ x: p.x, y, z: p.z }));
  painter.addLine(pts, { stroke: 'rgba(240,239,236,0.42)', lineWidth: 2.4, layer: 1 }, 0.04);
}

function drawProbes(painter, cam, model, sample, options) {
  const selected = options.selectedProbeId;
  const used = options.usedProbeIds ?? new Map();
  for (const probe of model.probes) {
    const pos = probePos(probe);
    const enabled = probe.enabled !== false;
    const inUse = used.get(probe.id) ?? 0;
    const isSel = selected === probe.id;
    const upColor = rgbToCss(probe.up, enabled ? 1 : 0.35);
    const sideColor = rgbToCss(probe.sides.s, enabled ? 0.85 : 0.2);
    const stemAlpha = enabled ? 0.55 : 0.18;
    painter.addLine(
      [{ x: pos.x, y: 0.02, z: pos.z }, { x: pos.x, y: pos.y - 0.12, z: pos.z }],
      { stroke: `rgba(240,239,236,${stemAlpha * 0.7})`, lineWidth: 1.2, layer: 1 },
      0.01,
    );
    painter.addSprite(
      { x: pos.x, y: pos.y, z: pos.z },
      {
        shape: 'diamond',
        size: isSel ? 6.4 : inUse > 0.02 ? 5.6 : 4.4,
        fill: upColor,
        stroke: isSel ? '#f0efec' : `rgba(26,26,25,${0.9})`,
        strokeWidth: isSel ? 2 : 1.6,
        glow: inUse > 0.02 ? `rgba(240,239,236,${0.06 + inUse * 0.2})` : null,
        layer: 1,
      },
      -0.02,
    );
    // 朝侧颜色：底部的小方块 + 一条朝向地面的短桩
    painter.addSprite(
      { x: pos.x, y: pos.y - 0.34, z: pos.z },
      {
        shape: 'diamond',
        size: 3.2,
        fill: sideColor,
        stroke: 'rgba(26,26,25,0.85)',
        strokeWidth: 1.2,
        layer: 1,
      },
      -0.02,
    );
  }
}

export function probePos(probe) {
  return probeWorldPos(probe);
}

function drawRays(painter, cam, model, sample, options) {
  if (!sample) return;
  const mover = model.mover;
  const top = sample.contributions.slice(0, 6);
  const maxW = top[0]?.weight ?? 1;
  for (const c of top) {
    const probe = model.probes.find((p) => p.id === c.probeId);
    if (!probe) continue;
    const pos = probePos(probe);
    const strength = maxW > 0 ? c.weight / maxW : 0;
    const alpha = 0.12 + strength * 0.5;
    painter.addLine(
      [
        { x: pos.x, y: pos.y, z: pos.z },
        { x: mover.x, y: MOVER.centerY, z: mover.z },
      ],
      {
        stroke: c.crossSide ? `rgba(217,89,38,${alpha})` : `rgba(240,239,236,${alpha * 0.8})`,
        lineWidth: 1 + strength * 2.4 * (c.fraction ?? 0.2) * 3,
        dash: c.crossSide ? [4, 4] : [],
        layer: 2,
      },
      -0.01,
    );
    painter.addSprite(
      { x: pos.x, y: pos.y, z: pos.z },
      {
        shape: 'diamond',
        size: 2.4 + strength * 3,
        fill: `rgba(240,239,236,${0.55 + strength * 0.4})`,
        stroke: 'rgba(26,26,25,0.6)',
        strokeWidth: 1,
        layer: 2,
      },
      -0.03,
    );
  }
}

function drawMover(painter, cam, model, sample, options) {
  const s = MOVER.size / 2;
  const cx = model.mover.x;
  const cz = model.mover.z;
  const cy = MOVER.centerY;
  const colors = sample?.colors ?? { up: [0.5, 0.5, 0.5], sides: { n: [0.3, 0.3, 0.3], e: [0.3, 0.3, 0.3], s: [0.3, 0.3, 0.3], w: [0.3, 0.3, 0.3] } };
  const top = rgbToCss(colors.up, 1);
  const sideN = rgbToCss(colors.sides.n, 1);
  const sideS = rgbToCss(colors.sides.s, 1);
  const sideE = rgbToCss(colors.sides.e, 1);
  const sideW = rgbToCss(colors.sides.w, 1);
  const edge = 'rgba(10,10,10,0.55)';

  const P = (dx, dy, dz) => ({ x: cx + dx, y: cy + dy, z: cz + dz });

  // 地面接触阴影
  painter.addPoly(
    [
      { x: cx - s * 1.6, y: 0.006, z: cz - s * 1.6 },
      { x: cx + s * 1.6, y: 0.006, z: cz - s * 1.6 },
      { x: cx + s * 1.6, y: 0.006, z: cz + s * 1.6 },
      { x: cx - s * 1.6, y: 0.006, z: cz + s * 1.6 },
    ],
    { fill: 'rgba(0,0,0,0.32)', layer: 1 },
    0.005,
  );

  const layer = 2;
  // 只画朝向相机的三个面：顶面 + 靠近相机的 ±x / ±z 侧面。
  // 这样不依赖绘制顺序，也不会出现背面盖住正面的情况。
  const eye = cam.eye;
  const sx = eye.x >= cx ? 1 : -1;
  const sz = eye.z >= cz ? 1 : -1;
  const xFace = sx > 0 ? sideE : sideW;
  const zFace = sz > 0 ? sideS : sideN;
  painter.addPoly([P(-s, -s, sz * s), P(s, -s, sz * s), P(s, s, sz * s), P(-s, s, sz * s)], { fill: zFace, stroke: edge, layer }, -0.002);
  painter.addPoly([P(sx * s, -s, -s), P(sx * s, -s, s), P(sx * s, s, s), P(sx * s, s, -s)], { fill: xFace, stroke: edge, layer }, -0.003);
  painter.addPoly([P(-s, s, -s), P(s, s, -s), P(s, s, s), P(-s, s, s)], { fill: top, stroke: edge, layer }, -0.004);
  // 底面轮廓线强调
  const corners = [
    P(-s, -s, -s), P(s, -s, -s), P(s, -s, s), P(-s, -s, s),
  ];
  painter.addLine([...corners, corners[0]], { stroke: 'rgba(12,12,12,0.6)', lineWidth: 1, layer: 3 }, -0.005);

  if (options.showMoverLabel !== false) {
    painter.addLabel(
      { x: cx, y: cy + s + 0.34, z: cz },
      `L ${sample ? sample.lum.toFixed(3) : '—'} · ${sample ? (sample.zone === 'interior' ? '室内' : sample.zone === 'exterior' ? '室外' : '未覆盖') : ''}`,
      { font: '600 11px ui-sans-serif, system-ui, sans-serif', fill: '#f0efec', bg: 'rgba(13,13,13,0.76)', layer: 3 },
      -0.05,
    );
  }
}
