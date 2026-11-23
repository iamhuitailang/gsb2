// 预览引擎：为每个源建立 <video>，按统一时间线把当前帧画到 canvas。
//
// - 叠化时同时绘制两层，按 alpha 混合。
// - 不同帧率的源按「统一时间 → 各源时间 → 各源帧号」定位，因此同一时间点总能对齐。
// - 播放时让相关视频自播，并按需纠正漂移；暂停 / 逐帧时精确 seek。
// - 视频本身静音，声音由 AuditionEngine 单独调度。
import { loadVideo } from './dom.js';
import { videoLayersAt } from '../../src/timeline.js';

export class PreviewEngine {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.videos = new Map(); // clipId -> { video, ready }
    this.loading = new Map();
    this.lastDraw = null;
    this.playing = false;
    this.seekQueue = Promise.resolve();
    this.frameCallback = null;
    this.drawGen = 0;
    this.usingRVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
  }

  setAspect(width, height) {
    const ar = width / height;
    if (!Number.isFinite(ar) || ar <= 0) return;
    this.canvas.style.aspectRatio = `${width} / ${height}`;
  }

  async ensure(clip) {
    if (this.videos.has(clip.id)) return this.videos.get(clip.id);
    if (this.loading.has(clip.id)) return this.loading.get(clip.id);
    const p = loadVideo(clip.src)
      .then((video) => {
        const entry = { video, clipId: clip.id, ready: true };
        this.videos.set(clip.id, entry);
        this.loading.delete(clip.id);
        return entry;
      })
      .catch((err) => {
        this.loading.delete(clip.id);
        throw err;
      });
    this.loading.set(clip.id, p);
    return p;
  }

  async prepareAll(clips) {
    await Promise.all(clips.map((c) => this.ensure(c).catch(() => null)));
  }

  disposeClip(id) {
    const entry = this.videos.get(id);
    if (!entry) return;
    try { entry.video.pause(); } catch { /* noop */ }
    entry.video.removeAttribute('src');
    entry.video.load();
    this.videos.delete(id);
  }

  videoFor(clipId) {
    return this.videos.get(clipId)?.video || null;
  }

  // 在统一时间 t 拉取两层视频的帧并绘制。返回 {layers}
  async drawAt(timeline, t, { exact = true } = {}) {
    const gen = ++this.drawGen;
    const layers = videoLayersAt(timeline, t);
    this.lastDraw = { t, layers };
    if (!layers.length) {
      this.clear();
      return this.lastDraw;
    }
    const entries = [];
    for (const layer of layers) {
      const row = timeline.clips[layer.clipIndex];
      try {
        const entry = await this.ensure(row.clip);
        entries.push({ entry, layer, row });
      } catch {
        /* skip missing */
      }
    }
    if (gen !== this.drawGen) return this.lastDraw; // 有更新的绘制请求，丢弃这次
    if (!entries.length) {
      this.clear();
      return this.lastDraw;
    }

    if (exact) {
      await Promise.all(entries.map(({ entry, layer }) => this.seekAndWait(entry.video, layer.srcTime)));
    } else {
      entries.forEach(({ entry, layer }) => this.correctDrift(entry.video, layer.srcTime));
    }
    if (gen !== this.drawGen) return this.lastDraw;
    this.paint(entries);
    return this.lastDraw;
  }

  async seekAndWait(video, srcTime) {
    const target = Math.max(0, Math.min(srcTime, Math.max(0, (video.duration || 0) - 0.001)));
    if (Math.abs(video.currentTime - target) < 0.002 && video.readyState >= 2) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, 700);
      const onSeeked = () => {
        if (this.usingRVFC) {
          // seeked 之后再来一帧，确保画面已解码
          video.requestVideoFrameCallback(finish);
          setTimeout(finish, 120);
        } else {
          finish();
        }
      };
      video.addEventListener('seeked', onSeeked, { once: true });
      try { video.currentTime = target; } catch { finish(); }
    });
  }

  correctDrift(video, srcTime) {
    if (video.readyState < 2) return;
    const drift = video.currentTime - srcTime;
    if (Math.abs(drift) > 0.28) {
      try { video.currentTime = Math.max(0, srcTime); } catch { /* noop */ }
    }
    if (video.paused) {
      video.play().catch(() => { /* 需要用户手势时忽略 */ });
    }
  }

  pauseAll() {
    for (const { video } of this.videos.values()) {
      try { video.pause(); } catch { /* noop */ }
    }
  }

  playLayers(timeline, t, speed = 1) {
    const layers = videoLayersAt(timeline, t);
    const active = new Set();
    for (const layer of layers) {
      const row = timeline.clips[layer.clipIndex];
      const entry = this.videos.get(row.clip.id);
      if (!entry) continue;
      active.add(entry.video);
      const v = entry.video;
      if (v.readyState < 1) continue;
      const drift = v.currentTime - layer.srcTime;
      if (Math.abs(drift) > 0.22) {
        try { v.currentTime = Math.max(0, layer.srcTime); } catch { /* noop */ }
      }
      v.playbackRate = speed;
      if (v.paused) v.play().catch(() => { /* 忽略 */ });
    }
    for (const { video } of this.videos.values()) {
      if (!active.has(video) && !video.paused) {
        try { video.pause(); } catch { /* noop */ }
      }
    }
  }

  paint(entries) {
    const { canvas, ctx } = this;
    const cw = canvas.width;
    const ch = canvas.height;
    ctx.fillStyle = '#05070b';
    ctx.fillRect(0, 0, cw, ch);
    for (const { entry, layer } of entries) {
      const v = entry.video;
      if (!v.videoWidth || !v.videoHeight) continue;
      // 播放中两层都要画；暂停精确绘制时也按 alpha 叠加
      const alpha = Math.max(0, Math.min(1, layer.weight));
      if (alpha <= 0.001) continue;
      ctx.globalAlpha = alpha;
      drawCover(ctx, v, cw, ch);
    }
    ctx.globalAlpha = 1;
  }

  // 播放中：直接用视频元素当前帧按权重合成（不 seek）。
  paintAt(timeline, t) {
    const layers = videoLayersAt(timeline, t);
    this.lastDraw = { t, layers };
    const entries = [];
    for (const layer of layers) {
      const row = timeline.clips[layer.clipIndex];
      const entry = row ? this.videos.get(row.clip.id) : null;
      if (entry) entries.push({ entry, layer });
    }
    if (!entries.length) {
      this.clear();
      return this.lastDraw;
    }
    this.paint(entries);
    return this.lastDraw;
  }

  clear() {
    const { ctx, canvas } = this;
    ctx.fillStyle = '#05070b';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  // 独立绘制某段源在统一时间 t 的帧到另一个 canvas（用于转场两侧对照）。
  async drawSourceFrame(timeline, clipIndex, t, canvas) {
    const row = timeline.clips[clipIndex];
    if (!row) return null;
    const entry = await this.ensure(row.clip);
    const local = Math.max(0, Math.min(t - row.start, Math.max(0, row.len - 1e-6)));
    const srcTime = Math.max(row.srcIn, Math.min(row.srcIn + local, row.srcOut - 1e-6));
    await this.seekAndWait(entry.video, srcTime);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#05070b';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (entry.video.videoWidth) drawCover(ctx, entry.video, canvas.width, canvas.height);
    const srcFps = row.srcFps;
    const frame = Math.max(Math.round(row.srcIn * srcFps),
      Math.min(Math.floor(srcTime * srcFps + 1e-6), Math.ceil(row.srcOut * srcFps - 1e-6) - 1));
    return { srcTime, frame, srcFps, outFps: timeline.fps, row };
  }
}

export function drawCover(ctx, video, cw, ch) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return;
  const scale = Math.max(cw / vw, ch / vh);
  const w = vw * scale;
  const h = vh * scale;
  const x = (cw - w) / 2;
  const y = (ch - h) / 2;
  ctx.drawImage(video, x, y, w, h);
}
