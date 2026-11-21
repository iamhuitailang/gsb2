/**
 * 生成光栅版样例素材（PNG / TGA）。
 * 运行：npm run generate:samples
 *
 * 仓库内 `samples/` 已经带有可直接使用的 SVG 样例与 demo-project.json；
 * 本脚本额外生成同一套图案的 PNG/TGA 版本，用于：
 *   - 验证自带的 PNG / TGA 编解码器
 *   - 无头导出 CLI（scripts/export.mjs）
 *
 * 默认输出到 samples/raster/，不会覆盖手写演示工程与 SVG 样例。
 *   samples/raster/materials/brick_wall/   — 颜色、法线、粗糙度、金属度、AO（尺寸不一致）、高度
 *   samples/raster/materials/metal_plate/  — 含 TGA 法线、8 位灰度 TGA 高度
 *   samples/raster/materials/wood_floor/   — 用于演示批量导出同名不覆盖
 *   samples/raster/materials/damaged_panel/— 含损坏 TGA，演示失败项与原因
 *   samples/raster/reference/              — 颜色色卡、法线参考球、灰阶阶梯
 *   samples/raster-project.json            — 指向 PNG/TGA 的演示工程（可用 CLI 导出）
 *
 * 传 `--legacy` 则输出到旧的 samples/materials 与 samples/demo-project.json（会覆盖手写工程，谨慎使用）。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { encodePng } from "../src/lib/png.js";
import {
  createMaterial,
  createOutput,
  emptyChannel,
  serializeProject,
} from "../src/lib/project.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LEGACY = process.argv.includes("--legacy");
const SAMPLES = LEGACY ? join(ROOT, "samples") : join(ROOT, "samples", "raster");
const PROJECT_FILE = LEGACY ? "demo-project.json" : "raster-project.json";

/* ----------------------------- 数学工具 ----------------------------- */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const smooth = (t) => t * t * (3 - 2 * t);
const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const mix = (a, b, t) => a.map((v, i) => Math.round(lerp(v, b[i], t)));

function valueNoise(seed) {
  const rand = mulberry32(seed);
  const size = 256;
  const grid = new Float32Array(size * size);
  for (let i = 0; i < grid.length; i++) grid[i] = rand();
  return function noise(x, y) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = smooth(x - xi);
    const yf = smooth(y - yi);
    const wrap = (n) => ((n % size) + size) % size;
    const x0 = wrap(xi);
    const y0 = wrap(yi);
    const x1 = wrap(xi + 1);
    const y1 = wrap(yi + 1);
    const v00 = grid[y0 * size + x0];
    const v10 = grid[y0 * size + x1];
    const v01 = grid[y1 * size + x0];
    const v11 = grid[y1 * size + x1];
    return lerp(lerp(v00, v10, xf), lerp(v01, v11, xf), yf);
  };
}

function fbm(noise, x, y, octaves = 4) {
  let value = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    value += amp * noise(x * freq, y * freq);
    norm += amp;
    freq *= 2;
    amp *= 0.5;
  }
  return value / norm;
}

/* ----------------------------- 图案生成 ----------------------------- */

function brickPattern(width, height, opts = {}) {
  const rows = opts.rows || 8;
  const cols = opts.cols || 4;
  const mortar = opts.mortar || 0.045;
  const brickH = height / rows;
  const brickW = width / cols;
  const noise = valueNoise(9137);
  const heightMap = new Float32Array(width * height);
  const mortarMap = new Float32Array(width * height);
  const idMap = new Float32Array(width * height);
  const rand = mulberry32(4242);
  const ids = new Float32Array(rows * cols).map(() => rand());

  for (let y = 0; y < height; y++) {
    const row = Math.floor(y / brickH);
    const offset = row % 2 ? brickW / 2 : 0;
    for (let x = 0; x < width; x++) {
      const xs = (x + offset) % width;
      const col = Math.floor(xs / brickW);
      const lx = (xs % brickW) / brickW;
      const ly = (y % brickH) / brickH;
      const edge = Math.min(lx, 1 - lx, ly, 1 - ly);
      const gap = edge < mortar ? 1 : 0;
      const i = y * width + x;
      mortarMap[i] = gap;
      idMap[i] = ids[(row % rows) * cols + (col % cols)];
      const bump = (1 - gap) * (0.72 + 0.28 * (1 - Math.max(0, (edge - mortar) / 0.12)));
      const surface = fbm(noise, x / 26, y / 26, 4) * 0.34;
      heightMap[i] = clamp01(bump * 0.8 + surface);
    }
  }
  return { heightMap, mortarMap, idMap };
}

function colorizeBrick(width, height) {
  const { mortarMap, idMap } = brickPattern(width, height);
  const noise = valueNoise(771);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const p = i * 4;
      const isMortar = mortarMap[i] > 0;
      const tint = idMap[i];
      const grain = fbm(noise, x / 6, y / 6, 3);
      let color;
      if (isMortar) {
        const g = 168 + grain * 26;
        color = [g, g * 0.98, g * 0.92];
      } else {
        const base = [146, 70, 48];
        const alt = [172, 92, 58];
        const c = mix(base, alt, tint);
        const shade = 0.82 + grain * 0.32;
        color = [c[0] * shade, c[1] * shade, c[2] * shade];
      }
      data[p] = color[0];
      data[p + 1] = color[1];
      data[p + 2] = color[2];
      data[p + 3] = 255;
    }
  }
  return data;
}

function grayscale(width, height, fn) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = Math.round(clamp01(fn(x, y)) * 255);
      const p = (y * width + x) * 4;
      data[p] = v;
      data[p + 1] = v;
      data[p + 2] = v;
      data[p + 3] = 255;
    }
  }
  return data;
}

function heightToNormal(heightMap, width, height, strength = 2.4) {
  const data = new Uint8ClampedArray(width * height * 4);
  const at = (x, y) => heightMap[Math.max(0, Math.min(height - 1, y)) * width + Math.max(0, Math.min(width - 1, x))];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      let nx = -dx;
      let ny = -dy;
      let nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len;
      ny /= len;
      nz /= len;
      const p = (y * width + x) * 4;
      // 切线空间法线以 OpenGL (+Y 向上) 存储
      data[p] = Math.round((nx * 0.5 + 0.5) * 255);
      data[p + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      data[p + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      data[p + 3] = 255;
    }
  }
  return data;
}

function brickMaps(width, height) {
  const { mortarMap, idMap, heightMap } = brickPattern(width, height);
  const noise = valueNoise(3301);
  const albedo = colorizeBrick(width, height);
  const normal = heightToNormal(heightMap, width, height, 3.1);
  const roughness = grayscale(width, height, (x, y) => {
    const i = y * width + x;
    if (mortarMap[i]) return 0.82 + fbm(noise, x / 9, y / 9, 2) * 0.12;
    return 0.5 + idMap[i] * 0.2 + fbm(noise, x / 15, y / 15, 3) * 0.16;
  });
  const metallic = grayscale(width, height, (x, y) => {
    const i = y * width + x;
    return mortarMap[i] ? 0 : 0.02 + idMap[i] * 0.03;
  });
  const ao = grayscale(width, height, (x, y) => {
    const i = y * width + x;
    const base = fbm(noise, x / 28, y / 28, 3);
    return mortarMap[i] ? 0.35 + base * 0.12 : 0.82 + base * 0.16;
  });
  return { albedo, normal, roughness, metallic, ao, height: grayscale(width, height, (x, y) => heightMap[y * width + x]) };
}

function metalMaps(width, height, seed = 1) {
  const rand = mulberry32(seed);
  const noise = valueNoise(5521 + seed);
  const plateH = height / 2;
  const plateW = width / 2;
  const heightMap = new Float32Array(width * height);
  const seamMap = new Float32Array(width * height);
  const rivetMap = new Float32Array(width * height);
  const rivets = [];
  for (let gy = 0; gy < 2; gy++) {
    for (let gx = 0; gx < 2; gx++) {
      for (const [ox, oy] of [[0.12, 0.12], [0.88, 0.12], [0.12, 0.88], [0.88, 0.88]]) {
        rivets.push({ x: gx * plateW + ox * plateW, y: gy * plateH + oy * plateH, r: Math.min(plateW, plateH) * 0.026 });
      }
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const lx = x % plateW;
      const ly = y % plateH;
      const edge = Math.min(lx, plateW - lx, ly, plateH - ly);
      const seam = edge < 3 ? 1 : 0;
      let h = 0.62 + fbm(noise, x / 40, y / 40, 4) * 0.12;
      let rivet = 0;
      for (const r of rivets) {
        const d = Math.hypot(x - r.x, y - r.y);
        if (d < r.r * 2.4) {
          const t = 1 - d / (r.r * 2.4);
          rivet = Math.max(rivet, t);
          h += (1 - Math.min(1, d / r.r)) * 0.35;
        }
      }
      if (seam) h -= 0.35;
      const i = y * width + x;
      heightMap[i] = clamp01(h);
      seamMap[i] = seam;
      rivetMap[i] = rivet;
    }
  }
  const albedo = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const p = i * 4;
      const brushed = fbm(noise, x / 3.5, y / 90, 3);
      const base = 112 + brushed * 46 - seamMap[i] * 46 + rivetMap[i] * 22;
      albedo[p] = base * 0.92;
      albedo[p + 1] = base * 0.96;
      albedo[p + 2] = base;
      albedo[p + 3] = 255;
    }
  }
  return {
    albedo,
    normal: heightToNormal(heightMap, width, height, 2.2),
    roughness: grayscale(width, height, (x, y) => {
      const i = y * width + x;
      return 0.24 + fbm(noise, x / 12, y / 60, 3) * 0.18 + seamMap[i] * 0.35;
    }),
    metallic: grayscale(width, height, () => 0.92),
    ao: grayscale(width, height, (x, y) => {
      const i = y * width + x;
      return seamMap[i] ? 0.45 : 0.9 - rivetMap[i] * 0.05;
    }),
    height: grayscale(width, height, (x, y) => heightMap[y * width + x]),
  };
}

function woodMaps(width, height, seed = 3) {
  const noise = valueNoise(8811 + seed);
  const rand = mulberry32(seed * 77);
  const planks = 4;
  const plankH = height / planks;
  const grainOffsets = Array.from({ length: planks }, () => rand() * 100);
  const heightMap = new Float32Array(width * height);
  const seamMap = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const plank = Math.floor(y / plankH);
    const ly = y % plankH;
    for (let x = 0; x < width; x++) {
      const seam = ly < 2 ? 1 : 0;
      const warp = fbm(noise, x / 220, (y + grainOffsets[plank]) / 14, 3);
      const ring = 0.5 + 0.5 * Math.sin((x / width) * 42 + warp * 9 + grainOffsets[plank]);
      const fine = fbm(noise, x / 5, y / 2, 2);
      const h = seam ? 0.2 : 0.55 + ring * 0.14 + fine * 0.08;
      const i = y * width + x;
      heightMap[i] = clamp01(h);
      seamMap[i] = seam;
    }
  }
  const albedo = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const plank = Math.floor(y / plankH);
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const p = i * 4;
      const warp = fbm(noise, x / 180, (y + grainOffsets[plank]) / 12, 3);
      const ring = 0.5 + 0.5 * Math.sin((x / width) * 42 + warp * 9 + grainOffsets[plank]);
      const tone = 0.7 + ring * 0.2 + (grainOffsets[plank] % 1) * 0.08;
      let color = [124 * tone, 82 * tone, 52 * tone];
      if (seamMap[i]) color = [62, 40, 26];
      albedo[p] = color[0];
      albedo[p + 1] = color[1];
      albedo[p + 2] = color[2];
      albedo[p + 3] = 255;
    }
  }
  return {
    albedo,
    normal: heightToNormal(heightMap, width, height, 1.6),
    roughness: grayscale(width, height, (x, y) => {
      const i = y * width + x;
      const n = fbm(noise, x / 9, y / 9, 3);
      return seamMap[i] ? 0.86 : 0.45 + n * 0.25;
    }),
    ao: grayscale(width, height, (x, y) => {
      const i = y * width + x;
      return seamMap[i] ? 0.4 : 0.86;
    }),
    height: grayscale(width, height, (x, y) => heightMap[y * width + x]),
  };
}

/* ----------------------------- 编码写盘 ----------------------------- */

const deflate = (bytes) => deflateSync(bytes, { level: 9 });

async function writePng(file, width, height, data) {
  mkdirSync(dirname(file), { recursive: true });
  const png = await encodePng({ width, height, data }, { deflate });
  writeFileSync(file, png);
  return png.length;
}

function writeTga24(file, width, height, rgba) {
  mkdirSync(dirname(file), { recursive: true });
  const header = Buffer.alloc(18);
  header[2] = 2; // uncompressed true-color
  header.writeUInt16LE(width, 12);
  header.writeUInt16LE(height, 14);
  header[16] = 24;
  header[17] = 0x20; // top-left origin
  const pixels = Buffer.alloc(width * height * 3);
  for (let i = 0, p = 0; i < width * height; i++, p += 4) {
    pixels[i * 3] = rgba[p + 2];
    pixels[i * 3 + 1] = rgba[p + 1];
    pixels[i * 3 + 2] = rgba[p];
  }
  const out = Buffer.concat([header, pixels]);
  writeFileSync(file, out);
  return out.length;
}

function writeTgaGray(file, width, height, rgba) {
  mkdirSync(dirname(file), { recursive: true });
  const header = Buffer.alloc(18);
  header[2] = 3; // uncompressed grayscale
  header.writeUInt16LE(width, 12);
  header.writeUInt16LE(height, 14);
  header[16] = 8;
  header[17] = 0x20;
  const pixels = Buffer.alloc(width * height);
  for (let i = 0; i < width * height; i++) pixels[i] = rgba[i * 4];
  const out = Buffer.concat([header, pixels]);
  writeFileSync(file, out);
  return out.length;
}

/* ----------------------------- 主流程 ----------------------------- */

async function main() {
  const written = [];
  const push = (name, bytes) => written.push({ name, bytes });

  // 砖墙（AO 故意 768×512，演示尺寸不一致）
  {
    const dir = join(SAMPLES, "materials", "brick_wall");
    const w = 1024;
    const h = 1024;
    const maps = brickMaps(w, h);
    push("brick_wall_Albedo.png", await writePng(join(dir, "brick_wall_Albedo.png"), w, h, maps.albedo));
    push("brick_wall_Normal.png", await writePng(join(dir, "brick_wall_Normal.png"), w, h, maps.normal));
    push("brick_wall_Roughness.png", await writePng(join(dir, "brick_wall_Roughness.png"), w, h, maps.roughness));
    push("brick_wall_Metallic.png", await writePng(join(dir, "brick_wall_Metallic.png"), w, h, maps.metallic));
    push("brick_wall_Height.png", await writePng(join(dir, "brick_wall_Height.png"), w, h, maps.height));
    const aoW = 768;
    const aoH = 512;
    const aoNoise = valueNoise(1201);
    const ao = grayscale(aoW, aoH, (x, y) => 0.55 + fbm(aoNoise, (x / aoW) * 24, (y / aoH) * 16, 3) * 0.4);
    push("brick_wall_AO_768x512.png", await writePng(join(dir, "brick_wall_AO_768x512.png"), aoW, aoH, ao));
  }

  // 金属板（含 TGA 法线 / 8 位灰度 TGA 高度）
  {
    const dir = join(SAMPLES, "materials", "metal_plate");
    const w = 512;
    const h = 512;
    const maps = metalMaps(w, h);
    push("metal_plate_Albedo.png", await writePng(join(dir, "metal_plate_Albedo.png"), w, h, maps.albedo));
    push("metal_plate_Normal.tga", writeTga24(join(dir, "metal_plate_Normal.tga"), w, h, maps.normal));
    push("metal_plate_Roughness.png", await writePng(join(dir, "metal_plate_Roughness.png"), w, h, maps.roughness));
    push("metal_plate_Metallic.png", await writePng(join(dir, "metal_plate_Metallic.png"), w, h, maps.metallic));
    push("metal_plate_AO.png", await writePng(join(dir, "metal_plate_AO.png"), w, h, maps.ao));
    push("metal_plate_Height.tga", writeTgaGray(join(dir, "metal_plate_Height.tga"), w, h, maps.height));
  }

  // 木地板（第三组，验证批量时同名输出不会互相覆盖）
  {
    const dir = join(SAMPLES, "materials", "wood_floor");
    const w = 1024;
    const h = 512;
    const maps = woodMaps(w, h);
    push("wood_floor_Albedo.png", await writePng(join(dir, "wood_floor_Albedo.png"), w, h, maps.albedo));
    push("wood_floor_Normal.png", await writePng(join(dir, "wood_floor_Normal.png"), w, h, maps.normal));
    push("wood_floor_Roughness.png", await writePng(join(dir, "wood_floor_Roughness.png"), w, h, maps.roughness));
    push("wood_floor_AO.png", await writePng(join(dir, "wood_floor_AO.png"), w, h, maps.ao));
    const metallic = grayscale(w, h, () => 0.02);
    push("wood_floor_Metallic.png", await writePng(join(dir, "wood_floor_Metallic.png"), w, h, metallic));
  }

  // 损坏样例：正常 albedo + 被截断的 TGA 法线（演示失败项保留成功项）
  {
    const dir = join(SAMPLES, "materials", "damaged_panel");
    const w = 256;
    const h = 256;
    const maps = metalMaps(w, h, 9);
    push("damaged_panel_Albedo.png", await writePng(join(dir, "damaged_panel_Albedo.png"), w, h, maps.albedo));
    const normalPath = join(dir, "damaged_panel_Normal.tga");
    const full = Buffer.alloc(18 + w * h * 3);
    full[2] = 2;
    full.writeUInt16LE(w, 12);
    full.writeUInt16LE(h, 14);
    full[16] = 24;
    full[17] = 0x20;
    for (let i = 0, p = 0, q = 18; i < w * h; i++, p += 4, q += 3) {
      full[q] = maps.normal[p + 2];
      full[q + 1] = maps.normal[p + 1];
      full[q + 2] = maps.normal[p];
    }
    const keep = Math.floor(full.length * 0.45);
    mkdirSync(dir, { recursive: true });
    writeFileSync(normalPath, full.subarray(0, keep));
    push("damaged_panel_Normal.tga", keep);
  }

  // 参考图：颜色色卡 / 法线球 / 灰阶阶梯
  {
    const dir = join(SAMPLES, "reference");
    const w = 512;
    const h = 512;
    // 色卡
    const swatches = [
      [214, 69, 65], [239, 146, 58], [244, 208, 74], [96, 178, 112],
      [76, 160, 196], [92, 110, 200], [156, 98, 190], [230, 230, 230],
    ];
    const color = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const sx = Math.min(3, Math.floor((x / w) * 4));
        const sy = Math.min(1, Math.floor((y / h) * 2));
        const c = swatches[sy * 4 + sx];
        const p = (y * w + x) * 4;
        color[p] = c[0];
        color[p + 1] = c[1];
        color[p + 2] = c[2];
        color[p + 3] = 255;
      }
    }
    push("color_swatches.png", await writePng(join(dir, "color_swatches.png"), w, h, color));

    // 法线参考：球面法线 + 渐变
    const normal = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = (y * w + x) * 4;
        const nx = (x / w) * 2 - 1;
        const ny = (y / h) * 2 - 1;
        const r2 = nx * nx + ny * ny;
        if (r2 <= 1) {
          const nz = Math.sqrt(1 - r2);
          normal[p] = (nx * 0.5 + 0.5) * 255;
          normal[p + 1] = (-ny * 0.5 + 0.5) * 255;
          normal[p + 2] = (nz * 0.5 + 0.5) * 255;
        } else {
          normal[p] = 128;
          normal[p + 1] = 128;
          normal[p + 2] = 255;
        }
        normal[p + 3] = 255;
      }
    }
    push("normal_sphere.png", await writePng(join(dir, "normal_sphere.png"), w, h, normal));

    // 灰阶阶梯
    const steps = 16;
    const gray = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const step = Math.min(steps - 1, Math.floor((x / w) * steps));
        const v = Math.round((step / (steps - 1)) * 255);
        const p = (y * w + x) * 4;
        gray[p] = v;
        gray[p + 1] = v;
        gray[p + 2] = v;
        gray[p + 3] = 255;
      }
    }
    push("gray_steps.png", await writePng(join(dir, "gray_steps.png"), w, h, gray));
  }

  // 演示工程（指向 PNG/TGA，便于无头 CLI 直接导出）
  const demo = buildDemoProject();
  writeFileSync(join(SAMPLES, PROJECT_FILE), JSON.stringify(demo, null, 2));

  const total = written.reduce((n, f) => n + f.bytes, 0);
  console.log(`生成 ${written.length} 个文件，共 ${(total / 1024 / 1024).toFixed(2)} MB`);
  console.log(`输出目录：${SAMPLES}`);
  for (const f of written) console.log(`  ${f.name}  ${(f.bytes / 1024).toFixed(0)} KB`);
}

function demoImage(role, fileName, dir, width, height) {
  return {
    role,
    fileName,
    url: LEGACY
      ? `samples/materials/${dir}/${fileName}`
      : `samples/raster/materials/${dir}/${fileName}`,
    width,
    height,
    bytes: null,
    restored: true,
  };
}

function makeColorOutput(name = "BaseColor") {
  return createOutput({
    name,
    type: "color",
    channels: {
      r: { ...emptyChannel("role", "albedo"), sample: "red" },
      g: { ...emptyChannel("role", "albedo"), sample: "green" },
      b: { ...emptyChannel("role", "albedo"), sample: "blue" },
      a: emptyChannel("constant", null, 255),
    },
  });
}

function makeNormalOutput(name = "Normal") {
  return createOutput({
    name,
    type: "normal",
    channels: {
      r: { ...emptyChannel("role", "normal"), sample: "red" },
      g: { ...emptyChannel("role", "normal"), sample: "green" },
      b: { ...emptyChannel("role", "normal"), sample: "blue" },
      a: emptyChannel("constant", null, 255),
    },
  });
}

function makeOrmOutput(name = "ORM") {
  return createOutput({
    name,
    type: "orm",
    channels: {
      r: emptyChannel("role", "ao"),
      g: emptyChannel("role", "roughness"),
      b: emptyChannel("role", "metallic"),
      a: emptyChannel("constant", null, 255),
    },
  });
}

function buildDemoProject() {
  const brick = createMaterial("砖墙 Brick Wall");
  brick.targetWidth = 1024;
  brick.targetHeight = 1024;
  brick.fitMode = "pad";
  brick.images = {
    albedo: demoImage("albedo", "brick_wall_Albedo.png", "brick_wall", 1024, 1024),
    normal: demoImage("normal", "brick_wall_Normal.png", "brick_wall", 1024, 1024),
    roughness: demoImage("roughness", "brick_wall_Roughness.png", "brick_wall", 1024, 1024),
    metallic: demoImage("metallic", "brick_wall_Metallic.png", "brick_wall", 1024, 1024),
    ao: demoImage("ao", "brick_wall_AO_768x512.png", "brick_wall", 768, 512),
    height: demoImage("height", "brick_wall_Height.png", "brick_wall", 1024, 1024),
  };
  const brickNormal = makeNormalOutput();
  brickNormal.convention = "opengl";
  brick.outputs = [
    makeColorOutput(),
    brickNormal,
    makeOrmOutput(),
    createOutput({
      name: "HeightMask",
      type: "custom",
      channels: {
        r: emptyChannel("role", "height"),
        g: emptyChannel("role", "ao"),
        b: emptyChannel("constant", null, 64),
        a: emptyChannel("role", "roughness"),
      },
      includeAlpha: true,
    }),
  ];

  const metal = createMaterial("金属板 Metal Plate");
  metal.targetWidth = 512;
  metal.targetHeight = 512;
  metal.fitMode = "crop";
  metal.images = {
    albedo: demoImage("albedo", "metal_plate_Albedo.png", "metal_plate", 512, 512),
    normal: demoImage("normal", "metal_plate_Normal.tga", "metal_plate", 512, 512),
    roughness: demoImage("roughness", "metal_plate_Roughness.png", "metal_plate", 512, 512),
    metallic: demoImage("metallic", "metal_plate_Metallic.png", "metal_plate", 512, 512),
    ao: demoImage("ao", "metal_plate_AO.png", "metal_plate", 512, 512),
    height: demoImage("height", "metal_plate_Height.tga", "metal_plate", 512, 512),
  };
  const metalNormal = makeNormalOutput();
  metalNormal.convention = "directx";
  metal.outputs = [makeColorOutput(), metalNormal, makeOrmOutput()];

  const wood = createMaterial("木地板 Wood Floor");
  wood.targetWidth = 1024;
  wood.targetHeight = 512;
  wood.fitMode = "scale";
  wood.images = {
    albedo: demoImage("albedo", "wood_floor_Albedo.png", "wood_floor", 1024, 512),
    normal: demoImage("normal", "wood_floor_Normal.png", "wood_floor", 1024, 512),
    roughness: demoImage("roughness", "wood_floor_Roughness.png", "wood_floor", 1024, 512),
    ao: demoImage("ao", "wood_floor_AO.png", "wood_floor", 1024, 512),
    metallic: demoImage("metallic", "wood_floor_Metallic.png", "wood_floor", 1024, 512),
  };
  wood.outputs = [
    makeColorOutput(),
    makeNormalOutput(),
    makeOrmOutput("ORM"),
    createOutput({
      name: "ORM",
      type: "custom",
      channels: {
        r: emptyChannel("role", "ao"),
        g: emptyChannel("role", "roughness"),
        b: emptyChannel("constant", null, 0),
        a: emptyChannel("constant", null, 255),
      },
    }),
  ];

  // 损坏样例：法线 TGA 被截断。打开后应显示"解码失败，用常量补齐"；
  // 批量导出时该输出失败并列出原因，颜色贴图输出仍然成功。
  const damaged = createMaterial("损坏样例 Damaged");
  damaged.targetWidth = 256;
  damaged.targetHeight = 256;
  damaged.fitMode = "pad";
  damaged.images = {
    albedo: demoImage("albedo", "damaged_panel_Albedo.png", "damaged_panel", 256, 256),
    normal: demoImage("normal", "damaged_panel_Normal.tga", "damaged_panel", 256, 256),
  };
  damaged.outputs = [makeColorOutput("BaseColor"), makeNormalOutput("Normal")];

  const project = {
    schema: "texture-channel-packer/1",
    appVersion: "1.0.0",
    name: "演示工程：四组材质（含错误尺寸与损坏文件）",
    createdAt: "2026-11-21T00:00:00.000Z",
    updatedAt: "2026-11-21T00:00:00.000Z",
    activeMaterialId: brick.id,
    selectedOutputId: brick.outputs[2].id,
    materials: [brick, metal, wood, damaged],
  };
  return serializeProject(project);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
