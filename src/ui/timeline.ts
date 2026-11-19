import type { Clip, Project, Track, ViewState } from '../types';
import { MIN_CLIP_DURATION, RULER_HEIGHT, TRACK_HEIGHT } from '../types';
import type { Store } from '../store';
import type { AudioEngine } from '../audio/AudioEngine';
import { computePeaks } from '../audio/peaks';
import { sortPoints } from '../utils/automation';
import { clamp, snapToGrid } from '../utils/helpers';

const HANDLE_WIDTH = 7;
const POINT_RADIUS = 5;
const HIT_PX = 8;
const SNAP_PX = 9;
const AUTOMATION_LANE_HEIGHT = 30;

const COLORS = {
  bg: '#16181d',
  lane: '#1b1e25',
  laneAlt: '#1e222b',
  grid: '#2a2f3a',
  gridStrong: '#3a4150',
  ruler: '#20242c',
  rulerText: '#8b93a3',
  clip: '#2f6fdb',
  clipBorder: '#5a93e8',
  clipMuted: '#4a4f5c',
  clipText: '#eaf1ff',
  waveform: '#9cc0ff',
  waveformMuted: '#8a909e',
  selection: '#ffd166',
  playhead: '#ff5d5d',
  automation: '#4ade80',
  automationFill: 'rgba(74, 222, 128, 0.10)',
  point: '#4ade80',
  pointSelected: '#fbbf24',
  endMarker: '#c084fc',
};

type DragMode =
  | { kind: 'none' }
  | { kind: 'pan'; startX: number; startScroll: number }
  | { kind: 'scrub' }
  | { kind: 'move-clip'; clipId: string; trackId: string; grabOffset: number; moved: boolean; duplicated: boolean }
  | { kind: 'trim-left'; clipId: string; trackId: string }
  | { kind: 'trim-right'; clipId: string; trackId: string }
  | { kind: 'move-point'; trackId: string; pointId: string }
  | { kind: 'marquee'; startX: number; startY: number };

/**
 * 时间线：所有几何位置都由 时间(秒) × pxPerSecond + scrollTime 唯一确定，
 * 缩放和平移只改变这两个视图参数，因此片段、播放指针、鼠标点击始终对应同一时间坐标。
 */
export class Timeline {
  private canvas: HTMLCanvasElement;
  private ruler: HTMLCanvasElement;
  private scrollEl: HTMLElement;
  private store: Store;
  private engine: AudioEngine;
  private ctx: CanvasRenderingContext2D;
  private rulerCtx: CanvasRenderingContext2D;
  private dpr = 1;
  private viewWidth = 0;
  private playheadTime = 0;
  private drag: DragMode = { kind: 'none' };
  private pendingPointId: string | null = null;
  private selectedPoint: { trackId: string; pointId: string } | null = null;
  private marquee: { x: number; y: number; w: number; h: number } | null = null;
  private contextMenu: { x: number; y: number; items: { label: string; action: () => void }[] } | null = null;
  private rafPending = false;

  constructor(
    canvas: HTMLCanvasElement,
    ruler: HTMLCanvasElement,
    scrollEl: HTMLElement,
    store: Store,
    engine: AudioEngine,
  ) {
    this.canvas = canvas;
    this.ruler = ruler;
    this.scrollEl = scrollEl;
    this.store = store;
    this.engine = engine;
    this.ctx = canvas.getContext('2d')!;
    this.rulerCtx = ruler.getContext('2d')!;

    store.subscribe(() => this.scheduleDraw());
    engine.onPosition((t) => {
      this.playheadTime = t;
      this.scheduleDraw();
    });

    this.bindEvents();
    this.resize();
    this.draw();
  }

  /* ---------------- 坐标映射（时间 ↔ 像素） ---------------- */

  private get view(): ViewState {
    return this.store.view;
  }

  private get project(): Project {
    return this.store.project;
  }

  timeToX(time: number): number {
    return (time - this.view.scrollTime) * this.view.pxPerSecond;
  }

  xToTime(x: number): number {
    return this.view.scrollTime + x / this.view.pxPerSecond;
  }

  private trackY(index: number): number {
    // 标尺是画布外部的独立 sticky 元素，画布内轨道直接从 0 开始
    return index * TRACK_HEIGHT;
  }

  private automationLaneTop(trackIndex: number): number {
    return this.trackY(trackIndex) + TRACK_HEIGHT - AUTOMATION_LANE_HEIGHT;
  }

  /* ---------------- 尺寸与重绘 ---------------- */

  resize(): void {
    const dpr = window.devicePixelRatio || 1;
    this.dpr = dpr;
    const width = this.scrollEl.clientWidth;
    this.viewWidth = width;
    const trackTotal = Math.max(1, this.project.tracks.length) * TRACK_HEIGHT;
    const canvasHeight = trackTotal + 40;

    for (const c of [this.canvas, this.ruler]) {
      c.width = Math.floor(width * this.dpr);
      c.style.width = `${width}px`;
    }
    this.canvas.height = Math.floor(canvasHeight * this.dpr);
    this.canvas.style.height = `${canvasHeight}px`;
    this.ruler.height = Math.floor(RULER_HEIGHT * this.dpr);
    this.ruler.style.height = `${RULER_HEIGHT}px`;

    for (const ctx2d of [this.ctx, this.rulerCtx]) {
      ctx2d.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    }
    this.draw();
  }

  private scheduleDraw(): void {
    if (this.rafPending) return;
    this.rafPending = true;
    window.requestAnimationFrame(() => {
      this.rafPending = false;
      this.draw();
    });
  }

  private draw(): void {
    this.drawRuler();
    this.drawTracks();
  }

  /* ---------------- 标尺 ---------------- */

  private niceStep(): number {
    const targetPx = 90;
    const targetSeconds = targetPx / this.view.pxPerSecond;
    const candidates = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
    for (const c of candidates) {
      if (c >= targetSeconds) return c;
    }
    return 600;
  }

  private drawRuler(): void {
    const ctx = this.rulerCtx;
    ctx.fillStyle = COLORS.ruler;
    ctx.fillRect(0, 0, this.viewWidth, RULER_HEIGHT);

    const step = this.niceStep();
    const startT = this.xToTime(0);
    const endT = this.xToTime(this.viewWidth);
    const first = Math.floor(startT / step) * step;

    ctx.font = '11px ui-monospace, monospace';
    ctx.textBaseline = 'middle';
    for (let t = first; t <= endT + step; t += step) {
      const x = this.timeToX(t);
      ctx.strokeStyle = COLORS.gridStrong;
      ctx.beginPath();
      ctx.moveTo(x, RULER_HEIGHT - 8);
      ctx.lineTo(x, RULER_HEIGHT);
      ctx.stroke();
      ctx.fillStyle = COLORS.rulerText;
      ctx.fillText(formatRuler(t, step), x + 4, RULER_HEIGHT / 2 - 4);
    }

    // 播放指针在标尺上的标记
    const px = this.timeToX(this.playheadTime);
    if (px >= 0 && px <= this.viewWidth) {
      ctx.fillStyle = COLORS.playhead;
      ctx.beginPath();
      ctx.moveTo(px - 6, 0);
      ctx.lineTo(px + 6, 0);
      ctx.lineTo(px, 9);
      ctx.closePath();
      ctx.fill();
    }
  }

  /* ---------------- 轨道与片段 ---------------- */

  private drawTracks(): void {
    const ctx = this.ctx;
    const width = this.viewWidth;
    const totalH = this.project.tracks.length * TRACK_HEIGHT + 40;
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, width, totalH);

    // 网格
    this.drawGrid(width, totalH);

    this.project.tracks.forEach((track, index) => {
      const y = this.trackY(index);
      ctx.fillStyle = index % 2 === 0 ? COLORS.lane : COLORS.laneAlt;
      ctx.fillRect(0, y, width, TRACK_HEIGHT);
      ctx.strokeStyle = COLORS.grid;
      ctx.strokeRect(0, y + 0.5, width, TRACK_HEIGHT);

      // 自动化编辑层
      if (this.view.automationTrackId === track.id) {
        this.drawAutomationLane(track, index);
      }

      for (const clip of track.clips) {
        this.drawClip(track, clip, y);
      }
    });

    // 工程结束标记
    const endX = this.timeToX(this.project.length);
    if (endX >= 0 && endX <= width) {
      ctx.strokeStyle = COLORS.endMarker;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(endX, 0);
      ctx.lineTo(endX, this.project.tracks.length * TRACK_HEIGHT);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 框选
    if (this.marquee) {
      ctx.fillStyle = 'rgba(255, 209, 102, 0.12)';
      ctx.strokeStyle = COLORS.selection;
      ctx.fillRect(this.marquee.x, this.marquee.y, this.marquee.w, this.marquee.h);
      ctx.strokeRect(this.marquee.x, this.marquee.y, this.marquee.w, this.marquee.h);
    }

    // 播放指针
    const px = this.timeToX(this.playheadTime);
    if (px >= -1 && px <= width + 1) {
      ctx.strokeStyle = COLORS.playhead;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, this.project.tracks.length * TRACK_HEIGHT);
      ctx.stroke();
      ctx.lineWidth = 1;
    }
  }

  private drawGrid(width: number, height: number): void {
    const ctx = this.ctx;
    const step = this.niceStep();
    const startT = this.xToTime(0);
    const endT = this.xToTime(width);
    const first = Math.floor(startT / step) * step;
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    for (let t = first; t <= endT + step; t += step) {
      const x = Math.round(this.timeToX(t)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
  }

  private drawClip(track: Track, clip: Clip, trackY: number): void {
    const ctx = this.ctx;
    const x = this.timeToX(clip.start);
    const w = clip.duration * this.view.pxPerSecond;
    if (x + w < 0 || x > this.viewWidth) return;

    const selected = this.view.selectedClipId === clip.id;
    const muted = clip.muted || track.muted || (this.project.tracks.some((t) => t.solo) && !track.solo);
    const top = trackY + 6;
    const laneBottom =
      this.view.automationTrackId === track.id
        ? this.automationLaneTop(this.project.tracks.indexOf(track)) - 4
        : trackY + TRACK_HEIGHT - 6;
    const height = laneBottom - top;

    // 主体
    ctx.fillStyle = muted ? COLORS.clipMuted : COLORS.clip;
    roundRect(ctx, x, top, w, height, 4);
    ctx.fill();
    ctx.strokeStyle = selected ? COLORS.selection : COLORS.clipBorder;
    ctx.lineWidth = selected ? 2 : 1;
    roundRect(ctx, x, top, w, height, 4);
    ctx.stroke();
    ctx.lineWidth = 1;

    // 波形（按源 offset 裁切显示）
    this.drawWaveform(clip, x, top, w, height, muted);

    // 两端裁切手柄
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillRect(x, top, HANDLE_WIDTH, height);
    ctx.fillRect(x + w - HANDLE_WIDTH, top, HANDLE_WIDTH, height);

    // 名称与静音标记
    if (w > 24) {
      ctx.fillStyle = COLORS.clipText;
      ctx.font = '11px system-ui, sans-serif';
      ctx.textBaseline = 'top';
      const label = `${clip.muted ? '🔇 ' : ''}${clip.name}`;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x + HANDLE_WIDTH + 2, top, Math.max(0, w - 2 * HANDLE_WIDTH - 4), 16);
      ctx.clip();
      ctx.fillText(label, x + HANDLE_WIDTH + 3, top + 3);
      ctx.restore();
    }
  }

  private drawWaveform(clip: Clip, x: number, top: number, w: number, height: number, muted: boolean): void {
    const ctx = this.ctx;
    const buffer = this.engine.getBuffer(clip.resourceId);
    if (!buffer || w < 2) return;
    const peaks = computePeaks(buffer);
    const mid = top + height / 2;
    const amp = height / 2 - 4;
    ctx.fillStyle = muted ? COLORS.waveformMuted : COLORS.waveform;

    // 片段在源缓冲中的归一化区间
    const ratioStart = clip.offset / peaks.duration;
    const ratioEnd = (clip.offset + clip.duration) / peaks.duration;
    const firstBucket = Math.floor(ratioStart * peaks.buckets);
    const lastBucket = Math.min(peaks.buckets - 1, Math.ceil(ratioEnd * peaks.buckets));

    const visibleBuckets = Math.max(1, lastBucket - firstBucket);
    const pxPerBucket = w / visibleBuckets;
    const barWidth = Math.max(1, Math.min(3, pxPerBucket - 0.5));

    for (let b = firstBucket; b <= lastBucket; b++) {
      const localIdx = b - firstBucket;
      const bx = x + localIdx * pxPerBucket;
      if (bx > this.viewWidth || bx + barWidth < 0) continue;
      const min = peaks.data[b * 2];
      const max = peaks.data[b * 2 + 1];
      const yMin = mid - max * amp;
      const yMax = mid - min * amp;
      ctx.fillRect(bx, yMin, barWidth, Math.max(1, yMax - yMin));
    }
  }

  /* ---------------- 自动化层 ---------------- */

  private drawAutomationLane(track: Track, trackIndex: number): void {
    const ctx = this.ctx;
    const laneTop = this.automationLaneTop(trackIndex);
    const width = this.viewWidth;

    ctx.fillStyle = 'rgba(10, 12, 16, 0.55)';
    ctx.fillRect(0, laneTop, width, AUTOMATION_LANE_HEIGHT);
    ctx.strokeStyle = COLORS.grid;
    ctx.beginPath();
    ctx.moveTo(0, laneTop + 0.5);
    ctx.lineTo(width, laneTop + 0.5);
    ctx.stroke();

    const valueToY = (v: number) => laneTop + (1 - clamp(v, 0, 1)) * (AUTOMATION_LANE_HEIGHT - 8) + 2;
    const points = sortPoints(track.automation);

    if (points.length === 0) {
      ctx.fillStyle = COLORS.rulerText;
      ctx.font = '10px system-ui';
      ctx.textBaseline = 'middle';
      ctx.fillText('双击添加音量关键点', 8, laneTop + AUTOMATION_LANE_HEIGHT / 2);
      return;
    }

    // 填充区域
    ctx.beginPath();
    const firstX = this.timeToX(points[0].time);
    ctx.moveTo(firstX, laneTop + AUTOMATION_LANE_HEIGHT);
    for (const p of points) ctx.lineTo(this.timeToX(p.time), valueToY(p.value));
    const lastX = this.timeToX(points[points.length - 1].time);
    ctx.lineTo(lastX, laneTop + AUTOMATION_LANE_HEIGHT);
    ctx.closePath();
    ctx.fillStyle = COLORS.automationFill;
    ctx.fill();

    // 折线（含首尾外延，表现钳制值）
    ctx.beginPath();
    const headX = Math.min(this.timeToX(points[0].time), this.viewWidth);
    ctx.moveTo(Math.max(0, headX), valueToY(points[0].value));
    for (const p of points) ctx.lineTo(this.timeToX(p.time), valueToY(p.value));
    ctx.strokeStyle = COLORS.automation;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.lineWidth = 1;

    // 关键点
    for (const p of points) {
      const px = this.timeToX(p.time);
      const py = valueToY(p.value);
      ctx.beginPath();
      ctx.arc(px, py, POINT_RADIUS, 0, Math.PI * 2);
      const isSelected =
        this.pendingPointId === p.id ||
        (this.selectedPoint?.trackId === track.id && this.selectedPoint.pointId === p.id);
      ctx.fillStyle = isSelected ? COLORS.pointSelected : COLORS.point;
      ctx.fill();
      ctx.strokeStyle = '#0f1115';
      ctx.stroke();
    }
  }

  /* ---------------- 命中测试 ---------------- */

  private hitTrack(y: number): number {
    // 鼠标坐标是相对画布的，画布本身位于标尺下方，轨道从 0 开始
    return Math.floor(y / TRACK_HEIGHT);
  }

  private hitClip(x: number, y: number): { track: Track; clip: Clip; edge: 'left' | 'right' | 'body' } | null {
    const trackIndex = this.hitTrack(y);
    const track = this.project.tracks[trackIndex];
    if (!track) return null;
    for (const clip of track.clips) {
      const cx = this.timeToX(clip.start);
      const cw = clip.duration * this.view.pxPerSecond;
      if (x >= cx && x <= cx + cw) {
        const edge = x <= cx + HANDLE_WIDTH ? 'left' : x >= cx + cw - HANDLE_WIDTH ? 'right' : 'body';
        return { track, clip, edge };
      }
    }
    return null;
  }

  private hitAutomationPoint(x: number, y: number): { track: Track; pointId: string } | null {
    for (let i = 0; i < this.project.tracks.length; i++) {
      const track = this.project.tracks[i];
      if (this.view.automationTrackId !== track.id) continue;
      const laneTop = this.automationLaneTop(i);
      if (y < laneTop || y > laneTop + AUTOMATION_LANE_HEIGHT) continue;
      for (const p of track.automation) {
        const px = this.timeToX(p.time);
        const valueToY = (v: number) => laneTop + (1 - clamp(v, 0, 1)) * (AUTOMATION_LANE_HEIGHT - 8) + 2;
        if (Math.abs(px - x) <= HIT_PX && Math.abs(valueToY(p.value) - y) <= HIT_PX) {
          return { track, pointId: p.id };
        }
      }
    }
    return null;
  }

  /* ---------------- 吸附 ---------------- */

  /** 返回吸附后的时间；候选包括同轨片段边缘与网格 */
  private applySnap(time: number, excludeClipId: string | null, trackId: string): number {
    if (!this.view.snap) return time;
    const track = this.store.findTrack(trackId);
    const candidates: number[] = [0];
    if (track) {
      for (const c of track.clips) {
        if (c.id === excludeClipId) continue;
        candidates.push(c.start, c.start + c.duration);
      }
    }
    const grid = this.niceStep() / 2;
    candidates.push(snapToGrid(time, grid));
    let best = time;
    let bestDist = SNAP_PX / this.view.pxPerSecond;
    for (const cand of candidates) {
      const d = Math.abs(cand - time);
      if (d < bestDist) {
        bestDist = d;
        best = cand;
      }
    }
    return Math.max(0, best);
  }

  /* ---------------- 事件绑定 ---------------- */

  private bindEvents(): void {
    this.ruler.addEventListener('mousedown', (e) => this.onRulerMouseDown(e));
    this.canvas.addEventListener('mousedown', (e) => this.onCanvasMouseDown(e));
    window.addEventListener('mousemove', (e) => this.onMouseMove(e));
    window.addEventListener('mouseup', (e) => this.onMouseUp(e));
    this.canvas.addEventListener('contextmenu', (e) => this.onContextMenu(e));
    this.ruler.addEventListener('contextmenu', (e) => e.preventDefault());
    this.scrollEl.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    window.addEventListener('resize', () => this.resize());
    document.addEventListener('click', () => {
      this.contextMenu = null;
      this.scheduleDraw();
    });
  }

  private localPoint(e: MouseEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private onRulerMouseDown(e: MouseEvent): void {
    if (e.button !== 0) return;
    const rect = this.ruler.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const time = this.xToTime(x);
    this.engine.seek(this.project, time);
    this.drag = { kind: 'scrub' };
  }

  private onCanvasMouseDown(e: MouseEvent): void {
    const { x, y } = this.localPoint(e);
    this.contextMenu = null;

    // 中键或空格平移由 keydown 处理；这里处理中键
    if (e.button === 1) {
      e.preventDefault();
      this.drag = { kind: 'pan', startX: x, startScroll: this.view.scrollTime };
      return;
    }
    if (e.button !== 0) return;

    // 1. 自动化关键点优先命中
    const pointHit = this.hitAutomationPoint(x, y);
    if (pointHit) {
      this.selectedPoint = { trackId: pointHit.track.id, pointId: pointHit.pointId };
      this.drag = { kind: 'move-point', trackId: pointHit.track.id, pointId: pointHit.pointId };
      this.scheduleDraw();
      return;
    }
    this.selectedPoint = null;

    // 2. 片段命中
    const clipHit = this.hitClip(x, y);
    if (clipHit) {
      const { track, clip, edge } = clipHit;
      this.view.selectedClipId = clip.id;
      this.store.commit();
      if (edge === 'left') {
        this.drag = { kind: 'trim-left', clipId: clip.id, trackId: track.id };
      } else if (edge === 'right') {
        this.drag = { kind: 'trim-right', clipId: clip.id, trackId: track.id };
      } else {
        const grabOffset = this.xToTime(x) - clip.start;
        this.drag = {
          kind: 'move-clip',
          clipId: clip.id,
          trackId: track.id,
          grabOffset,
          moved: false,
          duplicated: e.altKey,
        };
      }
      return;
    }

    // 3. 自动化轨道的空白处：按下准备添加点（mouseup 时若未拖动则添加）
    const trackIndex = this.hitTrack(y);
    const track = this.project.tracks[trackIndex];
    if (track && this.view.automationTrackId === track.id) {
      const laneTop = this.automationLaneTop(trackIndex);
      if (y >= laneTop) {
        this.drag = { kind: 'marquee', startX: x, startY: y };
        this.marquee = { x, y, w: 0, h: 0 };
        return;
      }
    }

    // 4. 空白：框选 / 平移
    if (e.shiftKey) {
      this.drag = { kind: 'pan', startX: x, startScroll: this.view.scrollTime };
    } else {
      this.drag = { kind: 'marquee', startX: x, startY: y };
      this.marquee = { x, y, w: 0, h: 0 };
      this.view.selectedClipId = null;
      this.store.commit();
    }
  }

  private onMouseMove(e: MouseEvent): void {
    if (this.drag.kind === 'none') {
      this.updateCursor(e);
      return;
    }
    const { x, y } = this.localPoint(e);

    switch (this.drag.kind) {
      case 'pan': {
        const dx = x - this.drag.startX;
        this.view.scrollTime = Math.max(0, this.drag.startScroll - dx / this.view.pxPerSecond);
        this.store.commit();
        break;
      }
      case 'scrub': {
        const rect = this.ruler.getBoundingClientRect();
        const rx = e.clientX - rect.left;
        this.engine.seek(this.project, this.xToTime(rx));
        break;
      }
      case 'move-clip': {
        const found = this.store.findClip(this.drag.clipId);
        if (!found) break;
        this.drag.moved = true;

        let targetTrackId = this.drag.trackId;
        const overTrackIndex = this.hitTrack(y);
        const overTrack = this.project.tracks[overTrackIndex];
        if (overTrack) targetTrackId = overTrack.id;

        // Alt 拖动：首次移动时复制一份，之后始终拖动副本（原片段不动）
        if (this.drag.duplicated) {
          const copyId = this.ensureDuplicate(this.drag.clipId);
          if (copyId) {
            this.drag.clipId = copyId;
            this.drag.duplicated = false;
          }
        }
        const current = this.store.findClip(this.drag.clipId);
        if (!current) break;
        if (current.track.id !== targetTrackId) {
          this.store.moveClipToTrack(current.clip.id, targetTrackId);
          this.drag.trackId = targetTrackId;
        }
        const rawStart = this.xToTime(x) - this.drag.grabOffset;
        const snapped = this.applySnap(rawStart, current.clip.id, targetTrackId);
        this.store.updateClipLive(current.clip.id, { start: snapped });
        break;
      }
      case 'trim-left': {
        const found = this.store.findClip(this.drag.clipId);
        if (!found) break;
        const resource = this.project.resources[found.clip.resourceId];
        const raw = this.xToTime(x);
        const snapped = this.applySnap(raw, found.clip.id, this.drag.trackId);
        const newStart = clamp(snapped, 0, found.clip.start + found.clip.duration - MIN_CLIP_DURATION);
        const newDuration = found.clip.start + found.clip.duration - newStart;
        const maxOffset = Math.max(0, resource.duration - newDuration);
        const newOffset = clamp(found.clip.offset + (newStart - found.clip.start), 0, maxOffset);
        this.store.updateClipLive(found.clip.id, { start: newStart, offset: newOffset, duration: newDuration });
        break;
      }
      case 'trim-right': {
        const found = this.store.findClip(this.drag.clipId);
        if (!found) break;
        const rawEnd = this.xToTime(x);
        const snapped = this.applySnap(rawEnd, found.clip.id, this.drag.trackId);
        const newDuration = clamp(snapped - found.clip.start, MIN_CLIP_DURATION, this.project.resources[found.clip.resourceId]?.duration ?? 9999);
        this.store.updateClipLive(found.clip.id, { duration: newDuration });
        break;
      }
      case 'move-point': {
        const track = this.store.findTrack(this.drag.trackId);
        if (!track) break;
        const trackIndex = this.project.tracks.indexOf(track);
        const laneTop = this.automationLaneTop(trackIndex);
        const value = clamp(1 - (y - laneTop - 2) / (AUTOMATION_LANE_HEIGHT - 8), 0, 1);
        this.store.updateAutomationPoint(this.drag.trackId, this.drag.pointId, {
          time: Math.max(0, this.xToTime(x)),
          value,
        });
        this.engine.reschedule(this.project);
        break;
      }
      case 'marquee': {
        this.marquee = {
          x: Math.min(this.drag.startX, x),
          y: Math.min(this.drag.startY, y),
          w: Math.abs(x - this.drag.startX),
          h: Math.abs(y - this.drag.startY),
        };
        this.scheduleDraw();
        break;
      }
    }
  }

  private duplicateInFlight: string | null = null;

  private ensureDuplicate(sourceClipId: string): string | null {
    if (this.duplicateInFlight) return this.duplicateInFlight;
    const id = this.store.duplicateClip(sourceClipId);
    this.duplicateInFlight = id;
    return id;
  }

  private onMouseUp(e: MouseEvent): void {
    if (this.drag.kind === 'none') return;

    if (this.drag.kind === 'marquee' && this.marquee) {
      // 小幅度拖动视为点击：在自动化层空白处添加关键点
      if (this.marquee.w < 4 && this.marquee.h < 4) {
        const { x, y } = this.localPoint(e);
        const trackIndex = this.hitTrack(y);
        const track = this.project.tracks[trackIndex];
        if (track && this.view.automationTrackId === track.id && y >= this.automationLaneTop(trackIndex)) {
          const laneTop = this.automationLaneTop(trackIndex);
          const value = clamp(1 - (y - laneTop - 2) / (AUTOMATION_LANE_HEIGHT - 8), 0, 1);
          const id = this.store.addAutomationPoint(track.id, this.xToTime(x), value);
          if (id) {
            this.pendingPointId = id;
            window.setTimeout(() => (this.pendingPointId = null), 600);
          }
        }
      }
    }

    this.marquee = null;
    this.duplicateInFlight = null;
    this.drag = { kind: 'none' };
    this.store.flushSave();
    this.scheduleDraw();
  }

  private updateCursor(e: MouseEvent): void {
    const { x, y } = this.localPoint(e);
    let cursor = 'default';
    if (this.hitAutomationPoint(x, y)) cursor = 'grab';
    const hit = this.hitClip(x, y);
    if (hit) {
      cursor = hit.edge === 'body' ? 'move' : 'ew-resize';
    }
    this.canvas.style.cursor = cursor;
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    if (e.ctrlKey || e.metaKey) {
      // 缩放：保持鼠标指向的时间坐标不动
      const anchorTime = this.xToTime(mx);
      const factor = Math.exp(-e.deltaY * 0.0015);
      this.view.pxPerSecond = clamp(this.view.pxPerSecond * factor, 8, 600);
      this.view.scrollTime = Math.max(0, anchorTime - mx / this.view.pxPerSecond);
    } else {
      // 平移：触控板横向手势优先取 deltaX，纵向滚轮映射为横向平移
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      this.view.scrollTime = Math.max(0, this.view.scrollTime + delta / this.view.pxPerSecond);
    }
    this.store.commit();
  }

  private onKeyDown(e: KeyboardEvent): void {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    if (e.key === ' ') {
      e.preventDefault();
      if (this.engine.isPlaying) this.engine.pause();
      else void this.engine.play(this.project);
      return;
    }
    const selected = this.view.selectedClipId ? this.store.findClip(this.view.selectedClipId) : undefined;
    const nudge = this.view.snap ? this.niceStep() / 4 : 0.02;
    if (selected && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      const dir = e.key === 'ArrowLeft' ? -1 : 1;
      const raw = selected.clip.start + dir * (e.shiftKey ? nudge * 5 : nudge);
      const snapped = this.applySnap(raw, selected.clip.id, selected.track.id);
      this.store.updateClipLive(selected.clip.id, { start: Math.max(0, snapped) });
      this.store.flushSave();
    }
    if (selected && e.key.toLowerCase() === 'd') {
      this.store.duplicateClip(selected.clip.id);
    }
    if (selected && (e.key === 'Delete' || e.key === 'Backspace')) {
      this.store.removeClip(selected.clip.id);
      return;
    }
    // 删除选中的自动化关键点（仅作用于其所属轨道）
    if (
      !selected &&
      this.selectedPoint &&
      (e.key === 'Delete' || e.key === 'Backspace')
    ) {
      this.store.removeAutomationPoint(this.selectedPoint.trackId, this.selectedPoint.pointId);
      this.selectedPoint = null;
    }
    if ((e.key === 'Home' || e.key === '0') && !selected) {
      this.engine.seek(this.project, 0);
    }
  }

  /* ---------------- 右键菜单 ---------------- */

  private onContextMenu(e: MouseEvent): void {
    e.preventDefault();
    const { x, y } = this.localPoint(e);

    // 自动化关键点右键：删除该点
    const pointHit = this.hitAutomationPoint(x, y);
    if (pointHit) {
      this.selectedPoint = { trackId: pointHit.track.id, pointId: pointHit.pointId };
      this.contextMenu = {
        x: e.clientX,
        y: e.clientY,
        items: [
          {
            label: '删除关键点 (Del)',
            action: () => {
              this.store.removeAutomationPoint(pointHit.track.id, pointHit.pointId);
              this.selectedPoint = null;
            },
          },
        ],
      };
      this.renderContextMenu();
      this.scheduleDraw();
      return;
    }

    const hit = this.hitClip(x, y);
    const items: { label: string; action: () => void }[] = [];

    if (hit) {
      const { clip } = hit;
      this.view.selectedClipId = clip.id;
      items.push(
        { label: '复制片段 (D)', action: () => this.store.duplicateClip(clip.id) },
        {
          label: clip.muted ? '取消片段静音' : '静音片段',
          action: () => this.store.toggleClipMute(clip.id),
        },
        {
          label: '重命名片段',
          action: () => {
            const name = window.prompt('片段名称', clip.name);
            if (name !== null) this.store.renameClip(clip.id, name);
          },
        },
        { label: '删除片段 (Del)', action: () => this.store.removeClip(clip.id) },
      );
    } else {
      const trackIndex = this.hitTrack(y);
      const track = this.project.tracks[trackIndex];
      if (track) {
        items.push({
          label: '在此添加片段（使用所选资源）',
          action: () => document.dispatchEvent(new CustomEvent('arranger:add-clip-at', { detail: { trackId: track.id, time: this.xToTime(x) } })),
        });
      }
    }

    if (items.length === 0) return;
    this.contextMenu = { x: e.clientX, y: e.clientY, items };
    this.renderContextMenu();
    this.scheduleDraw();
  }

  private renderContextMenu(): void {
    document.querySelectorAll('.context-menu').forEach((el) => el.remove());
    if (!this.contextMenu) return;
    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.style.left = `${this.contextMenu.x}px`;
    menu.style.top = `${this.contextMenu.y}px`;
    for (const item of this.contextMenu.items) {
      const btn = document.createElement('button');
      btn.className = 'context-menu-item';
      btn.textContent = item.label;
      btn.addEventListener('click', () => {
        item.action();
        this.contextMenu = null;
        menu.remove();
      });
      menu.appendChild(btn);
    }
    document.body.appendChild(menu);
  }

  /* ---------------- 外部调用 ---------------- */

  /** 供自动化测试验证吸附算法 */
  applySnapForTest(time: number, excludeClipId: string | null, trackId: string): number {
    return this.applySnap(time, excludeClipId, trackId);
  }

  setPlayhead(t: number): void {
    this.engine.seek(this.project, t);
  }

  refresh(): void {
    this.resize();
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function formatRuler(t: number, step: number): string {
  if (step >= 60) {
    const m = Math.floor(t / 60);
    const s = Math.round(t % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }
  if (step < 1) return t.toFixed(1);
  return `${Math.round(t)}s`;
}
