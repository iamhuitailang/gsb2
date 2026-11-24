/* 轻量 Canvas 3D 渲染：轨道相机 + 画家算法，无外部依赖。
   支持原始/还原对比、误差热力图、接缝高亮、错位夸大、T 接标记。 */
(function (global) {
  const MPC = global.MPC;
  const { clamp } = MPC.util;

  const BLOCK_COLORS = [
    [0.47, 0.62, 0.82], [0.55, 0.75, 0.55], [0.83, 0.68, 0.42], [0.72, 0.55, 0.78],
  ];

  class OrbitCamera {
    constructor() {
      this.yaw = -0.7; this.pitch = 0.85; this.dist = 14;
      this.target = [-1.2, 0, 2.5];
      this.fov = 50 * Math.PI / 180;
    }
    rotate(dx, dy) {
      this.yaw += dx * 0.008;
      this.pitch = clamp(this.pitch - dy * 0.008, 0.12, 1.5);
    }
    zoom(f) { this.dist = clamp(this.dist * f, 2.5, 80); }
    pan(dx, dy) {
      const s = this.dist * 0.0016;
      const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
      this.target[0] += (-dx * cy) * s;
      this.target[2] += (-dx * sy) * s;
      this.target[1] += dy * s;
    }
    // 世界坐标 -> 相机坐标
    basis() {
      const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
      const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
      // 相机位置
      const eye = [
        this.target[0] + this.dist * cp * sy,
        this.target[1] + this.dist * sp,
        this.target[2] + this.dist * cp * cy,
      ];
      const fwd = norm(sub(this.target, eye));
      const right = norm(cross(fwd, [0, 1, 0]));
      const up = cross(right, fwd);
      return { eye, fwd, right, up };
    }
  }

  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }
  function norm(a) {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

  // 蓝 -> 青 -> 绿 -> 黄 -> 红
  function heatColor(t) {
    t = clamp(t, 0, 1);
    const stops = [[40, 80, 200], [40, 190, 190], [90, 180, 70], [235, 200, 60], [220, 60, 50]];
    const x = t * (stops.length - 1);
    const i = Math.min(stops.length - 2, Math.floor(x));
    const f = x - i;
    const a = stops[i], b = stops[i + 1];
    return `rgb(${Math.round(a[0] + (b[0] - a[0]) * f)},${Math.round(a[1] + (b[1] - a[1]) * f)},${Math.round(a[2] + (b[2] - a[2]) * f)})`;
  }

  class MeshView {
    constructor(canvas, camera) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.camera = camera;
      this.mode = 'block';       // block | heat | wire
      this.exaggerate = 0;       // 错位夸大系数
      this.showSeams = true;
      this.showTJunctions = true;
      this.heatMax = 1;
      this.hoverInfo = null;
      this.onSelectSeam = null;
      this.seamHitAreas = [];
      this._bindInput();
    }

    _bindInput() {
      const c = this.canvas, cam = this.camera;
      let dragging = false, last = null, moved = 0;
      c.addEventListener('pointerdown', (e) => {
        dragging = true; last = [e.clientX, e.clientY]; moved = 0;
        c.setPointerCapture(e.pointerId);
      });
      c.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const dx = e.clientX - last[0], dy = e.clientY - last[1];
        last = [e.clientX, e.clientY]; moved += Math.abs(dx) + Math.abs(dy);
        if (e.shiftKey) cam.pan(dx, dy); else cam.rotate(dx, dy);
        this.dirty = true;
      });
      c.addEventListener('pointerup', (e) => {
        dragging = false;
        if (moved < 5) this._handleClick(e);
      });
      c.addEventListener('wheel', (e) => {
        e.preventDefault();
        cam.zoom(Math.exp(e.deltaY * 0.0012));
        this.dirty = true;
      }, { passive: false });
      c.addEventListener('dblclick', (e) => {
        const hit = this._pickSeam(e);
        if (hit && this.onSelectSeam) this.onSelectSeam(hit);
      });
    }

    _handleClick(e) {
      const hit = this._pickSeam(e);
      if (hit && this.onSelectSeam) this.onSelectSeam(hit);
    }

    _pickSeam(e) {
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left, y = e.clientY - rect.top;
      for (const h of this.seamHitAreas) {
        if (Math.hypot(h.x - x, h.y - y) < h.r + 6) return h.seamId;
      }
      return null;
    }

    // scene: 原始场景；pack: packScene 结果（可为 null 表示只画原始）
    draw(scene, pack) {
      const c = this.canvas, ctx = this.ctx;
      const dpr = window.devicePixelRatio || 1;
      const w = c.clientWidth, h = c.clientHeight;
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
        c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#10141b';
      ctx.fillRect(0, 0, w, h);
      this._drawGrid(ctx, w, h);

      const useRestored = !!pack;
      const cam = this.camera, basis = cam.basis();
      const focal = h / (2 * Math.tan(cam.fov / 2));
      const project = (p) => {
        const rel = sub(p, basis.eye);
        const cz = dot(rel, basis.fwd);
        if (cz <= 0.05) return null;
        const cx = dot(rel, basis.right), cy = dot(rel, basis.up);
        return { x: w / 2 + focal * cx / cz, y: h / 2 - focal * cy / cz, z: cz };
      };

      // 组装每块实际绘制的位置（叠加错位夸大）
      const drawPos = scene.blocks.map((block, bi) => {
        const n = block.positions.length;
        const out = new Float32Array(n);
        for (let i = 0; i < n; i += 3) {
          const ox = block.positions[i], oy = block.positions[i + 1], oz = block.positions[i + 2];
          if (useRestored && this.exaggerate > 0) {
            const qb = pack.qBlocks[bi];
            const k = this.exaggerate;
            out[i] = ox + (qb.restored[i] - ox) * k;
            out[i + 1] = oy + (qb.restored[i + 1] - oy) * k;
            out[i + 2] = oz + (qb.restored[i + 2] - oz) * k;
          } else if (useRestored) {
            out[i] = pack.qBlocks[bi].restored[i];
            out[i + 1] = pack.qBlocks[bi].restored[i + 1];
            out[i + 2] = pack.qBlocks[bi].restored[i + 2];
          } else {
            out[i] = ox; out[i + 1] = oy; out[i + 2] = oz;
          }
        }
        return out;
      });

      const tris = [];
      scene.blocks.forEach((block, bi) => {
        const pos = drawPos[bi], idx = block.indices;
        for (let t = 0; t < idx.length; t += 3) {
          const i0 = idx[t] * 3, i1 = idx[t + 1] * 3, i2 = idx[t + 2] * 3;
          tris.push({
            bi,
            p: [[pos[i0], pos[i0 + 1], pos[i0 + 2]], [pos[i1], pos[i1 + 1], pos[i1 + 2]], [pos[i2], pos[i2 + 1], pos[i2 + 2]]],
            vi: [idx[t], idx[t + 1], idx[t + 2]],
          });
        }
      });

      const light = norm([-0.4, 0.9, -0.3]);
      const projected = new Array(tris.length);
      for (let i = 0; i < tris.length; i++) {
        const t = tris[i];
        const s0 = project(t.p[0]), s1 = project(t.p[1]), s2 = project(t.p[2]);
        if (!s0 || !s1 || !s2) { projected[i] = null; continue; }
        projected[i] = [s0, s1, s2];
        t.depth = (s0.z + s1.z + s2.z) / 3;
        const n = norm(cross(sub(t.p[1], t.p[0]), sub(t.p[2], t.p[0])));
        t.shade = 0.35 + 0.65 * Math.max(0, dot(n, light));
      }
      const order = tris.map((t, i) => i).filter(i => projected[i]).sort((a, b) => tris[b].depth - tris[a].depth);

      for (const i of order) {
        const t = tris[i], s = projected[i];
        let fill;
        if (this.mode === 'wire') {
          fill = '#161b24';
        } else if (this.mode === 'heat' && pack) {
          let e = 0;
          const qb = pack.qBlocks[t.bi];
          for (const vi of t.vi) {
            const o = qb.positions, r = qb.restored, k = vi * 3;
            e = Math.max(e, Math.hypot(r[k] - o[k], r[k + 1] - o[k + 1], r[k + 2] - o[k + 2]));
          }
          fill = heatColor(e / this.heatMax);
        } else {
          const col = BLOCK_COLORS[t.bi % BLOCK_COLORS.length];
          const sh = t.shade;
          fill = `rgb(${Math.round(col[0] * 255 * sh)},${Math.round(col[1] * 255 * sh)},${Math.round(col[2] * 255 * sh)})`;
        }
        ctx.beginPath();
        ctx.moveTo(s[0].x, s[0].y); ctx.lineTo(s[1].x, s[1].y); ctx.lineTo(s[2].x, s[2].y);
        ctx.closePath();
        ctx.fillStyle = fill; ctx.fill();
        if (this.mode === 'wire') { ctx.strokeStyle = 'rgba(180,200,230,.5)'; ctx.lineWidth = 0.6; ctx.stroke(); }
      }

      // 地面参考网格
      this.seamHitAreas = [];
      if (this.showSeams && pack) this._drawSeams(ctx, scene, pack, project, useRestored);
      this._drawAxisHint(ctx, w, h);
      this.dirty = false;
    }

    _drawSeams(ctx, scene, pack, project, useRestored) {
      const report = pack.seamReport;
      for (const seam of scene.seams) {
        const rep = report.seams.find(s => s.id === seam.id);
        const A = pack.qBlocks[seam.blockA], B = pack.qBlocks[seam.blockB];
        const getP = (block, vi) => {
          const src = useRestored ? block.restored : block.positions;
          return [src[vi * 3], src[vi * 3 + 1], src[vi * 3 + 2]];
        };
        // 真实接边线（A 侧）与错位连线
        const ptsA = seam.pairs.map(p => project(getP(A, p.va)));
        ctx.beginPath();
        ptsA.forEach((p, i) => p ? (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)) : null);
        ctx.strokeStyle = '#ffd34d'; ctx.lineWidth = 2; ctx.stroke();

        // 每对匹配顶点的错位连线（按错位大小染色）
        for (const g of rep.gaps) {
          const pa = project(g.pointA), pb = project(g.pointB);
          if (!pa || !pb) continue;
          ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y);
          ctx.strokeStyle = g.distance > rep.threshold ? '#ff5a52' : 'rgba(255,211,77,.55)';
          ctx.lineWidth = g.distance > rep.threshold ? 2 : 1;
          ctx.stroke();
        }
        // T 接顶点
        if (this.showTJunctions) {
          for (const g of rep.tGaps) {
            const p = project(g.point);
            if (!p) continue;
            ctx.beginPath(); ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
            ctx.fillStyle = '#7de3ff'; ctx.fill();
          }
        }
        // 最差点标记 + 点击热区
        if (rep.worst) {
          const p = project(rep.worst.pointA);
          if (p) {
            ctx.beginPath(); ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
            ctx.strokeStyle = '#ff5a52'; ctx.lineWidth = 2; ctx.stroke();
            this.seamHitAreas.push({ x: p.x, y: p.y, r: 8, seamId: seam.id });
          }
        }
      }
    }

    _drawGrid(ctx, w, h) {
      // 简单的世界 y=0 参考网格
      const cam = this.camera, basis = cam.basis();
      const focal = h / (2 * Math.tan(cam.fov / 2));
      const project = (p) => {
        const rel = sub(p, basis.eye);
        const cz = dot(rel, basis.fwd);
        if (cz <= 0.05) return null;
        return { x: w / 2 + focal * dot(rel, basis.right) / cz, y: h / 2 - focal * dot(rel, basis.up) / cz };
      };
      ctx.strokeStyle = 'rgba(120,140,170,.14)'; ctx.lineWidth = 1;
      for (let g = -8; g <= 6; g++) {
        const a = project([g, -0.6, 0]), b = project([g, -0.6, 6]);
        if (a && b) { ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
        const c2 = project([-8, -0.6, g]), d2 = project([6, -0.6, g]);
        if (c2 && d2) { ctx.beginPath(); ctx.moveTo(c2.x, c2.y); ctx.lineTo(d2.x, d2.y); ctx.stroke(); }
      }
    }

    _drawAxisHint(ctx, w, h) {
      ctx.font = '11px sans-serif'; ctx.fillStyle = 'rgba(200,215,240,.75)';
      ctx.fillText('拖动旋转 · Shift+拖动平移 · 滚轮缩放 · 双击红点定位接缝', 10, h - 10);
    }
  }

  MPC.render = { OrbitCamera, MeshView, heatColor, BLOCK_COLORS };
  if (typeof module !== 'undefined' && module.exports) module.exports = MPC;
})(typeof globalThis !== 'undefined' ? globalThis : this);
