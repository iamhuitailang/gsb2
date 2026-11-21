/**
 * 程序化示例素材（纯像素数据，不依赖 DOM、fs 或 canvas）。
 *
 * 同一份定义同时被三个地方使用：
 *   - scripts/generate-samples.mjs 写出 PNG 文件；
 *   - scripts/server.mjs 启动时若发现缺失就自动生成；
 *   - 浏览器在 fetch 不到示例文件时现场构建，保证界面里总有样图可点。
 */

function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

function makeCanvas(width, height) {
  return { width, height, rgba: new Uint8ClampedArray(width * height * 4) };
}

function setPixel(img, x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const i = (y * img.width + x) * 4;
  img.rgba[i] = r;
  img.rgba[i + 1] = g;
  img.rgba[i + 2] = b;
  img.rgba[i + 3] = a;
}

function blendPixel(img, x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  if (a <= 0) return;
  const i = (y * img.width + x) * 4;
  const srcA = a / 255;
  const dstA = img.rgba[i + 3] / 255;
  const outA = srcA + dstA * (1 - srcA);
  if (outA <= 0) return;
  img.rgba[i] = Math.round((r * srcA + img.rgba[i] * dstA * (1 - srcA)) / outA);
  img.rgba[i + 1] = Math.round((g * srcA + img.rgba[i + 1] * dstA * (1 - srcA)) / outA);
  img.rgba[i + 2] = Math.round((b * srcA + img.rgba[i + 2] * dstA * (1 - srcA)) / outA);
  img.rgba[i + 3] = Math.round(outA * 255);
}

function drawLine(img, x0, y0, x1, y1, r, g, b) {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  for (let i = 0; i <= steps; i++) {
    const t = steps === 0 ? 0 : i / steps;
    setPixel(img, Math.round(x0 + (x1 - x0) * t), Math.round(y0 + (y1 - y0) * t), r, g, b, 255);
  }
}

/* ------------------------------------------------------------------ */
/* 1. 连续渐变                                                          */
/* ------------------------------------------------------------------ */

export function buildGradient() {
  const img = makeCanvas(360, 240);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const hue = (x / img.width) * 330 + 10;
      const lightness = 0.16 + 0.68 * (1 - y / img.height);
      const saturation = 0.28 + 0.55 * (0.5 + 0.5 * Math.sin((x / img.width) * Math.PI));
      const [r, g, b] = hslToRgb(hue, saturation, lightness);
      setPixel(img, x, y, r, g, b, 255);
    }
  }
  // 右上角柔和光斑
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const dx = (x - img.width * 0.78) / (img.width * 0.3);
      const dy = (y - img.height * 0.24) / (img.height * 0.34);
      const d = Math.hypot(dx, dy);
      if (d < 1) {
        const alpha = Math.round(255 * (1 - d) ** 2.2 * 0.85);
        blendPixel(img, x, y, 255, 246, 214, alpha);
      }
    }
  }
  return img;
}

/* ------------------------------------------------------------------ */
/* 2. 细线                                                              */
/* ------------------------------------------------------------------ */

export function buildThinLines() {
  const img = makeCanvas(300, 300);
  // 1px 水平线
  for (let y = 18; y < img.height; y += 28) {
    const [r, g, b] = hslToRgb(200 + 120 * (y / img.height), 0.75, 0.5);
    drawLine(img, 12, y, img.width - 12, y, r, g, b);
  }
  // 1px 竖直线
  for (let x = 22; x < img.width; x += 34) {
    const [r, g, b] = hslToRgb(20 + x, 0.7, 0.45);
    drawLine(img, x, 12, x, img.height - 12, r, g, b);
  }
  // 对角线
  drawLine(img, 18, 18, img.width - 18, img.height - 18, 250, 250, 250);
  drawLine(img, img.width - 18, 18, 18, img.height - 18, 10, 10, 10);
  // 虚线
  for (let x = 30; x < img.width - 20; x += 12) {
    setPixel(img, x, 60, 255, 210, 40, 255);
    setPixel(img, x, 61, 255, 210, 40, 255);
  }
  // 点线
  for (let x = 30; x < img.width - 20; x += 6) {
    setPixel(img, x, 105, 120, 220, 255, 255);
  }
  // 同心细线
  const cx = img.width * 0.72;
  const cy = img.height * 0.72;
  for (let radius = 8; radius < 70; radius += 7) {
    const steps = Math.ceil(2 * Math.PI * radius);
    for (let i = 0; i < steps; i++) {
      const angle = (i / steps) * Math.PI * 2;
      setPixel(
        img,
        Math.round(cx + Math.cos(angle) * radius),
        Math.round(cy + Math.sin(angle) * radius),
        255,
        255,
        255,
        255,
      );
    }
  }
  return img;
}

/* ------------------------------------------------------------------ */
/* 3. 透明边缘                                                          */
/* ------------------------------------------------------------------ */

export function buildTransparentEdge() {
  const img = makeCanvas(320, 320);

  const drawDisc = (cx, cy, radius, hue, alphaScale = 1) => {
    for (let y = Math.floor(cy - radius - 1); y <= cy + radius + 1; y++) {
      for (let x = Math.floor(cx - radius - 1); x <= cx + radius + 1; x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        const coverage = Math.max(0, Math.min(1, radius + 0.5 - d));
        if (coverage <= 0) continue;
        const t = (x - (cx - radius)) / (radius * 2);
        const [r, g, b] = hslToRgb(hue + t * 40, 0.72, 0.32 + 0.3 * t);
        blendPixel(img, x, y, r, g, b, Math.round(255 * coverage * alphaScale));
      }
    }
  };

  const drawRing = (cx, cy, inner, outer, rgb, alpha) => {
    for (let y = Math.floor(cy - outer - 1); y <= cy + outer + 1; y++) {
      for (let x = Math.floor(cx - outer - 1); x <= cx + outer + 1; x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        if (d < inner || d > outer + 0.5) continue;
        const coverage = Math.min(1, outer + 0.5 - d);
        const innerFade = Math.min(1, d - inner + 0.5);
        blendPixel(img, x, y, rgb[0], rgb[1], rgb[2], Math.round(alpha * coverage * innerFade));
      }
    }
  };

  const drawStar = (cx, cy, outer, inner, points, hue) => {
    const poly = [];
    for (let i = 0; i < points * 2; i++) {
      const r = i % 2 === 0 ? outer : inner;
      const angle = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2;
      poly.push([cx + Math.cos(angle) * r, cy + Math.sin(angle) * r]);
    }
    const inside = (px, py) => {
      let hit = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i];
        const [xj, yj] = poly[j];
        if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) hit = !hit;
      }
      return hit;
    };
    for (let y = Math.floor(cy - outer - 2); y <= cy + outer + 2; y++) {
      for (let x = Math.floor(cx - outer - 2); x <= cx + outer + 2; x++) {
        if (!inside(x + 0.5, y + 0.5)) continue;
        const [r, g, b] = hslToRgb(hue + (y - cy) * 0.6, 0.8, 0.52);
        setPixel(img, x, y, r, g, b, 255);
      }
    }
    // 1px 轮廓
    for (let y = Math.floor(cy - outer - 2); y <= cy + outer + 2; y++) {
      for (let x = Math.floor(cx - outer - 2); x <= cx + outer + 2; x++) {
        if (inside(x + 0.5, y + 0.5)) continue;
        const near =
          inside(x + 1.5, y + 0.5) ||
          inside(x - 0.5, y + 0.5) ||
          inside(x + 0.5, y + 1.5) ||
          inside(x + 0.5, y - 0.5);
        if (near) setPixel(img, x, y, 18, 14, 30, 255);
      }
    }
  };

  drawDisc(96, 104, 66, 196, 1);
  drawDisc(228, 108, 46, 30, 0.72);
  drawRing(96, 104, 74, 80, [40, 220, 190], 0.9);
  drawRing(228, 108, 54, 60, [255, 250, 235], 0.55);
  drawStar(160, 238, 52, 22, 5, 48);

  // 右下角的硬边色块，紧邻透明区，用来观察误差扩散是否渗漏
  for (let y = 196; y < 292; y++) {
    for (let x = 232; x < 300; x++) {
      const t = (x - 232) / 68;
      const [r, g, b] = hslToRgb(140 + t * 80, 0.55, 0.28 + t * 0.4);
      setPixel(img, x, y, r, g, b, 255);
    }
  }
  return img;
}

/* ------------------------------------------------------------------ */
/* 4. 像素风角色                                                        */
/* ------------------------------------------------------------------ */

export function buildPixelSprite() {
  const cell = 4;
  const img = makeCanvas(32 * cell, 32 * cell);
  const palette = {
    o: [24, 20, 37, 255],
    h: [56, 34, 28, 255],
    H: [110, 68, 44, 255],
    s: [244, 196, 154, 255],
    M: [212, 155, 115, 255],
    e: [20, 20, 28, 255],
    w: [250, 250, 250, 255],
    C: [58, 128, 190, 255],
    c: [39, 84, 132, 255],
    P: [58, 56, 84, 255],
    B: [40, 34, 30, 255],
  };
  const sprite = [
    '................................',
    '............oooooooo............',
    '..........oohhhhhhhhoo..........',
    '.........ohhhhHHHHhhhho.........',
    '........ohhhHHHHHHHHhhho........',
    '........ohhHHHHHHHHHHhho........',
    '.......ohhHHHHHHHHHHHHhho.......',
    '.......ohhHHssssssssHHhho.......',
    '.......ohhHssssssssssHhho.......',
    '.......ohssssssssssssssho.......',
    '.......ohsssseessseesssho.......',
    '.......ohsssseessseesssho.......',
    '.......ohssssssssssssssho.......',
    '........ohsssssMMsssssho........',
    '.........ohssssssssssho.........',
    '..........oossssssssoo..........',
    '...........oossssssoo...........',
    '.........ooooCCCCCCoooo.........',
    '.......ooCCCCCCCCCCCCCCoo.......',
    '......oCCCCCCCCCCCCCCCCCCo......',
    '.....oCCCCCwwCCCCCCwwCCCCCo.....',
    '.....oCCCCCwwCCCCCCwwCCCCCo.....',
    '.....oCCCCCCCCCCCCCCCCCCCCo.....',
    '.....oCCCCCCCCCCCCCCCCCCCCo.....',
    '.....oCCCCCCCCCCCCCCCCCCCCo.....',
    '......oCCCCCCCCCCCCCCCCCCo......',
    '.......ooCCCCCCCCCCCCCCoo.......',
    '.........ooCCCCCCCCCCoo.........',
    '..........oPPPPPPPPPPo..........',
    '..........oPPPoooPPPo...........',
    '..........oBBBooBBBBo...........',
    '..........oooooooooooo..........',
  ];
  for (let y = 0; y < 32; y++) {
    const row = sprite[y] || '';
    for (let x = 0; x < 32; x++) {
      const color = palette[row[x]];
      if (!color) continue;
      for (let dy = 0; dy < cell; dy++) {
        for (let dx = 0; dx < cell; dx++) {
          setPixel(img, x * cell + dx, y * cell + dy, color[0], color[1], color[2], color[3]);
        }
      }
    }
  }
  return img;
}
/* ------------------------------------------------------------------ */

export const SAMPLE_DEFINITIONS = [
  {
    file: 'gradient.png',
    name: '渐变',
    description: '连续色相与明度渐变加柔光，观察色带与抖动强度。',
    recommended: { colorCount: 16, dither: 'floyd-steinberg' },
    build: buildGradient,
  },
  {
    file: 'thin-lines.png',
    name: '细线',
    description: '1px 横竖斜线、虚线、点线与同心圆，检查细线在减色后的完整度。',
    recommended: { colorCount: 8, dither: 'none' },
    build: buildThinLines,
  },
  {
    file: 'transparent-edge.png',
    name: '透明边缘',
    description: '抗锯齿圆盘、半透明环、星形描边和硬边色块，验证透明像素不被背景色污染。',
    recommended: { colorCount: 12, dither: 'atkinson' },
    build: buildTransparentEdge,
  },
  {
    file: 'pixel-sprite.png',
    name: '像素风角色',
    description: '4× 整数放大的手绘像素图，检查调色板是否稳定、色块是否干净。',
    recommended: { colorCount: 12, dither: 'none' },
    build: buildPixelSprite,
  },
];

/** 返回 manifest（不含函数），与 samples.json 的结构一致。 */
export function sampleManifest() {
  return {
    generatedAt: new Date().toISOString(),
    samples: SAMPLE_DEFINITIONS.map(({ file, name, description, recommended }) => ({
      file,
      name,
      description,
      recommended,
    })),
  };
}

/** 现场构建全部示例图。 */
export function buildAllSamples() {
  return SAMPLE_DEFINITIONS.map((def) => ({
    file: def.file,
    name: def.name,
    description: def.description,
    recommended: def.recommended,
    image: def.build(),
  }));
}
