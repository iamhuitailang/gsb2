/*
 * 圆柱标签展开 —— 纯几何核心，无 DOM 依赖。
 * 浏览器 <script> 与 Node (require) 共用同一份数学实现，
 * tools/cyl_tool.py 的验证逻辑与这里逐式对应。
 */
(function (global) {
  'use strict';
  const PI = Math.PI;

  const lerp = (a, b, t) => a + (b - a) * t;
  function lerpPt(p, q, t) { return [lerp(p[0], q[0], t), lerp(p[1], q[1], t)]; }
  function bezier2(p0, p1, p2, t) {
    const a = 1 - t;
    return [
      a * a * p0[0] + 2 * a * t * p1[0] + t * t * p2[0],
      a * a * p0[1] + 2 * a * t * p1[1] + t * t * p2[1],
    ];
  }
  const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const rad2deg = (r) => r * 180 / PI;

  /** 图片刚载入时给一个居中的默认控制点布局，用户再拖动修正 */
  function defaultControls(w, h) {
    const x0 = w * 0.18, x1 = w * 0.82, y0 = h * 0.18, y1 = h * 0.82;
    const LT = [x0, y0], RT = [x1, y0], LB = [x0, y1], RB = [x1, y1];
    return {
      LT, RT, LB, RB,
      TM: lerpPt(LT, RT, 0.5),   // 轴顶 = 上缘中点
      BM: lerpPt(LB, RB, 0.5),   // 轴底 = 下缘中点
    };
  }

  /** 轴向信息：u 为轴方向（顶→底），n 为垂直轴的水平方向 */
  function axisInfo(c) {
    const p0 = c.TM, p1 = c.BM;
    const len = Math.max(1e-6, dist(p0, p1));
    const u = [(p1[0] - p0[0]) / len, (p1[1] - p0[1]) / len];
    const n = [-u[1], u[0]];
    return { p0, p1, u, n, len };
  }

  function edgePoint(c, which, s) {
    return which === 'top'
      ? bezier2(c.LT, c.TM, c.RT, s)
      : bezier2(c.LB, c.BM, c.RB, s);
  }

  function segmentsIntersect(p1, p2, p3, p4) {
    const d = (p2[0] - p1[0]) * (p4[1] - p3[1]) - (p2[1] - p1[1]) * (p4[0] - p3[0]);
    if (Math.abs(d) < 1e-12) return false;
    const t = ((p3[0] - p1[0]) * (p4[1] - p3[1]) - (p3[1] - p1[1]) * (p4[0] - p3[0])) / d;
    const u = ((p3[0] - p1[0]) * (p2[1] - p1[1]) - (p3[1] - p1[1]) * (p2[0] - p1[0])) / d;
    return t > 0 && t < 1 && u > 0 && u < 1;
  }

  /**
   * 控制线体检：返回 [{level:'error'|'warn', msg}]。
   * 反向、相交、越界、中点不在两端之间等都会报出来，
   * 避免用畸形控制线“展开”出看似有效的数据。
   */
  function controlWarnings(c, imgW, imgH) {
    const out = [];
    const names = { LT: '左上', RT: '右上', LB: '左下', RB: '右下', TM: '上缘中点', BM: '下缘中点' };
    for (const k of Object.keys(names)) {
      const p = c[k];
      if (p[0] < 0 || p[1] < 0 || p[0] > imgW || p[1] > imgH) {
        out.push({ level: 'error', msg: `控制点「${names[k]}」超出源图范围 (${p[0].toFixed(0)}, ${p[1].toFixed(0)})` });
      }
    }
    const ax = axisInfo(c);
    if (ax.len < 30) out.push({ level: 'error', msg: `轴向长度仅 ${ax.len.toFixed(0)}px，控制线可能重合或反向` });

    // 上下缘在轴垂直方向上必须单调（递增或递减皆可），否则中点把边拉反了
    for (const [which, label] of [['top', '上缘'], ['bot', '下缘']]) {
      let prev = null, dir = 0, mono = true;
      for (let i = 0; i <= 20; i++) {
        const p = edgePoint(c, which, i / 20);
        const x = (p[0] - ax.p0[0]) * ax.n[0] + (p[1] - ax.p0[1]) * ax.n[1];
        if (prev !== null) {
          const d = x - prev;
          if (Math.abs(d) > 1e-6) {
            if (dir === 0) dir = Math.sign(d);
            else if (Math.sign(d) !== dir) mono = false;
          }
        }
        prev = x;
      }
      if (!mono) out.push({ level: 'error', msg: `${label}控制点顺序反向或自交（中点没有位于两端之间）` });
    }
    // 两条侧缘相交
    if (segmentsIntersect(c.LT, c.LB, c.RT, c.RB)) {
      out.push({ level: 'error', msg: '两条侧缘相交，左右侧边控制点可能接反' });
    }
    // 轴与侧缘重合度过高
    for (const [p, q, label] of [[c.LT, c.LB, '左侧缘'], [c.RT, c.RB, '右侧缘']]) {
      if (dist(p, q) < 30) out.push({ level: 'warn', msg: `${label}长度过短 (${dist(p, q).toFixed(0)}px)` });
    }
    return out;
  }

  /**
   * 核心展开映射。输出画布固定覆盖完整可见半圆 θ∈(-90°,90°)，
   * 列按弧长等角排布；|θ|>thetaLimit 的列标记为 NO-DATA（取用角限制），
   * 源点落到图外的像素标记为 NO-DATA（源图边缘外），绝不插值补全。
   *
   * status: 0=有效, 1=超出取用角, 2=源图外
   */
  function buildWarp(c, W, H, thetaLimit, imgW, imgH) {
    const N = W * H;
    const sx = new Float32Array(N), sy = new Float32Array(N);
    const thetaArr = new Float32Array(N), stretchArr = new Float32Array(N);
    const status = new Uint8Array(N);
    const pxPerRad = (W - 1) / PI;          // 全半圆 π 弧度铺满 W 列
    const dThetaCol = PI / (W - 1);         // 相邻列的角间距

    for (let x = 0; x < W; x++) {
      const theta = -PI / 2 + PI * x / (W - 1);
      const s = (Math.sin(theta) + 1) / 2;
      const top = edgePoint(c, 'top', s);
      const bot = edgePoint(c, 'bot', s);

      // 拉伸 = 展开图每弧度像素 / 源图每弧度像素；用相邻列中点速度，轮廓边 cosθ→0 时趋于无穷。
      // 首末列没有外侧邻居，改用单侧差分，避免 clamp 把速度算成 0。
      let sPrev, sNext, dThetaEff;
      if (x === 0) {
        sNext = (Math.sin(theta + dThetaCol) + 1) / 2;
        sPrev = s;
        dThetaEff = dThetaCol;
      } else if (x === W - 1) {
        sPrev = (Math.sin(theta - dThetaCol) + 1) / 2;
        sNext = s;
        dThetaEff = dThetaCol;
      } else {
        sPrev = (Math.sin(theta - dThetaCol) + 1) / 2;
        sNext = (Math.sin(theta + dThetaCol) + 1) / 2;
        dThetaEff = 2 * dThetaCol;
      }
      const midPrev = lerpPt(edgePoint(c, 'top', sPrev), edgePoint(c, 'bot', sPrev), 0.5);
      const midNext = lerpPt(edgePoint(c, 'top', sNext), edgePoint(c, 'bot', sNext), 0.5);
      const speed = dist(midPrev, midNext) / dThetaEff;
      const stretch = pxPerRad / speed;

      for (let y = 0; y < H; y++) {
        const i = y * W + x;
        const t = H === 1 ? 0 : y / (H - 1);
        const p = lerpPt(top, bot, t);
        sx[i] = p[0]; sy[i] = p[1];
        thetaArr[i] = theta;
        stretchArr[i] = stretch;
        if (Math.abs(theta) > thetaLimit) status[i] = 1;
        else if (p[0] < 0 || p[1] < 0 || p[0] > imgW - 1 || p[1] > imgH - 1) status[i] = 2;
        else status[i] = 0;
      }
    }
    return { sx, sy, theta: thetaArr, stretch: stretchArr, status, W, H, pxPerRad, spanRad: PI };
  }

  /** 展开图单点 → 源图坐标（查询/跳转用），与 buildWarp 同式 */
  function unwrappedToSource(c, ux, uy, W, H) {
    const theta = -PI / 2 + PI * ux / (W - 1);
    const s = (Math.sin(theta) + 1) / 2;
    const top = edgePoint(c, 'top', s);
    const bot = edgePoint(c, 'bot', s);
    const t = H === 1 ? 0 : clamp(uy / (H - 1), 0, 1);
    const p = lerpPt(top, bot, t);
    const dThetaCol = PI / (W - 1);
    let sPrev, sNext, dThetaEff;
    if (ux < 1) {
      sNext = (Math.sin(theta + dThetaCol) + 1) / 2; sPrev = s; dThetaEff = dThetaCol;
    } else if (ux > W - 2) {
      sPrev = (Math.sin(theta - dThetaCol) + 1) / 2; sNext = s; dThetaEff = dThetaCol;
    } else {
      sPrev = (Math.sin(theta - dThetaCol) + 1) / 2;
      sNext = (Math.sin(theta + dThetaCol) + 1) / 2;
      dThetaEff = 2 * dThetaCol;
    }
    const midPrev = lerpPt(edgePoint(c, 'top', sPrev), edgePoint(c, 'bot', sPrev), 0.5);
    const midNext = lerpPt(edgePoint(c, 'top', sNext), edgePoint(c, 'bot', sNext), 0.5);
    const stretch = ((W - 1) / PI) / (dist(midPrev, midNext) / dThetaEff);
    return { sx: p[0], sy: p[1], theta, stretch, s };
  }

  /** 4 元高斯消元（小矩阵，够用） */
  function solve4(A, b) {
    const M = A.map((row, i) => row.concat([b[i]]));
    for (let col = 0; col < 4; col++) {
      let piv = col;
      for (let r = col + 1; r < 4; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
      [M[col], M[piv]] = [M[piv], M[col]];
      const d = M[col][col] || 1e-12;
      for (let r = 0; r < 4; r++) {
        if (r === col) continue;
        const f = M[r][col] / d;
        for (let k = col; k <= 4; k++) M[r][k] -= f * M[col][k];
      }
    }
    return [0, 1, 2, 3].map((i) => M[i][4] / M[i][i]);
  }

  /**
   * 由对齐点对拟合 B 局部展开坐标 → A 局部展开坐标的相似变换
   * (x',y') = (a x - b y + tx, b x + a y + ty)。
   * 1 对点退化为纯平移；2 个共线点无法区分旋转/反射，标记 degenerate；
   * 返回每对残差（像素）、均方根与 warnings。
   */
  function fitSimilarity(pairs) {
    if (!pairs.length) return null;
    const warnings = [];
    let tx = 0, ty = 0, aRot = 1, bRot = 0;
    if (pairs.length === 1) {
      const [pa, pb] = [pairs[0].a, pairs[0].b];
      tx = pa[0] - pb[0]; ty = pa[1] - pb[1];
      warnings.push({ level: 'warn', msg: '仅 1 对点，按纯平移处理（无法估计旋转/缩放）' });
    } else {
      // 共线检测：所有点相对首点的方向若近似平行，则法方程病态，解不可信
      let minArea = Infinity;
      for (let i = 1; i < pairs.length; i++) {
        for (let j = i + 1; j < pairs.length; j++) {
          const p0 = pairs[0].b, p1 = pairs[i].b, p2 = pairs[j].b;
          const area = Math.abs((p1[0] - p0[0]) * (p2[1] - p0[1]) - (p1[1] - p0[1]) * (p2[0] - p0[0]));
          minArea = Math.min(minArea, area);
        }
      }
      if (pairs.length === 2 || minArea < 1e-6) {
        warnings.push({ level: 'error', msg: '对齐点共线或不足 3 个非共线点，相似变换不唯一（可能产生颠倒/镜像），请补一个不在同一直线上的点' });
      }
      const A = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
      const b = [0, 0, 0, 0];
      for (const { a, b: pb } of pairs) {
        const [x, y] = pb;
        const J = [[x, -y, 1, 0], [y, x, 0, 1]];
        const r = [a[0], a[1]];
        for (let i = 0; i < 2; i++) {
          for (let k = 0; k < 4; k++) {
            b[k] += J[i][k] * r[i];
            for (let l = 0; l < 4; l++) A[k][l] += J[i][k] * J[i][l];
          }
        }
      }
      [aRot, bRot, tx, ty] = solve4(A, b);
    }
    const M = { a: pairs.length === 1 ? 1 : aRot, b: pairs.length === 1 ? 0 : bRot, tx, ty };
    const residuals = pairs.map(({ a, b: pb }) => {
      const q = applySim(M, pb[0], pb[1]);
      return Math.hypot(q[0] - a[0], q[1] - a[1]);
    });
    const rms = Math.sqrt(residuals.reduce((s, v) => s + v * v, 0) / residuals.length);
    const degenerate = warnings.some((w) => w.level === 'error');
    return { M, residuals, rms, warnings, degenerate };
  }

  function applySim(M, x, y) {
    return [M.a * x - M.b * y + M.tx, M.b * x + M.a * y + M.ty];
  }

  /** 相似变换逆变换（合并图反查 B 局部坐标用） */
  function invertSim(M) {
    const det = M.a * M.a + M.b * M.b || 1e-12;
    const ia = M.a / det, ib = -M.b / det;
    return {
      a: ia, b: ib,
      tx: -(ia * M.tx + ib * M.ty),
      ty: -(-ib * M.tx + ia * M.ty),
    };
  }

  global.CylGeo = {
    PI, lerp, lerpPt, bezier2, dist, clamp, rad2deg,
    defaultControls, axisInfo, edgePoint, controlWarnings,
    buildWarp, unwrappedToSource, fitSimilarity, applySim, invertSim,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.CylGeo;
})(typeof window !== 'undefined' ? window : globalThis);
