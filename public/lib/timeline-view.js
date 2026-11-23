// 时间线渲染：分段块、转场标记、音频条与播放头。
import { $, h, clear, fmt } from './dom.js';

const GUTTER = 74; // 与 .tl-ruler 的 margin-left 对齐

export class TimelineView {
  constructor({ onSeek, onSelectClip, onSelectTransition, onTrimDrag }) {
    this.wrap = $('#tlWrap');
    this.ruler = $('#tlRuler');
    this.tracks = $('#tlTracks');
    this.playhead = $('#tlPlayhead');
    this.onSeek = onSeek;
    this.onSelectClip = onSelectClip;
    this.onSelectTransition = onSelectTransition;
    this.onTrimDrag = onTrimDrag;
    this.timeline = null;
    this.selectedClip = null;
    this.selectedTransition = null;
    this.dragging = null;
    this.scrub = this.scrub.bind(this);
    this.wrap.addEventListener('pointerdown', (e) => this.beginScrub(e));
  }

  laneWidth() {
    const lane = this.tracks.querySelector('.tl-lane');
    if (lane && lane.clientWidth > 0) return lane.clientWidth;
    return Math.max(100, this.wrap.clientWidth - GUTTER - 16);
  }

  timeToX(t) {
    const dur = this.timeline?.duration || 0;
    if (dur <= 0) return 0;
    return (t / dur) * this.laneWidth();
  }

  xToTime(clientX) {
    const lane = this.tracks.querySelector('.tl-lane');
    if (!lane) return 0;
    const rect = lane.getBoundingClientRect();
    const x = clientX - rect.left;
    const dur = this.timeline?.duration || 0;
    return Math.max(0, Math.min(dur, (x / rect.width) * dur));
  }

  beginScrub(e) {
    if (e.button !== 0) return;
    if (e.target.closest('button, input, select, a')) return;
    const lane = this.tracks.querySelector('.tl-lane');
    if (!lane) return;
    const rect = lane.getBoundingClientRect();
    if (e.clientX < rect.left - 40 || e.clientX > rect.right + 4) return;
    this.dragging = 'scrub';
    this.onSeek(this.xToTime(e.clientX));
    const move = (ev) => { if (this.dragging === 'scrub') this.onSeek(this.xToTime(ev.clientX)); };
    const up = () => {
      this.dragging = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  scrub() { /* 兼容占位 */ }

  render(timeline, { selectedClip = null, selectedTransition = null, playhead = 0, audioPlan = null, filmstrips = {} } = {}) {
    this.timeline = timeline;
    this.selectedClip = selectedClip;
    this.selectedTransition = selectedTransition;
    clear(this.ruler);
    clear(this.tracks);

    if (!timeline.clips.length) {
      this.tracks.append(h('div', { class: 'empty-state' }, '还没有片段。先在左侧添加素材或载入演示三连。'));
      clear(this.ruler);
      this.playhead.style.display = 'none';
      return;
    }

    // 视频轨
    const videoLane = h('div', { class: 'tl-lane video' });
    const videoRow = h('div', { class: 'tl-row' },
      h('div', { class: 'tl-gutter' }, h('span', {}, '画面')),
      videoLane);
    this.tracks.append(videoRow);

    // 音频轨
    const audioLane = h('div', { class: 'tl-lane audio' });
    const audioRow = h('div', { class: 'tl-row audio' },
      h('div', { class: 'tl-gutter' }, h('span', {}, '声音')),
      audioLane);
    this.tracks.append(audioRow);

    // 刻度在轨道插入之后再画，才能量到真实车道宽度
    this.renderRuler(timeline);

    for (const row of timeline.clips) {
      const left = this.timeToX(row.start);
      const right = this.timeToX(row.end);
      const w = Math.max(2, right - left);
      const strip = filmstrips[row.id] || null;
      const block = h('div', {
        class: `clip-block${row.id === selectedClip ? ' selected' : ''}${row.clip.locked ? ' locked' : ''}`,
        style: {
          left: `${left}px`, width: `${w}px`,
          ...(strip ? { backgroundImage: `linear-gradient(180deg, #0d1420bb, #0d1420dd), url("${strip}")`, backgroundSize: 'auto 100%', backgroundRepeat: 'repeat-x' } : {}),
        },
        title: `${row.name}\n入点 ${fmt(row.srcIn)} s · 出点 ${fmt(row.srcOut)} s\n源 ${row.srcFps} fps`,
        onclick: (e) => {
          e.stopPropagation();
          this.onSelectClip?.(row.index);
        },
      },
      h('div', { class: 'cb-title' }, `${row.index + 1}. ${row.name}`),
      h('div', { class: 'cb-sub' }, `${fmt(row.srcIn, 2)}–${fmt(row.srcOut, 2)} s · ${row.frameCount} 帧`));
      videoLane.append(block);
    }

    // 转场标记
    for (const tr of timeline.transitions) {
      const mid = tr.type === 'dissolve' ? (tr.start + tr.end) / 2 : tr.cutAt;
      const x = this.timeToX(mid);
      const width = tr.type === 'dissolve' ? Math.max(8, this.timeToX(tr.end) - this.timeToX(tr.start)) : 14;
      const el = h('div', {
        class: `tl-transition${tr.type === 'dissolve' ? ' dissolve' : ''}`,
        style: { left: `${x}px`, width: `${width}px`, transform: 'translateX(-50%)' },
        dataset: tr.type === 'dissolve' ? { label: `${tr.duration.toFixed(2)}s` } : {},
        title: tr.type === 'dissolve'
          ? `叠化 ${tr.index + 1}：${fmt(tr.duration)} s（${fmt(tr.start)} → ${fmt(tr.end)} s）`
          : `硬切 ${tr.index + 1}：${fmt(tr.cutAt)} s`,
        onclick: (e) => {
          e.stopPropagation();
          this.onSelectTransition?.(tr.index);
        },
      });
      if (tr.index === selectedTransition) el.style.filter = 'brightness(1.35)';
      videoLane.append(el);
    }

    const plan = audioPlan || [];
    for (let i = 0; i < timeline.clips.length; i++) {
      const row = timeline.clips[i];
      const span = plan[i];
      const start = row.start;
      const end = span ? span.end : start;
      const left = this.timeToX(start);
      const right = this.timeToX(end);
      const w = Math.max(2, right - left);
      const silent = !span || span.silent;
      const block = h('div', {
        class: `audio-block${silent ? ' silent' : ''}`,
        style: { left: `${left}px`, width: `${w}px` },
        title: silent ? `${row.name}：${span?.reason || '静音'}` : `${row.name}：音频 ${fmt(span.duration, 2)} s`,
      });
      block.append(h('span', { class: 'ab-label' }, silent ? '静音' : `${fmt(span.duration, 2)}s`));
      if (!silent) {
        const cvs = h('canvas', { width: Math.max(2, Math.round(w * 2)), height: 58 });
        block.append(cvs);
        requestAnimationFrame(() => drawEnvelope(cvs, span, start, end));
      }
      audioLane.append(block);
    }

    this.setPlayhead(playhead);
  }

  renderRuler(timeline) {
    const total = timeline.duration || 0;
    const lane = this.laneWidth();
    const targetTicks = Math.max(3, Math.min(12, Math.round(lane / 90)));
    const step = niceStep(total / targetTicks);
    clear(this.ruler);
    for (let t = 0; t <= total + 1e-6; t += step) {
      const x = this.timeToX(t);
      this.ruler.append(h('div', { class: 'tick', style: { left: `${x}px` } }, `${t.toFixed(step < 1 ? 2 : 1)}s`));
    }
  }

  setPlayhead(t) {
    const x = this.timeToX(t);
    this.playhead.style.display = 'block';
    // 与 .tl-ruler 的 margin-left / 轨道 gutter 对齐（GUTTER = 66px + 8px 间距）
    this.playhead.style.left = `${GUTTER + x}px`;
  }
}

function niceStep(raw) {
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  const exp = Math.floor(Math.log10(raw));
  const base = raw / 10 ** exp;
  const mult = base <= 1 ? 1 : base <= 2 ? 2 : base <= 5 ? 5 : 10;
  return mult * 10 ** exp;
}

function drawEnvelope(canvas, span, start, end) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const pts = span.points || [];
  if (!pts.length) return;
  const dur = Math.max(1e-6, end - start);
  const xOf = (t) => ((t - start) / dur) * W;
  const yOf = (g) => H - 4 - g * (H - 10);
  ctx.beginPath();
  ctx.moveTo(xOf(start), H);
  for (const [t, g] of pts) ctx.lineTo(xOf(t), yOf(g));
  ctx.lineTo(xOf(end), H);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, 'rgba(126,224,193,0.55)');
  grad.addColorStop(1, 'rgba(126,224,193,0.08)');
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.beginPath();
  for (let i = 0; i < pts.length; i++) {
    const [t, g] = pts[i];
    if (i === 0) ctx.moveTo(xOf(t), yOf(g));
    else ctx.lineTo(xOf(t), yOf(g));
  }
  ctx.strokeStyle = 'rgba(126,224,193,0.95)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
}
