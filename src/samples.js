/*
 * samples.js — 程序生成的内置样例六面图
 *
 * 设计：
 *   1) 先造一张“经纬展开底图”，格线按经纬每 15° 一条、每 45°/90° 加粗，
 *      所以任意相邻两面在共用边上格线天然连续，可以直接拿来核对接缝。
 *   2) 用 CubeCore.extractFacesFromEquirect 从底图抽出六面（得到“读者视角”正向的面），
 *      再在每张面上绘制方向文字、上/右箭头、四角坐标标记。
 *   3) 返回时把 0 号右面故意转 90°（rot=1），其余 rot=0。
 *      加载后接缝检查应能指出 0 号面“只需转向”，一键修正即可复原。
 *
 * 无第三方依赖；浏览器和 Node 都能用（window.Samples / require）。
 * Node 端 tools/generate-samples.js 也调用这里的函数，写出 PNG。
 */
(function (root, factory) {
  const isNode = typeof module === 'object' && module.exports;
  const CubeCore = isNode ? require('./cube.js') : root.CubeCore;
  const api = factory(CubeCore);
  if (isNode) module.exports = api;
  else root.Samples = api;
})(typeof self !== 'undefined' ? self : globalThis, function (CubeCore) {
  'use strict';

  // ---------------------------------------------------------------------------
  // 5×7 点阵字体（只收样例需要的字符）
  // ---------------------------------------------------------------------------
  const FONT = {
    A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
    B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
    C: ['.####', '#....', '#....', '#....', '#....', '#....', '.####'],
    D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
    E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
    F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
    G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.###.'],
    H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
    I: ['.###.', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'],
    J: ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
    K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
    L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
    M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
    N: ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
    O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
    P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
    Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
    R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
    S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
    T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
    U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
    V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
    W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '##.##', '#...#'],
    X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
    Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
    Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
    0: ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
    1: ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
    2: ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
    3: ['#####', '...#.', '..#..', '...#.', '....#', '#...#', '.###.'],
    4: ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
    5: ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
    6: ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
    7: ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
    8: ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
    9: ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
    '+': ['.....', '..#..', '..#..', '#####', '..#..', '..#..', '.....'],
    '-': ['.....', '.....', '.....', '#####', '.....', '.....', '.....'],
    ':': ['.....', '..#..', '..#..', '.....', '..#..', '..#..', '.....'],
    '.': ['.....', '.....', '.....', '.....', '.....', '.##..', '.##..'],
    '/': ['....#', '....#', '...#.', '..#..', '.#...', '#....', '#....'],
    '(': ['...#.', '..#..', '.#...', '.#...', '.#...', '..#..', '...#.'],
    ')': ['.#...', '..#..', '...#.', '...#.', '...#.', '..#..', '.#...'],
    '<': ['...#.', '..#..', '.#...', '#....', '.#...', '..#..', '...#.'],
    '>': ['.#...', '..#..', '...#.', '....#', '...#.', '..#..', '.#...'],
    ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
  };

  function glyph(ch) {
    return FONT[ch] || FONT['?'] || FONT[' '];
  }

  function textWidth(text, scale) {
    return text.length * 6 * scale - scale;
  }

  // 位图写入器
  function Painter(data, w, h) {
    this.data = data;
    this.w = w;
    this.h = h;
  }
  Painter.prototype.blend = function (x, y, c, a) {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4;
    const d = this.data;
    const al = a === undefined ? 1 : a;
    d[i] = d[i] * (1 - al) + c[0] * al;
    d[i + 1] = d[i + 1] * (1 - al) + c[1] * al;
    d[i + 2] = d[i + 2] * (1 - al) + c[2] * al;
    d[i + 3] = 255;
  };
  Painter.prototype.fillRect = function (x, y, w, h, c, a) {
    for (let yy = y; yy < y + h; yy++)
      for (let xx = x; xx < x + w; xx++) this.blend(xx, yy, c, a);
  };
  Painter.prototype.text = function (x, y, text, scale, color, align) {
    text = String(text).toUpperCase();
    const tw = textWidth(text, scale);
    let sx = x;
    if (align === 'center') sx = x - tw / 2;
    else if (align === 'right') sx = x - tw;
    // 深色描边提高可读性
    const off = Math.max(1, Math.round(scale / 2));
    for (let pass = 0; pass < 2; pass++) {
      const colr = pass === 0 ? [12, 14, 18] : color;
      const o = pass === 0 ? off : 0;
      for (let ci = 0; ci < text.length; ci++) {
        const g = glyph(text[ci]);
        const gx = Math.round(sx + ci * 6 * scale);
        for (let row = 0; row < 7; row++) {
          const line = g[row];
          for (let cx = 0; cx < 5; cx++) {
            if (line[cx] !== '#') continue;
            this.fillRect(gx + cx * scale + o, Math.round(y + row * scale + o), scale, scale, colr);
          }
        }
      }
    }
    return tw;
  };
  Painter.prototype.line = function (x0, y0, x1, y1, color, thickness) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy)));
    const t = Math.max(1, thickness || 1);
    const half = (t - 1) / 2;
    for (let i = 0; i <= steps; i++) {
      const x = x0 + (dx * i) / steps;
      const y = y0 + (dy * i) / steps;
      for (let oy = -Math.ceil(half); oy <= Math.ceil(half); oy++)
        for (let ox = -Math.ceil(half); ox <= Math.ceil(half); ox++)
          this.blend(x + ox, y + oy, color, 1);
    }
  };
  // 箭头（angle 弧度，屏幕坐标 y 向下）
  Painter.prototype.arrow = function (cx, cy, len, angle, color, thickness) {
    const hx = cx + Math.cos(angle) * len * 0.5;
    const hy = cy + Math.sin(angle) * len * 0.5;
    const tx = cx - Math.cos(angle) * len * 0.5;
    const ty = cy - Math.sin(angle) * len * 0.5;
    this.line(tx, ty, hx, hy, color, thickness);
    const head = Math.max(6, len * 0.22);
    const a1 = angle + Math.PI - 0.5;
    const a2 = angle + Math.PI + 0.5;
    this.line(hx, hy, hx + Math.cos(a1) * head, hy + Math.sin(a1) * head, color, thickness);
    this.line(hx, hy, hx + Math.cos(a2) * head, hy + Math.sin(a2) * head, color, thickness);
  };

  // ---------------------------------------------------------------------------
  // 经纬底图
  // ---------------------------------------------------------------------------
  function makeBaseEquirect(width, height) {
    const data = new Uint8ClampedArray(width * height * 4);
    const D2R = Math.PI / 180;
    const R2D = 180 / Math.PI;
    for (let y = 0; y < height; y++) {
      const lat = Math.PI / 2 - ((y + 0.5) / height) * Math.PI;
      const latDeg = lat * R2D;
      for (let x = 0; x < width; x++) {
        const lon = ((x + 0.5) / width) * Math.PI * 2 - Math.PI;
        const lonDeg = ((lon * R2D) + 360) % 360;
        // 用 CubeCore 的同一套经纬约定求方向，保证抽取六面时跨面连续
        const d = CubeCore.dirFromLonLat(lon, lat);
        const dx = d[0];
        const sy = d[1];
        const dz = d[2];
        // 方向渐变色：跨面连续
        let r = 34 + 26 * (0.5 + 0.5 * dx);
        let g = 38 + 26 * (0.5 + 0.5 * sy);
        let b = 50 + 34 * (0.5 + 0.5 * dz);
        // 15° 棋盘格，略变亮/暗
        const cell = (Math.floor(lonDeg / 15) + Math.floor((latDeg + 90) / 15)) & 1;
        const adj = cell ? 8 : -6;
        r += adj;
        g += adj;
        b += adj;
        // 网格线
        const fLon = lonDeg / 15;
        const dLonDeg = Math.min(fLon - Math.floor(fLon), 1 - (fLon - Math.floor(fLon))) * 15;
        const fLat = (latDeg + 90) / 15;
        const dLatDeg = Math.min(fLat - Math.floor(fLat), 1 - (fLat - Math.floor(fLat))) * 15;
        const dLon = dLonDeg * Math.abs(Math.cos(lat));
        const on15 = dLon < 0.28 || dLatDeg < 0.28;
        const on45 =
          Math.abs(((lonDeg + 0.01) % 45)) < 0.55 ||
          Math.abs(((lonDeg + 0.01) % 45) - 45) < 0.55 ||
          Math.abs(((latDeg + 90 + 0.01) % 45)) < 0.55;
        const on90 =
          Math.abs(((lonDeg + 0.01) % 90)) < 0.95 ||
          Math.abs(((lonDeg + 0.01) % 90) - 90) < 0.95 ||
          Math.abs(((latDeg + 90 + 0.01) % 90)) < 0.95;
        if (on15) {
          r = r * 0.55 + 66;
          g = g * 0.55 + 100;
          b = b * 0.55 + 112;
        }
        if (on45) {
          r = 52;
          g = 168;
          b = 176;
        }
        if (on90) {
          r = 250;
          g = 176;
          b = 72;
        }
        const i = (y * width + x) * 4;
        data[i] = r;
        data[i + 1] = g;
        data[i + 2] = b;
        data[i + 3] = 255;
      }
    }
    return { data, width, height };
  }

  // ---------------------------------------------------------------------------
  // 面上标注
  // ---------------------------------------------------------------------------
  function axisLabel(v) {
    const ax = Math.abs(v[0]);
    const ay = Math.abs(v[1]);
    const az = Math.abs(v[2]);
    if (ax >= ay && ax >= az) return (v[0] > 0 ? '+' : '-') + 'X';
    if (ay >= az) return (v[1] > 0 ? '+' : '-') + 'Y';
    return (v[2] > 0 ? '+' : '-') + 'Z';
  }
  function coordLabel(P) {
    const f = (x) => (x > 0 ? '+' : '-') + Math.abs(x);
    return '(' + f(P[0]) + ',' + f(P[1]) + ',' + f(P[2]) + ')';
  }

  function annotateFace(tex, faceId) {
    const f = CubeCore.FACE_BY_ID[faceId];
    const S = tex.width;
    const p = new Painter(tex.data, tex.width, tex.height);
    const bright = [248, 248, 244];
    const accent = [255, 214, 102];
    const cyan = [120, 230, 240];

    // 内框
    const m = Math.round(S * 0.055);
    const frame = [24, 28, 36];
    const fr = Math.max(2, Math.round(S * 0.006));
    p.fillRect(m, m, S - 2 * m, fr, frame, 0.85);
    p.fillRect(m, S - m - fr, S - 2 * m, fr, frame, 0.85);
    p.fillRect(m, m, fr, S - 2 * m, frame, 0.85);
    p.fillRect(S - m - fr, m, fr, S - 2 * m, frame, 0.85);

    // 角点坐标标记（图像四角）
    const cs = Math.max(1, Math.round(S / 512));
    const corners = [
      { txt: 'TL', st: [-1, 1], x: m + 6 * cs, y: m + 6 * cs, align: 'left' },
      { txt: 'TR', st: [1, 1], x: S - m - 6 * cs, y: m + 6 * cs, align: 'right' },
      { txt: 'BL', st: [-1, -1], x: m + 6 * cs, y: S - m - 26 * cs, align: 'left' },
      { txt: 'BR', st: [1, -1], x: S - m - 6 * cs, y: S - m - 26 * cs, align: 'right' },
    ];
    for (const c of corners) {
      const P = CubeCore.stTo3(faceId, c.st);
      p.text(c.x, c.y, c.txt, 2 * cs, accent, c.align);
      p.text(c.x, c.y + 9 * cs, coordLabel(P), 1 * cs, bright, c.align);
    }

    // 标题
    const titleScale = Math.max(2, Math.round(S / 128));
    p.text(S / 2, S * 0.2, 'FACE ' + faceId, titleScale, accent, 'center');
    p.text(S / 2, S * 0.29, f.name, titleScale, bright, 'center');

    // 轴信息
    const axisScale = Math.max(2, Math.round(S / 170));
    p.text(S / 2, S * 0.4, axisLabel(f.n), Math.max(3, Math.round(S / 110)), cyan, 'center');

    // 上 / 右 箭头
    const arrowLen = S * 0.2;
    const arrowThick = Math.max(2, Math.round(S / 200));
    // 上箭头（图像上方）
    p.arrow(S * 0.26, S * 0.67, arrowLen, -Math.PI / 2, accent, arrowThick);
    p.text(S * 0.26, S * 0.67 - arrowLen / 2 - 16 * cs, 'UP', 2 * cs, accent, 'center');
    p.text(S * 0.26, S * 0.67 + arrowLen / 2 + 4 * cs, axisLabel(f.u), 2 * cs, bright, 'center');
    // 右箭头
    p.arrow(S * 0.68, S * 0.8, arrowLen, 0, cyan, arrowThick);
    p.text(S * 0.68, S * 0.8 - 18 * cs, 'RIGHT', 2 * cs, cyan, 'center');
    p.text(S * 0.68, S * 0.8 + 14 * cs, axisLabel(f.r), 2 * cs, bright, 'center');

    // 说明
    p.text(S / 2, S * 0.9, 'U' + axisLabel(f.u) + ' R' + axisLabel(f.r), Math.max(1, Math.round(S / 300)), bright, 'center');
    return tex;
  }

  // ---------------------------------------------------------------------------
  // 生成六面（正确朝向）+ 故意转错的配置
  // ---------------------------------------------------------------------------
  function makeSampleFaces(opts) {
    const size = (opts && opts.size) || 512;
    const eqW = (opts && opts.equirectWidth) || 2048;
    const eqH = eqW / 2;
    const base = makeBaseEquirect(eqW, eqH);
    const extracted = CubeCore.extractFacesFromEquirect({ equirect: base, size, bilinear: true });
    const faces = {};
    const configs = {};
    for (const f of CubeCore.FACES) {
      const tex = annotateFace(
        { data: extracted[f.id].data, width: size, height: size },
        f.id
      );
      faces[f.id] = {
        tex,
        label: 'sample-' + f.id + '-' + f.name.toLowerCase() + '.png',
        fileName: 'sample-' + f.id + '-' + f.name.toLowerCase() + '.png',
        builtin: true,
      };
      configs[f.id] = { rot: 0, flipH: false };
    }
    // 故意把 0 号右面顺时针转 90°，用于验证“只需转向”的诊断
    configs[0] = { rot: 1, flipH: false };
    return {
      faces,
      configs,
      deliberateError: { faceId: 0, rot: 1, flipH: false },
      equirect: base,
    };
  }

  // 生成一张“带方向标注的经纬展开样例图”：把正确朝向的六面再合成回去
  function makeSampleEquirect(opts) {
    const size = (opts && opts.size) || 512;
    const width = (opts && opts.width) || 2048;
    const height = width / 2;
    const sample = makeSampleFaces({ size, equirectWidth: width });
    // 用正确朝向（把 0 号面的故意错误去掉）
    const fixed = {};
    for (const f of CubeCore.FACES) {
      fixed[f.id] = {
        tex: sample.faces[f.id].tex,
        rot: 0,
        flipH: false,
      };
    }
    const eq = CubeCore.renderEquirectFromFaces({ width, height, faces: fixed, bilinear: true });
    // 在赤道与两极附近加点文字标记，便于核对方向
    // （与 CubeCore 的经纬约定一致：中心=前面 +Z，向右依次是右面 +X、后面 -Z、左面 -X）
    const p = new Painter(eq.data, width, height);
    const white = [255, 255, 255];
    const yellow = [255, 220, 110];
    p.text(width / 2, height / 2 - 10, 'LON 0  +Z FRONT', 3, yellow, 'center');
    p.text(width * 0.75, height / 2 - 10, 'LON +90  +X RIGHT', 2, white, 'center');
    p.text(width * 0.25, height / 2 - 10, 'LON -90  -X LEFT', 2, white, 'center');
    p.text(width * 0.02, height / 2 - 10, 'LON 180  -Z BACK', 2, white, 'left');
    p.text(width * 0.98, height / 2 - 10, 'LON 180  -Z BACK', 2, white, 'right');
    p.text(width / 2, 22, 'NORTH POLE +Y', 3, yellow, 'center');
    p.text(width / 2, height - 38, 'SOUTH POLE -Y', 3, yellow, 'center');
    return { tex: eq, width, height, faces: sample };
  }

  return {
    FONT,
    textWidth,
    Painter,
    makeBaseEquirect,
    annotateFace,
    makeSampleFaces,
    makeSampleEquirect,
    axisLabel,
    coordLabel,
  };
});
