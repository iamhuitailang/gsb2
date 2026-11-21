/**
 * Sample scenes for the workbench. Each scene is drawn in fixed "design
 * units"; a version renders those units at its own pixel scale so the pair
 * ends up at different sizes (e.g. 960×1280 vs 1080×1440).
 *
 * Every scene includes corner registration rings, which double as natural
 * targets for the corner-assisted alignment tool.
 */
import { Raster, Painter } from './raster.mjs';

const SUPERSAMPLE = 2;

export const SCENES = [
  {
    id: 'verdant-launch',
    title: 'Verdant · 启动页',
    description:
      '移动端启动页，B 版本整体放大了 12.5%（960×1280 → 1080×1440），并按 1.125× 重新导出。修改集中在副标题、主按钮与右上角的新徽标。',
    design: { width: 480, height: 640 },
    a: { width: 960, height: 1280, version: 'v1.4 · 2026-03-02' },
    b: { width: 1080, height: 1440, version: 'v1.5 · 2026-03-18' },
    changes: [
      '副标题 GROW SLOWLY → GROW STEADILY',
      '主按钮颜色 琥珀色 → 薄荷绿，文案 START → BEGIN',
      '右上角新增 NEW 圆形徽标',
      '左下角版本标记 REV 01 → REV 02',
    ],
    draw: drawVerdant,
  },
  {
    id: 'alpine-package',
    title: 'Alpine Roast · 包装正面',
    description:
      '咖啡包装正面标签，B 版本按 0.9× 缩小（1200×900 → 1080×810）。批次号、印章位置和一条色带颜色发生变化。',
    design: { width: 600, height: 450 },
    a: { width: 1200, height: 900, version: '印刷稿 v3' },
    b: { width: 1080, height: 810, version: '印刷稿 v4' },
    changes: [
      '批次号 LOT 0421 → LOT 0427',
      '圆形验收印章位置左移并改为深绿',
      '第二条色带 陶土红 → 焦橙',
      '左下角版次标记 03 → 04',
    ],
    draw: drawPackage,
  },
  {
    id: 'spring-poster',
    title: 'Spring Sounds · 活动海报',
    description:
      '活动海报，B 版本导出尺寸略大（760×1000 → 820×1080）且内容整体轻微偏移，适合先手动配准再微调。主标题、图块与页脚编号有改动。',
    design: { width: 380, height: 500 },
    a: { width: 760, height: 1000, version: '校样 A' },
    b: { width: 820, height: 1080, version: '校样 B' },
    offset: { x: 9, y: -7 },
    changes: [
      '主标题 SOUNDS → SIGNALS',
      '第一幅图块的底色 赭黄 → 玫红',
      '页脚期号 03 → 04',
      '右下角新增一条斜向装饰线',
    ],
    draw: drawPoster,
  },
];

export function renderSceneVersion(scene, version) {
  const spec = version === 'a' ? scene.a : scene.b;
  const designScale = spec.width / scene.design.width;
  const pixelScale = designScale * SUPERSAMPLE;
  const raster = new Raster(
    spec.width * SUPERSAMPLE,
    spec.height * SUPERSAMPLE,
  );
  const painter = new Painter(raster, pixelScale);
  const offset = version === 'b' ? scene.offset || { x: 0, y: 0 } : { x: 0, y: 0 };
  scene.draw(painter, {
    version,
    scene,
    offset,
    width: scene.design.width,
    height: scene.design.height,
  });
  const out = raster.downsample(SUPERSAMPLE);
  return out;
}

/** Alignment that maps B pixels into A pixels for this scene. */
export function sceneAlignment(scene) {
  const aScale = scene.a.width / scene.design.width;
  const bScale = scene.b.width / scene.design.width;
  const offset = scene.offset || { x: 0, y: 0 };
  // world = R·s·b + t, world and b in pixels. Content at design point (u, v)
  // sits at v*bScale in B and v*aScale in A, so:
  //   scale = aScale / bScale, tx = -offset.u * bScale * scale
  const scale = aScale / bScale;
  return {
    scale,
    rotation: 0,
    tx: -offset.x * bScale * scale,
    ty: -offset.y * bScale * scale,
  };
}

/** Corner pairs in design units, converted to A/B pixel coordinates. */
export function sceneCornerPoints(scene) {
  const aScale = scene.a.width / scene.design.width;
  const bScale = scene.b.width / scene.design.width;
  const { width, height } = scene.design;
  const offset = scene.offset || { x: 0, y: 0 };
  const inset = 26;
  const corners = [
    { u: inset, v: inset },
    { u: width - inset, v: inset },
    { u: width - inset, v: height - inset },
    { u: inset, v: height - inset },
  ];
  return corners.map((c, i) => ({
    id: `corner-${i + 1}`,
    ax: round(c.u * aScale),
    ay: round(c.v * aScale),
    bx: round((c.u + offset.x) * bScale),
    by: round((c.v + offset.y) * bScale),
  }));
}

function round(v) {
  return Math.round(v * 100) / 100;
}

/* ------------------------------------------------------------------ scenes */

function registrationMarks(
  p,
  width,
  height,
  ins,
  dx = 0,
  dy = 0,
  color = 'rgba(255,255,255,0.38)',
) {
  const marks = [
    [ins + dx, ins + dy],
    [width - ins + dx, ins + dy],
    [width - ins + dx, height - ins + dy],
    [ins + dx, height - ins + dy],
  ];
  for (const [x, y] of marks) {
    p.ring(x, y, 9, 1.2, color);
    p.line(x - 13, y, x - 4, y, 0.8, color);
    p.line(x + 4, y, x + 13, y, 0.8, color);
    p.line(x, y - 13, x, y - 4, 0.8, color);
    p.line(x, y + 4, x, y + 13, 0.8, color);
  }
}

function drawVerdant(p, { version, width, height }) {
  const isB = version === 'b';
  p.gradient(0, 0, width, height, [
    [0, '#0e2a22'],
    [0.55, '#0a1d18'],
    [1, '#06110e'],
  ]);
  p.glow(330, 150, 250, '#1c6b4d');
  p.glow(90, 520, 210, '#0f3b2d');

  // faint dotted grid
  for (let y = 80; y < height - 40; y += 32) {
    for (let x = 24; x < width; x += 32) {
      p.circle(x, y, 0.7, 'rgba(255,255,255,0.06)');
    }
  }

  registrationMarks(p, width, height, 26);

  p.text('VERDANT', 48, 56, 7, '#f2efe4', 2);
  p.fillRect(48, 96, 32, 2, '#7ee2b0');
  p.text(isB ? 'GROW STEADILY' : 'GROW SLOWLY', 48, 110, 3, 'rgba(242,239,228,0.62)', 1.4);

  // hero leaf motif
  const cx = 240;
  const cy = 250;
  p.ring(cx, cy, 112, 1.2, 'rgba(126,226,176,0.5)');
  p.ring(cx, cy, 88, 0.7, 'rgba(126,226,176,0.18)');
  p.circle(cx, cy, 66, '#123b2c');
  p.gradient(cx - 60, cy - 60, 120, 120, [
    [0, 'rgba(76,180,132,0.55)'],
    [1, 'rgba(13,45,33,0.1)'],
  ]);
  p.line(cx - 2, cy + 58, cx + 6, cy - 46, 2.2, '#8fe9bb');
  for (let i = 0; i < 5; i++) {
    const t = i / 4;
    const y = cy + 44 - t * 88;
    const x = cx + 4 - t * 4;
    const r = 26 - i * 3.4;
    p.circle(x - r * 0.62, y, r * 0.62, 'rgba(94,203,150,0.85)');
    p.circle(x + r * 0.62, y - 2, r * 0.52, 'rgba(56,150,110,0.9)');
  }
  p.circle(cx + 6, cy - 47, 3, '#c8f7dc');

  if (isB) {
    p.circle(402, 138, 24, '#ff6b57');
    p.text('NEW', 390, 135, 2.2, '#3a0d07', 0.6);
    p.ring(402, 138, 28, 0.8, 'rgba(255,107,87,0.35)');
  }

  // stat pills
  const stats = [
    ['42%', 'FOCUS'],
    ['18H', 'QUIET'],
    [isB ? '8D' : '7D', 'STREAK'],
  ];
  stats.forEach(([value, label], i) => {
    const x = 48 + i * 140;
    const y = 404;
    p.fillRoundRect(x, y, 122, 44, 10, 'rgba(255,255,255,0.04)');
    p.strokeRoundRect(x, y, 122, 44, 10, 0.8, 'rgba(126,226,176,0.22)');
    p.text(value, x + 12, y + 10, 4.4, '#e9f6ee', 0.8);
    p.text(label, x + 12, y + 32, 1.8, 'rgba(233,246,238,0.45)', 0.8);
  });

  // bottom card
  p.fillRoundRect(40, 474, 400, 124, 16, '#0f2a20');
  p.strokeRoundRect(40, 474, 400, 124, 16, 1, 'rgba(126,226,176,0.28)');
  p.text('YOUR FOREST IS READY', 60, 494, 3.2, '#f2efe4', 1.1);
  p.text('4 MIN OF QUIET PER DAY', 60, 516, 2, 'rgba(242,239,228,0.42)', 0.9);

  p.fillRoundRect(60, 544, 168, 36, 18, isB ? '#57d6a9' : '#e8b04b');
  p.text(isB ? 'BEGIN' : 'START', 88, 557, 2.8, '#0b1c15', 1.1);
  p.strokeRoundRect(244, 544, 168, 36, 18, 1, 'rgba(242,239,228,0.35)');
  p.text('LEARN MORE', 266, 557, 2.4, 'rgba(242,239,228,0.78)', 0.9);

  p.text(isB ? 'REV 02' : 'REV 01', 48, 616, 1.8, 'rgba(242,239,228,0.3)', 0.8);
}

function drawPackage(p, { version }) {
  const isB = version === 'b';
  p.fillRect(0, 0, 600, 450, '#d8c7a6');
  p.fillRect(0, 0, 600, 450, 'rgba(255,255,255,0.02)');
  // kraft texture: deterministic speckles
  const rand = mulberry(11);
  for (let i = 0; i < 900; i++) {
    const x = rand() * 600;
    const y = rand() * 450;
    p.circle(x, y, 0.5 + rand() * 0.9, rand() > 0.5 ? 'rgba(120,95,58,0.10)' : 'rgba(255,250,235,0.16)');
  }
  p.fillRect(0, 0, 66, 450, '#22303a');
  p.text('A', 24, 30, 2.6, '#d8c7a6', 1);
  p.text('R', 24, 50, 2.6, '#d8c7a6', 1);
  p.text('0', 24, 70, 2.6, '#d8c7a6', 1);
  p.text('4', 24, 90, 2.6, '#d8c7a6', 1);
  p.line(24, 118, 42, 118, 0.8, 'rgba(216,199,166,0.5)');

  const px = 108;
  const py = 56;
  const pw = 388;
  const ph = 310;
  p.fillRoundRect(px, py, pw, ph, 8, '#f7f1e3');
  p.strokeRoundRect(px, py, pw, ph, 8, 1, 'rgba(90,66,38,0.35)');
  registrationMarks(p, 600, 450, 26, 0, 0, 'rgba(90,66,38,0.55)');

  p.text('ALPINE', px + 32, py + 34, 6.4, '#2f3a33', 1.6);
  p.text('ROAST', px + 32, py + 76, 6.4, '#2f3a33', 1.6);
  p.text('SINGLE ORIGIN · 250 G', px + 32, py + 120, 2.2, '#8a6d4c', 1);

  // mountain mark
  const mx = px + 300;
  const my = py + 84;
  p.circle(mx, my, 42, 'rgba(47,107,94,0.12)');
  p.triangle(mx - 40, my + 28, mx, my - 30, mx + 40, my + 28, '#2f6b5e');
  p.triangle(mx - 12, my + 28, mx + 14, my - 6, mx + 40, my + 28, '#d8c7a6');
  p.circle(mx + 18, my - 12, 5, '#f2c26a');

  const swatches = [
    ['#c25b3c', isB ? '#d9762f' : '#c25b3c'],
    ['#2f6b5e', '#2f6b5e'],
    ['#d9b25a', '#d9b25a'],
    ['#2f3a33', '#2f3a33'],
  ];
  swatches.forEach(([orig, changed], i) => {
    const x = px + 32 + i * 44;
    p.fillRoundRect(x, py + 154, 34, 34, 5, changed || orig);
    p.text(`0${i + 1}`, x + 2, py + 194, 1.6, '#8a6d4c', 0.6);
  });

  p.text('ROAST LEVEL', px + 32, py + 218, 1.8, '#8a6d4c', 0.8);
  p.line(px + 32, py + 232, px + 220, py + 232, 2.4, '#e5dcc6');
  p.line(px + 32, py + 232, px + 166, py + 232, 2.4, '#2f6b5e');

  p.text(isB ? 'LOT 0427' : 'LOT 0421', px + 32, py + 254, 2.4, '#2f3a33', 1.2);
  p.text('ROASTED 2026-03-08', px + 32, py + 274, 1.7, '#8a6d4c', 0.8);

  // barcode
  const barcode = [2, 1, 3, 1, 1, 4, 1, 2, 1, 1, 3, 2, 1, 1, 4, 1, 2, 3, 1, 1];
  let bx = px + 250;
  for (let i = 0; i < barcode.length; i++) {
    const w = barcode[i];
    if (i % 2 === 0) p.fillRect(bx, py + 246, w, 34, '#2f3a33');
    bx += w + 2;
  }
  p.text('8 901234 567890', px + 250, py + 286, 1.5, '#8a6d4c', 0.5);

  p.text(isB ? 'V04' : 'V03', 30, 418, 1.8, 'rgba(216,199,166,0.55)', 0.7);
  p.text('STORE IN A COOL DRY PLACE', 108, 408, 1.7, 'rgba(90,66,38,0.55)', 0.8);

  // circular approval stamp
  const sx = isB ? 262 : 292;
  const sy = isB ? 300 : 288;
  p.ring(sx, sy, 34, 1.4, isB ? 'rgba(47,107,94,0.75)' : 'rgba(194,91,60,0.7)');
  p.ring(sx, sy, 27, 0.7, isB ? 'rgba(47,107,94,0.5)' : 'rgba(194,91,60,0.45)');
  p.text('OK', sx - 11, sy - 7, 3.2, isB ? '#2f6b5e' : '#c25b3c', 0.8);
  p.text(isB ? '03/26' : '02/26', sx - 18, sy + 10, 1.5, isB ? '#2f6b5e' : '#c25b3c', 0.5);
}

function drawPoster(p, { version, width, height, offset }) {
  const isB = version === 'b';
  const dx = offset.x;
  const dy = offset.y;
  // All content is inside a 380x500 safe area and every element moves with
  // (dx, dy), so B is a genuinely translated copy of A.
  p.fillRect(0, 0, width, height, '#eee7d8');
  p.gradient(0, 0, width, height, [
    [0, 'rgba(255,255,255,0.28)'],
    [1, 'rgba(206,193,166,0.18)'],
  ]);

  // Top-right concentric mark.
  p.circle(318 + dx, 60 + dy, 56, '#1c2a26');
  p.circle(318 + dx, 60 + dy, 43, '#eee7d8');
  p.circle(318 + dx, 60 + dy, 26, '#c4553f');
  p.circle(318 + dx, 60 + dy, 11, '#eee7d8');

  p.text('SPRING', 34 + dx, 120 + dy, 10, '#1c2a26', 1.4);
  p.text(isB ? 'SIGNALS' : 'SOUNDS', 34 + dx, 176 + dy, 10, '#c4553f', 1.4);
  p.fillRect(34 + dx, 238 + dy, 150, 3, '#1c2a26');

  p.text('TWO NIGHTS · LIVE SESSIONS', 34 + dx, 252 + dy, 2, '#4a5148', 0.8);
  p.text('APRIL 12—13 · RIVERSIDE HALL', 34 + dx, 266 + dy, 2, '#4a5148', 0.8);

  const rand = mulberry(31);
  for (let i = 0; i < 3; i++) {
    const w = 140 + rand() * 110;
    p.fillRect(34 + dx, 284 + dy + i * 10, w, 3, 'rgba(28,42,38,0.22)');
  }

  const tiles = [
    { x: 34, y: 330, w: 150, h: 78, color: isB ? '#b04a63' : '#c99a3f', label: '01' },
    { x: 196, y: 330, w: 150, h: 78, color: '#3d5a50', label: '02' },
    { x: 34, y: 414, w: 312, h: 38, color: '#202a26', label: '03' },
  ];
  tiles.forEach((t) => {
    p.fillRect(t.x + dx, t.y + dy, t.w, t.h, t.color);
    p.circle(t.x + dx + t.w - 16, t.y + dy + 16, 5, 'rgba(238,231,216,0.8)');
    p.text(t.label, t.x + dx + 10, t.y + dy + t.h - 14, 1.9, 'rgba(238,231,216,0.85)', 0.7);
  });

  // Footer band spans the full canvas; it shifts too so B is a translation.
  p.fillRect(-20 + dx, height - 40 + dy, width + 40, 40, '#1c2a26');
  p.text(isB ? 'NO. 04 — APRIL' : 'NO. 03 — APRIL', 20 + dx, height - 28 + dy, 2.1, '#eee7d8', 1);
  p.text('SPRING SOUNDS', width - 132 + dx, height - 28 + dy, 1.9, 'rgba(238,231,216,0.55)', 0.8);

  if (isB) {
    p.line(296 + dx, 300 + dy, 326 + dx, 262 + dy, 2, '#c4553f');
    p.circle(326 + dx, 262 + dy, 3.5, '#c4553f');
  }

  // Drawn last so the footer band cannot hide the bottom registration marks.
  // The teal tone reads on both the beige paper and the dark footer.
  registrationMarks(p, width, height, 26, dx, dy, 'rgba(74,150,128,0.9)');
}

function mulberry(seed) {
  let a = seed >>> 0;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
