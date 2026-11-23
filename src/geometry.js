// 几何与 SVG 路径工具：纯函数，不依赖 DOM 之外的环境（测试可直接引用）

export const V = (x, y) => ({ x: +x || 0, y: +y || 0 });
export const add = (a, b) => V(a.x + b.x, a.y + b.y);
export const sub = (a, b) => V(a.x - b.x, a.y - b.y);
export const mul = (a, s) => V(a.x * s, a.y * s);
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const len = (a) => Math.hypot(a.x, a.y);
export const equalP = (a, b, eps = 1e-9) => Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps;
export const mid = (a, b) => V((a.x + b.x) / 2, (a.y + b.y) / 2);

// 数字输出：最多 3 位小数，去掉 -0
export function n(v) {
  if (Math.abs(v) < 0.0005) v = 0;
  const s = String(Math.round(v * 1000) / 1000);
  return s === '-0' ? '0' : s;
}

// ---------- 2D 仿射矩阵 [a,b,c,d,e,f]，与 SVGMatrix 一致 ----------
export class Transform {
  constructor(a = 1, b = 0, c = 0, d = 1, e = 0, f = 0) {
    this.a = a; this.b = b; this.c = c; this.d = d; this.e = e; this.f = f;
  }
  static identity() { return new Transform(); }
  static translate(x, y) { return new Transform(1, 0, 0, 1, x, y); }
  static scale(sx, sy = sx) { return new Transform(sx, 0, 0, sy, 0, 0); }
  static rotate(rad, cx = 0, cy = 0) {
    const c = Math.cos(rad), s = Math.sin(rad);
    return new Transform(c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy);
  }
  // this * m（先应用 m，再应用 this）
  multiply(m) {
    const t = this;
    return new Transform(
      t.a * m.a + t.c * m.b, t.b * m.a + t.d * m.b,
      t.a * m.c + t.c * m.d, t.b * m.c + t.d * m.d,
      t.a * m.e + t.c * m.f + t.e, t.b * m.e + t.d * m.f + t.f,
    );
  }
  applyPoint(p) {
    return V(this.a * p.x + this.c * p.y + this.e, this.b * p.x + this.d * p.y + this.f);
  }
  inverse() {
    const { a, b, c, d, e, f } = this;
    const det = a * d - b * c;
    if (Math.abs(det) < 1e-12) return Transform.identity();
    return new Transform(
      d / det, -b / det, -c / det, a / det,
      (c * f - d * e) / det, (b * e - a * f) / det,
    );
  }
  get isIdentity() {
    return this.a === 1 && this.b === 0 && this.c === 0 && this.d === 1 && this.e === 0 && this.f === 0;
  }
  toCss() {
    return `matrix(${n(this.a)},${n(this.b)},${n(this.c)},${n(this.d)},${n(this.e)},${n(this.f)})`;
  }
}

// 解析 SVG transform 属性串
export function parseTransform(str = '') {
  let t = Transform.identity();
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let m;
  while ((m = re.exec(str))) {
    const args = m[2].split(/[\s,]+/).filter(Boolean).map(Number);
    let step;
    switch (m[1]) {
      case 'matrix': step = new Transform(...args); break;
      case 'translate': step = Transform.translate(args[0] || 0, args[1] || 0); break;
      case 'scale': step = Transform.scale(args[0] || 1, args.length > 1 ? args[1] : (args[0] || 1)); break;
      case 'rotate': {
        const deg = args[0] || 0;
        step = args.length >= 3
          ? Transform.rotate((deg * Math.PI) / 180, args[1], args[2])
          : Transform.rotate((deg * Math.PI) / 180);
        break;
      }
      case 'skewX': step = new Transform(1, 0, Math.tan((args[0] * Math.PI) / 180), 1, 0, 0); break;
      case 'skewY': step = new Transform(1, Math.tan((args[0] * Math.PI) / 180), 0, 1, 0, 0); break;
      default: step = Transform.identity();
    }
    t = t.multiply(step);
  }
  return t;
}

// ---------- 三次贝塞尔 ----------
export function cubicAt(p0, p1, p2, p3, t) {
  const u = 1 - t;
  const u2 = u * u, t2 = t * t;
  return V(
    u2 * u * p0.x + 3 * u2 * t * p1.x + 3 * u * t2 * p2.x + t2 * t * p3.x,
    u2 * u * p0.y + 3 * u2 * t * p1.y + 3 * u * t2 * p2.y + t2 * t * p3.y,
  );
}

export function cubicDerivativeAt(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return V(
    3 * u * u * (p1.x - p0.x) + 6 * u * t * (p2.x - p1.x) + 3 * t * t * (p3.x - p2.x),
    3 * u * u * (p1.y - p0.y) + 6 * u * t * (p2.y - p1.y) + 3 * t * t * (p3.y - p2.y),
  );
}

// 点 p 到三次贝塞尔曲线的距离（按步进采样求最近，步长足够小，配合命中容差使用）
export function distanceToCubic(p, p0, p1, p2, p3, steps = 24) {
  let best = Infinity;
  for (let i = 0; i <= steps; i++) {
    const q = cubicAt(p0, p1, p2, p3, i / steps);
    const d = dist(p, q);
    if (d < best) best = d;
  }
  return best;
}

// 在 t 处把三次曲线切成两段，返回两条曲线的控制点
export function splitCubic(p0, p1, p2, p3, t) {
  const p01 = mid(p0, p1), p12 = mid(p1, p2), p23 = mid(p2, p3);
  const p012 = mid(p01, p12), p123 = mid(p12, p23);
  const p0123 = mid(p012, p123);
  return {
    left: [p0, p01, p012, p0123],
    right: [p0123, p123, p23, p3],
  };
}

// SVG 椭圆弧转一组三次贝塞尔（端点参数化，返回端点+控制点序列，不含起点）
// 返回 [[c1,c2,end], ...]
export function arcToCubics(x1, y1, rx, ry, angleDeg, largeArc, sweep, x2, y2) {
  rx = Math.abs(rx); ry = Math.abs(ry);
  if (rx < 1e-9 || ry < 1e-9) return [[V(x1, y1), V(x2, y2), V(x2, y2)]];
  const phi = (angleDeg * Math.PI) / 180;
  const cosP = Math.cos(phi), sinP = Math.sin(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = cosP * dx + sinP * dy;
  const y1p = -sinP * dx + cosP * dy;
  let rx2 = rx * rx, ry2 = ry * ry;
  const x1p2 = x1p * x1p, y1p2 = y1p * y1p;
  const lambda = x1p2 / rx2 + y1p2 / ry2;
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s; ry *= s; rx2 = rx * rx; ry2 = ry * ry;
  }
  let factor = (rx2 * ry2 - rx2 * y1p2 - ry2 * x1p2) / (rx2 * y1p2 + ry2 * x1p2);
  factor = Math.sqrt(Math.max(0, factor));
  if (largeArc === sweep) factor = -factor;
  const cxp = factor * ((rx * y1p) / ry);
  const cyp = factor * (-(ry * x1p) / rx);
  const cx = cosP * cxp - sinP * cyp + (x1 + x2) / 2;
  const cy = sinP * cxp + cosP * cyp + (y1 + y2) / 2;
  const angle = (ux, uy, vx, vy) => {
    const dot = ux * vx + uy * vy;
    const cross = ux * vy - uy * vx;
    let a = Math.atan2(cross, dot);
    if (a < 0) a += 2 * Math.PI;
    return a;
  };
  const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dtheta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  // SVG sweep=1 为顺时针（屏幕坐标系 y 向下），扫描角取正；sweep=0 取负
  if (sweep && dtheta < 0) dtheta += 2 * Math.PI;
  if (!sweep && dtheta > 0) dtheta -= 2 * Math.PI;
  const segments = Math.max(1, Math.ceil(Math.abs(dtheta) / (Math.PI / 2)));
  const delta = dtheta / segments;
  const t = (4 / 3) * Math.tan(delta / 4);
  const result = [];
  let theta = theta1;
  let sx = x1, sy = y1;
  for (let i = 0; i < segments; i++) {
    const cosT = Math.cos(theta), sinT = Math.sin(theta);
    const eTheta = theta + delta;
    const cosE = Math.cos(eTheta), sinE = Math.sin(eTheta);
    const ex = cx + rx * cosE * cosP - ry * sinE * sinP;
    const ey = cy + rx * cosE * sinP + ry * sinE * cosP;
    const c1x = sx + t * (-rx * sinT * cosP - ry * cosT * sinP);
    const c1y = sy + t * (-rx * sinT * sinP + ry * cosT * cosP);
    const c2x = ex + t * (rx * sinE * cosP + ry * cosE * sinP);
    const c2y = ey + t * (rx * sinE * sinP - ry * cosE * cosP);
    result.push([V(c1x, c1y), V(c2x, c2y), V(ex, ey)]);
    sx = ex; sy = ey;
    theta = eTheta;
  }
  return result;
}

// ---------- 锚点模型与 path d 互转 ----------
// anchor: { x, y, hIn:{dx,dy} 相对本点（前一段入向控制柄）, hOut:{dx,dy} 相对本点（下一段出向）, smooth }
// subpath: { closed, anchors:[] }
const asOffset = (h) => ({
  dx: h ? (h.dx !== undefined ? h.dx : (h.x || 0)) : 0,
  dy: h ? (h.dy !== undefined ? h.dy : (h.y || 0)) : 0,
});
// 构造控制柄相对偏移（统一 dx/dy 形态）
export const offset = (dx, dy) => ({ dx, dy });
export const anchor = (x, y, hIn = V(0, 0), hOut = V(0, 0), smooth = false) =>
  ({ x, y, hIn: asOffset(hIn), hOut: asOffset(hOut), smooth });

// 两个锚点之间的三次曲线控制点（a 出向 / b 入向）
const outHandle = (a) => V(a.x + a.hOut.dx, a.y + a.hOut.dy);
const inHandle = (b) => V(b.x + b.hIn.dx, b.y + b.hIn.dy);

export function subpathToD(sp) {
  const a = sp.anchors;
  if (!a.length) return '';
  let d = `M${n(a[0].x)} ${n(a[0].y)}`;
  for (let i = 0; i < a.length - 1; i++) {
    d += `C${n(a[i].x + a[i].hOut.dx)} ${n(a[i].y + a[i].hOut.dy)} `
      + `${n(a[i + 1].x + a[i + 1].hIn.dx)} ${n(a[i + 1].y + a[i + 1].hIn.dy)} `
      + `${n(a[i + 1].x)} ${n(a[i + 1].y)}`;
  }
  if (sp.closed && a.length > 1) {
    const last = a[a.length - 1], first = a[0];
    d += `C${n(last.x + last.hOut.dx)} ${n(last.y + last.hOut.dy)} `
      + `${n(first.x + first.hIn.dx)} ${n(first.y + first.hIn.dy)} `
      + `${n(first.x)} ${n(first.y)}Z`;
  }
  return d;
}

export function pathToD(subpaths) {
  return subpaths.filter((sp) => sp.anchors.length > 0).map(subpathToD).join(' ');
}

// 解析 SVG path d 为 subpaths（所有线段/Q/A 统一转三次贝塞尔锚点）
export function parsePathD(d) {
  const tokens = d.match(/[a-zA-Z]|[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g) || [];
  let i = 0;
  const num = () => parseFloat(tokens[i++]);
  const subpaths = [];
  let cur = null;           // 当前子路径锚点数组
  let start = V(0, 0);      // 子路径起点
  let prevCmd = '';
  let prevCtrl = V(0, 0);   // 上一条 cubic 的 p2（用于 S/T 平滑续接）
  let prevQCtrl = V(0, 0);  // 上一条 quadratic 的控制点
  let curPt = V(0, 0);

  const newSub = (p) => {
    cur = [];
    subpaths.push({ closed: false, anchors: cur });
    cur.push(anchor(p.x, p.y));
    start = p;
  };
  // 连续曲线命令会落在同一锚点上：已存在则只更新入向控制柄，避免覆盖上一条命令的结果
  const off = (v) => (v && v.dx !== undefined) ? v : { dx: v?.x || 0, dy: v?.y || 0 };
  const upsertAnchor = (p, hIn, hOut) => {
    // 与末尾锚点重合（连续曲线命令）或与起点重合（闭合路径的收尾段）时合并
    const last = cur[cur.length - 1];
    const same = (q) => q && Math.abs(q.x - p.x) < 1e-9 && Math.abs(q.y - p.y) < 1e-9;
    let target = same(last) ? last : (same(cur[0]) ? cur[0] : null);
    if (target) {
      target.hIn = off(hIn);
      // 仅当传入非零出向柄时覆盖，避免直线/移动命令误清空已有的曲线控制柄
      const ho = off(hOut);
      if (ho.dx !== 0 || ho.dy !== 0) target.hOut = ho;
    } else {
      cur.push(anchor(p.x, p.y, hIn, hOut));
    }
  };

  while (i < tokens.length) {
    const tok = tokens[i];
    let cmd;
    if (/[a-zA-Z]/.test(tok)) { cmd = tok; i++; }
    else cmd = (prevCmd === 'M' || prevCmd === 'm') ? (cmd = /[a-z]/.test(prevCmd) ? 'l' : 'L')
      : prevCmd; // 参数组隐式重复上一条命令；M 重复按 L 处理
    const rel = cmd === cmd.toLowerCase();
    const abs = (x, y) => rel ? V(curPt.x + x, curPt.y + y) : V(x, y);

    switch (cmd.toUpperCase()) {
      case 'M': {
        const p = abs(num(), num());
        newSub(p); curPt = p; prevCtrl = p; prevQCtrl = p;
        break;
      }
      case 'L': {
        const p = abs(num(), num());
        if (!cur) newSub(curPt);
        upsertAnchor(p, V(0, 0), V(0, 0));
        curPt = p; prevCtrl = p; prevQCtrl = p;
        break;
      }
      case 'H': {
        const x = rel ? curPt.x + num() : num();
        const p = V(x, curPt.y);
        if (!cur) newSub(curPt);
        upsertAnchor(p, V(0, 0), V(0, 0));
        curPt = p; prevCtrl = p; prevQCtrl = p;
        break;
      }
      case 'V': {
        const y = rel ? curPt.y + num() : num();
        const p = V(curPt.x, y);
        if (!cur) newSub(curPt);
        upsertAnchor(p, V(0, 0), V(0, 0));
        curPt = p; prevCtrl = p; prevQCtrl = p;
        break;
      }
      case 'C': {
        const c1 = abs(num(), num()), c2 = abs(num(), num()), p = abs(num(), num());
        const a0 = cur[cur.length - 1];
        a0.hOut = off(sub(c1, a0));
        upsertAnchor(p, sub(c2, p), V(0, 0));
        curPt = p; prevCtrl = c2; prevQCtrl = p;
        break;
      }
      case 'S': {
        const c2 = abs(num(), num()), p = abs(num(), num());
        const a0 = cur[cur.length - 1];
        const c1 = (prevCmd.toUpperCase() === 'C' || prevCmd.toUpperCase() === 'S')
          ? V(2 * a0.x - prevCtrl.x, 2 * a0.y - prevCtrl.y) : V(a0.x, a0.y);
        a0.hOut = off(sub(c1, a0));
        upsertAnchor(p, sub(c2, p), V(0, 0));
        curPt = p; prevCtrl = c2; prevQCtrl = p;
        break;
      }
      case 'Q': {
        const q = abs(num(), num()), p = abs(num(), num());
        const a0 = cur[cur.length - 1];
        const c1 = V(a0.x + (2 / 3) * (q.x - a0.x), a0.y + (2 / 3) * (q.y - a0.y));
        const c2 = V(p.x + (2 / 3) * (q.x - p.x), p.y + (2 / 3) * (q.y - p.y));
        a0.hOut = off(sub(c1, a0));
        upsertAnchor(p, sub(c2, p), V(0, 0));
        curPt = p; prevCtrl = p; prevQCtrl = q;
        break;
      }
      case 'T': {
        const p = abs(num(), num());
        const q = (prevCmd.toUpperCase() === 'Q' || prevCmd.toUpperCase() === 'T')
          ? V(2 * curPt.x - prevQCtrl.x, 2 * curPt.y - prevQCtrl.y) : V(curPt.x, curPt.y);
        const a0 = cur[cur.length - 1];
        const c1 = V(a0.x + (2 / 3) * (q.x - a0.x), a0.y + (2 / 3) * (q.y - a0.y));
        const c2 = V(p.x + (2 / 3) * (q.x - p.x), p.y + (2 / 3) * (q.y - p.y));
        a0.hOut = off(sub(c1, a0));
        upsertAnchor(p, sub(c2, p), V(0, 0));
        curPt = p; prevCtrl = p; prevQCtrl = q;
        break;
      }
      case 'A': {
        const rx = num(), ry = num(), ang = num();
        const large = num(), sweep = num();
        const p = abs(num(), num());
        const pieces = arcToCubics(curPt.x, curPt.y, rx, ry, ang, large, sweep, p.x, p.y);
        for (let k = 0; k < pieces.length; k++) {
          const [c1, c2, end] = pieces[k];
          // 弧的各三次分段首尾相接：当前末尾锚点即本段起点（k>0 时为上一段插入的连接锚点）
          const a0 = cur[cur.length - 1];
          a0.hOut = off(sub(c1, a0));
          upsertAnchor(end, sub(c2, end), V(0, 0));
        }
        curPt = p; prevCtrl = p; prevQCtrl = p;
        break;
      }
      case 'Z': {
        if (cur && cur.length) {
          subpaths[subpaths.length - 1].closed = true;
          curPt = start;
        }
        prevCtrl = start; prevQCtrl = start;
        break;
      }
      default:
        i++; // 跳过无法识别的 token
    }
    prevCmd = cmd;
  }
  return subpaths.filter((sp) => sp.anchors.length > 0);
}

// ---------- 采样 / 包围盒 / 命中 ----------
// 展开 subpaths 为三次曲线段数组：{p0,p1,p2,p3}，闭合路径含收尾段
export function iterCubics(subpaths) {
  const segs = [];
  for (const sp of subpaths) {
    const a = sp.anchors;
    if (a.length < 2) continue;
    for (let i = 0; i < a.length - 1; i++) {
      segs.push({ p0: V(a[i].x, a[i].y), p1: outHandle(a[i]), p2: inHandle(a[i + 1]), p3: V(a[i + 1].x, a[i + 1].y) });
    }
    if (sp.closed) {
      const last = a[a.length - 1], first = a[0];
      segs.push({ p0: V(last.x, last.y), p1: outHandle(last), p2: inHandle(first), p3: V(first.x, first.y) });
    }
  }
  return segs;
}

export function samplePath(subpaths, stepsPerCubic = 12) {
  const pts = [];
  for (const s of iterCubics(subpaths)) {
    for (let i = 0; i <= stepsPerCubic; i++) pts.push(cubicAt(s.p0, s.p1, s.p2, s.p3, i / stepsPerCubic));
  }
  return pts;
}

export function pathBounds(subpaths) {
  const pts = samplePath(subpaths, 8);
  if (!pts.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x; if (p.y > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

// 点到路径描边的距离（文档坐标系）
export function distanceToPath(p, subpaths) {
  let best = Infinity;
  for (const s of iterCubics(subpaths)) {
    const d = distanceToCubic(p, s.p0, s.p1, s.p2, s.p3, 16);
    if (d < best) best = d;
  }
  // 单点路径
  for (const sp of subpaths) {
    if (sp.anchors.length === 1) {
      const d = dist(p, sp.anchors[0]);
      if (d < best) best = d;
    }
  }
  return best;
}

// 射线法判断点是否在（可能自相交的）多边形内，配合 evenodd/nonzero
export function pointInPolygon(p, pts, rule = 'evenodd') {
  let inside = false, winding = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[j], b = pts[i];
    if ((a.y > p.y) !== (b.y > p.y)) {
      const x = a.x + ((p.y - a.y) * (b.x - a.x)) / (b.y - a.y);
      if (p.x < x) {
        inside = !inside;
        if (b.y > a.y) winding++; else winding--;
      }
    }
  }
  return rule === 'evenodd' ? inside : winding !== 0;
}

// 点是否落在路径填充区域内
export function pointInPath(p, subpaths, rule = 'evenodd') {
  // 优先用原生 isPointInFill（调用方传入已构造好的 Path2D 时），这里给采样兜底
  for (const sp of subpaths) {
    if (sp.anchors.length === 1 && dist(p, sp.anchors[0]) < 2) return true;
    const pts = samplePath([sp], 10);
    if (pts.length > 2 && pointInPolygon(p, pts, rule)) return true;
  }
  return false;
}

// 把一组 subpaths 整体做仿射变换（含控制柄）
export function transformSubpaths(subpaths, t) {
  return subpaths.map((sp) => ({
    closed: sp.closed,
    anchors: sp.anchors.map((a) => {
      const p = t.applyPoint(V(a.x, a.y));
      const hi = t.applyPoint(V(a.x + a.hIn.dx, a.y + a.hIn.dy));
      const ho = t.applyPoint(V(a.x + a.hOut.dx, a.y + a.hOut.dy));
      return anchor(p.x, p.y, sub(hi, p), sub(ho, p), a.smooth);
    }),
  }));
}

// 矩形 / 直线 / 椭圆工具生成路径
export function rectSubpaths(x, y, w, h) {
  const pts = [V(x, y), V(x + w, y), V(x + w, y + h), V(x, y + h)];
  return [{ closed: true, anchors: pts.map((p) => anchor(p.x, p.y)) }];
}

export function lineSubpaths(x1, y1, x2, y2) {
  return [{ closed: false, anchors: [anchor(x1, y1), anchor(x2, y2)] }];
}

// 椭圆：4 个三次贝塞尔段。屏幕坐标系 y 向下，锚点顺序 (rx,0)->(0,ry)->(-rx,0)->(0,-ry) 为顺时针
export function ellipseSubpaths(cx, cy, rx, ry) {
  const k = 0.5522847498307936; // 圆形近似系数
  const ox = k * rx, oy = k * ry;
  // 每个锚点：位置 + 入向柄偏移 + 出向柄偏移（控制柄沿切线方向）
  const anchors = [
    anchor(cx + rx, cy,       V(0, -oy), V(0, oy)),     // 右
    anchor(cx, cy + ry,       V(ox, 0), V(-ox, 0)),     // 下
    anchor(cx - rx, cy,       V(0, oy), V(0, -oy)),     // 左
    anchor(cx, cy - ry,       V(-ox, 0), V(ox, 0)),     // 上
  ];
  return [{ closed: true, anchors }];
}
