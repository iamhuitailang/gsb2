/**
 * Minimal raster + PNG encoder used only by the sample generator.
 * No third-party dependencies; deterministic output.
 */
import { deflateSync } from 'node:zlib';

export class Raster {
  constructor(width, height) {
    this.width = Math.round(width);
    this.height = Math.round(height);
    this.data = new Uint8ClampedArray(this.width * this.height * 4);
  }

  fill(color) {
    this.fillRect(0, 0, this.width, this.height, color);
  }

  fillRect(x, y, w, h, color) {
    const [r, g, b, a = 255] = toRgba(color);
    if (a === 0) return;
    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(this.width, Math.ceil(x + w));
    const y1 = Math.min(this.height, Math.ceil(y + h));
    const alpha = a / 255;
    for (let py = y0; py < y1; py++) {
      let o = (py * this.width + x0) * 4;
      for (let px = x0; px < x1; px++, o += 4) {
        if (alpha === 1) {
          this.data[o] = r;
          this.data[o + 1] = g;
          this.data[o + 2] = b;
          this.data[o + 3] = 255;
        } else {
          blendPixel(this.data, o, r, g, b, alpha);
        }
      }
    }
  }

  fillCircle(cx, cy, radius, color) {
    const [r, g, b, a = 255] = toRgba(color);
    const x0 = Math.max(0, Math.floor(cx - radius));
    const y0 = Math.max(0, Math.floor(cy - radius));
    const x1 = Math.min(this.width, Math.ceil(cx + radius + 1));
    const y1 = Math.min(this.height, Math.ceil(cy + radius + 1));
    const alpha = a / 255;
    const r2 = radius * radius;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        if (dx * dx + dy * dy <= r2) {
          blendPixel(this.data, (y * this.width + x) * 4, r, g, b, alpha);
        }
      }
    }
  }

  fillRing(cx, cy, radius, thickness, color) {
    const [r, g, b, a = 255] = toRgba(color);
    const outer = radius + thickness / 2;
    const inner = Math.max(0, radius - thickness / 2);
    const x0 = Math.max(0, Math.floor(cx - outer));
    const y0 = Math.max(0, Math.floor(cy - outer));
    const x1 = Math.min(this.width, Math.ceil(cx + outer + 1));
    const y1 = Math.min(this.height, Math.ceil(cy + outer + 1));
    const alpha = a / 255;
    const o2 = outer * outer;
    const i2 = inner * inner;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        const d2 = dx * dx + dy * dy;
        if (d2 <= o2 && d2 >= i2) {
          blendPixel(this.data, (y * this.width + x) * 4, r, g, b, alpha);
        }
      }
    }
  }

  strokeCircle(cx, cy, radius, thickness, color) {
    this.fillRing(cx, cy, radius, thickness, color);
  }

  fillTriangle(x1, y1, x2, y2, x3, y3, color) {
    const [r, g, b, a = 255] = toRgba(color);
    const minX = Math.max(0, Math.floor(Math.min(x1, x2, x3)));
    const maxX = Math.min(this.width, Math.ceil(Math.max(x1, x2, x3)) + 1);
    const minY = Math.max(0, Math.floor(Math.min(y1, y2, y3)));
    const maxY = Math.min(this.height, Math.ceil(Math.max(y1, y2, y3)) + 1);
    const area = (x2 - x1) * (y3 - y1) - (x3 - x1) * (y2 - y1);
    if (Math.abs(area) < 1e-6) return;
    const alpha = a / 255;
    for (let y = minY; y < maxY; y++) {
      for (let x = minX; x < maxX; x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        const w1 = ((x2 - px) * (y3 - py) - (x3 - px) * (y2 - py)) / area;
        const w2 = ((x3 - px) * (y1 - py) - (x1 - px) * (y3 - py)) / area;
        const w3 = 1 - w1 - w2;
        if (w1 >= 0 && w2 >= 0 && w3 >= 0) {
          blendPixel(this.data, (y * this.width + x) * 4, r, g, b, alpha);
        }
      }
    }
  }

  fillRoundRect(x, y, w, h, radius, color) {
    const r = Math.min(radius, w / 2, h / 2);
    this.fillRect(x + r, y, w - 2 * r, h, color);
    this.fillRect(x, y + r, r, h - 2 * r, color);
    this.fillRect(x + w - r, y + r, r, h - 2 * r, color);
    this.fillCircle(x + r, y + r, r, color);
    this.fillCircle(x + w - r, y + r, r, color);
    this.fillCircle(x + r, y + h - r, r, color);
    this.fillCircle(x + w - r, y + h - r, r, color);
  }

  strokeRoundRect(x, y, w, h, radius, thickness, color) {
    const r = Math.min(radius, w / 2, h / 2);
    this.line(x + r, y, x + w - r, y, thickness, color);
    this.line(x + r, y + h, x + w - r, y + h, thickness, color);
    this.line(x, y + r, x, y + h - r, thickness, color);
    this.line(x + w, y + r, x + w, y + h - r, thickness, color);
    this.arc(x + r, y + r, r, Math.PI, Math.PI * 1.5, thickness, color);
    this.arc(x + w - r, y + r, r, Math.PI * 1.5, Math.PI * 2, thickness, color);
    this.arc(x + w - r, y + h - r, r, 0, Math.PI / 2, thickness, color);
    this.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI, thickness, color);
  }

  arc(cx, cy, radius, start, end, thickness, color) {
    const steps = Math.max(8, Math.ceil((end - start) * radius * 2));
    const [r, g, b, a = 255] = toRgba(color);
    for (let i = 0; i <= steps; i++) {
      const angle = start + ((end - start) * i) / steps;
      const x = cx + Math.cos(angle) * radius - thickness / 2;
      const y = cy + Math.sin(angle) * radius - thickness / 2;
      this.fillCircle(x, y, thickness / 2, [r, g, b, a]);
    }
  }

  line(x1, y1, x2, y2, thickness, color) {
    const [r, g, b, a = 255] = toRgba(color);
    const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) * 2));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      this.fillCircle(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, thickness / 2, [
        r,
        g,
        b,
        a,
      ]);
    }
  }

  fillLinearGradientRect(x, y, w, h, stops, vertical = true) {
    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(this.width, Math.ceil(x + w));
    const y1 = Math.min(this.height, Math.ceil(y + h));
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        const t = vertical
          ? (py - y) / Math.max(1, h)
          : (px - x) / Math.max(1, w);
        const [r, g, b, a = 255] = sampleStops(stops, t);
        blendPixel(
          this.data,
          (py * this.width + px) * 4,
          r,
          g,
          b,
          a / 255,
        );
      }
    }
  }

  /** Large soft light blobs for a bit of depth. */
  glow(cx, cy, radius, color) {
    const [r, g, b] = toRgba(color);
    const x0 = Math.max(0, Math.floor(cx - radius));
    const y0 = Math.max(0, Math.floor(cy - radius));
    const x1 = Math.min(this.width, Math.ceil(cx + radius));
    const y1 = Math.min(this.height, Math.ceil(cy + radius));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const d = Math.hypot(x - cx, y - cy) / radius;
        if (d >= 1) continue;
        const alpha = (1 - d) ** 2 * 0.55;
        blendPixel(this.data, (y * this.width + x) * 4, r, g, b, alpha);
      }
    }
  }

  grain(seed, amount = 6) {
    const rand = mulberry32(seed);
    for (let i = 0; i < this.data.length; i += 4) {
      const n = (rand() - 0.5) * amount;
      this.data[i] += n;
      this.data[i + 1] += n;
      this.data[i + 2] += n;
    }
  }

  downsample(factor) {
    const outW = Math.max(1, Math.round(this.width / factor));
    const outH = Math.max(1, Math.round(this.height / factor));
    const out = new Raster(outW, outH);
    const f = Math.max(1, Math.round(factor));
    const area = f * f;
    for (let y = 0; y < outH; y++) {
      for (let x = 0; x < outW; x++) {
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        for (let dy = 0; dy < f; dy++) {
          const sy = y * f + dy;
          if (sy >= this.height) continue;
          for (let dx = 0; dx < f; dx++) {
            const sx = x * f + dx;
            if (sx >= this.width) continue;
            const o = (sy * this.width + sx) * 4;
            r += this.data[o];
            g += this.data[o + 1];
            b += this.data[o + 2];
            a += this.data[o + 3];
          }
        }
        const o = (y * outW + x) * 4;
        out.data[o] = r / area;
        out.data[o + 1] = g / area;
        out.data[o + 2] = b / area;
        out.data[o + 3] = a / area;
      }
    }
    return out;
  }
}

function blendPixel(data, o, r, g, b, alpha) {
  if (alpha >= 1) {
    data[o] = r;
    data[o + 1] = g;
    data[o + 2] = b;
    data[o + 3] = 255;
    return;
  }
  const dstA = data[o + 3] / 255;
  const outA = alpha + dstA * (1 - alpha);
  if (outA <= 0) return;
  data[o] = (r * alpha + data[o] * dstA * (1 - alpha)) / outA;
  data[o + 1] = (g * alpha + data[o + 1] * dstA * (1 - alpha)) / outA;
  data[o + 2] = (b * alpha + data[o + 2] * dstA * (1 - alpha)) / outA;
  data[o + 3] = outA * 255;
}

function toRgba(color) {
  if (Array.isArray(color)) return color;
  if (typeof color === 'string') {
    const value = color.trim();
    const rgbMatch = /^rgba?\(([^)]+)\)$/i.exec(value);
    if (rgbMatch) {
      const parts = rgbMatch[1].split(/[\s,/]+/).filter(Boolean);
      const [r, g, b] = parts.slice(0, 3).map((p) => Number.parseFloat(p));
      const alpha =
        parts.length > 3 ? Number.parseFloat(parts[3]) : 1;
      const clampedAlpha = Number.isFinite(alpha)
        ? alpha <= 1
          ? alpha * 255
          : alpha
        : 255;
      return [
        Number.isFinite(r) ? r : 0,
        Number.isFinite(g) ? g : 0,
        Number.isFinite(b) ? b : 0,
        clampedAlpha,
      ];
    }
    const hex = value.replace('#', '');
    if (hex.length === 3) {
      return [
        parseInt(hex[0] + hex[0], 16),
        parseInt(hex[1] + hex[1], 16),
        parseInt(hex[2] + hex[2], 16),
        255,
      ];
    }
    if (hex.length === 6 || hex.length === 8) {
      return [
        parseInt(hex.slice(0, 2), 16),
        parseInt(hex.slice(2, 4), 16),
        parseInt(hex.slice(4, 6), 16),
        hex.length === 8 ? parseInt(hex.slice(6, 8), 16) : 255,
      ];
    }
  }
  return [0, 0, 0, 255];
}

function sampleStops(stops, t) {
  const clamped = Math.max(0, Math.min(1, t));
  for (let i = 0; i < stops.length - 1; i++) {
    const [p0, c0] = stops[i];
    const [p1, c1] = stops[i + 1];
    if (clamped >= p0 && clamped <= p1) {
      const local = (clamped - p0) / Math.max(1e-6, p1 - p0);
      const a = toRgba(c0);
      const b = toRgba(c1);
      return [
        a[0] + (b[0] - a[0]) * local,
        a[1] + (b[1] - a[1]) * local,
        a[2] + (b[2] - a[2]) * local,
        (a[3] ?? 255) + ((b[3] ?? 255) - (a[3] ?? 255)) * local,
      ];
    }
  }
  return toRgba(stops[stops.length - 1][1]);
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Painter transform: scene designs use base coordinates, output is scaled. */
export class Painter {
  constructor(raster, scale) {
    this.r = raster;
    this.k = scale;
  }

  fillRect(x, y, w, h, color) {
    this.r.fillRect(x * this.k, y * this.k, w * this.k, h * this.k, color);
  }

  fillRoundRect(x, y, w, h, radius, color) {
    this.r.fillRoundRect(
      x * this.k,
      y * this.k,
      w * this.k,
      h * this.k,
      radius * this.k,
      color,
    );
  }

  strokeRoundRect(x, y, w, h, radius, thickness, color) {
    this.r.strokeRoundRect(
      x * this.k,
      y * this.k,
      w * this.k,
      h * this.k,
      radius * this.k,
      Math.max(1, thickness * this.k),
      color,
    );
  }

  circle(cx, cy, radius, color) {
    this.r.fillCircle(cx * this.k, cy * this.k, radius * this.k, color);
  }

  ring(cx, cy, radius, thickness, color) {
    this.r.fillRing(
      cx * this.k,
      cy * this.k,
      radius * this.k,
      Math.max(1, thickness * this.k),
      color,
    );
  }

  triangle(x1, y1, x2, y2, x3, y3, color) {
    this.r.fillTriangle(
      x1 * this.k,
      y1 * this.k,
      x2 * this.k,
      y2 * this.k,
      x3 * this.k,
      y3 * this.k,
      color,
    );
  }

  line(x1, y1, x2, y2, thickness, color) {
    this.r.line(
      x1 * this.k,
      y1 * this.k,
      x2 * this.k,
      y2 * this.k,
      Math.max(1, thickness * this.k),
      color,
    );
  }

  glow(cx, cy, radius, color) {
    this.r.glow(cx * this.k, cy * this.k, radius * this.k, color);
  }

  gradient(x, y, w, h, stops) {
    this.r.fillLinearGradientRect(
      x * this.k,
      y * this.k,
      w * this.k,
      h * this.k,
      stops,
    );
  }

  text(str, x, y, size, color, spacing = 1) {
    const unit = Math.max(1, Math.round(size * this.k));
    const gap = Math.max(1, Math.round(spacing * this.k * 0.5));
    let cursor = x * this.k;
    const top = y * this.k;
    for (const ch of String(str).toUpperCase()) {
      if (ch === ' ') {
        cursor += unit * 4 + gap;
        continue;
      }
      const glyph = FONT[ch] || FONT['?'];
      glyph.forEach((row, ry) => {
        for (let rx = 0; rx < 3; rx++) {
          if (row[rx] === '1') {
            this.r.fillRect(
              cursor + rx * unit,
              top + ry * unit,
              unit,
              unit,
              color,
            );
          }
        }
      });
      cursor += unit * 4 + gap;
    }
  }

  textWidth(str, size, spacing = 1) {
    const unit = Math.max(1, Math.round(size * this.k));
    const gap = Math.max(1, Math.round(spacing * this.k * 0.5));
    let width = 0;
    for (const ch of String(str).toUpperCase()) {
      width += ch === ' ' ? unit * 4 + gap : unit * 4 + gap;
    }
    return Math.max(0, width - gap) / this.k;
  }
}

const G = (rows) => rows.split('/');

/** 3x5 pixel font (three columns, five rows per glyph). */
export const FONT = {
  A: G('010/101/111/101/101'),
  B: G('110/101/110/101/110'),
  C: G('011/100/100/100/011'),
  D: G('110/101/101/101/110'),
  E: G('111/100/110/100/111'),
  F: G('111/100/110/100/100'),
  G: G('011/100/101/101/011'),
  H: G('101/101/111/101/101'),
  I: G('111/010/010/010/111'),
  J: G('001/001/001/101/010'),
  K: G('101/101/110/101/101'),
  L: G('100/100/100/100/111'),
  M: G('101/111/111/101/101'),
  N: G('101/111/111/111/101'),
  O: G('010/101/101/101/010'),
  P: G('110/101/110/100/100'),
  Q: G('010/101/101/111/011'),
  R: G('110/101/110/101/101'),
  S: G('011/100/010/001/110'),
  T: G('111/010/010/010/010'),
  U: G('101/101/101/101/111'),
  V: G('101/101/101/101/010'),
  W: G('101/101/111/111/101'),
  X: G('101/101/010/101/101'),
  Y: G('101/101/010/010/010'),
  Z: G('111/001/010/100/111'),
  0: G('111/101/101/101/111'),
  1: G('010/110/010/010/111'),
  2: G('111/001/111/100/111'),
  3: G('111/001/011/001/111'),
  4: G('101/101/111/001/001'),
  5: G('111/100/111/001/111'),
  6: G('111/100/111/101/111'),
  7: G('111/001/001/001/001'),
  8: G('111/101/111/101/111'),
  9: G('111/101/111/001/111'),
  '.': G('000/000/000/000/010'),
  ',': G('000/000/000/010/100'),
  ':': G('000/010/000/010/000'),
  '-': G('000/000/111/000/000'),
  '+': G('000/010/111/010/000'),
  '/': G('001/001/010/100/100'),
  '!': G('010/010/010/000/010'),
  '?': G('111/001/011/000/010'),
  '&': G('010/101/010/101/011'),
  '#': G('101/111/101/111/101'),
  "'": G('010/010/000/000/000'),
  '%': G('101/001/010/100/101'),
  '*': G('000/101/010/101/000'),
  '=': G('000/111/000/111/000'),
  _: G('000/000/000/000/111'),
  '(': G('001/010/010/010/001'),
  ')': G('100/010/010/010/100'),
  '·': G('000/000/010/000/000'),
  '—': G('000/000/111/000/000'),
  '–': G('000/000/111/000/000'),
  '→': G('000/010/111/010/000'),
  '×': G('000/101/010/101/000'),
};

/* ------------------------------ PNG encoding ----------------------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i++) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crcBuf]);
}

export function encodePng(raster) {
  const { width, height, data } = raster;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(data.buffer, data.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1,
    );
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
