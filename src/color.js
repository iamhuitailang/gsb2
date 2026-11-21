/**
 * 颜色空间与色差计算。
 * 所有输入 RGB 均为 0..255 的 sRGB（D65 白点）。
 */

export const D65 = { x: 0.95047, y: 1.0, z: 1.08883 };

export function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

export function clamp255(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

export function packRgb(r, g, b) {
  return ((r & 255) << 16) | ((g & 255) << 8) | (b & 255);
}

export function unpackRgb(value) {
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

export function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map((v) => clamp255(Math.round(v)).toString(16).padStart(2, '0')).join('');
}

/** 支持 #rgb / #rrggbb / #rrggbbaa（忽略 alpha）以及 0xRRGGBB。 */
export function hexToRgb(hex) {
  if (typeof hex !== 'string') return null;
  let h = hex.trim().toLowerCase();
  h = h.replace(/^0x/, '').replace(/^#/, '');
  if (!/^[0-9a-f]+$/.test(h)) return null;
  if (h.length === 3 || h.length === 4) {
    const r = parseInt(h[0] + h[0], 16);
    const g = parseInt(h[1] + h[1], 16);
    const b = parseInt(h[2] + h[2], 16);
    return { r, g, b };
  }
  if (h.length === 6 || h.length === 8) {
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
    };
  }
  return null;
}

/**
 * 解析用户输入的调色板。支持每行/逗号/空白分隔的十六进制颜色，
 * 也支持 r,g,b 三元组。`;` 与 `//` 后为注释。
 */
export function parsePaletteText(text) {
  if (!text) return [];
  const result = [];
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.replace(/;.*$/, '').replace(/\/\/.*$/, '').trim();
    if (!line) continue;

    // r, g, b 形式
    const rgbMatch = line.match(/^(?:rgba?\s*\(\s*)?(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})/i);
    if (rgbMatch) {
      result.push({
        r: clamp255(parseInt(rgbMatch[1], 10)),
        g: clamp255(parseInt(rgbMatch[2], 10)),
        b: clamp255(parseInt(rgbMatch[3], 10)),
      });
      continue;
    }

    for (const token of line.split(/[\s,]+/)) {
      const rgb = hexToRgb(token);
      if (rgb) result.push(rgb);
    }
  }
  return dedupePalette(result);
}

export function dedupePalette(palette) {
  const seen = new Set();
  const out = [];
  for (const c of palette) {
    if (!c || !Number.isFinite(c.r) || !Number.isFinite(c.g) || !Number.isFinite(c.b)) continue;
    const r = clamp255(Math.round(c.r));
    const g = clamp255(Math.round(c.g));
    const b = clamp255(Math.round(c.b));
    const key = packRgb(r, g, b);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ r, g, b });
  }
  return out;
}

export function paletteToHex(palette) {
  return palette.map((c) => rgbToHex(c.r, c.g, c.b));
}

export function paletteToFlat(palette) {
  const flat = new Float32Array(palette.length * 3);
  for (let i = 0; i < palette.length; i++) {
    flat[i * 3] = palette[i].r;
    flat[i * 3 + 1] = palette[i].g;
    flat[i * 3 + 2] = palette[i].b;
  }
  return flat;
}

export function srgbToLinear(c) {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(c) {
  const v = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return clamp255(v * 255);
}

export function rgbToXyz(r, g, b) {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  return {
    x: 0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb,
    y: 0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb,
    z: 0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb,
  };
}

export function rgbToLab(r, g, b) {
  const xyz = rgbToXyz(r, g, b);
  const fx = labF(xyz.x / D65.x);
  const fy = labF(xyz.y / D65.y);
  const fz = labF(xyz.z / D65.z);
  return {
    l: 116 * fy - 16,
    a: 500 * (fx - fy),
    b: 200 * (fy - fz),
  };
}

function labF(t) {
  return t > 0.008856451679035631 ? Math.cbrt(t) : 7.787037037037035 * t + 16 / 116;
}

export function labToRgb(l, a, b) {
  const fy = (l + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const xyz = {
    x: D65.x * labInvF(fx),
    y: D65.y * labInvF(fy),
    z: D65.z * labInvF(fz),
  };
  const lr = 3.2404542 * xyz.x - 1.5371385 * xyz.y - 0.4985314 * xyz.z;
  const lg = -0.969266 * xyz.x + 1.8760108 * xyz.y + 0.041556 * xyz.z;
  const lb = 0.0556434 * xyz.x - 0.2040259 * xyz.y + 1.0572252 * xyz.z;
  return {
    r: clamp255(linearToSrgb(Math.max(0, lr))),
    g: clamp255(linearToSrgb(Math.max(0, lg))),
    b: clamp255(linearToSrgb(Math.max(0, lb))),
  };
}

function labInvF(t) {
  const t3 = t * t * t;
  return t3 > 0.008856451679035631 ? t3 : (t - 16 / 116) / 7.787037037037035;
}

export function luma(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function paletteKey(palette) {
  return palette.map((c) => `${c.r},${c.g},${c.b}`).join(';');
}

/** CIE76: Lab 空间欧氏距离。 */
export function deltaE76(lab1, lab2) {
  const dl = lab1.l - lab2.l;
  const da = lab1.a - lab2.a;
  const db = lab1.b - lab2.b;
  return Math.sqrt(dl * dl + da * da + db * db);
}

/** CIEDE2000，Sharma 2005 实现。 */
export function deltaE2000(lab1, lab2) {
  const L1 = lab1.l;
  const a1 = lab1.a;
  const b1 = lab1.b;
  const L2 = lab2.l;
  const a2 = lab2.a;
  const b2 = lab2.b;

  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cbar = (C1 + C2) / 2;
  const Cbar7 = Math.pow(Cbar, 7);
  const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + 6103515625))); // 25^7
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);

  let h1p = Math.atan2(b1, a1p) * 180 / Math.PI;
  if (h1p < 0) h1p += 360;
  let h2p = Math.atan2(b2, a2p) * 180 / Math.PI;
  if (h2p < 0) h2p += 360;
  if (C1p === 0) h1p = 0;
  if (C2p === 0) h2p = 0;

  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = h2p - h1p;
  if (C1p * C2p === 0) dhp = 0;
  else if (dhp > 180) dhp -= 360;
  else if (dhp < -180) dhp += 360;
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * Math.PI) / 360);

  const Lbarp = (L1 + L2) / 2;
  const Cbarp = (C1p + C2p) / 2;
  let hbarp;
  if (C1p * C2p === 0) {
    hbarp = h1p + h2p;
  } else if (Math.abs(h1p - h2p) <= 180) {
    hbarp = (h1p + h2p) / 2;
  } else if (h1p + h2p < 360) {
    hbarp = (h1p + h2p + 360) / 2;
  } else {
    hbarp = (h1p + h2p - 360) / 2;
  }

  const T = 1
    - 0.17 * Math.cos(((hbarp - 30) * Math.PI) / 180)
    + 0.24 * Math.cos((2 * hbarp * Math.PI) / 180)
    + 0.32 * Math.cos(((3 * hbarp + 6) * Math.PI) / 180)
    - 0.2 * Math.cos(((4 * hbarp - 63) * Math.PI) / 180);

  const dTheta = 30 * Math.exp(-Math.pow((hbarp - 275) / 25, 2));
  const Cbarp7 = Math.pow(Cbarp, 7);
  const Rc = 2 * Math.sqrt(Cbarp7 / (Cbarp7 + 6103515625));
  const Sl = 1 + (0.015 * Math.pow(Lbarp - 50, 2)) / Math.sqrt(20 + Math.pow(Lbarp - 50, 2));
  const Sc = 1 + 0.045 * Cbarp;
  const Sh = 1 + 0.015 * Cbarp * T;
  const Rt = -Math.sin((2 * dTheta * Math.PI) / 180) * Rc;

  const l = dLp / Sl;
  const c = dCp / Sc;
  const h = dHp / Sh;
  return Math.sqrt(l * l + c * c + h * h + Rt * c * h);
}

/** “红均值”加权 RGB 距离（CompuPhase），无需转 Lab。 */
export function redmeanDistance(r1, g1, b1, r2, g2, b2) {
  const rmean = (r1 + r2) / 2;
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return (2 + rmean / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rmean) / 256) * db * db;
}

export function rgbDistance(r1, g1, b1, r2, g2, b2) {
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return dr * dr + dg * dg + db * db;
}

/**
 * 重复解码调色板时避免重复计算 Lab。
 */
export function computePaletteLab(palette) {
  return palette.map((c) => rgbToLab(c.r, c.g, c.b));
}
