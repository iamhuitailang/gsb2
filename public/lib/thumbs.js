// 用 <video> + canvas 在浏览器本地截取缩略图（不需要往返服务端）。
import { loadVideo } from './dom.js';

const cache = new Map(); // `${src}@${t}` -> dataURL

export async function thumbnailAt(video, t, { width = 160, height = 90 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#05070b';
  ctx.fillRect(0, 0, width, height);
  await seek(video, t);
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (vw && vh) {
    const scale = Math.max(width / vw, height / vh);
    const w = vw * scale;
    const h = vh * scale;
    ctx.drawImage(video, (width - w) / 2, (height - h) / 2, w, h);
  }
  return canvas.toDataURL('image/jpeg', 0.6);
}

function seek(video, t) {
  return new Promise((resolve) => {
    const target = Math.max(0, Math.min(t, Math.max(0, (video.duration || 0) - 0.001)));
    if (Math.abs(video.currentTime - target) < 0.02) return resolve();
    const done = () => { video.removeEventListener('seeked', done); clearTimeout(timer); resolve(); };
    const timer = setTimeout(done, 600);
    video.addEventListener('seeked', done);
    try { video.currentTime = target; } catch { done(); }
  });
}

// 为一段素材生成横向拼接的胶片条（若干帧拼成一张图）。
export async function filmstrip(src, inSec, outSec, { frames = 5, width = 96, height = 54 } = {}) {
  const key = `${src}@${inSec.toFixed(2)}-${outSec.toFixed(2)}-${frames}`;
  if (cache.has(key)) return cache.get(key);
  try {
    const video = await loadVideo(src);
    const cols = Math.max(1, frames);
    const canvas = document.createElement('canvas');
    canvas.width = width * cols;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#05070b';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const span = Math.max(0.001, outSec - inSec);
    for (let i = 0; i < cols; i++) {
      const t = inSec + (span * (i + 0.5)) / cols;
      await seek(video, t);
      drawCover(ctx, video, width, height, i * width, 0);
    }
    video.removeAttribute('src');
    video.load();
    const url = canvas.toDataURL('image/jpeg', 0.55);
    cache.set(key, url);
    return url;
  } catch {
    return null;
  }
}

function drawCover(ctx, video, w, h, ox, oy) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return;
  const scale = Math.max(w / vw, h / vh);
  ctx.save();
  ctx.beginPath();
  ctx.rect(ox, oy, w, h);
  ctx.clip();
  ctx.drawImage(video, ox + (w - vw * scale) / 2, oy + (h - vh * scale) / 2, vw * scale, vh * scale);
  ctx.restore();
}
