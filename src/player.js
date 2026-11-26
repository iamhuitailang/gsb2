// 播放引擎：单一时间线时钟驱动所有机位。
//
// 关键设计：
// 1. 时间只有一个权威来源（performance.now 换算的时间线秒），机位切换只换
//    显示的素材，时钟不重置 -> 预览中切换机位不会产生时间跳跃。
// 2. 每帧把权威时间映射回当前段机位的「素材内时间」，按该素材帧率取整帧，
//    切点因此天然按帧对齐，不会出现半帧画面。
// 3. 素材越界（before/after/缺失）时绘制斜纹警示卡，绝不静音补黑帧。
// 4. 同时只有当前段素材出声，其余全部静音暂停。

import { segmentAt, coverageAt, getSource } from './core/model.js';
import { parseFps, formatTimecode, formatSeconds } from './core/time.js';

export class Player {
  // 逻辑绘制分辨率：所有绘制代码都基于这个坐标系，DPR 仅用于高清放大
  static LOGICAL_W = 960;
  static LOGICAL_H = 540;

  constructor(canvas, mediaStore, getProject) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.mediaStore = mediaStore;
    this.getProject = getProject;

    this.playing = false;
    this.timelineTime = 0; // 权威时间线时间（秒）
    this.playStartClock = 0; // performance.now()
    this.playStartTimeline = 0;
    this.rafId = 0;

    this.activeSourceId = null; // 当前正在驱动画面/声音的素材
    this.lastShownFrame = new Map(); // sourceId -> 上次显示的素材帧号
    this.onFrame = null; // 每帧回调，UI 用来刷新播放头位置

    this.syncPixelRatio();
    window.addEventListener('resize', () => this.syncPixelRatio());
  }

  /** 按设备像素比设置 backing store，逻辑坐标系始终保持 960x540。 */
  syncPixelRatio() {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(Player.LOGICAL_W * dpr);
    this.canvas.height = Math.round(Player.LOGICAL_H * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** 绘制代码统一使用逻辑尺寸（物理像素已由 setTransform 缩放）。 */
  get viewW() {
    return Player.LOGICAL_W;
  }
  get viewH() {
    return Player.LOGICAL_H;
  }

  /** 定位到时间线 t（暂停状态也会立即重绘一帧）。 */
  seek(t) {
    this.timelineTime = t;
    this.renderFrame(t);
    this.onFrame?.(t);
  }

  play() {
    if (this.playing) return;
    const { max } = this.currentBounds();
    if (this.timelineTime >= max) this.timelineTime = this.currentBounds().min;
    this.playing = true;
    this.playStartClock = performance.now();
    this.playStartTimeline = this.timelineTime;
    this.loop();
  }

  pause() {
    this.playing = false;
    cancelAnimationFrame(this.rafId);
    this.deactivateAll();
  }

  toggle() {
    this.playing ? this.pause() : this.play();
  }

  currentBounds() {
    const b = requireBounds(this.getProject());
    return b;
  }

  loop = () => {
    if (!this.playing) return;
    const t = this.playStartTimeline + (performance.now() - this.playStartClock) / 1000;
    const { max } = this.currentBounds();
    if (t >= max) {
      this.timelineTime = max;
      this.pause();
      this.renderFrame(max);
      this.onFrame?.(max);
      return;
    }
    this.timelineTime = t;
    this.renderFrame(t);
    this.onFrame?.(t);
    this.rafId = requestAnimationFrame(this.loop);
  };

  /** 核心：把时间线时间渲染成一帧。 */
  renderFrame(t) {
    const project = this.getProject();
    const seg = segmentAt(project, t);
    if (!seg) {
      this.deactivateAll();
      this.drawNotice('时间线为空', '导入素材后在此预览');
      return;
    }
    const cov = coverageAt(project, seg.sourceId, t);
    const item = this.mediaStore.get(seg.sourceId);

    // 先把非当前机位全部静音/暂停，保证任意时刻只有一路声音
    this.activateOnly(seg.sourceId);

    if (cov.status !== 'ok' || !item) {
      // 越界或素材未重新载入：显式警示，不补黑帧
      this.pauseElement(item);
      this.drawOutOfRange(cov, seg, t);
      return;
    }

    const src = cov.source;
    const fps = parseFps(src.fps);
    const frame = cov.frame;
    // 视频吸附到整帧；纯音频没有帧网格，直接用连续素材时间
    const sourceT = src.kind === 'video' ? frame / fps : cov.sourceT;

    if (src.kind === 'audio') {
      this.drawAudioCard(src, cov, t);
    } else {
      const video = item.element;
      const last = this.lastShownFrame.get(src.id);
      if (last !== frame) {
        // 显式 seek 到整帧：切换机位/切点处不会漂在两帧之间
        trySeek(video, sourceT);
        this.lastShownFrame.set(src.id, frame);
      }
      this.drawVideoFrame(video, src, cov, t);
    }
    this.syncAudio(item, sourceT, t);
  }

  activateOnly(sourceId) {
    if (this.activeSourceId === sourceId) return;
    const project = this.getProject();
    for (const src of project.sources) {
      const item = this.mediaStore.get(src.id);
      if (!item) continue;
      if (src.id === sourceId) {
        item.element.muted = false;
      } else {
        item.element.muted = true;
        this.pauseElement(item);
      }
    }
    this.activeSourceId = sourceId;
  }

  deactivateAll() {
    for (const item of this.mediaStore.items.values()) {
      item.element.muted = true;
      this.pauseElement(item);
    }
    this.activeSourceId = null;
  }

  /** 声音跟随权威时钟；只有播放中才让元素发声，暂停即停。 */
  syncAudio(item, sourceT, timelineT) {
    if (!item || !item.audioBuffer) return;
    const el = item.element;
    if (!this.playing) {
      this.pauseElement(item);
      return;
    }
    el.muted = false;
    el.playbackRate = 1;
    const drift = Math.abs(el.currentTime - sourceT);
    if (el.paused || drift > 0.08) {
      trySeek(el, sourceT);
      el.play().catch(() => {});
    }
  }

  pauseElement(item) {
    if (!item) return;
    const el = item.element;
    if (!el.paused) el.pause();
  }

  // ---------- 画布绘制 ----------

  drawVideoFrame(video, src, cov, t) {
    const ctx = this.ctx;
    const w = this.viewW;
    const h = this.viewH;
    ctx.fillStyle = '#0b0e14';
    ctx.fillRect(0, 0, w, h);
    if (video.videoWidth > 0) {
      // contain 适配，保持像素比
      const scale = Math.min(w / video.videoWidth, h / video.videoHeight);
      const dw = video.videoWidth * scale;
      const dh = video.videoHeight * scale;
      ctx.drawImage(video, (w - dw) / 2, (h - dh) / 2, dw, dh);
    }
    this.drawHud(src, cov, t);
  }

  drawAudioCard(src, cov, t) {
    const ctx = this.ctx;
    const w = this.viewW;
    const h = this.viewH;
    ctx.fillStyle = '#101826';
    ctx.fillRect(0, 0, w, h);
    const item = this.mediaStore.get(src.id);
    if (item?.peaks) this.drawWaveform(item.peaks, cov.sourceT / src.duration);
    ctx.fillStyle = '#7dd3fc';
    ctx.font = '600 28px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`🎧 纯音频机位：${src.name}`, w / 2, h / 2 - 40);
    this.drawHud(src, cov, t);
  }

  drawWaveform(peaks, progress) {
    const ctx = this.ctx;
    const w = this.viewW;
    const h = this.viewH;
    const mid = h / 2;
    const bw = w / peaks.length;
    ctx.strokeStyle = '#1e3a5f';
    ctx.lineWidth = Math.max(1, bw * 0.7);
    ctx.beginPath();
    peaks.forEach((p, i) => {
      const x = i * bw;
      ctx.moveTo(x, mid + p.min * h * 0.28);
      ctx.lineTo(x, mid + p.max * h * 0.28);
    });
    ctx.stroke();
    if (Number.isFinite(progress)) {
      ctx.strokeStyle = '#38bdf8';
      ctx.beginPath();
      ctx.moveTo(w * clamp01(progress), 0);
      ctx.lineTo(w * clamp01(progress), h);
      ctx.stroke();
    }
  }

  /** 越界警示卡：斜纹 + 原因 + 时间线/素材时间，明确替代黑帧。 */
  drawOutOfRange(cov, seg, t) {
    const ctx = this.ctx;
    const w = this.viewW;
    const h = this.viewH;
    ctx.fillStyle = '#1a1207';
    ctx.fillRect(0, 0, w, h);
    // 黄黑斜纹
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.clip();
    ctx.strokeStyle = 'rgba(250, 204, 21, 0.35)';
    ctx.lineWidth = 18;
    for (let x = -h; x < w + h; x += 36) {
      ctx.beginPath();
      ctx.moveTo(x, h);
      ctx.lineTo(x + h, 0);
      ctx.stroke();
    }
    ctx.restore();

    const src = cov.source || getSource(this.getProject(), seg.sourceId);
    const title =
      cov.status === 'before'
        ? '⚠ 素材尚未开始'
        : cov.status === 'after'
          ? '⚠ 素材已经结束'
          : '⚠ 素材缺失（工程引用的本地文件未重新载入）';
    ctx.fillStyle = '#facc15';
    ctx.font = '700 34px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(title, w / 2, h / 2 - 30);
    ctx.fillStyle = '#e2e8f0';
    ctx.font = '18px system-ui, sans-serif';
    const lines = [
      `机位：${src ? src.name : seg.sourceId}`,
      `时间线时间：${formatSeconds(t)}s（${formatTimecode(t, src?.fps || 30)}）`,
    ];
    if (src) {
      lines.push(
        `素材范围：${formatSeconds(0)} ~ ${formatSeconds(src.duration)}s，` +
          `映射到素材时间：${formatSeconds(t - src.offset)}s`,
      );
      lines.push(`该机位在时间线上的覆盖区间：${formatSeconds(src.offset)} ~ ${formatSeconds(src.offset + src.duration)}s`);
    }
    lines.push('此段不会被黑帧填充；请调整切点、机位或素材偏移');
    lines.forEach((line, i) => ctx.fillText(line, w / 2, h / 2 + 14 + i * 28));
  }

  drawNotice(title, sub) {
    const ctx = this.ctx;
    ctx.fillStyle = '#0b0e14';
    ctx.fillRect(0, 0, this.viewW, this.viewH);
    ctx.fillStyle = '#94a3b8';
    ctx.font = '600 26px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(title, this.viewW / 2, this.viewH / 2 - 8);
    ctx.font = '16px system-ui, sans-serif';
    ctx.fillText(sub, this.viewW / 2, this.viewH / 2 + 24);
  }

  drawHud(src, cov, t) {
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, this.viewH - 42, this.viewW, 42);
    ctx.fillStyle = '#e6edf3';
    ctx.font = '15px system-ui, sans-serif';
    ctx.textAlign = 'left';
    const fps = parseFps(src.fps);
    const left =
      src.kind === 'audio'
        ? `${src.name}  |  纯音频  |  素材 ${formatSeconds(cov.sourceT)}s / ${formatSeconds(src.duration)}s`
        : `${src.name}  |  帧 ${cov.frame}/${cov.frameCount}  |  素材 ${formatSeconds(cov.sourceT)}s`;
    ctx.fillText(left, 14, this.viewH - 16);
    ctx.textAlign = 'right';
    ctx.fillText(
      `时间线 ${formatSeconds(t)}s  ${formatTimecode(t, fps)}`,
      this.viewW - 14,
      this.viewH - 16,
    );
  }
}

function requireBounds(project) {
  if (project.sources.length === 0) return { min: 0, max: 0, duration: 0 };
  let min = Infinity;
  let max = -Infinity;
  for (const s of project.sources) {
    min = Math.min(min, s.offset);
    max = Math.max(max, s.offset + s.duration);
  }
  return { min, max, duration: max - min };
}

function trySeek(el, t) {
  try {
    el.currentTime = Math.max(0, t);
  } catch {
    // 元数据未就绪时忽略，下一帧会再次尝试
  }
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}
