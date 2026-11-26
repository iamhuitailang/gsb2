// 时间线组件：Canvas 绘制 + 鼠标交互。
// 上半部为每个素材画一条覆盖泳道（含波形/越界斜纹），下半部是机位段落轨道
// 与可拖拽的切点，最上方为时间标尺和播放头。

import { buildSegments, timelineBounds, getSource } from './core/model.js';
import { parseFps, formatSeconds, snapToFrame } from './core/time.js';

const LANE_H = 44;
const SEG_TRACK_H = 64;
const RULER_H = 30;
const PAD = 8;

export class Timeline {
  constructor(canvas, mediaStore, getProject, handlers) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.mediaStore = mediaStore;
    this.getProject = getProject;
    this.handlers = handlers; // { onSeek, onMoveCut, onSelectSegment, onAddCut, onDragSourceOffset }

    this.viewMin = 0;
    this.viewMax = 10;
    this.playhead = 0;
    this.selectedSegment = -1;
    this.drag = null; // { type: 'playhead'|'cut'|'offset', ... }
    this.hover = null;

    this.bindEvents();
  }

  fitToProject() {
    const b = timelineBounds(this.getProject());
    if (b.duration <= 0) {
      this.viewMin = 0;
      this.viewMax = 10;
    } else {
      const pad = b.duration * 0.05;
      this.viewMin = b.min - pad;
      this.viewMax = b.max + pad;
    }
    this.draw();
  }

  zoom(factor, centerT) {
    const span = this.viewMax - this.viewMin;
    const newSpan = Math.max(0.2, Math.min(3600, span * factor));
    const ratio = (centerT - this.viewMin) / span;
    this.viewMin = centerT - newSpan * ratio;
    this.viewMax = this.viewMin + newSpan;
    this.draw();
  }

  setPlayhead(t) {
    this.playhead = t;
    this.draw();
  }

  setSelected(index) {
    this.selectedSegment = index;
    this.draw();
  }

  // ---------- 坐标换算 ----------

  t2x(t) {
    const w = this.canvas.clientWidth;
    return PAD + ((t - this.viewMin) / (this.viewMax - this.viewMin)) * (w - PAD * 2);
  }

  x2t(x) {
    const w = this.canvas.clientWidth;
    return this.viewMin + ((x - PAD) / (w - PAD * 2)) * (this.viewMax - this.viewMin);
  }

  laneY(i) {
    return RULER_H + i * (LANE_H + 6);
  }

  segTrackY() {
    const n = this.getProject().sources.length;
    return RULER_H + n * (LANE_H + 6) + 10;
  }

  totalHeight() {
    return this.segTrackY() + SEG_TRACK_H + 24;
  }

  // ---------- 绘制 ----------

  draw() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.totalHeight();
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    this.canvas.style.height = `${h}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const ctx = this.ctx;
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, w, h);

    this.drawRuler(w);
    const project = this.getProject();
    project.sources.forEach((src, i) => this.drawSourceLane(src, i));
    this.drawSegmentTrack();
    this.drawPlayhead(w, h);
  }

  drawRuler(w) {
    const ctx = this.ctx;
    const span = this.viewMax - this.viewMin;
    const step = niceStep(span / 8);
    ctx.fillStyle = '#161b22';
    ctx.fillRect(0, 0, w, RULER_H);
    ctx.strokeStyle = '#30363d';
    ctx.beginPath();
    ctx.moveTo(0, RULER_H - 0.5);
    ctx.lineTo(w, RULER_H - 0.5);
    ctx.stroke();
    ctx.fillStyle = '#8b949e';
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    const first = Math.ceil(this.viewMin / step) * step;
    for (let t = first; t <= this.viewMax; t += step) {
      const x = this.t2x(t);
      ctx.strokeStyle = '#30363d';
      ctx.beginPath();
      ctx.moveTo(x, RULER_H - 8);
      ctx.lineTo(x, RULER_H);
      ctx.stroke();
      ctx.fillText(formatSeconds(t), x, 14);
    }
  }

  drawSourceLane(src, i) {
    const ctx = this.ctx;
    const y = this.laneY(i);
    const x0 = this.t2x(src.offset);
    const x1 = this.t2x(src.offset + src.duration);
    const w = this.canvas.clientWidth;

    // 泳道背景
    ctx.fillStyle = '#111820';
    ctx.fillRect(PAD, y, w - PAD * 2, LANE_H);

    // 视口内但素材外的区域用斜纹提示「这里没有该素材」
    this.drawHatch(PAD, y, Math.max(0, x0 - PAD), LANE_H, 'rgba(250,204,21,0.10)');
    this.drawHatch(x1, y, Math.max(0, PAD + w - PAD - x1), LANE_H, 'rgba(250,204,21,0.10)');

    // 素材覆盖区
    const color = sourceColor(i);
    ctx.fillStyle = color.bg;
    ctx.fillRect(x0, y, Math.max(2, x1 - x0), LANE_H);
    ctx.strokeStyle = color.border;
    ctx.strokeRect(x0 + 0.5, y + 0.5, Math.max(2, x1 - x0) - 1, LANE_H - 1);

    // 波形（音频素材或带音轨的视频）
    const item = this.mediaStore.get(src.id);
    if (item?.peaks && x1 - x0 > 4) {
      this.drawLaneWaveform(item.peaks, x0, y, x1 - x0, color.fg);
    }

    // 名称与偏移
    ctx.fillStyle = '#e6edf3';
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'left';
    const label = `${src.kind === 'audio' ? '🎧' : '🎥'} ${src.name}  ${src.fps ? src.fps.toFixed(3).replace(/0+$/, '').replace(/\.$/, '') + 'fps' : ''}  off ${src.offset >= 0 ? '+' : ''}${src.offset.toFixed(3)}s`;
    ctx.fillText(truncate(label, x1 - x0 - 10), x0 + 8, y + 17);
    ctx.fillStyle = '#8b949e';
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillText(`${formatSeconds(src.offset)} → ${formatSeconds(src.offset + src.duration)}`, x0 + 8, y + 34);

    // 左边缘的偏移拖动手柄
    ctx.fillStyle = '#facc15';
    ctx.fillRect(x0 - 3, y - 2, 6, LANE_H + 4);
  }

  drawLaneWaveform(peaks, x0, y, width, color) {
    const ctx = this.ctx;
    const mid = y + LANE_H / 2;
    const bw = width / peaks.length;
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.75;
    ctx.lineWidth = Math.max(0.6, bw * 0.7);
    ctx.beginPath();
    peaks.forEach((p, idx) => {
      const x = x0 + idx * bw;
      ctx.moveTo(x, mid + p.min * LANE_H * 0.42);
      ctx.lineTo(x, mid + p.max * LANE_H * 0.42);
    });
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  drawSegmentTrack() {
    const project = this.getProject();
    const ctx = this.ctx;
    const y = this.segTrackY();
    const w = this.canvas.clientWidth;
    ctx.fillStyle = '#111820';
    ctx.fillRect(PAD, y, w - PAD * 2, SEG_TRACK_H);
    const segs = buildSegments(project);
    segs.forEach((seg, i) => {
      const src = getSource(project, seg.sourceId);
      const srcIndex = project.sources.findIndex((s) => s.id === seg.sourceId);
      const color = sourceColor(srcIndex >= 0 ? srcIndex : 0);
      const x0 = this.t2x(seg.start);
      const x1 = this.t2x(seg.end);
      ctx.fillStyle = color.bg;
      ctx.fillRect(x0, y + 6, Math.max(2, x1 - x0), SEG_TRACK_H - 12);
      if (i === this.selectedSegment) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.strokeRect(x0 + 1, y + 7, Math.max(2, x1 - x0) - 2, SEG_TRACK_H - 14);
        ctx.lineWidth = 1;
      } else {
        ctx.strokeStyle = color.border;
        ctx.strokeRect(x0 + 0.5, y + 6.5, Math.max(2, x1 - x0) - 1, SEG_TRACK_H - 13);
      }
      // 越界区间：在段落内部用红色斜纹标出
      this.drawSegmentOutOfRange(seg, src, x0, x1, y + 6, SEG_TRACK_H - 12);
      ctx.fillStyle = '#e6edf3';
      ctx.font = '12px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(truncate(src ? src.name : '(缺失)', x1 - x0 - 10), x0 + 6, y + SEG_TRACK_H / 2 + 4);

      // 切点手柄（第 0 个也画，但样式区分）
      ctx.fillStyle = i === 0 ? '#6e7681' : '#f0f6fc';
      ctx.beginPath();
      ctx.arc(x0, y + SEG_TRACK_H / 2, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#0d1117';
      ctx.stroke();
    });
    ctx.fillStyle = '#8b949e';
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('机位段落（白点为可拖拽切点，切点吸附到切入机位的帧网格）', PAD + 4, y + SEG_TRACK_H + 14);
  }

  drawSegmentOutOfRange(seg, src, x0, x1, y, h) {
    if (!src) {
      this.drawHatch(x0, y, x1 - x0, h, 'rgba(239,68,68,0.35)');
      return;
    }
    // before 区
    if (seg.start < src.offset) {
      const endX = Math.min(x1, this.t2x(src.offset));
      this.drawHatch(x0, y, Math.max(0, endX - x0), h, 'rgba(239,68,68,0.35)');
    }
    // after 区
    if (seg.end > src.offset + src.duration) {
      const startX = Math.max(x0, this.t2x(src.offset + src.duration));
      this.drawHatch(startX, y, Math.max(0, x1 - startX), h, 'rgba(239,68,68,0.35)');
    }
  }

  drawHatch(x, y, width, height, style) {
    if (width <= 0 || height <= 0) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, width, height);
    ctx.clip();
    ctx.strokeStyle = style;
    ctx.lineWidth = 8;
    for (let xx = x - height; xx < x + width + height; xx += 16) {
      ctx.beginPath();
      ctx.moveTo(xx, y + height);
      ctx.lineTo(xx + height, y);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawPlayhead(w, h) {
    const ctx = this.ctx;
    const x = this.t2x(this.playhead);
    if (x < PAD || x > w - PAD) return;
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
    ctx.fillStyle = '#38bdf8';
    ctx.beginPath();
    ctx.moveTo(x - 6, 0);
    ctx.lineTo(x + 6, 0);
    ctx.lineTo(x, 9);
    ctx.closePath();
    ctx.fill();
  }

  // ---------- 交互 ----------

  bindEvents() {
    this.canvas.addEventListener('mousedown', (e) => this.onMouseDown(e));
    window.addEventListener('mousemove', (e) => this.onMouseMove(e));
    window.addEventListener('mouseup', () => {
      if (this.drag) {
        this.drag = null;
        this.draw();
      }
    });
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      const centerT = this.x2t(e.clientX - rect.left);
      this.zoom(e.deltaY > 0 ? 1.15 : 1 / 1.15, centerT);
    }, { passive: false });
    this.canvas.addEventListener('dblclick', (e) => this.onDblClick(e));
  }

  hitTest(e) {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const t = this.x2t(x);
    const project = this.getProject();

    // 切点手柄优先
    const segY = this.segTrackY();
    if (y >= segY && y <= segY + SEG_TRACK_H) {
      for (let i = 0; i < project.cuts.length; i++) {
        const cx = this.t2x(project.cuts[i].time);
        if (Math.abs(cx - x) < 8 && i > 0) return { type: 'cut', index: i };
      }
      const segs = buildSegments(project);
      for (let i = 0; i < segs.length; i++) {
        if (t >= segs[i].start && t < segs[i].end) return { type: 'segment', index: i };
      }
      return { type: 'ruler', t };
    }

    // 素材泳道：左边缘 8px 为偏移手柄
    for (let i = 0; i < project.sources.length; i++) {
      const ly = this.laneY(i);
      if (y >= ly && y <= ly + LANE_H) {
        const edgeX = this.t2x(project.sources[i].offset);
        if (Math.abs(edgeX - x) < 8) return { type: 'offset', sourceIndex: i };
        return { type: 'lane', sourceIndex: i, t };
      }
    }
    if (y <= RULER_H) return { type: 'ruler', t };
    return null;
  }

  onMouseDown(e) {
    const hit = this.hitTest(e);
    if (!hit) return;
    if (hit.type === 'cut') {
      this.drag = { type: 'cut', index: hit.index };
      this.handlers.onMoveCutStart?.(hit.index); // 拖动开始压一次历史，过程中不再压栈
    } else if (hit.type === 'offset') {
      const src = this.getProject().sources[hit.sourceIndex];
      this.drag = { type: 'offset', sourceId: src.id, startX: e.clientX, origOffset: src.offset };
    } else if (hit.type === 'segment') {
      this.selectedSegment = hit.index;
      this.handlers.onSelectSegment?.(hit.index);
      this.drag = { type: 'segment-start', index: hit.index };
      this.draw();
    } else if (hit.type === 'ruler' || hit.type === 'lane') {
      this.drag = { type: 'playhead' };
      this.handlers.onSeek?.(hit.t);
    }
  }

  onMouseMove(e) {
    if (!this.drag) {
      const hit = this.hitTest(e);
      this.canvas.style.cursor = hit?.type === 'cut' || hit?.type === 'offset'
        ? 'ew-resize'
        : hit ? 'pointer' : 'default';
      return;
    }
    const rect = this.canvas.getBoundingClientRect();
    const t = this.x2t(e.clientX - rect.left);
    if (this.drag.type === 'playhead') {
      this.handlers.onSeek?.(t);
    } else if (this.drag.type === 'cut') {
      this.handlers.onMoveCut?.(this.drag.index, t);
    } else if (this.drag.type === 'offset') {
      const project = this.getProject();
      const src = getSource(project, this.drag.sourceId);
      let next = this.drag.origOffset + (e.clientX - this.drag.startX) / (rect.width - PAD * 2) * (this.viewMax - this.viewMin);
      if (src?.kind === 'video') next = snapToFrame(next, parseFps(src.fps));
      this.handlers.onDragSourceOffset?.(this.drag.sourceId, next);
    }
  }

  onDblClick(e) {
    const hit = this.hitTest(e);
    if (hit?.type === 'ruler' || hit?.type === 'lane') {
      this.handlers.onAddCut?.(hit.t);
    }
  }
}

function niceStep(raw) {
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / pow;
  const step = n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10;
  return step * pow;
}

function truncate(s, maxWidth) {
  if (maxWidth < 30) return '';
  return s;
}

const PALETTE = [
  { bg: 'rgba(56,189,248,0.22)', border: '#38bdf8', fg: '#7dd3fc' },
  { bg: 'rgba(244,114,182,0.22)', border: '#f472b6', fg: '#f9a8d4' },
  { bg: 'rgba(52,211,153,0.22)', border: '#34d399', fg: '#6ee7b7' },
  { bg: 'rgba(251,191,36,0.22)', border: '#fbbf24', fg: '#fcd34d' },
  { bg: 'rgba(167,139,250,0.22)', border: '#a78bfa', fg: '#c4b5fd' },
  { bg: 'rgba(248,113,113,0.22)', border: '#f87171', fg: '#fca5a5' },
];

export function sourceColor(index) {
  return PALETTE[index % PALETTE.length];
}
