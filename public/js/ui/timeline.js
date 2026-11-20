import { clamp, formatTimecode, roundSeconds } from '../core/time.js';
import { assignLanes, coverageStats } from '../core/layout.js';
import { clampView, fitView, timeToX, visibleRange, xToTime, zoomAt, scrollToInclude } from '../core/view.js';
import { peakInRange } from '../audio/peaks.js';

const COLORS = {
  bg: '#0f151d',
  rulerBgTop: '#121a24',
  grid: 'rgba(148, 163, 184, 0.09)',
  gridStrong: 'rgba(148, 163, 184, 0.2)',
  wave: '#5b738a',
  waveFill: 'rgba(91, 115, 138, 0.32)',
  waveDim: 'rgba(91, 115, 138, 0.16)',
  center: 'rgba(148, 163, 184, 0.28)',
  playhead: '#f2b45e',
  active: 'rgba(242, 180, 94, 0.1)',
  laneLine: 'rgba(148, 163, 184, 0.07)',
  text: '#e8eef6',
  textMuted: '#93a4b8',
  selection: '#f2b45e',
};

const GEOMETRY = {
  topPad: 10,
  bottomPad: 14,
  laneHeight: 30,
  laneGap: 6,
  get laneStride() {
    return this.laneHeight + this.laneGap;
  },
};

function hexToRgba(hex, alpha) {
  if (typeof hex !== 'string') return `rgba(148, 163, 184, ${alpha})`;
  let value = hex.replace('#', '');
  if (value.length === 3) value = value.split('').map((c) => c + c).join('');
  const int = Number.parseInt(value.slice(0, 6), 16);
  if (!Number.isFinite(int)) return `rgba(148, 163, 184, ${alpha})`;
  const r = (int >> 16) & 255;
  const g = (int >> 8) & 255;
  const b = int & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** 计算「好看」的时间刻度间隔（秒）。 */
function niceStep(pxPerSecond, minPx = 78) {
  const target = minPx / Math.max(0.01, pxPerSecond);
  const power = 10 ** Math.floor(Math.log10(target));
  const candidates = [1, 2, 5, 10];
  for (const factor of candidates) {
    if (power * factor >= target) return power * factor;
  }
  return power * 10;
}

function stepDecimals(step) {
  if (step >= 1) return 0;
  if (step >= 0.1) return 1;
  if (step >= 0.01) return 2;
  return 3;
}

function formatTick(time, step) {
  const decimals = stepDecimals(step);
  return formatTimecode(time, { decimals });
}

function roundedRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, h / 2, w / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.arcTo(x + w, y, x + w, y + radius, radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius);
  ctx.lineTo(x + radius, y + h);
  ctx.arcTo(x, y + h, x, y + h - radius, radius);
  ctx.lineTo(x, y + radius);
  ctx.arcTo(x, y, x + radius, y, radius);
  ctx.closePath();
}

/**
 * 时间轴视图。负责绘制与指针交互，不直接修改文档：
 * 所有编辑通过回调交给应用层，时间始终以秒计算。
 */
export class Timeline {
  constructor({ rulerCanvas, waveCanvas, overlayCanvas, overviewCanvas, lanesScroll, lanesInner, shell, tooltip, store, engine, handlers }) {
    this.rulerCanvas = rulerCanvas;
    this.waveCanvas = waveCanvas;
    this.overlayCanvas = overlayCanvas;
    this.overviewCanvas = overviewCanvas;
    this.lanesScroll = lanesScroll;
    this.lanesInner = lanesInner;
    this.shell = shell;
    this.tooltip = tooltip;
    this.store = store;
    this.engine = engine;
    this.handlers = handlers;

    this.view = { ...store.doc.view };
    this.cache = null;
    this.contentWidth = 800;
    this.contentHeight = 300;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.selection = null;
    this.activeIds = new Set();
    this.drag = null;
    this.hover = null;
    this.follow = true;
    this.snapEnabled = true;
    this.playheadOverride = null;
    this.raf = 0;
    this.needsBaseRender = true;
    this.laneById = new Map();
    this.laneCount = 1;
    this.stats = null;

    this.bindEvents();
    this.resize();
    this.startLoop();
  }

  /** 音频本身的时长（没有音频时为 0），用于限制新建区间和播放。 */
  get audioDuration() {
    return this.store.duration || 0;
  }

  /** 新建/拖动区间时允许的时间范围：有音频就到音频结尾，没有音频则不限制。 */
  get bounds() {
    const audioDuration = this.audioDuration;
    return audioDuration > 0 ? audioDuration : Infinity;
  }

  get duration() {
    // 时间轴长度取音频时长与最晚区间结尾的较大值：
    // 既保证没有音频时（仅导入标注）也能滚动查看，也能展示超出音频的标注。
    const audioDuration = this.store.duration || 0;
    const regionEnd = this.store.doc.regions.reduce((max, region) => Math.max(max, region.end), 0);
    return Math.max(audioDuration, regionEnd);
  }

  setCache(cache) {
    this.cache = cache;
    this.needsBaseRender = true;
    this.render();
  }

  setSelection(id) {
    if (this.selection === id) return;
    this.selection = id;
    this.updateActive();
    this.needsBaseRender = true;
    this.render();
  }

  setPlayheadOverride(time) {
    this.playheadOverride = time;
  }

  get playheadTime() {
    if (this.playheadOverride !== null) return this.playheadOverride;
    return this.engine?.time ?? 0;
  }

  setView(view, { persist = true } = {}) {
    const duration = this.duration;
    this.view = clampView(view, duration || Math.max(view.start + 1, 10), this.contentWidth);
    if (persist) this.store.setView(this.view);
    this.needsBaseRender = true;
    this.render();
  }

  applyDurationView({ fit = false } = {}) {
    const duration = this.duration;
    if (duration > 0) {
      if (fit) {
        this.view = fitView(duration, this.contentWidth);
      } else {
        const saved = this.store.doc.view;
        // 优先恢复工程里保存的缩放/位置（时间以秒保存，与窗口宽度无关）
        this.view = clampView(
          { start: saved?.start ?? this.view.start, pxPerSecond: saved?.pxPerSecond ?? this.view.pxPerSecond },
          duration,
          this.contentWidth,
        );
      }
      this.store.setView(this.view);
    }
    this.needsBaseRender = true;
    this.recomputeLanes();
    this.ensureHeight();
    this.render();
  }

  refresh({ keepView = true, freezeLanes = false } = {}) {
    if (!keepView) this.applyDurationView();
    this.view = clampView(this.view, this.duration || Math.max(10, this.view.start + 1), this.contentWidth);
    if (freezeLanes && this.drag?.frozenLanes) {
      // 拖动期间冻结泳道，避免区间跨泳道跳动影响手感
      this.laneById = this.drag.frozenLanes;
      this.laneCount = this.drag.frozenLaneCount;
      this.stats = coverageStats(this.store.doc.regions, this.duration);
    } else {
      this.recomputeLanes();
      this.ensureHeight();
    }
    this.needsBaseRender = true;
    this.render();
  }

  recomputeLanes() {
    const regions = this.store.doc.regions;
    const { laneById, laneCount } = assignLanes(regions);
    this.laneById = laneById;
    this.laneCount = laneCount;
    this.stats = coverageStats(regions, this.duration);
  }

  /** 泳道数量变化时同步画布高度，超出容器则出现纵向滚动。 */
  ensureHeight() {
    const laneHeight = GEOMETRY.topPad + this.laneCount * GEOMETRY.laneStride() + GEOMETRY.bottomPad;
    const container = Math.max(140, this.lanesScroll.clientHeight - 2);
    const target = Math.max(container, laneHeight);
    if (target === this.contentHeight && this.waveCanvas.width > 0) return;
    this.resize();
  }

  /* ------------------------------ layout ------------------------------ */

  resize() {
    const width = Math.max(200, this.lanesScroll.clientWidth);
    const laneHeight = GEOMETRY.topPad + this.laneCount * GEOMETRY.laneStride() + GEOMETRY.bottomPad;
    const height = Math.max(this.lanesScroll.clientHeight - 2, laneHeight, 140);
    const pixelWidth = Math.round(width * this.dpr);
    const pixelHeight = Math.round(height * this.dpr);
    const overviewWidth = Math.max(80, this.overviewCanvas.clientWidth);
    const overviewHeight = Math.round(34 * this.dpr);

    if (
      width === this.contentWidth &&
      height === this.contentHeight &&
      this.waveCanvas.width === pixelWidth &&
      this.waveCanvas.height === pixelHeight &&
      this.overviewWidth === overviewWidth
    ) {
      // 尺寸没变就不要重设 canvas（重设会清空画布并触发 ResizeObserver 抖动），
      // 但仍要保证首次/待重绘的内容画出来。
      if (this.needsBaseRender) this.render();
      return;
    }
    this.contentWidth = width;
    this.contentHeight = height;

    this.rulerCanvas.style.width = `${width}px`;
    this.rulerCanvas.width = pixelWidth;
    this.rulerCanvas.height = Math.round(30 * this.dpr);

    this.waveCanvas.style.width = `${width}px`;
    this.waveCanvas.style.height = `${height}px`;
    this.waveCanvas.width = pixelWidth;
    this.waveCanvas.height = pixelHeight;

    this.overlayCanvas.style.width = `${width}px`;
    this.overlayCanvas.style.height = `${height}px`;
    this.overlayCanvas.width = pixelWidth;
    this.overlayCanvas.height = pixelHeight;

    this.lanesInner.style.height = `${height}px`;

    this.overviewCanvas.width = Math.round(overviewWidth * this.dpr);
    this.overviewCanvas.height = overviewHeight;
    this.overviewWidth = overviewWidth;

    this.view = clampView(this.view, this.duration || Math.max(10, this.view.start + 1), this.contentWidth);
    this.needsBaseRender = true;
    this.render();
  }

  regionRect(region) {
    const lane = this.laneById.get(region.id) ?? 0;
    const x = timeToX(region.start, this.view);
    const w = Math.max(2, (region.end - region.start) * this.view.pxPerSecond);
    const y = GEOMETRY.topPad + lane * GEOMETRY.laneStride() + GEOMETRY.laneGap / 2;
    return { x, y, w, h: GEOMETRY.laneHeight, lane };
  }

  /* ------------------------------ drawing ------------------------------ */

  render() {
    if (this.needsBaseRender) {
      this.drawBase();
      this.drawRuler();
      this.drawOverview();
      this.needsBaseRender = false;
    }
    this.drawOverlay();
  }

  drawBase() {
    const ctx = this.waveCanvas.getContext('2d');
    const width = this.contentWidth;
    const height = this.contentHeight;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, width, height);

    const { span } = visibleRange(this.view, width);

    // 时间网格
    const step = niceStep(this.view.pxPerSecond);
    const first = Math.floor(this.view.start / step) * step;
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    for (let t = first; t <= this.view.start + span + step; t += step) {
      if (t < 0) continue;
      const x = Math.round(timeToX(t, this.view)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }

    // 泳道分隔
    ctx.strokeStyle = COLORS.laneLine;
    for (let lane = 1; lane < this.laneCount; lane += 1) {
      const y = Math.round(GEOMETRY.topPad + lane * GEOMETRY.laneStride() - GEOMETRY.laneGap / 2) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    this.drawWaveform(ctx, width, height);

    // 空白/重叠等无法靠波形直接看出的区域用极淡底色提示
    if (this.stats) {
      ctx.fillStyle = 'rgba(251, 113, 133, 0.025)';
      for (const gap of this.stats.gaps) {
        const x = Math.max(0, timeToX(gap.start, this.view));
        const w = Math.min(width, timeToX(gap.end, this.view)) - x;
        if (w > 1) ctx.fillRect(x, 0, w, height);
      }
    }

    for (const region of this.store.sortedRegions()) {
      this.drawRegion(ctx, region);
    }

    if (this.drag?.type === 'create' && this.drag.preview) {
      const { start, end } = this.drag.preview;
      const x = timeToX(start, this.view);
      const w = Math.max(2, (end - start) * this.view.pxPerSecond);
      const y = GEOMETRY.topPad;
      const h = Math.max(GEOMETRY.laneHeight, this.laneCount * GEOMETRY.laneStride() - GEOMETRY.laneGap);
      ctx.save();
      ctx.fillStyle = 'rgba(242, 180, 94, 0.14)';
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = COLORS.selection;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
      ctx.restore();
    }
  }

  drawWaveform(ctx, width, height) {
    // 波形以「泳道带」为中心绘制，这样与标注区间垂直对齐；
    // 画布底部多余的空间留白，方便上下滚动查看多泳道标注。
    const bandTop = GEOMETRY.topPad;
    const bandBottom = GEOMETRY.topPad + this.laneCount * GEOMETRY.laneStride() - GEOMETRY.laneGap;
    const centerY = (bandTop + bandBottom) / 2;
    const amp = Math.max(10, (bandBottom - bandTop) / 2 - 3);
    ctx.strokeStyle = COLORS.center;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, Math.round(centerY) + 0.5);
    ctx.lineTo(width, Math.round(centerY) + 0.5);
    ctx.stroke();

    if (!this.cache || !this.cache.min) return;
    const sampleRate = this.cache.sampleRate;
    const pps = this.view.pxPerSecond;
    const samplesPerPx = sampleRate / pps;

    if (samplesPerPx > 2.5 || !this.cache.raw) {
      // 常规缩放：填充包络
      const path = new Path2D();
      const top = [];
      const bottom = [];
      for (let x = 0; x <= width; x += 1) {
        const t0 = this.view.start + x / pps;
        const s0 = Math.max(0, t0 * sampleRate);
        const s1 = Math.min(this.cache.length, (t0 + 1 / pps) * sampleRate);
        const { min, max } = peakInRange(this.cache, s0, s1);
        top.push([x, centerY - max * amp]);
        bottom.push([x, centerY - min * amp]);
      }
      path.moveTo(top[0][0], top[0][1]);
      for (const [x, y] of top) path.lineTo(x, y);
      for (let i = bottom.length - 1; i >= 0; i -= 1) path.lineTo(bottom[i][0], bottom[i][1]);
      path.closePath();
      ctx.fillStyle = COLORS.waveFill;
      ctx.fill(path);
      ctx.strokeStyle = 'rgba(120, 148, 172, 0.55)';
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      for (const [x, y] of top) {
        if (x === top[0][0]) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.beginPath();
      for (const [x, y] of bottom) {
        if (x === bottom[0][0]) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      return;
    }

    // 高倍缩放：逐采样折线 + 采样点
    const startSample = Math.max(0, Math.floor(this.view.start * sampleRate));
    const endSample = Math.min(this.cache.length, Math.ceil((this.view.start + width / pps) * sampleRate));
    ctx.strokeStyle = 'rgba(132, 160, 186, 0.9)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    let started = false;
    for (let s = startSample; s <= endSample; s += 1) {
      const x = timeToX(s / sampleRate, this.view);
      const value = this.cache.raw ? this.cache.raw[s] ?? 0 : 0;
      const y = centerY - value * amp;
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
    if (pps > 400) {
      ctx.fillStyle = 'rgba(200, 220, 240, 0.55)';
      for (let s = startSample; s <= endSample; s += 1) {
        const x = timeToX(s / sampleRate, this.view);
        const value = this.cache.raw ? this.cache.raw[s] ?? 0 : 0;
        ctx.fillRect(x - 1, centerY - value * amp - 1, 2, 2);
      }
    }
  }

  drawRegion(ctx, region) {
    const { x, y, w, h } = this.regionRect(region);
    if (x > this.contentWidth || x + w < 0) return;
    const label = this.store.regionLabel(region);
    const speaker = this.store.regionSpeaker(region);
    const color = label?.color ?? '#94a3b8';
    const selected = this.selection === region.id;
    const confidenceAlpha = region.confidence === 'certain' ? 1 : 0.85;

    ctx.save();
    // 主体
    roundedRect(ctx, x, y, w, h, 5);
    ctx.fillStyle = hexToRgba(color, selected ? 0.3 : 0.17);
    ctx.fill();

    // 左侧色条 + 顶边
    ctx.save();
    ctx.clip();
    ctx.fillStyle = hexToRgba(color, 0.95);
    ctx.fillRect(x, y, Math.min(3.5, w), h);
    ctx.restore();

    // 置信状态：存疑/听不清加虚线轮廓
    ctx.lineWidth = selected ? 2 : 1;
    ctx.strokeStyle = selected ? '#ffd79a' : hexToRgba(color, 0.65 * confidenceAlpha);
    if (region.confidence !== 'certain') {
      ctx.setLineDash(region.confidence === 'inaudible' ? [3, 3] : [6, 3]);
    }
    roundedRect(ctx, x + 0.5, y + 0.5, Math.max(1, w - 1), h - 1, 5);
    ctx.stroke();
    ctx.setLineDash([]);

    // 文本（单独裁剪，避免影响选中手柄的绘制）
    if (w > 34) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x + 6, y, Math.max(0, w - 10), h);
      ctx.clip();
      ctx.fillStyle = COLORS.text;
      ctx.font = '600 11px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
      ctx.textBaseline = 'middle';
      const title = label?.name ?? '未分类';
      let text = title;
      if (speaker && w > 92) text += ` · ${speaker.name}`;
      if (region.confidence === 'inaudible') text = `⚠ ${text}`;
      ctx.fillText(text, x + 8, y + h / 2 - (w > 150 ? 5 : 0), Math.max(0, w - 14));
      if (w > 150) {
        ctx.fillStyle = COLORS.textMuted;
        ctx.font = '10px ui-monospace, Menlo, monospace';
        ctx.fillText(
          `${region.start.toFixed(2)}–${region.end.toFixed(2)}s`,
          x + 8,
          y + h / 2 + 7,
          Math.max(0, w - 14),
        );
      }
      ctx.restore();
    }

    // 选中手柄
    if (selected) {
      ctx.fillStyle = '#ffd79a';
      ctx.fillRect(x - 1, y + 4, 3, h - 8);
      ctx.fillRect(x + w - 2, y + 4, 3, h - 8);
    }
    ctx.restore();
  }

  drawRuler() {
    const ctx = this.rulerCanvas.getContext('2d');
    const width = this.contentWidth;
    const height = 30;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, COLORS.rulerBgTop);
    gradient.addColorStop(1, '#0e151d');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    const step = niceStep(this.view.pxPerSecond, 86);
    const minor = step / (step >= 1 ? 5 : 4);
    const { span } = visibleRange(this.view, width);
    const first = Math.floor(this.view.start / minor) * minor;
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.22)';
    ctx.lineWidth = 1;
    for (let t = first; t <= this.view.start + span + minor; t += minor) {
      if (t < -1e-6) continue;
      const x = Math.round(timeToX(t, this.view)) + 0.5;
      if (x < -1 || x > width + 1) continue;
      ctx.beginPath();
      ctx.moveTo(x, height - 6);
      ctx.lineTo(x, height);
      ctx.stroke();
    }

    ctx.font = '10px ui-monospace, Menlo, monospace';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = COLORS.textMuted;
    const majorFirst = Math.floor(this.view.start / step) * step;
    for (let t = majorFirst; t <= this.view.start + span + step; t += step) {
      if (t < -1e-6) continue;
      const x = Math.round(timeToX(t, this.view)) + 0.5;
      if (x < -40 || x > width + 40) continue;
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.4)';
      ctx.beginPath();
      ctx.moveTo(x, height - 11);
      ctx.lineTo(x, height);
      ctx.stroke();
      const label = formatTick(t, step);
      const textWidth = ctx.measureText(label).width;
      let textX = x + 4;
      if (textX + textWidth > width - 2) textX = x - textWidth - 4;
      ctx.fillText(label, Math.max(2, textX), height / 2 - 3);
    }

    // 区间轮廓条，帮助在标尺上快速定位
    for (const region of this.store.doc.regions) {
      const x = timeToX(region.start, this.view);
      const w = Math.max(1.5, (region.end - region.start) * this.view.pxPerSecond);
      if (x > width || x + w < 0) continue;
      const label = this.store.regionLabel(region);
      ctx.fillStyle = hexToRgba(label?.color ?? '#94a3b8', 0.6);
      ctx.fillRect(x, 2, Math.max(1, Math.min(w, width - x)), 2);
    }

    // 标尺上标出音频结尾之后的区域（超出音频的标注会落在这里）
    const audioEnd = this.audioDuration;
    if (audioEnd > 0) {
      const endX = timeToX(audioEnd, this.view);
      if (endX < width) {
        ctx.fillStyle = 'rgba(11, 15, 20, 0.55)';
        ctx.fillRect(Math.max(0, endX), 0, width - Math.max(0, endX), height);
      }
    }
  }

  drawOverview() {
    const canvas = this.overviewCanvas;
    const ctx = canvas.getContext('2d');
    const width = this.overviewWidth;
    const height = 34;
    if (!width) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#0c1219';
    ctx.fillRect(0, 0, width, height);

    const duration = Math.max(this.duration, 0.001);
    const centerY = height / 2;

    if (this.cache?.min) {
      const blocks = this.cache.min.length;
      ctx.fillStyle = 'rgba(120, 148, 172, 0.5)';
      const bucket = Math.max(1, Math.ceil(blocks / width));
      for (let x = 0; x < width; x += 1) {
        const from = Math.floor((x / width) * blocks);
        const to = Math.min(blocks - 1, from + bucket);
        let lo = 0;
        let hi = 0;
        for (let b = from; b <= to; b += 1) {
          if (this.cache.min[b] < lo) lo = this.cache.min[b];
          if (this.cache.max[b] > hi) hi = this.cache.max[b];
        }
        const y1 = centerY - hi * (height * 0.42);
        const y2 = centerY - lo * (height * 0.42);
        ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
      }
    }

    // 区间色块
    for (const region of this.store.doc.regions) {
      const label = this.store.regionLabel(region);
      const x = (region.start / duration) * width;
      const w = Math.max(1, ((region.end - region.start) / duration) * width);
      ctx.fillStyle = hexToRgba(label?.color ?? '#94a3b8', this.selection === region.id ? 0.95 : 0.55);
      ctx.fillRect(x, height - 8, w, 4);
    }

    // 视口
    const { span } = visibleRange(this.view, this.contentWidth);
    const viewX = (this.view.start / duration) * width;
    const viewW = Math.max(3, (span / duration) * width);
    ctx.fillStyle = 'rgba(242, 180, 94, 0.12)';
    ctx.fillRect(viewX, 0, viewW, height);
    ctx.strokeStyle = 'rgba(242, 180, 94, 0.75)';
    ctx.lineWidth = 1;
    ctx.strokeRect(viewX + 0.5, 0.5, Math.max(1, viewW - 1), height - 1);
  }

  drawOverlay() {
    const ctx = this.overlayCanvas.getContext('2d');
    const width = this.contentWidth;
    const height = this.contentHeight;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const playhead = this.playheadTime;
    const playing = this.engine?.isPlaying;

    // 播放中命中区间高亮（暂停后不残留）
    if (playing && this.duration > 0) {
      ctx.fillStyle = COLORS.active;
      for (const id of this.activeIds) {
        const region = this.store.getRegion(id);
        if (!region) continue;
        const { x, y, w, h } = this.regionRect(region);
        roundedRect(ctx, x, y, w, h, 5);
        ctx.fill();
        ctx.strokeStyle = 'rgba(242, 180, 94, 0.55)';
        ctx.lineWidth = 1.4;
        ctx.stroke();
      }
    }

    // 拖动时的吸附参考线
    if (this.drag?.snapTime != null) {
      const x = Math.round(timeToX(this.drag.snapTime, this.view)) + 0.5;
      ctx.strokeStyle = 'rgba(96, 165, 250, 0.7)';
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (this.hover?.time != null && !this.drag) {
      const x = Math.round(timeToX(this.hover.time, this.view)) + 0.5;
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }

    if (this.duration > 0 || this.cache) {
      const x = Math.round(timeToX(playhead, this.view)) + 0.5;
      if (x >= -1 && x <= width + 1) {
        ctx.strokeStyle = COLORS.playhead;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
        ctx.fillStyle = COLORS.playhead;
        ctx.beginPath();
        ctx.moveTo(x - 5, 0);
        ctx.lineTo(x + 5, 0);
        ctx.lineTo(x, 7);
        ctx.closePath();
        ctx.fill();
      }
    }

    // 循环范围指示
    const loop = this.engine?.loopRange;
    if (loop) {
      const x1 = timeToX(loop.start, this.view);
      const x2 = timeToX(loop.end, this.view);
      ctx.fillStyle = 'rgba(52, 211, 153, 0.08)';
      ctx.fillRect(x1, 0, Math.max(1, x2 - x1), height);
      ctx.strokeStyle = 'rgba(52, 211, 153, 0.4)';
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(Math.round(x1) + 0.5, 0);
      ctx.lineTo(Math.round(x1) + 0.5, height);
      ctx.moveTo(Math.round(x2) + 0.5, 0);
      ctx.lineTo(Math.round(x2) + 0.5, height);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  startLoop() {
    const tick = () => {
      const playing = this.engine?.isPlaying;
      if (playing) {
        this.updateActive();
        if (this.follow) this.followPlayhead();
        this.drawOverlay();
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  updateActive() {
    const time = this.playheadTime;
    const next = new Set();
    if (this.engine?.isPlaying || this.playheadOverride !== null) {
      for (const region of this.store.doc.regions) {
        if (time >= region.start && time < region.end) next.add(region.id);
      }
    }
    const changed = next.size !== this.activeIds.size || [...next].some((id) => !this.activeIds.has(id));
    this.activeIds = next;
    if (changed) this.handlers.onActiveChange?.([...next]);
  }

  followPlayhead() {
    const time = this.playheadTime;
    const x = timeToX(time, this.view);
    const width = this.contentWidth;
    if (x > width * 0.82 || x < 0) {
      const next = clampView(
        { start: time - width * 0.18 / this.view.pxPerSecond, pxPerSecond: this.view.pxPerSecond },
        this.duration || time + 1,
        width,
      );
      if (Math.abs(next.start - this.view.start) > 1e-6) {
        this.view = next;
        this.store.setView(this.view);
        this.needsBaseRender = true;
        this.drawBase();
        this.drawRuler();
        this.drawOverview();
      }
    }
  }

  /* ------------------------------ hit testing ------------------------------ */

  pointFromEvent(event) {
    const rect = this.waveCanvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    return { x, y, time: xToTime(x, this.view) };
  }

  hitTest(x, y) {
    const regions = this.store.sortedRegions();
    // 逆序，优先命中上层（后创建的）
    for (let i = regions.length - 1; i >= 0; i -= 1) {
      const region = regions[i];
      const rect = this.regionRect(region);
      // 按矩形本身判断，避免落在泳道间隙时误命中相邻泳道
      if (y < rect.y - 2 || y > rect.y + rect.h + 2) continue;
      if (x >= rect.x && x <= rect.x + rect.w) {
        // 窄区间里两侧手柄会重叠：取更近的一侧，保证仍能拉伸
        const edge = Math.min(6, Math.max(2, rect.w / 3));
        const distStart = Math.abs(x - rect.x);
        const distEnd = Math.abs(x - (rect.x + rect.w));
        if (distStart <= edge && distStart <= distEnd) return { type: 'start', region, rect };
        if (distEnd <= edge) return { type: 'end', region, rect };
        return { type: 'body', region, rect };
      }
      // 区间外侧的 6px 也允许抓取边缘
      if (x >= rect.x - 6 && x < rect.x) return { type: 'start', region, rect };
      if (x > rect.x + rect.w && x <= rect.x + rect.w + 6) return { type: 'end', region, rect };
    }
    return { type: 'empty', time: xToTime(x, this.view) };
  }

  snapTime(time, excludeId) {
    if (!this.snapEnabled) return { time, snapped: false };
    const threshold = 7 / this.view.pxPerSecond;
    const candidates = [0, this.duration, this.playheadTime];
    for (const region of this.store.doc.regions) {
      if (region.id === excludeId) continue;
      candidates.push(region.start, region.end);
    }
    let best = null;
    for (const candidate of candidates) {
      if (!Number.isFinite(candidate)) continue;
      const distance = Math.abs(candidate - time);
      if (distance <= threshold && (!best || distance < best.distance)) best = { time: candidate, distance };
    }
    return best ? { time: best.time, snapped: true } : { time, snapped: false };
  }

  /* ------------------------------ events ------------------------------ */

  bindEvents() {
    const canvas = this.waveCanvas;

    canvas.addEventListener('pointerdown', (event) => this.onPointerDown(event));
    window.addEventListener('pointermove', (event) => this.onPointerMove(event));
    window.addEventListener('pointerup', (event) => this.onPointerUp(event));
    window.addEventListener('pointercancel', (event) => this.onPointerUp(event, true));

    canvas.addEventListener('pointermove', (event) => this.onHover(event));
    canvas.addEventListener('pointerleave', () => {
      this.hover = null;
      this.tooltip.hidden = true;
      this.drawOverlay();
    });

    canvas.addEventListener('dblclick', (event) => {
      const point = this.pointFromEvent(event);
      const hit = this.hitTest(point.x, point.y);
      if (hit.type === 'empty') {
        const start = Math.max(0, point.time);
        const end = Math.min(this.bounds, start + 1);
        this.handlers.onCreate?.({ start, end });
      } else if (hit.type === 'body') {
        this.handlers.onSeek?.(hit.region.start);
        this.handlers.onSelect?.(hit.region.id, { seek: false });
      }
    });

    canvas.addEventListener('wheel', (event) => this.onWheel(event), { passive: false });
    this.overviewCanvas.addEventListener('pointerdown', (event) => this.onOverviewDrag(event));
    this.rulerCanvas.addEventListener('pointerdown', (event) => this.onRulerScrub(event));

    new ResizeObserver(() => this.resize()).observe(this.lanesScroll);
    // 总览画布的 CSS 宽度由 flex 决定，尺寸变化时也要重设 backing store，否则会被拉伸
    new ResizeObserver(() => this.resize()).observe(this.overviewCanvas);
  }

  onPointerDown(event) {
    if (event.button !== 0) return;
    this.waveCanvas.focus({ preventScroll: true });
    const point = this.pointFromEvent(event);
    const hit = this.hitTest(point.x, point.y);
    this.snapEnabled = !event.altKey;
    event.preventDefault();
    this.waveCanvas.setPointerCapture?.(event.pointerId);

    if (hit.type === 'body') {
      this.handlers.onSelect?.(hit.region.id, { seek: false });
      // onSelect 可能滚动视图，因此重新计算指针时间
      const origin = this.pointFromEvent(event);
      this.drag = {
        type: 'move',
        region: hit.region,
        originTime: origin.time,
        originStart: hit.region.start,
        originEnd: hit.region.end,
        currentStart: hit.region.start,
        currentEnd: hit.region.end,
        moved: false,
        pointerId: event.pointerId,
        frozenLanes: new Map(this.laneById),
        frozenLaneCount: this.laneCount,
      };
      this.handlers.onDragStart?.(hit.region.id);
      this.updateCursor(point);
      return;
    }

    if (hit.type === 'start' || hit.type === 'end') {
      this.handlers.onSelect?.(hit.region.id, { seek: false });
      // 先进入拖动状态（会暂停播放），再做定位与试听，避免播放头被中途重启
      this.handlers.onDragStart?.(hit.region.id);
      const origin = this.pointFromEvent(event);
      const edgeTime = hit.type === 'start' ? hit.region.start : hit.region.end;
      this.drag = {
        type: hit.type,
        region: hit.region,
        originTime: origin.time,
        originStart: hit.region.start,
        originEnd: hit.region.end,
        remoteEdge: hit.type === 'start' ? hit.region.end : hit.region.start,
        lastValue: edgeTime,
        moved: false,
        pointerId: event.pointerId,
        frozenLanes: new Map(this.laneById),
        frozenLaneCount: this.laneCount,
      };
      this.handlers.onSeek?.(edgeTime);
      this.beginAudition(hit.type, edgeTime);
      this.updateCursor(point);
      return;
    }

    // 空白拖动：创建
    this.handlers.onSelect?.(null, { seek: false });
    this.drag = {
      type: 'create',
      anchor: point.time,
      preview: { start: point.time, end: point.time },
      moved: false,
      pointerId: event.pointerId,
    };
    this.updateCursor(point);
  }

  onPointerMove(event) {
    const drag = this.drag;
    if (!drag) return;
    const point = this.pointFromEvent(event);
    let snapped = this.snapTime(point.time, drag.region?.id);
    const time = snapped.time;

    if (drag.type === 'create') {
      const start = Math.max(0, Math.min(drag.anchor, time));
      const end = Math.min(this.bounds, Math.max(drag.anchor, time));
      drag.preview = { start, end };
      drag.moved = drag.moved || Math.abs((end - start) * this.view.pxPerSecond) > 2;
      drag.snapTime = snapped.snapped ? time : null;
      this.setPlayheadOverride(null);
      this.drawBase();
      this.drawOverlay();
      this.showTooltip(point, `${start.toFixed(3)} – ${end.toFixed(3)} s（${(end - start).toFixed(3)} s）`);
      return;
    }

    if (drag.type === 'move') {
      const delta = time - drag.originTime;
      const length = drag.originEnd - drag.originStart;
      const bounds = this.bounds;
      let start = drag.originStart + delta;
      if (Number.isFinite(bounds)) start = Math.min(Math.max(0, start), Math.max(0, bounds - length));
      else start = Math.max(0, start);
      const end = start + length;
      // 移动时对起点/终点分别尝试吸附，取更近者
      let adjusted = start;
      const snapStart = this.snapTime(start, drag.region.id);
      const snapEnd = this.snapTime(end, drag.region.id);
      const dStart = Math.abs(snapStart.time - start);
      const dEnd = Math.abs(snapEnd.time - end);
      if (snapStart.snapped && (!snapEnd.snapped || dStart <= dEnd)) adjusted = snapStart.time;
      else if (snapEnd.snapped) adjusted = snapEnd.time - length;
      if (Number.isFinite(bounds)) adjusted = Math.min(Math.max(0, adjusted), Math.max(0, bounds - length));
      else adjusted = Math.max(0, adjusted);
      const nextStart = roundSeconds(adjusted);
      const nextEnd = roundSeconds(adjusted + length);
      // 与「本次拖动当前值」比较，这样拖回原位也能恢复
      if (nextStart !== drag.currentStart || nextEnd !== drag.currentEnd) {
        drag.currentStart = nextStart;
        drag.currentEnd = nextEnd;
        drag.moved = true;
        this.handlers.onUpdate?.(drag.region.id, { start: nextStart, end: nextEnd }, { history: false, reason: 'region:drag' });
      }
      drag.snapTime = snapStart.snapped || snapEnd.snapped ? (snapStart.snapped && dStart <= dEnd ? snapStart.time : snapEnd.time) : null;
      this.drawBase();
      this.drawOverlay();
      this.showTooltip(point, `${nextStart.toFixed(3)} – ${nextEnd.toFixed(3)} s`);
      return;
    }

    if (drag.type === 'start' || drag.type === 'end') {
      const bounds = this.bounds;
      let value = time;
      if (Number.isFinite(bounds)) value = Math.min(Math.max(0, value), bounds);
      if (drag.type === 'start') value = Math.min(value, drag.remoteEdge - 0.02);
      else value = Math.max(value, drag.remoteEdge + 0.02);
      const rounded = roundSeconds(value);
      const patch = drag.type === 'start' ? { start: rounded } : { end: rounded };
      if (rounded !== drag.lastValue) {
        drag.lastValue = rounded;
        drag.moved = true;
        this.handlers.onUpdate?.(drag.region.id, patch, { history: false, reason: 'region:resize' });
      }
      drag.snapTime = snapped.snapped ? rounded : null;
      this.beginAudition(drag.type, rounded);
      this.drawBase();
      this.drawOverlay();
      this.showTooltip(point, `${rounded.toFixed(3)} s`);
    }
  }

  onPointerUp(event, cancelled = false) {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    this.handlers.onAuditionEnd?.();
    this.tooltip.hidden = true;
    this.waveCanvas.releasePointerCapture?.(drag.pointerId);

    if (drag.type === 'create') {
      const { start, end } = drag.preview ?? { start: drag.anchor, end: drag.anchor };
      if (cancelled) {
        this.drawBase();
        return;
      }
      if (drag.moved && end - start >= 0.02) {
        this.handlers.onCreate?.({ start, end });
      } else {
        this.handlers.onSeek?.(drag.anchor);
      }
      this.drawBase();
      this.drawOverlay();
      return;
    }

    this.handlers.onCommit?.(drag.region.id, drag.type, { moved: drag.moved });
    this.drawBase();
    this.drawOverlay();
    this.updateActive();
    const point = this.pointFromEvent(event);
    this.updateCursor(point);
  }

  beginAudition(edge, time) {
    const pad = 0.3;
    const bounds = this.bounds;
    const start = Math.max(0, time - pad);
    const end = Number.isFinite(bounds) ? Math.min(bounds, time + pad) : time + pad;
    if (end - start > 0.03) this.handlers.onAudition?.(start, end, edge);
  }

  onHover(event) {
    if (this.drag) return;
    const point = this.pointFromEvent(event);
    this.hover = { ...point };
    const hit = this.hitTest(point.x, point.y);
    this.updateCursor(point, hit);
    if (hit.type === 'empty') {
      this.tooltip.hidden = true;
    } else if (hit.region) {
      const label = this.store.regionLabel(hit.region);
      const speaker = this.store.regionSpeaker(hit.region);
      const parts = [
        `${hit.region.start.toFixed(3)}–${hit.region.end.toFixed(3)} s`,
        label?.name ?? '未分类',
        speaker?.name,
      ].filter(Boolean);
      this.showTooltip(point, parts.join(' · '), hit.region);
    }
    this.drawOverlay();
  }

  updateCursor(point, hit = null) {
    const canvas = this.waveCanvas;
    if (this.drag) {
      if (this.drag.type === 'start' || this.drag.type === 'end') canvas.style.cursor = 'col-resize';
      else if (this.drag.type === 'move') canvas.style.cursor = 'grabbing';
      else canvas.style.cursor = 'crosshair';
      return;
    }
    const target = hit ?? this.hitTest(point.x, point.y);
    if (target.type === 'start' || target.type === 'end') canvas.style.cursor = 'col-resize';
    else if (target.type === 'body') canvas.style.cursor = 'grab';
    else canvas.style.cursor = 'crosshair';
  }

  showTooltip(point, text, region = null) {
    const tooltip = this.tooltip;
    tooltip.textContent = text;
    tooltip.hidden = false;
    const rect = this.waveCanvas.getBoundingClientRect();
    const x = clamp(point.x, 60, Math.max(60, rect.width - 60));
    const y = clamp(point.y, 24, Math.max(24, rect.height - 8));
    tooltip.style.left = `${x}px`;
    tooltip.style.top = `${y}px`;
    if (region) {
      const lane = this.laneById.get(region.id) ?? 0;
      tooltip.style.top = `${GEOMETRY.topPad + lane * GEOMETRY.laneStride() + GEOMETRY.laneGap / 2 + 6}px`;
    }
  }

  onWheel(event) {
    const rect = this.waveCanvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const duration = this.duration || Math.max(30, this.view.start + 30);
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      const factor = Math.exp(-event.deltaY * 0.0016);
      const next = zoomAt(this.view, x, factor, duration, this.contentWidth);
      this.setView(next);
      return;
    }
    if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
      event.preventDefault();
      const delta = (event.shiftKey ? event.deltaY : event.deltaX) / this.view.pxPerSecond;
      const next = clampView({ start: this.view.start + delta, pxPerSecond: this.view.pxPerSecond }, duration, this.contentWidth);
      this.setView(next);
      this.follow = false;
      return;
    }
    // 纵向滚动交给泳道容器；已到底时也不阻止页面滚动
    // （故意不 preventDefault）
  }

  onRulerScrub(event) {
    event.preventDefault();
    // 拖动标尺时暂停播放，避免每帧重建音源造成爆音；松开后从新位置继续
    const wasPlaying = this.engine?.isPlaying;
    if (wasPlaying) this.engine.pause();
    const scrub = (clientX) => {
      const rect = this.rulerCanvas.getBoundingClientRect();
      const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
      const target = xToTime(x, this.view);
      const time = Math.max(0, Math.min(this.duration || target, target));
      // seek 会同步更新音源位置；不再额外设置播放头覆盖值，避免两者互相清除
      this.handlers.onSeek?.(time);
      this.drawOverlay();
    };
    scrub(event.clientX);
    const onMove = (moveEvent) => scrub(moveEvent.clientX);
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (wasPlaying) this.engine.play({ from: this.engine.position, loopRange: this.engine.loopRange });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  onOverviewDrag(event) {
    event.preventDefault();
    const moveTo = (clientX) => {
      const rect = this.overviewCanvas.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const time = ratio * (this.duration || 0);
      const span = this.contentWidth / this.view.pxPerSecond;
      const next = clampView(
        { start: time - span / 2, pxPerSecond: this.view.pxPerSecond },
        this.duration || Math.max(30, time + 1),
        this.contentWidth,
      );
      this.setView(next);
      this.follow = false;
    };
    moveTo(event.clientX);
    const onMove = (moveEvent) => moveTo(moveEvent.clientX);
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  /* ------------------------------ public view ops ------------------------------ */

  zoomBy(factor) {
    const next = zoomAt(this.view, this.contentWidth / 2, factor, this.duration || 30, this.contentWidth);
    this.setView(next);
    this.handlers.onViewChange?.(next);
  }

  fit() {
    const next = fitView(this.duration || 30, this.contentWidth);
    this.setView({ start: 0, pxPerSecond: next.pxPerSecond });
  }

  scrollToTime(time, { selectRange = null } = {}) {
    let next;
    if (selectRange) {
      next = scrollToInclude(this.view, selectRange.start, selectRange.end, this.contentWidth, this.duration || time + 1);
      if (!Number.isFinite(next.start)) next = { start: 0, pxPerSecond: this.view.pxPerSecond };
    } else {
      const x = timeToX(time, this.view);
      if (x < 0 || x > this.contentWidth - 30) {
        next = clampView(
          { start: time - this.contentWidth * 0.15 / this.view.pxPerSecond, pxPerSecond: this.view.pxPerSecond },
          this.duration || time + 1,
          this.contentWidth,
        );
      } else {
        return;
      }
    }
    this.setView(next);
  }
}

export { COLORS, GEOMETRY };
