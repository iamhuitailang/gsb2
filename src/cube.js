/*
 * cube.js — 立方体环境图核心：面几何 / 邻接 / 采样 / 渲染 / 投影 / 诊断
 *
 * 纯函数，无 DOM 依赖。浏览器里挂到 window.CubeCore，Node 里可 require 测试。
 *
 * ── 坐标与朝向约定（所有旋转都按它推）────────────────────────────────
 *
 *   世界坐标：立方体 [-1,1]^3，+X 右，+Y 上，+Z 前。
 *   每个面用 (法线 n, 图向右 r, 图向上 u) 描述：
 *       P(s,t) = n + r*s + u*t,  s,t ∈ [-1,1]
 *       UV：u = (s+1)/2（左→右），v = (t+1)/2（下→上）
 *
 *   六张图按“站在立方体中心、朝外看这面墙”的视角制作；下面的 r/u 就是
 *   该内部视角的“图向右 / 图向上”。默认 rot=0 / flip=false 时，人从里面
 *   看文字是正的、不镜像。主视图正是立方体内部视角，所以正放的面读起来方向正确。
 *   （从立方体外部看会镜像，这是环境贴图的正常现象。）
 *
 *   六面编号（固定，不随排列改变）与内部视角朝向（均满足 r × u = n）：
 *     0 +X 右 Right   n=( 1,0,0)  r=(0,0,-1)  u=(0,1,0)
 *     1 -X 左 Left    n=(-1,0,0)  r=(0,0, 1)  u=(0,1,0)
 *     2 +Y 上 Top     n=(0, 1,0)  r=(1,0, 0)  u=(0,0,-1)
 *     3 -Y 下 Bottom  n=(0,-1,0)  r=(1,0, 0)  u=(0,0, 1)
 *     4 +Z 前 Front   n=(0,0, 1)  r=(1,0, 0)  u=(0,1,0)
 *     5 -Z 后 Back    n=(0,0,-1)  r=(-1,0,0)  u=(0,1,0)
 *
 *   校验：站在立方体正中朝 +Z 看、头顶 +Y，右手边正是 +X（面朝北、右手朝东）。
 *   所以前面(+Z)的“图向右”是 +X，且六面统一满足 r × u = n，从内部看全部正读。
 *   相机同样取 R = 上 × F（对 F=+Z 得 R=+X），与面朝向一致，投影不镜像。
 *
 *   十字展开图（与上面朝向严格自洽，可无缝平铺）：
 *              [上2]
 *      [左1][前4][右0][后5]
 *              [下3]
 *   横带从左到右 左→前→右→后；上2 贴在前4 上方、下3 贴在前4 下方。
 *   带两端 左1 左边缘 与 后5 右边缘 折起后相接，即“横带首尾”。
 *
 *   图像像素：(0,0) 在左上；像素 (x,y) → UV(u=x/W, v=1-y/H)。
 *
 * ── 用户操作语义 ─────────────────────────────────────────────────────
 *   “顺时针旋转 90°” = 屏幕上看到的图片顺时针转；
 *   “水平翻转” = 在旋转后的画面上左右镜像。
 *   makeSampler(rot, flip) 把“读者看到的 UV”映射到“原图 UV”；
 *   invertSampler 是它的严格逆。test/core.test.js 里逐点校验。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CubeCore = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // 向量
  // ---------------------------------------------------------------------------
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const norm = (a) => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  };
  const lerp3 = (a, b, t) => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
  const lexLess = (a, b) =>
    a[0] !== b[0] ? a[0] < b[0] : a[1] !== b[1] ? a[1] < b[1] : a[2] < b[2];
  const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

  // ---------------------------------------------------------------------------
  // 六面
  // ---------------------------------------------------------------------------
  // 全部满足 r × u = n（内部视角：正对某面时，该面“图向右”= 观察者右手边）
  const FACES = [
    { id: 0, name: 'Right', cn: '右', short: 'R', axis: '+X', n: [1, 0, 0], r: [0, 0, -1], u: [0, 1, 0], tint: [255, 128, 89] },
    { id: 1, name: 'Left', cn: '左', short: 'L', axis: '-X', n: [-1, 0, 0], r: [0, 0, 1], u: [0, 1, 0], tint: [90, 169, 255] },
    { id: 2, name: 'Top', cn: '上', short: 'U', axis: '+Y', n: [0, 1, 0], r: [1, 0, 0], u: [0, 0, -1], tint: [87, 217, 154] },
    { id: 3, name: 'Bottom', cn: '下', short: 'D', axis: '-Y', n: [0, -1, 0], r: [1, 0, 0], u: [0, 0, 1], tint: [233, 200, 90] },
    { id: 4, name: 'Front', cn: '前', short: 'F', axis: '+Z', n: [0, 0, 1], r: [1, 0, 0], u: [0, 1, 0], tint: [180, 140, 255] },
    { id: 5, name: 'Back', cn: '后', short: 'B', axis: '-Z', n: [0, 0, -1], r: [-1, 0, 0], u: [0, 1, 0], tint: [255, 110, 170] },
  ];
  const FACE_BY_ID = Object.fromEntries(FACES.map((f) => [f.id, f]));

  function faceLabel(id) {
    const f = FACE_BY_ID[id];
    return '#' + id + ' ' + f.cn + '面 (' + f.name + ')';
  }

  // 一次拖入六张图时按文件名猜测面（不区分大小写，支持 xpos/px/right 等）
  const FACE_ALIASES = {
    0: ['right', 'rt', 'px', 'posx', 'xpos', 'x+', '+x', '_r_', '-r-'],
    1: ['left', 'lf', 'nx', 'negx', 'xneg', 'x-', '-x', '_l_', '-l-'],
    2: ['top', 'up', 'py', 'posy', 'ypos', 'y+', '+y', '_u_', '-u-'],
    3: ['bottom', 'down', 'dn', 'ny', 'negy', 'yneg', 'y-', '-y', '_d_', '-d-'],
    4: ['front', 'ft', 'fwd', 'forward', 'pz', 'posz', 'zpos', 'z+', '+z', '_f_', '-f-'],
    5: ['back', 'rear', 'bk', 'nz', 'negz', 'zneg', 'z-', '-z', '_b_', '-b-'],
  };

  function guessFaceFromName(name) {
    const n = String(name || '').toLowerCase();
    const base = n.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
    const tokens = base.split(/[^a-z0-9+_-]+/).filter(Boolean);
    for (const faceId of Object.keys(FACE_ALIASES)) {
      for (const alias of FACE_ALIASES[faceId]) {
        if (/^[0-9]+$/.test(alias)) {
          if (tokens.includes(alias) || base === alias) return Number(faceId);
          continue;
        }
        if (tokens.includes(alias) || base.includes(alias)) return Number(faceId);
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // 面内角点与边
  // ---------------------------------------------------------------------------
  const SIDES = ['right', 'top', 'left', 'bottom'];
  const SIDE_CN = { right: '右', top: '上', left: '左', bottom: '下' };

  // 沿每条边走一圈（在面内看是顺时针：右 下→上，上 左→右，左 上→下，下 右→左）
  const EDGE_ST = {
    right: [[1, -1], [1, 1]],
    top: [[-1, 1], [1, 1]],
    left: [[-1, 1], [-1, -1]],
    bottom: [[1, -1], [-1, -1]],
  };

  function stTo3(faceId, st) {
    const f = FACE_BY_ID[faceId];
    const [s, t] = st;
    return [
      f.n[0] + f.r[0] * s + f.u[0] * t,
      f.n[1] + f.r[1] * s + f.u[1] * t,
      f.n[2] + f.r[2] * s + f.u[2] * t,
    ];
  }
  const stToUV = (st) => [(st[0] + 1) / 2, (st[1] + 1) / 2];

  function facePoint3(faceId, u, v) {
    return stTo3(faceId, [u * 2 - 1, v * 2 - 1]);
  }

  function faceUVFrom3D(faceId, P) {
    const f = FACE_BY_ID[faceId];
    const rel = [P[0] - f.n[0], P[1] - f.n[1], P[2] - f.n[2]];
    const s = dot(rel, f.r);
    const t = dot(rel, f.u);
    return { s, t, u: (s + 1) / 2, v: (t + 1) / 2 };
  }

  const EDGES = {};
  for (const f of FACES) {
    for (const side of SIDES) {
      const [st0, st1] = EDGE_ST[side];
      EDGES[f.id + ':' + side] = {
        faceId: f.id,
        side,
        st0,
        st1,
        p0: stTo3(f.id, st0),
        p1: stTo3(f.id, st1),
        uv0: stToUV(st0),
        uv1: stToUV(st1),
      };
    }
  }

  // ---------------------------------------------------------------------------
  // 12 条真实共用边
  //   规范端点 P0/P1 按坐标字典序固定；两面都沿同一物理方向取样比较。
  // ---------------------------------------------------------------------------
  function buildSeams() {
    const seams = [];
    for (const f of FACES) {
      for (const g of FACES) {
        if (g.id <= f.id) continue;
        if (dot(f.n, g.n) !== 0) continue;
        let found = 0;
        for (const sa of SIDES) {
          for (const sb of SIDES) {
            const ea = EDGES[f.id + ':' + sa];
            const eb = EDGES[g.id + ':' + sb];
            const pEq = (p, q) => p[0] === q[0] && p[1] === q[1] && p[2] === q[2];
            const same = pEq(ea.p0, eb.p0) && pEq(ea.p1, eb.p1);
            const flip = pEq(ea.p0, eb.p1) && pEq(ea.p1, eb.p0);
            if (!same && !flip) continue;
            found++;
            const aStartIsP0 = lexLess(ea.p0, ea.p1); // ea.p0 是否为规范 P0
            seams.push({
              id: seams.length,
              key: f.id + ':' + sa + '|' + g.id + ':' + sb,
              faceA: f.id,
              sideA: sa,
              faceB: g.id,
              sideB: sb,
              P0: aStartIsP0 ? ea.p0 : ea.p1,
              P1: aStartIsP0 ? ea.p1 : ea.p0,
              aStartIsP0,
              bStartIsP0: flip ? !aStartIsP0 : aStartIsP0,
            });
          }
        }
        if (found !== 1) {
          throw new Error('adjacency check failed for faces ' + f.id + '/' + g.id + ' found=' + found);
        }
      }
    }
    if (seams.length !== 12) throw new Error('expected 12 seams, got ' + seams.length);
    return seams;
  }
  const SEAMS = buildSeams();
  const SEAM_BY_PAIR = new Map(SEAMS.map((s) => [s.faceA + ',' + s.faceB, s]));

  function seamFor(faceId, side) {
    return (
      SEAMS.find((s) => s.faceA === faceId && s.sideA === side) ||
      SEAMS.find((s) => s.faceB === faceId && s.sideB === side) ||
      null
    );
  }
  function seamBetween(a, b) {
    return SEAM_BY_PAIR.get(Math.min(a, b) + ',' + Math.max(a, b)) || null;
  }
  function neighbors(faceId) {
    const out = [];
    for (const s of SEAMS) {
      if (s.faceA === faceId) out.push(s.faceB);
      else if (s.faceB === faceId) out.push(s.faceA);
    }
    return out.sort((a, b) => a - b);
  }

  // ---------------------------------------------------------------------------
  // 图像显示变换：读者看到的 UV → 原图 UV
  //   rot = 顺时针 90° 的次数；flipH = 在旋转后的画面上左右镜像。
  //   rot 1 的推导：原图点 (su,sv) 顺时针转到 (sv, 1-su)；
  //   取逆得原图 UV = (1-ty, tx)。
  // ---------------------------------------------------------------------------
  function makeSampler(rot, flipH) {
    const r = ((rot % 4) + 4) % 4;
    const flip = !!flipH;
    return function sampleUV(u, v) {
      let tx = u;
      let ty = v;
      if (flip) tx = 1 - tx;
      switch (r) {
        case 1:
          return [1 - ty, tx];
        case 2:
          return [1 - tx, 1 - ty];
        case 3:
          return [ty, 1 - tx];
        default:
          return [tx, ty];
      }
    };
  }

  function invertSampler(rot, flipH, su, sv) {
    const r = ((rot % 4) + 4) % 4;
    let tx, ty;
    switch (r) {
      case 1:
        tx = sv;
        ty = 1 - su;
        break;
      case 2:
        tx = 1 - su;
        ty = 1 - sv;
        break;
      case 3:
        tx = 1 - sv;
        ty = su;
        break;
      default:
        tx = su;
        ty = sv;
    }
    if (flipH) tx = 1 - tx;
    return [tx, ty];
  }

  // 读者看到的 UV → 原图像素（连续坐标）
  function uvToSourcePixel(rot, flipH, u, v, srcW, srcH) {
    const [su, sv] = makeSampler(rot, flipH)(u, v);
    return { x: su * srcW, y: (1 - sv) * srcH, su, sv };
  }
  // 原图像素 → 读者看到的 UV
  function sourcePixelToUV(rot, flipH, px, py, srcW, srcH) {
    const su = srcW ? px / srcW : 0;
    const sv = srcH ? 1 - py / srcH : 0;
    const [u, v] = invertSampler(rot, flipH, su, sv);
    return { u, v };
  }

  function orientationLabel(rot, flipH) {
    const deg = (((rot % 4) + 4) % 4) * 90;
    return deg + '°' + (flipH ? ' + 水平镜像' : '');
  }

  function rotateConfig(rot, flipH, delta) {
    return { rot: ((rot + delta) % 4 + 4) % 4, flipH };
  }

  // ---------------------------------------------------------------------------
  // 经纬（等距柱状）投影 —— 与主视图同为“从立方体中心向外看”的全景
  //
  //     d(lon, lat) = ( sin lon·cos lat,  sin lat,  cos lon·cos lat )
  //     lon = atan2(x, z) ∈ [-π, π]，lat = asin(y) ∈ [-π/2, π/2]
  //     u = (lon + π)/2π，v = (π/2 - lat)/π
  //
  //   观察者朝 +Z 时右手边是 +X，所以全景图里 lon=+90°（u=0.75，中央的右侧）
  //   对应 +X 右面；lon=-90°（u=0.25）对应 -X 左面；lon=±180°（u=0/1）是 -Z 后面。
  //   u=0.5 正对 +Z 前面。竖直：+Y 上在顶部、-Y 下在底部。
  //   这样经纬图里各面文字也是正读的（与六面图一致），后墙被首尾接缝一分为二。
  // ---------------------------------------------------------------------------
  const TAU = Math.PI * 2;
  // 立方体某面角点对应的边界纬度（atan(1/√2) ≈ 35.264°）
  const EQ_POLE_LAT = Math.atan(1 / Math.SQRT2);

  function wrapPi(a) {
    let x = a;
    while (x > Math.PI) x -= TAU;
    while (x < -Math.PI) x += TAU;
    return x;
  }
  function dirFromLonLat(lon, lat) {
    const cl = Math.cos(lat);
    return [Math.sin(lon) * cl, Math.sin(lat), Math.cos(lon) * cl];
  }
  function lonLatFromDir(d) {
    const l = Math.hypot(d[0], d[1], d[2]) || 1;
    const y = clamp(d[1] / l, -1, 1);
    return { lon: Math.atan2(d[0], d[2]), lat: Math.asin(y) };
  }
  function dirToFace(d) {
    const out = { faceId: 0, s: 0, t: 0, u: 0, v: 0 };
    dirToFaceInto(out, d[0], d[1], d[2]);
    return out;
  }

  // 无分配版本：写入 out 的 faceId/s/t/u/v
  function dirToFaceInto(out, dx, dy, dz) {
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    const az = Math.abs(dz);
    let faceId, major;
    if (ax >= ay && ax >= az) {
      faceId = dx > 0 ? 0 : 1;
      major = ax || 1e-12;
    } else if (ay >= az) {
      faceId = dy > 0 ? 2 : 3;
      major = ay || 1e-12;
    } else {
      faceId = dz > 0 ? 4 : 5;
      major = az || 1e-12;
    }
    const f = FACE_BY_ID[faceId];
    // p = d/major，p 的 `axis` 分量必为 ±1，等于 n；故 rel = p - n 只在另两个轴非零
    const px_ = dx / major - f.n[0];
    const py_ = dy / major - f.n[1];
    const pz_ = dz / major - f.n[2];
    const s = px_ * f.r[0] + py_ * f.r[1] + pz_ * f.r[2];
    const t = px_ * f.u[0] + py_ * f.u[1] + pz_ * f.u[2];
    out.faceId = faceId;
    out.s = s;
    out.t = t;
    out.u = (s + 1) / 2;
    out.v = (t + 1) / 2;
    return out;
  }
  function faceUVToLonLat(faceId, u, v) {
    return lonLatFromDir(facePoint3(faceId, u, v));
  }
  function equirectPixelToDir(x, y, W, H) {
    const lon = ((x + 0.5) / W) * TAU - Math.PI;
    const lat = Math.PI / 2 - ((y + 0.5) / H) * Math.PI;
    return { lon, lat, dir: dirFromLonLat(lon, lat) };
  }
  function dirToEquirectPixel(d, W, H) {
    const { lon, lat } = lonLatFromDir(d);
    return {
      x: ((lon + Math.PI) / TAU) * W - 0.5,
      y: ((Math.PI / 2 - lat) / Math.PI) * H - 0.5,
      lon,
      lat,
    };
  }

  // ---------------------------------------------------------------------------
  // 十字展开图布局（与上面的朝向严格自洽，可无缝平铺）
  //
  //              [上2]
  //      [左1][前4][右0][后5]
  //              [下3]
  //
  //   水平横带 左→前→右→后：每条相邻边从两侧取样时 t 方向一致，可直接拼。
  //   上2 贴在前4 上方、下3 贴在前4 下方（各自与前面共用水平棱）。
  //   带两端：左1 的左边缘 与 后5 的右边缘 折起后相接（横带首尾）。
  // ---------------------------------------------------------------------------
  const NET_LAYOUT = [
    { faceId: 1, col: 0, row: 1 }, // Left
    { faceId: 4, col: 1, row: 1 }, // Front
    { faceId: 0, col: 2, row: 1 }, // Right
    { faceId: 5, col: 3, row: 1 }, // Back
    { faceId: 2, col: 1, row: 0 }, // Top    （在 Front 上方）
    { faceId: 3, col: 1, row: 2 }, // Bottom （在 Front 下方）
  ];
  const NET_CELL = Object.fromEntries(NET_LAYOUT.map((c) => [c.faceId, c]));
  const NET_COLS = 4;
  const NET_ROWS = 3;

  // 从某个面格跨过它的某条边，在展开图网格里的位移（列右、行下）
  const NET_STEP = { right: [1, 0], left: [-1, 0], top: [0, -1], bottom: [0, 1] };

  // 该接缝在十字展开图里是否物理相邻（可直接拼）
  function netPhysical(seam) {
    const a = NET_CELL[seam.faceA];
    const b = NET_CELL[seam.faceB];
    if (!a || !b) return false;
    const sa = NET_STEP[seam.sideA];
    const sb = NET_STEP[seam.sideB];
    // 从 A 的某条边跨出去应该正好落在 B；反过来从 B 的边跨出去应回到 A
    return b.col === a.col + sa[0] && b.row === a.row + sa[1] && a.col === b.col + sb[0] && a.row === b.row + sb[1];
  }
  const BAND_WRAP_SEAM = seamBetween(1, 5);

  // ---------------------------------------------------------------------------
  // 纹理采样
  //   tex = { data: Uint8ClampedArray|Uint8Array RGBA, width, height }
  //   su 左→右，sv 下→上。wrapX 用于经纬图横向环绕。
  // ---------------------------------------------------------------------------
  function sampleTexture(tex, su, sv, wrapX, bilinear) {
    const out = [0, 0, 0, 255];
    sampleInto(out, tex, su, sv, wrapX, bilinear);
    return tex ? out : null;
  }

  // 写入 out[0..3]，避免逐像素分配；tex 为空时不动 out 并返回 false
  function sampleInto(out, tex, su, sv, wrapX, bilinear) {
    if (!tex || !tex.data || !tex.width || !tex.height) return false;
    const w = tex.width;
    const h = tex.height;
    let fx = su * w;
    let fy = (1 - sv) * h;
    if (wrapX) {
      fx = ((fx % w) + w) % w;
    } else {
      fx = clamp(fx, 0, w - 1e-6);
    }
    fy = clamp(fy, 0, h - 1e-6);
    const d = tex.data;
    if (!bilinear) {
      const x = Math.min(w - 1, Math.floor(fx));
      const y = Math.min(h - 1, Math.floor(fy));
      const i = (y * w + x) * 4;
      out[0] = d[i];
      out[1] = d[i + 1];
      out[2] = d[i + 2];
      out[3] = d[i + 3];
      return true;
    }
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const txx = fx - x0;
    const tyy = fy - y0;
    const xi = (x) => (wrapX ? ((x % w) + w) % w : clamp(x, 0, w - 1));
    const yi = (y) => clamp(y, 0, h - 1);
    const p00 = (yi(y0) * w + xi(x0)) * 4;
    const p10 = (yi(y0) * w + xi(x0 + 1)) * 4;
    const p01 = (yi(y0 + 1) * w + xi(x0)) * 4;
    const p11 = (yi(y0 + 1) * w + xi(x0 + 1)) * 4;
    for (let c = 0; c < 4; c++) {
      const top = d[p00 + c] * (1 - txx) + d[p10 + c] * txx;
      const bottom = d[p01 + c] * (1 - txx) + d[p11 + c] * txx;
      out[c] = top * (1 - tyy) + bottom * tyy;
    }
    return true;
  }

  // 提前算好“读者 UV → 原图 UV”的仿射系数（见 makeSampler 的说明）
  //   su = a*u + b*v + c ； sv = d*u + e*v + f
  function affineFor(rot, flipH) {
    const r = ((rot % 4) + 4) % 4;
    if (!flipH) {
      switch (r) {
        case 1: return { a: 0, b: -1, c: 1, d: 1, e: 0, f: 0 };
        case 2: return { a: -1, b: 0, c: 1, d: 0, e: -1, f: 1 };
        case 3: return { a: 0, b: 1, c: 0, d: -1, e: 0, f: 1 };
        default: return { a: 1, b: 0, c: 0, d: 0, e: 1, f: 0 };
      }
    }
    switch (r) {
      case 1: return { a: 0, b: -1, c: 1, d: -1, e: 0, f: 1 };
      case 2: return { a: 1, b: 0, c: 0, d: 0, e: -1, f: 1 };
      case 3: return { a: 0, b: 1, c: 0, d: 1, e: 0, f: 0 };
      default: return { a: -1, b: 0, c: 1, d: 0, e: 1, f: 0 };
    }
  }

  // 缺图时的占位图案：面色调 + 棋盘格，便于在 3D 中辨认朝向
  function placeholderColor(faceId, u, v) {
    const f = FACE_BY_ID[faceId];
    const checker = (Math.floor(u * 8) + Math.floor(v * 8)) & 1;
    const base = checker ? 0.22 : 0.34;
    return [
      Math.round(f.tint[0] * base + 26),
      Math.round(f.tint[1] * base + 26),
      Math.round(f.tint[2] * base + 26),
      255,
    ];
  }

  // ---------------------------------------------------------------------------
  // 相机（位于立方体内部）
  //   yaw=0 朝 +Z 看；pitch 为正抬头。
  //   与面的朝向一致：R = 上 × F，U = F × R（对 F=+Z 得 R=+X、U=+Y）。
  //   这样正对某面时，该面文字正读，投影不镜像。
  // ---------------------------------------------------------------------------
  function cameraBasis(yaw, pitch) {
    const p = clamp(pitch, -Math.PI / 2 + 0.001, Math.PI / 2 - 0.001);
    const F = norm([Math.sin(yaw) * Math.cos(p), Math.sin(p), Math.cos(yaw) * Math.cos(p)]);
    const R = norm(cross([0, 1, 0], F));
    const U = cross(F, R);
    return { F, R, U };
  }

  function viewRay(x, y, W, H, basis, fovDeg) {
    const tanH = Math.tan((fovDeg * Math.PI) / 180 / 2);
    const tanV = tanH * (H / W);
    const nx = ((x + 0.5) / W) * 2 * tanH - tanH;
    const ny = tanH * (H / W) - ((y + 0.5) / H) * 2 * tanV;
    return [
      basis.F[0] + basis.R[0] * nx + basis.U[0] * ny,
      basis.F[1] + basis.R[1] * nx + basis.U[1] * ny,
      basis.F[2] + basis.R[2] * nx + basis.U[2] * ny,
    ];
  }

  // 3D 点投到屏幕（相机在原点）；返回 null 表示在背后
  function projectPoint(P, W, H, basis, fovDeg) {
    const z = dot(P, basis.F);
    if (z <= 1e-6) return null;
    const tanH = Math.tan((fovDeg * Math.PI) / 180 / 2);
    const tanV = tanH * (H / W);
    const x = dot(P, basis.R) / z;
    const y = dot(P, basis.U) / z;
    return {
      x: ((x / tanH + 1) / 2) * W,
      y: ((1 - y / tanV) / 2) * H,
      depth: z,
    };
  }

  // 相机在世界中的朝向角（用于读取俯仰/偏航提示）
  function viewLabel(yaw, pitch) {
    const deg = (r) => Math.round((r * 180) / Math.PI);
    return '偏航 ' + deg(yaw) + '° / 俯仰 ' + deg(pitch) + '°';
  }

  // ---------------------------------------------------------------------------
  // 渲染：立方体内部视角
  //   faces[id] = { tex, rot, flipH }  （tex 可为 null）
  // ---------------------------------------------------------------------------
  const pxc = [0, 0, 0, 255];
  const hit = { faceId: 0, s: 0, t: 0, u: 0, v: 0 };

  function renderCubeView(opts) {
    const W = opts.width;
    const H = opts.height;
    const basis = cameraBasis(opts.yaw || 0, opts.pitch || 0);
    const fov = opts.fovDeg || 92;
    const faces = opts.faces || {};
    const data = new Uint8ClampedArray(W * H * 4);
    const faceAt = new Int8Array(W * H).fill(-1);
    const tanH = Math.tan((fov * Math.PI) / 180 / 2);
    const tanV = tanH * (H / W);
    // 预计算每面的仿射系数
    const aff = {};
    for (const k of Object.keys(faces)) {
      if (faces[k] && faces[k].tex) aff[k] = affineFor(faces[k].rot || 0, faces[k].flipH);
    }
    for (let y = 0; y < H; y++) {
      const ny = tanV - ((y + 0.5) / H) * 2 * tanV;
      for (let x = 0; x < W; x++) {
        const nx = ((x + 0.5) / W) * 2 * tanH - tanH;
        const dx = basis.F[0] + basis.R[0] * nx + basis.U[0] * ny;
        const dy = basis.F[1] + basis.R[1] * nx + basis.U[1] * ny;
        const dz = basis.F[2] + basis.R[2] * nx + basis.U[2] * ny;
        dirToFaceInto(hit, dx, dy, dz);
        const i = y * W + x;
        faceAt[i] = hit.faceId;
        const cfg = faces[hit.faceId];
        let ok = false;
        if (cfg && cfg.tex) {
          const A = aff[hit.faceId];
          const su = A.a * hit.u + A.b * hit.v + A.c;
          const sv = A.d * hit.u + A.e * hit.v + A.f;
          ok = sampleInto(pxc, cfg.tex, su, sv, false, false);
        }
        if (!ok) {
          const f = FACE_BY_ID[hit.faceId];
          const checker = (Math.floor(hit.u * 8) + Math.floor(hit.v * 8)) & 1;
          const b = checker ? 0.22 : 0.34;
          pxc[0] = Math.round(f.tint[0] * b + 26);
          pxc[1] = Math.round(f.tint[1] * b + 26);
          pxc[2] = Math.round(f.tint[2] * b + 26);
          pxc[3] = 255;
        }
        const o = i * 4;
        data[o] = pxc[0];
        data[o + 1] = pxc[1];
        data[o + 2] = pxc[2];
        data[o + 3] = 255;
      }
    }
    return { width: W, height: H, data, faceAt };
  }

  // ---------------------------------------------------------------------------
  // 渲染：经纬展开图
  // ---------------------------------------------------------------------------
  function renderEquirectFromFaces(opts) {
    const W = opts.width;
    const H = opts.height;
    const faces = opts.faces || {};
    const data = new Uint8ClampedArray(W * H * 4);
    const faceAt = new Int8Array(W * H).fill(-1);
    const bilinear = !!opts.bilinear;
    const aff = {};
    for (const k of Object.keys(faces)) {
      if (faces[k] && faces[k].tex) aff[k] = affineFor(faces[k].rot || 0, faces[k].flipH);
    }
    for (let y = 0; y < H; y++) {
      const lat = Math.PI / 2 - ((y + 0.5) / H) * Math.PI;
      const cl = Math.cos(lat);
      const sy = Math.sin(lat);
      for (let x = 0; x < W; x++) {
        const lon = ((x + 0.5) / W) * TAU - Math.PI;
        // 与 dirFromLonLat 一致：d = (sin lon·cos lat, sin lat, cos lon·cos lat)
        const dxv = Math.sin(lon) * cl;
        const dzv = Math.cos(lon) * cl;
        dirToFaceInto(hit, dxv, sy, dzv);
        const i = y * W + x;
        faceAt[i] = hit.faceId;
        const cfg = faces[hit.faceId];
        let ok = false;
        if (cfg && cfg.tex) {
          const A = aff[hit.faceId];
          const su = A.a * hit.u + A.b * hit.v + A.c;
          const sv = A.d * hit.u + A.e * hit.v + A.f;
          ok = sampleInto(pxc, cfg.tex, su, sv, false, bilinear);
        }
        if (!ok) {
          const f = FACE_BY_ID[hit.faceId];
          const checker = (Math.floor(hit.u * 8) + Math.floor(hit.v * 8)) & 1;
          const b = checker ? 0.22 : 0.34;
          pxc[0] = Math.round(f.tint[0] * b + 26);
          pxc[1] = Math.round(f.tint[1] * b + 26);
          pxc[2] = Math.round(f.tint[2] * b + 26);
          pxc[3] = 255;
        }
        const o = i * 4;
        data[o] = pxc[0];
        data[o + 1] = pxc[1];
        data[o + 2] = pxc[2];
        data[o + 3] = 255;
      }
    }
    return { width: W, height: H, data, faceAt };
  }

  // ---------------------------------------------------------------------------
  // 从经纬展开图抽取六面
  //   输出为“读者看到的正确朝向”，因此配置应设为 rot=0/flip=false；
  //   每一面按内部视角采样，等价于 renderEquirectFromFaces 的逆。
  // ---------------------------------------------------------------------------
  function extractFacesFromEquirect(opts) {
    const eq = opts.equirect;
    const size = opts.size;
    const out = {};
    for (const f of FACES) {
      const data = new Uint8ClampedArray(size * size * 4);
      let i = 0;
      for (let y = 0; y < size; y++) {
        const v = 1 - (y + 0.5) / size;
        for (let x = 0; x < size; x++) {
          const u = (x + 0.5) / size;
          const dir = facePoint3(f.id, u, v);
          const { lon, lat } = lonLatFromDir(dir);
          const ex = ((lon + Math.PI) / TAU) * eq.width - 0.5;
          const ey = ((Math.PI / 2 - lat) / Math.PI) * eq.height - 0.5;
          const c = sampleTexture(eq, (ex + 0.5) / eq.width, 1 - (ey + 0.5) / eq.height, true, opts.bilinear);
          data[i * 4] = c ? c[0] : 0;
          data[i * 4 + 1] = c ? c[1] : 0;
          data[i * 4 + 2] = c ? c[2] : 0;
          data[i * 4 + 3] = 255;
          i++;
        }
      }
      out[f.id] = { data, width: size, height: size };
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // 接缝取样与比较
  // ---------------------------------------------------------------------------
  const SAMPLE_PER_SEAM = 96;

  function sampleSeamColors(faces, seam, n) {
    const N = n || SAMPLE_PER_SEAM;
    const a = new Array(N);
    const b = new Array(N);
    for (let i = 0; i < N; i++) {
      const t = (i + 0.5) / N;
      const P = lerp3(seam.P0, seam.P1, t);
      const ua = faceUVFrom3D(seam.faceA, P);
      const ub = faceUVFrom3D(seam.faceB, P);
      const ca = sampleFaceColor(faces, seam.faceA, ua.u, ua.v);
      const cb = sampleFaceColor(faces, seam.faceB, ub.u, ub.v);
      a[i] = ca;
      b[i] = cb;
    }
    return { a, b };
  }

  function sampleFaceColor(faces, faceId, u, v) {
    const cfg = faces && faces[faceId];
    if (!cfg || !cfg.tex) return placeholderColor(faceId, u, v);
    const p = uvToSourcePixel(cfg.rot || 0, cfg.flipH, u, v, cfg.tex.width, cfg.tex.height);
    // 双线性可缓减“两侧在共用棱上各差半像素”带来的格线抖动
    const c = sampleTexture(cfg.tex, p.su, p.sv, false, true);
    return c || placeholderColor(faceId, u, v);
  }

  const ROTATION_ONLY_DELTA = 30; // 单点色差容忍（0..255 平均通道差）
  const ROTATION_ONLY_MEAN = 18; // 整条边平均色差容忍

  function colorDist(c1, c2) {
    return (Math.abs(c1[0] - c2[0]) + Math.abs(c1[1] - c2[1]) + Math.abs(c1[2] - c2[2])) / 3;
  }

  function compareStrips(a, b) {
    const n = Math.min(a.length, b.length);
    const calc = (rev) => {
      let sum = 0;
      let max = 0;
      let bad = 0;
      for (let i = 0; i < n; i++) {
        const d = colorDist(a[i], b[rev ? n - 1 - i : i]);
        sum += d;
        if (d > max) max = d;
        if (d > ROTATION_ONLY_DELTA) bad++;
      }
      return { mean: n ? sum / n : 255, max, badFrac: n ? bad / n : 1 };
    };
    const direct = calc(false);
    const reversed = calc(true);
    let verdict;
    if (direct.mean <= ROTATION_ONLY_MEAN && direct.badFrac <= 0.25) verdict = 'match';
    else if (reversed.mean <= ROTATION_ONLY_MEAN && reversed.badFrac <= 0.25) verdict = 'reversed';
    else verdict = 'mismatch';
    return { direct, reversed, verdict, reversedOrder: verdict === 'reversed' };
  }

  function compareSeam(faces, seam, n) {
    const { a, b } = sampleSeamColors(faces, seam, n);
    return Object.assign({ seam }, compareStrips(a, b));
  }

  function compareAllSeams(faces, n) {
    return SEAMS.map((s) => compareSeam(faces, s, n));
  }

  // 每条接缝两个端点的角点对应关系
  function seamCornerInfo(faces, seam) {
    const ends = [
      { name: 'P0', P: seam.P0 },
      { name: 'P1', P: seam.P1 },
    ];
    return ends.map((end) => {
      const perFace = [seam.faceA, seam.faceB].map((faceId) => {
        const uv = faceUVFrom3D(faceId, end.P);
        const cfg = faces && faces[faceId] || { rot: 0, flipH: false };
        const tex = faces && faces[faceId] && faces[faceId].tex;
        const W = tex ? tex.width : 1;
        const H = tex ? tex.height : 1;
        const src = uvToSourcePixel(cfg.rot || 0, cfg.flipH, uv.u, uv.v, W, H);
        return {
          faceId,
          u: uv.u,
          v: uv.v,
          px: Math.floor(src.x),
          py: Math.floor(src.y),
          corner: cornerName(uv.u, uv.v),
        };
      });
      return { end: end.name, P: end.P, faces: perFace };
    });
  }

  function cornerName(u, v) {
    const vert = v > 0.5 ? '上' : '下';
    const horiz = u < 0.5 ? '左' : '右';
    return horiz + vert + '角';
  }

  // ---------------------------------------------------------------------------
  // 朝向搜索：给每个面找出与邻居最吻合的 rot/flip
  //   目标：所有已存在面的“直接比对色差”之和最小。
  //   用坐标下降（每次只改一个面，绕 6 个面迭代几轮），6×8×4 次取样，足够快。
  // ---------------------------------------------------------------------------
  const ORIENTATIONS = [];
  for (let rot = 0; rot < 4; rot++) {
    ORIENTATIONS.push({ rot, flipH: false });
    ORIENTATIONS.push({ rot, flipH: true });
  }

  function withConfig(faces, faceId, cfg) {
    const out = Object.assign({}, faces);
    const f = faces[faceId];
    if (!f) return out;
    out[faceId] = Object.assign({}, f, { rot: cfg.rot, flipH: cfg.flipH });
    return out;
  }

  // 当前配置下，一条接缝的直接色差（缺失面返回 Infinity）
  function seamError(faces, seam, n) {
    if (!faces[seam.faceA] || !faces[seam.faceA].tex) return Infinity;
    if (!faces[seam.faceB] || !faces[seam.faceB].tex) return Infinity;
    const { a, b } = sampleSeamColors(faces, seam, n || 48);
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += colorDist(a[i], b[i]);
    return sum / a.length;
  }

  function faceScore(faces, faceId) {
    let sum = 0;
    let count = 0;
    for (const s of SEAMS) {
      if (s.faceA !== faceId && s.faceB !== faceId) continue;
      const e = seamError(faces, s, 40);
      if (!isFinite(e)) continue;
      sum += e;
      count++;
    }
    return count ? sum / count : Infinity;
  }

  function suggestOrientations(faces) {
    const present = FACES.filter((f) => faces[f.id] && faces[f.id].tex).map((f) => f.id);
    let best = {};
    for (const id of present) {
      best[id] = { rot: (faces[id].rot || 0) % 4, flipH: !!faces[id].flipH };
    }
    let working = faces;
    const before = present.length > 1 ? present.reduce((acc, id) => acc + faceScore(working, id), 0) : 0;
    for (let iter = 0; iter < 3; iter++) {
      let improved = false;
      for (const id of present) {
        let localBest = best[id];
        let localScore = faceScore(working, id);
        for (const cand of ORIENTATIONS) {
          const trial = withConfig(working, id, cand);
          const sc = faceScore(trial, id);
          if (sc + 1e-6 < localScore) {
            localScore = sc;
            localBest = cand;
          }
        }
        if (localBest.rot !== best[id].rot || localBest.flipH !== best[id].flipH) {
          best[id] = localBest;
          working = withConfig(working, id, localBest);
          improved = true;
        }
      }
      if (!improved) break;
    }
    const after = present.length > 1 ? present.reduce((acc, id) => acc + faceScore(working, id), 0) : 0;
    const changed = present.filter(
      (id) => best[id].rot !== ((faces[id].rot || 0) % 4) || best[id].flipH !== !!faces[id].flipH
    );
    return {
      configs: best,
      workingFaces: working,
      changed,
      scoreBefore: before,
      scoreAfter: after,
    };
  }

  // 找“只改一个面”就能让这条接缝吻合的配置（找不到返回 null）
  function findSingleFaceFix(faces, seam, threshold) {
    const limit = threshold == null ? ROTATION_ONLY_MEAN : threshold;
    let best = null;
    for (const id of [seam.faceA, seam.faceB]) {
      for (const cand of ORIENTATIONS) {
        const trial = withConfig(faces, id, cand);
        const e = seamError(trial, seam, 64);
        if (e <= limit && (!best || e < best.err)) best = { faceId: id, cfg: cand, err: e };
      }
    }
    return best;
  }

  // 接缝分类：
  //   'missing'    缺图
  //   'aligned'    当前朝向就对得上
  //   'reversed'   颜色序列一致但方向相反 → 朝向问题，给出转向/镜像修法
  //   'turnable'   改一个面的朝向就能对上 → 只需转向
  //   'paired'     必须两个面一起改朝向才能对上
  //   'content'    任何朝向组合都对不上 → 颜色确实接不上（内容不同/接缝不连续）
  function classifySeam(faces, seam) {
    const A = faces[seam.faceA];
    const B = faces[seam.faceB];
    if (!A || !A.tex || !B || !B.tex) {
      return {
        kind: 'missing',
        label: '缺图，无法比较',
        detail: '两侧都要有图才能比色。',
        direct: Infinity,
        reversed: Infinity,
      };
    }
    const samples = sampleSeamColors(faces, seam, SAMPLE_PER_SEAM);
    const cmp = compareStrips(samples.a, samples.b);
    if (cmp.verdict === 'match') {
      return {
        kind: 'aligned',
        label: '当前朝向已吻合',
        detail: '沿边逐点色差 ' + cmp.direct.mean.toFixed(1) + '（阈值 ' + ROTATION_ONLY_MEAN + '）。',
        direct: cmp.direct.mean,
        reversed: cmp.reversed.mean,
        cmp,
      };
    }

    const singleFix = findSingleFaceFix(faces, seam);

    if (cmp.verdict === 'reversed') {
      return {
        kind: 'reversed',
        label: '颜色一致但顺序反了',
        detail:
          singleFix
            ? '颜色一致、方向相反，属于朝向问题：把 ' + faceLabel(singleFix.faceId) + ' 改为 ' +
              orientationLabel(singleFix.cfg.rot, singleFix.cfg.flipH) + ' 即可对上。'
            : '两侧颜色序列互为倒序，说明某面被镜像或转了 180°；请用“自动修正朝向”统一定向。',
        fix: singleFix || undefined,
        direct: cmp.direct.mean,
        reversed: cmp.reversed.mean,
        cmp,
      };
    }

    if (singleFix) {
      return {
        kind: 'turnable',
        label: '只需转向',
        detail:
          faceLabel(singleFix.faceId) + ' 改成 ' + orientationLabel(singleFix.cfg.rot, singleFix.cfg.flipH) +
          ' 后接上（色差降至 ' + singleFix.err.toFixed(1) + '）。',
        fix: singleFix,
        direct: cmp.direct.mean,
        reversed: cmp.reversed.mean,
        cmp,
      };
    }

    // 试双面
    let pairFix = null;
    outer: for (const ca of ORIENTATIONS) {
      const t1 = withConfig(faces, seam.faceA, ca);
      for (const cb of ORIENTATIONS) {
        const t2 = withConfig(t1, seam.faceB, cb);
        const e = seamError(t2, seam, 48);
        if (e <= ROTATION_ONLY_MEAN) {
          pairFix = { a: ca, b: cb, err: e };
          break outer;
        }
      }
    }
    if (pairFix) {
      return {
        kind: 'paired',
        label: '两面配合才接上',
        detail:
          seam.faceA + ' 改 ' + orientationLabel(pairFix.a.rot, pairFix.a.flipH) + '、' +
          seam.faceB + ' 改 ' + orientationLabel(pairFix.b.rot, pairFix.b.flipH) +
          ' 才能接上（色差 ' + pairFix.err.toFixed(1) + '）。',
        fix: pairFix,
        direct: cmp.direct.mean,
        reversed: cmp.reversed.mean,
        cmp,
      };
    }
    return {
      kind: 'content',
      label: '颜色确实接不上',
      detail:
        '试过两侧所有 64 种朝向组合仍接不上（最好方向色差 ' + cmp.direct.mean.toFixed(1) +
        '，反向 ' + cmp.reversed.mean.toFixed(1) + '）。不是转向问题，是内容/接缝本身不连续。',
      direct: cmp.direct.mean,
      reversed: cmp.reversed.mean,
      cmp,
    };
  }

  function classifyAllSeams(faces) {
    return SEAMS.map((s) => Object.assign({ seam: s }, classifySeam(faces, s)));
  }

  // ---------------------------------------------------------------------------
  // 渲染十字展开图（带面编号、缝线、横带首尾标记）
  // ---------------------------------------------------------------------------
  function renderNet(opts) {
    const faces = opts.faces || {};
    const cell = opts.cell || 256;
    const gap = opts.gap == null ? 6 : opts.gap;
    const pad = opts.pad == null ? 10 : opts.pad;
    const W = NET_COLS * cell + (NET_COLS - 1) * gap + pad * 2;
    const H = NET_ROWS * cell + (NET_ROWS - 1) * gap + pad * 2;
    const data = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      data[i * 4] = 16;
      data[i * 4 + 1] = 18;
      data[i * 4 + 2] = 22;
      data[i * 4 + 3] = 255;
    }
    const rects = {};
    for (const c of NET_LAYOUT) {
      const x0 = pad + c.col * (cell + gap);
      const y0 = pad + c.row * (cell + gap);
      rects[c.faceId] = { x: x0, y: y0, w: cell, h: cell };
      const cfg = faces[c.faceId];
      for (let y = 0; y < cell; y++) {
        const v = 1 - (y + 0.5) / cell;
        for (let x = 0; x < cell; x++) {
          const u = (x + 0.5) / cell;
          const col = cfg && cfg.tex
            ? sampleFaceColor(faces, c.faceId, u, v)
            : placeholderColor(c.faceId, u, v);
          const i = ((y0 + y) * W + (x0 + x)) * 4;
          data[i] = col[0];
          data[i + 1] = col[1];
          data[i + 2] = col[2];
          data[i + 3] = 255;
        }
      }
    }
    return { width: W, height: H, data, rects, cell, gap, pad };
  }

  // ---------------------------------------------------------------------------
  // 项目诊断：缺面 / 非正方形 / 尺寸不一致（明确指出该处理哪一张）
  // ---------------------------------------------------------------------------
  function diagnose(faces) {
    const missing = [];
    for (const f of FACES) {
      const x = faces && faces[f.id];
      if (!x || !x.tex) missing.push(f.id);
    }
    const sized = FACES.filter((f) => faces && faces[f.id] && faces[f.id].tex).map((f) => ({
      id: f.id,
      w: faces[f.id].tex.width,
      h: faces[f.id].tex.height,
      label: (faces[f.id] && faces[f.id].label) || faceLabel(f.id),
    }));
    const groups = {};
    for (const s of sized) {
      const k = s.w + '×' + s.h;
      (groups[k] = groups[k] || []).push(s);
    }
    const sizes = Object.keys(groups);
    const nonSquare = sized.filter((s) => s.w !== s.h);
    const mixed = sizes.length > 1;
    const messages = [];
    let ok = true;

    if (missing.length) {
      ok = false;
      messages.push({
        kind: 'missing',
        severity: 'error',
        text:
          '缺少 ' + missing.length + ' 个面：' +
          missing.map((id) => faceLabel(id)).join('、') +
          '。请给这些面补图（可一次拖入六张，按文件名自动对号）。',
        faces: missing,
      });
    }
    if (nonSquare.length) {
      ok = false;
      messages.push({
        kind: 'aspect',
        severity: 'warn',
        text:
          '不是 1:1：' +
          nonSquare.map((s) => faceLabel(s.id) + ' = ' + s.w + '×' + s.h).join('；') +
          '。立方体面会被拉伸，建议先裁成正方形。',
        faces: nonSquare.map((s) => s.id),
      });
    }
    if (mixed) {
      ok = false;
      const major = sizes.slice().sort((a, b) => groups[b].length - groups[a].length)[0];
      const outlierIds = [];
      for (const k of sizes) if (k !== major) for (const s of groups[k]) outlierIds.push(s.id);
      const parts = sizes.map((k) => k + ' → ' + groups[k].map((s) => faceLabel(s.id)).join('、'));
      messages.push({
        kind: 'mixed',
        severity: 'warn',
        text:
          '尺寸不一致：' + parts.join('；') + '。多数面是 ' + major +
          '；请把 ' + outlierIds.map((id) => faceLabel(id)).join('、') +
          ' 重采样到 ' + major + '（导出时会按公共尺寸缩放，细节会略损）。',
        faces: outlierIds,
        majorSize: major,
      });
    }
    return { ok, missing, mixed, nonSquare, sizes, messages };
  }

  function commonSize(faces) {
    let w = 0;
    let h = 0;
    for (const f of FACES) {
      const t = faces && faces[f.id] && faces[f.id].tex;
      if (t) {
        w = Math.max(w, t.width);
        h = Math.max(h, t.height);
      }
    }
    if (!w) w = 512;
    if (!h) h = 512;
    return { width: w, height: h };
  }

  const DEFAULT_VIEW = { yaw: -0.65, pitch: 0.42, fovDeg: 92 };

  return {
    // 数据
    FACES,
    FACE_BY_ID,
    FACE_ALIASES,
    SIDES,
    SIDE_CN,
    EDGES,
    SEAMS,
    NET_LAYOUT,
    NET_CELL,
    NET_COLS,
    NET_ROWS,
    BAND_WRAP_SEAM,
    SAMPLE_PER_SEAM,
    ROTATION_ONLY_DELTA,
    ROTATION_ONLY_MEAN,
    DEFAULT_VIEW,
    EQ_POLE_LAT,
    TAU,
    // 基础
    dot,
    cross,
    norm,
    clamp,
    faceLabel,
    guessFaceFromName,
    stTo3,
    stToUV,
    facePoint3,
    faceUVFrom3D,
    // 邻接
    seamFor,
    seamBetween,
    neighbors,
    netPhysical,
    // 采样/变换
    makeSampler,
    invertSampler,
    uvToSourcePixel,
    sourcePixelToUV,
    orientationLabel,
    rotateConfig,
    sampleTexture,
    placeholderColor,
    sampleFaceColor,
    // 投影
    dirFromLonLat,
    lonLatFromDir,
    dirToFace,
    faceUVToLonLat,
    equirectPixelToDir,
    dirToEquirectPixel,
    // 相机
    cameraBasis,
    viewRay,
    projectPoint,
    viewLabel,
    // 渲染/转换
    renderCubeView,
    renderEquirectFromFaces,
    extractFacesFromEquirect,
    renderNet,
    // 接缝
    sampleSeamColors,
    compareStrips,
    compareSeam,
    compareAllSeams,
    seamCornerInfo,
    cornerName,
    colorDist,
    ORIENTATIONS,
    seamError,
    faceScore,
    suggestOrientations,
    classifySeam,
    classifyAllSeams,
    // 诊断
    diagnose,
    commonSize,
  };
});
