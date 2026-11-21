// Canvas 程序化纹样：编号牌 / 警示条纹 / 箭头 / 圆形标记
import * as THREE from 'three';

export const PATTERNS = ['plate', 'stripes', 'arrow', 'roundel'];

function makeCanvas(size = 512) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return [c, c.getContext('2d')];
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawPlate(ctx, s, text) {
  // 透明底 + 深色圆角牌 + 边框 + 编号文字
  ctx.clearRect(0, 0, s, s);
  const m = s * 0.06;
  roundRect(ctx, m, s * 0.22, s - 2 * m, s * 0.56, s * 0.06);
  ctx.fillStyle = '#20242c';
  ctx.fill();
  ctx.lineWidth = s * 0.02;
  ctx.strokeStyle = '#e8c33a';
  ctx.stroke();
  ctx.fillStyle = '#f2f4f8';
  ctx.font = `bold ${s * 0.3}px "Arial Black", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text || 'A-01', s / 2, s * 0.5);
}

function drawStripes(ctx, s) {
  ctx.fillStyle = '#e8c33a';
  ctx.fillRect(0, 0, s, s);
  ctx.fillStyle = '#1c1c1c';
  const w = s / 8;
  ctx.save();
  ctx.translate(s / 2, s / 2);
  ctx.rotate(-Math.PI / 4);
  for (let x = -s; x < s; x += w * 2) {
    ctx.fillRect(x, -s, w, s * 2);
  }
  ctx.restore();
  ctx.lineWidth = s * 0.03;
  ctx.strokeStyle = '#1c1c1c';
  ctx.strokeRect(0, 0, s, s);
}

function drawArrow(ctx, s) {
  ctx.clearRect(0, 0, s, s);
  ctx.fillStyle = '#f2f4f8';
  const cx = s / 2;
  ctx.beginPath();
  ctx.moveTo(cx, s * 0.08);            // 箭头尖（朝上 = 贴花 V 正方向）
  ctx.lineTo(cx + s * 0.3, s * 0.45);
  ctx.lineTo(cx + s * 0.12, s * 0.45);
  ctx.lineTo(cx + s * 0.12, s * 0.92);
  ctx.lineTo(cx - s * 0.12, s * 0.92);
  ctx.lineTo(cx - s * 0.12, s * 0.45);
  ctx.lineTo(cx - s * 0.3, s * 0.45);
  ctx.closePath();
  ctx.fill();
}

function drawRoundel(ctx, s, text) {
  ctx.clearRect(0, 0, s, s);
  const cx = s / 2, cy = s / 2;
  ctx.lineWidth = s * 0.07;
  ctx.strokeStyle = '#e84848';
  ctx.beginPath();
  ctx.arc(cx, cy, s * 0.4, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = s * 0.025;
  ctx.beginPath();
  ctx.arc(cx, cy, s * 0.3, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = '#e84848';
  ctx.font = `bold ${s * 0.22}px "Arial Black", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text || 'OK', cx, cy);
}

const textureCache = new Map();

export function makePatternTexture(pattern, text) {
  const key = `${pattern}::${text || ''}`;
  if (textureCache.has(key)) return textureCache.get(key);

  const [canvas, ctx] = makeCanvas();
  switch (pattern) {
    case 'stripes': drawStripes(ctx, 512); break;
    case 'arrow': drawArrow(ctx, 512); break;
    case 'roundel': drawRoundel(ctx, 512, text); break;
    case 'plate':
    default: drawPlate(ctx, 512, text); break;
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  textureCache.set(key, tex);
  return tex;
}
