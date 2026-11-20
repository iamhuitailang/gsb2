/**
 * Procedural sample photographs, generated without any image library.
 *
 * Every scene is rendered per pixel with 2×2 supersampling, then encoded to a
 * real JPEG or PNG (see codecs.js). JPEG samples carry an EXIF orientation tag
 * so the app's upright-display and export paths are exercised with genuinely
 * rotated files.
 *
 * Run `npm run generate:samples` to (re)create the files in `samples/`.
 * Node-only: imports `node:zlib` transitively through codecs.js.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeJpeg, encodePng } from './codecs.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// this file lives in <repo>/src/lib, so the repo root is two levels up
const REPO_ROOT = join(HERE, '..', '..');

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a, b, t) => a + (b - a) * t;

function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

// Scene maths calls this on the order of 10^8 times, so parse each hex once.
const LINEAR_CACHE = new Map();

function hexToLinear(hex) {
  const cached = LINEAR_CACHE.get(hex);
  if (cached) return cached;
  const body = hex.replace('#', '');
  // sRGB hex → linear light, so scene mixing/lighting behaves physically.
  const value = [0, 2, 4].map((offset) => {
    const c = parseInt(body.slice(offset, offset + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  LINEAR_CACHE.set(hex, value);
  return value;
}

/** Linear light → 8-bit sRGB, used once per channel at the end of a pixel. */
function encodeSrgb8(value) {
  const v = clamp01(value);
  const encoded = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.round(clamp01(encoded) * 255);
}

function mixColor(a, b, t) {
  return [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];
}

function hash2(x, y, seed = 0) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 1442695040);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function valueNoise(x, y, seed = 0) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  return mix(
    mix(hash2(xi, yi, seed), hash2(xi + 1, yi, seed), u),
    mix(hash2(xi, yi + 1, seed), hash2(xi + 1, yi + 1, seed), u),
    v
  );
}

function applyVignette(color, u, v, strength) {
  const dx = (u - 0.5) * 1.2;
  const dy = v - 0.5;
  const d = Math.min(1, Math.hypot(dx, dy) / 0.72);
  const k = 1 - strength * d * d;
  return color.map((c) => c * k);
}

const SCENE_DEFS = [
  {
    key: 'citrus',
    label: '柑橘 · 暖色高光',
    file: 'citrus-warm.jpg',
    format: 'jpeg',
    width: 1280,
    height: 880,
    orientation: 1,
    description: '暖色顶光、橙色主体与亮黄高光；白平衡和高光曲线差异明显。',
    render(u, v, rand) {
      const diag = clamp01(0.5 * u + 0.5 * v);
      let color = mixColor(hexToLinear('#fff4d6'), hexToLinear('#c98a3d'), diag * 0.9);
      color = mixColor(color, hexToLinear('#8a5220'), Math.max(0, v - 0.62) * 0.35);

      const tableEdge = 0.63 + 0.02 * u;
      if (v > tableEdge) {
        const depth = smoothstep(tableEdge, 1, v);
        const plank = 0.5 + 0.5 * Math.sin(u * 46 + Math.sin(u * 9) * 2);
        const wood = mixColor(hexToLinear('#9c6a3b'), hexToLinear('#3d2410'), depth * 0.85);
        color = mixColor(wood, hexToLinear('#b98a55'), plank * 0.12);
      }

      const shadow = Math.exp(-(((u - 0.5) / 0.42) ** 2) - (((v - 0.78) / 0.1) ** 2));
      color = mixColor(color, hexToLinear('#2a1608'), shadow * 0.3);

      const oranges = [
        [0.3, 0.66, 0.155, '#f08c24', '#ffd489'],
        [0.53, 0.7, 0.2, '#e97c16', '#ffca6b'],
        [0.77, 0.65, 0.14, '#ffb03a', '#ffe3a1']
      ];
      for (const [cx, cy, r, mid, hi] of oranges) {
        const dx = (u - cx) * (1280 / 880);
        const dy = v - cy;
        const dist = Math.hypot(dx, dy);
        const edge = smoothstep(r, r * 0.985, dist);
        if (edge > 0) {
          const light = clamp01(0.5 - (dx * 0.45 + dy * 0.6) / r);
          let surface = mixColor(hexToLinear(mid), hexToLinear(hi), light ** 1.6);
          surface = mixColor(surface, hexToLinear('#7a3407'), smoothstep(r * 0.8, r, dist) * 0.85);
          const pores = 0.94 + 0.06 * valueNoise(u * 140, v * 140, 9);
          color = mixColor(color, surface.map((c) => c * pores), edge);
        }
      }

      for (const [cx, cy, r] of [
        [0.13, 0.79, 0.1],
        [0.9, 0.82, 0.085]
      ]) {
        const dx = (u - cx) * (1280 / 880);
        const dy = v - cy;
        const dist = Math.hypot(dx, dy);
        const edge = smoothstep(r, r * 0.99, dist);
        if (edge > 0) {
          const angle = Math.atan2(dy, dx);
          const wedge = Math.abs(Math.sin(angle * 4));
          let surface = mixColor(hexToLinear('#f7f2b0'), hexToLinear('#e4d75e'), wedge * 0.7);
          if (dist > r * 0.78) surface = hexToLinear('#fdfbe2');
          else if (dist > r * 0.7) surface = hexToLinear('#fffdf0');
          color = mixColor(color, surface, edge);
        }
      }

      const lx = (u - 0.43) * (1280 / 880) + 0.02;
      const ly = v - 0.43;
      const lr = Math.cos(-0.55) * lx + Math.sin(-0.55) * ly;
      const lq = -Math.sin(-0.55) * lx + Math.cos(-0.55) * ly;
      const leaf = smoothstep(1, 0.92, (lr / 0.11) ** 2 + (lq / 0.04) ** 2);
      if (leaf > 0) {
        const vein = Math.abs(lq) < 0.004;
        const leafColor = mixColor(hexToLinear('#2f6b2c'), hexToLinear('#6aa84f'), clamp01(0.5 - lq * 6));
        color = mixColor(color, leafColor.map((c) => (vein ? c * 1.35 : c)), leaf);
      }

      color = color.map((c) => c * (0.96 + 0.04 * rand()));
      return applyVignette(color, u, v, 0.24).map(clamp01);
    }
  },
  {
    key: 'forest',
    label: '雾林 · 冷色阴影',
    file: 'forest-cool.png',
    format: 'png',
    width: 1200,
    height: 800,
    orientation: 1,
    description: '青蓝色雾气、层叠树影与一点暖色灯笼光；观察冷部曲线与饱和度。',
    render(u, v) {
      const horizon = 0.68;
      let color = mixColor(hexToLinear('#cfe7f2'), hexToLinear('#5f889b'), smoothstep(0, 0.62, v));
      color = mixColor(color, hexToLinear('#1c3338'), smoothstep(0.45, 1, v) * 0.9);

      for (let layer = 3; layer >= 0; layer -= 1) {
        const spacing = 0.16 - layer * 0.022;
        const baseY = horizon + layer * 0.03;
        const fade = 0.16 + layer * 0.14;
        const col = mixColor(hexToLinear('#6f9cab'), hexToLinear('#12292b'), layer / 3);
        const x = u / spacing + layer * 0.37;
        const cell = Math.floor(x);
        const localX = x - cell;
        const height = 0.2 + 0.16 * hash2(cell, layer, 3);
        const tip = baseY - height;
        const halfWidth = 0.5 * (1 - smoothstep(tip, baseY, v));
        if (v > tip && v < baseY + 0.06 && Math.abs(localX - 0.5) < halfWidth) {
          color = mixColor(color, col, fade);
        }
      }

      for (let i = 0; i < 4; i += 1) {
        const beam = Math.exp(-(((u - 0.12 - i * 0.22) + (v - 0.25) * 0.42) / 0.045) ** 2);
        color = color.map((c) => c + beam * 0.1 * (1 - v * 0.4));
      }

      const dx = (u - 0.7) * (1200 / 800);
      const dy = v - 0.52;
      const glow = Math.exp(-((dx * dx + dy * dy) / 0.012));
      color = color.map((c, i) => c + glow * [0.9, 0.46, 0.12][i]);
      if (Math.hypot(dx, dy) < 0.022) color = [1, 0.86, 0.55];

      const fog = Math.exp(-(((v - 0.66) / 0.09) ** 2)) * 0.22;
      color = mixColor(color, hexToLinear('#d7e8ef'), fog);
      return applyVignette(color, u, v, 0.2).map(clamp01);
    }
  },
  {
    key: 'studio',
    label: '产品静物 · 中性灰背景',
    file: 'studio-neutral.jpg',
    format: 'jpeg',
    width: 1080,
    height: 800,
    orientation: 6,
    description: '中性灰背景与蓝色瓶身；文件内含 EXIF 旋转 90°，用于验证方向一致性。',
    render(u, v) {
      let color = mixColor(hexToLinear('#eceae5'), hexToLinear('#a6a49e'), smoothstep(0.05, 0.95, v));
      const key = Math.exp(-((((u - 0.32) / 0.6) ** 2) + (((v - 0.2) / 0.5) ** 2)));
      color = color.map((c) => c + key * 0.12);

      const plinthTop = 0.72;
      if (v > plinthTop && v < 0.9) {
        const spread = 0.32 + (v - plinthTop) * 0.45;
        if (Math.abs(u - 0.5) < spread) {
          const shade = smoothstep(0.9, plinthTop, v);
          color = mixColor(hexToLinear('#8f8c84'), hexToLinear('#c7c4bb'), shade);
        }
      }

      const shadow = Math.exp(-((((u - 0.5) / 0.17) ** 2) + (((v - 0.79) / 0.045) ** 2)));
      color = mixColor(color, hexToLinear('#4a4842'), shadow * 0.32);

      const bodyX = Math.abs(u - 0.5);
      if (v > 0.33 && v < 0.74) {
        const shoulder = smoothstep(0.33, 0.39, v);
        const width = 0.075 + 0.028 * shoulder;
        if (bodyX < width) {
          const across = (u - (0.5 - width)) / (2 * width);
          let glass = mixColor(hexToLinear('#0e2138'), hexToLinear('#3f78b5'), smoothstep(0.1, 0.42, across));
          glass = mixColor(glass, hexToLinear('#081526'), smoothstep(0.62, 0.92, across));
          glass = glass.map((c) => c + Math.exp(-(((across - 0.28) / 0.06) ** 2)) * 0.35);
          color = glass;
        }
      }
      if (u > 0.468 && u < 0.532) {
        if (v > 0.24 && v < 0.34) color = hexToLinear('#0b1a2c');
        if (v > 0.185 && v < 0.245) {
          color = mixColor(hexToLinear('#c9972f'), hexToLinear('#f2c14e'), smoothstep(0.185, 0.245, v));
        }
      }
      if (u > 0.44 && u < 0.56 && v > 0.47 && v < 0.57) {
        color = mixColor(hexToLinear('#f2efe6'), hexToLinear('#d8d3c4'), (v - 0.47) / 0.1);
        if (v > 0.5 && v < 0.545 && u > 0.45 && u < 0.55) color = mixColor(color, hexToLinear('#274a71'), 0.65);
      }

      const chips = ['#c0392b', '#e67e22', '#f1c40f', '#27ae60', '#2980b9', '#8e44ad'];
      if (v > 0.8 && v < 0.87 && u > 0.1 && u < 0.36) {
        const index = Math.floor((u - 0.1) / 0.042);
        if (index >= 0 && index < chips.length) {
          const innerU = (u - 0.1) % 0.042;
          if (innerU > 0.004 && innerU < 0.038) color = hexToLinear(chips[index]);
        }
      }

      return applyVignette(color, u, v, 0.16).map(clamp01);
    }
  },
  {
    key: 'neon',
    label: '夜色霓虹 · 高饱和',
    file: 'neon-night.jpg',
    format: 'jpeg',
    width: 1280,
    height: 800,
    orientation: 8,
    description: '深蓝夜空、霓虹灯与湿街倒影；文件内含 EXIF 旋转 270°，色彩极易观察。',
    render(u, v) {
      let color = mixColor(hexToLinear('#080d20'), hexToLinear('#26103f'), smoothstep(0, 0.7, v));
      color = mixColor(color, hexToLinear('#3a1030'), smoothstep(0.5, 1, v) * 0.55);

      const streetY = 0.71;
      const block = Math.floor(u * 22);
      const bw = 0.02 + hash2(block, 1, 7) * 0.028;
      const center = (block + 0.5) / 22;
      const bh = 0.12 + hash2(block, 2, 7) * 0.24;
      if (v > streetY - bh && v < streetY && Math.abs(u - center) < bw / 2) {
        color = hexToLinear(hash2(block, 3, 7) > 0.5 ? '#101a3a' : '#161f44');
        const gridU = (u - (center - bw / 2)) / (bw / 8);
        const gridV = (v - (streetY - bh)) / 0.038;
        const fx = gridU - Math.floor(gridU);
        const fy = gridV - Math.floor(gridV);
        if (fx > 0.25 && fx < 0.7 && fy > 0.2 && fy < 0.65 && hash2(Math.floor(gridU), Math.floor(gridV), block) > 0.45) {
          color = mixColor(color, hexToLinear('#ffd36e'), 0.85);
        }
      }

      const signs = [
        [0.16, 0.36, 1.0, 0.16, 0.42],
        [0.37, 0.24, 0.1, 0.82, 0.9],
        [0.61, 0.34, 0.66, 0.3, 0.98],
        [0.84, 0.28, 0.98, 0.45, 0.1]
      ];
      for (const [cx, cy, cr, cg, cb] of signs) {
        const dx = (u - cx) * (1280 / 800);
        const dy = v - cy;
        const d = Math.hypot(dx, dy);
        const glow = Math.exp(-((d / 0.13) ** 2));
        color = [color[0] + glow * cr * 0.7, color[1] + glow * cg * 0.7, color[2] + glow * cb * 0.7];
        if (Math.abs(dx) < 0.05 && Math.abs(dy) < 0.032) {
          const border = Math.abs(dx) > 0.042 || Math.abs(dy) > 0.025;
          color = border ? [cr, cg, cb] : mixColor(color, [cr, cg, cb], 0.25);
        }
      }

      if (v > streetY) {
        const depth = (v - streetY) / (1 - streetY);
        color = mixColor(hexToLinear('#1b1233'), hexToLinear('#05060e'), depth);
        for (const [cx, , cr, cg, cb] of signs) {
          const ripple = Math.sin((v - streetY) * 220 + u * 18) * 0.012;
          const refl = Math.exp(-(((u - cx + ripple) / 0.035) ** 2)) * (1 - depth) ** 1.4;
          color = [color[0] + refl * cr * 0.5, color[1] + refl * cg * 0.5, color[2] + refl * cb * 0.5];
        }
      }

      color = color.map((c) => c * 0.98);
      return applyVignette(color, u, v, 0.3).map(clamp01);
    }
  }
];

export function sceneList() {
  return SCENE_DEFS.map((scene) => ({
    key: scene.key,
    label: scene.label,
    file: scene.file,
    format: scene.format,
    width: scene.width,
    height: scene.height,
    orientation: scene.orientation,
    description: scene.description
  }));
}

export function renderScene(key, { width, height } = {}) {
  const scene = SCENE_DEFS.find((entry) => entry.key === key);
  if (!scene) throw new Error(`未知样例场景：${key}`);
  const w = width ?? scene.width;
  const h = height ?? scene.height;
  const rgba = new Uint8Array(w * h * 4);
  const ratios = [0.25, 0.75];
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (const sy of ratios) {
        for (const sx of ratios) {
          const [cr, cg, cb] = scene.render((x + sx) / w, (y + sy) / h, hash2(x * 2 + sx * 3, y * 2 + sy * 5, 11));
          r += cr;
          g += cg;
          b += cb;
        }
      }
      const p = (y * w + x) * 4;
      // Scene colours are linear; encode back to sRGB for the 8-bit buffer.
      rgba[p] = encodeSrgb8(r / 4);
      rgba[p + 1] = encodeSrgb8(g / 4);
      rgba[p + 2] = encodeSrgb8(b / 4);
      rgba[p + 3] = 255;
    }
  }
  return { rgba, width: w, height: h };
}

export async function writeAllSamples(outDir = join(REPO_ROOT, 'samples')) {
  await mkdir(outDir, { recursive: true });
  const results = [];
  for (const scene of SCENE_DEFS) {
    const { rgba, width, height } = renderScene(scene.key);
    let format = scene.format;
    let bytes;
    if (scene.format === 'png') {
      bytes = encodePng(rgba, { width, height });
    } else {
      try {
        bytes = encodeJpeg(rgba, { width, height, quality: 90, orientation: scene.orientation });
      } catch (error) {
        // The demo must not become unusable because of one encoder edge case:
        // fall back to PNG (lossless, no Huffman tables) and say so.
        console.warn(`[samples] ${scene.file} 的 JPEG 编码失败，改用 PNG：${error.message}`);
        format = 'png';
        bytes = encodePng(rgba, { width, height });
      }
    }
    const file = format === scene.format ? scene.file : scene.file.replace(/\.[^.]+$/, '.png');
    const path = join(outDir, file);
    await writeFile(path, bytes);
    results.push({
      key: scene.key,
      label: scene.label,
      description: scene.description,
      file,
      format,
      bytes: bytes.length,
      width,
      height,
      orientation: format === 'jpeg' ? scene.orientation : 1
    });
  }
  await writeFile(join(outDir, 'manifest.json'), `${JSON.stringify(results, null, 2)}\n`);
  return results;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const outDir = process.argv[2] ? join(process.cwd(), process.argv[2]) : undefined;
  const results = await writeAllSamples(outDir);
  for (const result of results) {
    console.log(
      `${result.file}  ${result.width}×${result.height}  ${(result.bytes / 1024).toFixed(0)} KB  EXIF=${result.orientation}`
    );
  }
}
