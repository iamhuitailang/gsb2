// 多轨波形画布：分桶峰值 mipmap 渲染、时间标尺、播放指针、拖拽调偏移、锚点交互。
import { projectTimeFromAnchors, sourceTimeFromAnchors, sourceTimeSimple } from './dsp.js';

const BASE_BUCKET = 256; // 基础桶：每桶最多 256 个采样

export class WaveformView {
  constructor(canvas, app) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.app = app;
    this.viewStart = 0; // 可视窗口左端的工程时间（秒）
    this.pxPerSec = 20;
    this.drag = null; // 当前拖拽状态
    this._bind();
  }

  buildPeaks(buffer) {
    const mono = [];
    const ch = buffer.numberOfChannels;
    const n = buffer.length;
    // 基础桶峰值（同时服务所有缩放级别）。
    const buckets = new Float32Array(Math.ceil(n / BASE_BUCKET));
    const data = buffer.getChannelData(0);
    for (let i = 0; i < n; i++) {
      let v = Math.abs(data[i]);
      if (ch > 1) v = Math.max(v, Math.abs(buffer.getChannelData(1)[i]));
      const b = (i / BASE_BUCKET) | 0;
      if (v > buckets[b]) buckets[b] = v;
    }
    return { buckets, bucketSamples: BASE_BUCKET, sampleRate: buffer.sampleRate };
  }

  sourceToProject(track, sSec) {
    if (this.app.preMode === 'before') return sSec; // 对齐前：源时间即显示时间
    if (track.anchors && track.anchors.length > 0) {
      return projectTimeFromAnchors(sSec, track.anchors);
    }
    // s = p + offset + drift*p  =>  p = (s - offset) / (1 + drift)
    return (sSec - (track.offsetSec || 0)) / (1 + (track.driftPpm || 0) * 1e-6);
  }

  projectToSource(track, pSec) {
    if (this.app.preMode === 'before') return pSec;
    if (track.anchors && track.anchors.length > 0) {
      return sourceTimeFromAnchors(pSec, track.anchors);
    }
    return sourceTimeSimple(pSec, track.offsetSec || 0, track.driftPpm || 0);
  }

  _layout() {
    const tracks = this.app.tracks;
    const headerH = 28;
    const laneH = 78;
    this.canvas.width = this.canvas.clientWidth * devicePixelRatio;
    this.canvas.height = (headerH + tracks.length * laneH) * devicePixelRatio;
    this.canvas.style.height = `${headerH + tracks.length * laneH}px`;
    this.ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    return { headerH, laneH, width: this.canvas.clientWidth };
  }

  render(playheadSec) {
    const { ctx } = this;
    const { headerH, laneH, width } = this._layout();
    const viewEnd = this.viewStart + width / this.pxPerSec;
    ctx.fillStyle = '#16181d';
    ctx.fillRect(0, 0, width, headerH + this.app.tracks.length * laneH);

    // 时间标尺
    ctx.fillStyle = '#20232a';
    ctx.fillRect(0, 0, width, headerH);
    const step = niceStep(width / this.pxPerSec);
    ctx.strokeStyle = '#3a3f4b';
    ctx.fillStyle = '#8b93a7';
    ctx.font = '11px monospace';
    ctx.textBaseline = 'middle';
    for (let t = Math.ceil(this.viewStart / step) * step; t < viewEnd; t += step) {
      const x = (t - this.viewStart) * this.pxPerSec;
      ctx.beginPath();
      ctx.moveTo(x, headerH - 8);
      ctx.lineTo(x, headerH);
      ctx.stroke();
      ctx.fillText(fmtTick(t), x + 4, headerH / 2);
    }

    this.app.tracks.forEach((track, i) => {
      const y = headerH + i * laneH;
      // 轨道底色
      ctx.fillStyle = i === this.app.selectedIndex ? '#1d2129' : '#181b21';
      ctx.fillRect(0, y, width, laneH);
      ctx.strokeStyle = '#262a33';
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();

      if (track.buffer && track.peaks) this._drawWave(track, y, laneH, width, viewEnd);

      // 锚点
      if (this.app.preMode !== 'before' && track.anchors) {
        for (const a of track.anchors) {
          const x = (a.projectSec - this.viewStart) * this.pxPerSec;
          if (x < -10 || x > width + 10) continue;
          ctx.fillStyle = '#f0b429';
          ctx.beginPath();
          ctx.moveTo(x, y + 8);
          ctx.lineTo(x - 6, y);
          ctx.lineTo(x + 6, y);
          ctx.closePath();
          ctx.fill();
          ctx.fillStyle = '#f0b429';
          ctx.fillRect(x - 1, y + 8, 2, laneH - 12);
        }
      }
    });

    // 循环区间
    if (this.app.loopRange) {
      const [ls, le] = this.app.loopRange;
      const x0 = (ls - this.viewStart) * this.pxPerSec;
      const x1 = (le - this.viewStart) * this.pxPerSec;
      ctx.fillStyle = 'rgba(88, 166, 255, 0.12)';
      ctx.fillRect(Math.max(0, x0), headerH, Math.max(0, x1 - x0), this.app.tracks.length * laneH);
    }

    // 播放指针
    const px = (playheadSec - this.viewStart) * this.pxPerSec;
    if (px >= 0 && px <= width) {
      ctx.strokeStyle = '#ff5d5d';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, headerH + this.app.tracks.length * laneH);
      ctx.stroke();
      ctx.lineWidth = 1;
    }
  }

  _drawWave(track, y, laneH, width, viewEnd) {
    const { ctx } = this;
    const { buckets, bucketSamples, sampleRate } = track.peaks;
    const bucketSec = bucketSamples / sampleRate;
    const mid = y + laneH / 2;
    const amp = laneH / 2 - 14;
    // 每个像素覆盖多少秒，决定取哪一级聚合（这里直接按像素聚合基础桶）。
    const secPerPx = 1 / this.pxPerSec;
    const trackColor = track.muted ? '#5a6070' : track.color;

    ctx.fillStyle = trackColor;
    for (let px = 0; px < width; px++) {
      const p0 = this.viewStart + px * secPerPx;
      const p1 = p0 + secPerPx;
      // 像素对应的工程时间 -> 源时间，再映射到基础桶。
      const s0 = this.projectToSource(track, p0);
      const s1 = this.projectToSource(track, p1);
      const b0 = Math.floor(s0 / bucketSec);
      const b1 = Math.max(b0 + 1, Math.ceil(s1 / bucketSec));
      let v = 0;
      for (let b = b0; b < b1; b++) {
        if (b >= 0 && b < buckets.length && buckets[b] > v) v = buckets[b];
      }
      if (v <= 0) continue;
      const h = Math.max(1, v * amp);
      ctx.fillRect(px, mid - h, 1, h * 2);
    }
  }

  // ---- 交互 ----
  _bind() {
    const c = this.canvas;
    c.addEventListener('mousedown', (e) => {
      const rect = c.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const headerH = 28;
      const laneH = 78;
      const tSec = this.viewStart + x / this.pxPerSec;
      if (y < headerH) {
        this.drag = { type: 'seek', x0: x };
        this.app.player.seek(tSec);
        return;
      }
      const idx = Math.floor((y - headerH) / laneH);
      if (idx >= this.app.tracks.length) return;
      this.app.selectTrack(idx);
      const track = this.app.tracks[idx];

      // 命中锚点？
      if (this.app.preMode !== 'before' && track.anchors) {
        for (let k = 0; k < track.anchors.length; k++) {
          const ax = (track.anchors[k].projectSec - this.viewStart) * this.pxPerSec;
          if (Math.abs(ax - x) < 8) {
            this.drag = { type: 'anchor', idx, anchorIdx: k, moved: false };
            return;
          }
        }
      }
      if (e.shiftKey) {
        this.drag = { type: 'seek', x0: x };
        this.app.player.seek(tSec);
      } else {
        this.drag = { type: 'move', idx, startX: x, startOffset: track.offsetSec || 0, moved: false };
      }
    });

    c.addEventListener('mousemove', (e) => {
      if (!this.drag) return;
      const rect = c.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const d = this.drag;
      if (d.type === 'seek') {
        this.app.player.seek(this.viewStart + x / this.pxPerSec);
      } else if (d.type === 'anchor') {
        const track = this.app.tracks[d.idx];
        const a = track.anchors[d.anchorIdx];
        const np = Math.max(0, this.viewStart + x / this.pxPerSec);
        const ds = np - a.projectSec; // 工程时间平移量，源时间随动以保持“整体拖动锚点”
        a.projectSec = np;
        a.sourceSec += ds;
        d.moved = true;
        this.app.onTrackChanged();
      } else if (d.type === 'move') {
        const track = this.app.tracks[d.idx];
        const dSec = (x - d.startX) / this.pxPerSec;
        if (Math.abs(x - d.startX) > 3) d.moved = true;
        if (track.anchors && track.anchors.length > 0) {
          // 锚点模式下整体平移所有锚点。
          for (const a of track.anchors) a.projectSec -= dSec;
        } else {
          // 向右拖 = 轨道变晚 = offset 增大。
          track.offsetSec = d.startOffset + dSec;
        }
        this.app.onTrackChanged();
      }
    });

    window.addEventListener('mouseup', () => {
      this.drag = null;
    });

    c.addEventListener('dblclick', (e) => {
      const rect = c.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const headerH = 28;
      const laneH = 78;
      if (y < headerH) return;
      const idx = Math.floor((y - headerH) / laneH);
      const track = this.app.tracks[idx];
      if (!track) return;
      const projectSec = Math.max(0, this.viewStart + x / this.pxPerSec);
      const sourceSec = this.projectToSource(track, projectSec);
      if (!track.anchors) track.anchors = [];
      track.anchors.push({ projectSec, sourceSec });
      track.anchors.sort((a, b) => a.projectSec - b.projectSec);
      this.app.selectTrack(idx);
      this.app.onTrackChanged();
    });

    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = c.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const anchor = this.viewStart + x / this.pxPerSec;
      const factor = e.deltaY < 0 ? 1.25 : 0.8;
      this.pxPerSec = Math.max(2, Math.min(800, this.pxPerSec * factor));
      this.viewStart = Math.max(0, anchor - x / this.pxPerSec);
      this.app.render();
    }, { passive: false });
  }

  scrollToTime(sec) {
    const width = this.canvas.clientWidth;
    this.viewStart = Math.max(0, sec - width / this.pxPerSec / 2);
  }
}

function niceStep(spanSec) {
  const target = spanSec / 10;
  const pow = 10 ** Math.floor(Math.log10(target));
  for (const m of [1, 2, 5, 10]) {
    if (m * pow >= target) return m * pow;
  }
  return 10 * pow;
}

function fmtTick(sec) {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
}
