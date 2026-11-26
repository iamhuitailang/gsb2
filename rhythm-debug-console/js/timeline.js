/*!
 * timeline.js —— Canvas 时间轴渲染
 * 双行刻度：上行拍号（beat，含小节分组），下行实际秒数；
 * 变速段背景分段着色；音符/输入/判定窗口全部为程序绘制的图形。
 */
(function (global) {
  'use strict';

  const COLORS = {
    bg: '#0f1420',
    lane: '#171e2e',
    laneBorder: '#2a3550',
    segA: 'rgba(64, 120, 200, 0.10)',
    segB: 'rgba(200, 120, 64, 0.12)',
    segLine: '#e0a040',
    beatLine: '#2c3852',
    barLine: '#465980',
    beatText: '#8fa3c8',
    secText: '#7c8aa6',
    tap: '#5ab0ff',
    hold: '#35d07f',
    holdBody: 'rgba(53, 208, 127, 0.28)',
    holdBorder: '#35d07f',
    inputDown: '#ffd166',
    inputUp: '#c98bff',
    window: 'rgba(90, 176, 255, 0.10)',
    windowEdge: 'rgba(90, 176, 255, 0.45)',
    relWindow: 'rgba(53, 208, 127, 0.12)',
    playhead: '#ff5d73',
    checkpoint: '#ffd166',
    perfect: '#35d07f',
    good: '#5ab0ff',
    miss: '#ff5d73',
    early: '#ff9f43',
  };

  /** 旧版浏览器无 CanvasRenderingContext2D.roundRect 时的兜底实现。 */
  function installRoundRect(ctx) {
    if (typeof ctx.roundRect === 'function') return;
    ctx.roundRect = function (x, y, w, h, r) {
      const rad = Math.min(r || 0, w / 2, h / 2);
      this.moveTo(x + rad, y);
      this.arcTo(x + w, y, x + w, y + h, rad);
      this.arcTo(x + w, y + h, x, y + h, rad);
      this.arcTo(x, y + h, x, y, rad);
      this.arcTo(x, y, x + w, y, rad);
      this.closePath();
    };
  }

  class Timeline {
    constructor(canvas, engine) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.engine = engine;
      installRoundRect(this.ctx);
      this.chart = null;
      this.inputs = [];
      this.segs = [];
      this.notes = [];
      this.viewStart = 0;   // 秒
      this.viewEnd = 10;
      this.playhead = null;
      this.checkpoint = null;
      this.windows = null; // 判定窗口（绘制窗口区）
      this.onSeek = null;  // 点击/拖拽时间轴回调
      this._drag = false;
      this._bind();
      this._resize();
    }

    _bind() {
      const toTime = (ev) => {
        const rect = this.canvas.getBoundingClientRect();
        const x = (ev.clientX - rect.left) * (this.canvas.width / rect.width) / devicePixelRatio;
        return this.viewStart + (x / this._plotW()) * (this.viewEnd - this.viewStart);
      };
      this.canvas.addEventListener('pointerdown', (ev) => {
        this._drag = true;
        this.canvas.setPointerCapture(ev.pointerId);
        if (this.onSeek) this.onSeek(Math.max(0, toTime(ev)));
      });
      this.canvas.addEventListener('pointermove', (ev) => {
        if (this._drag && this.onSeek) this.onSeek(Math.max(0, toTime(ev)));
      });
      this.canvas.addEventListener('pointerup', () => { this._drag = false; });
    }

    _resize() {
      const dpr = window.devicePixelRatio || 1;
      const rect = this.canvas.getBoundingClientRect();
      this.canvas.width = Math.round(rect.width * dpr);
      this.canvas.height = Math.round(rect.height * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this._w = rect.width;
      this._h = rect.height;
    }

    setData(chart, inputs, windows) {
      this.chart = chart;
      this.inputs = inputs || [];
      this.windows = windows || null;
      if (chart) {
        this.segs = this.engine.buildTimeline(chart);
        this.notes = this.engine.prepareNotes(chart, this.segs);
      } else {
        this.segs = [];
        this.notes = [];
      }
      this.fit();
    }

    /** 计算谱面总时长并自动适配视野。 */
    fit() {
      let end = 6;
      for (const n of this.notes) end = Math.max(end, (n.endTime || n.startTime) + 0.5);
      this.viewStart = 0;
      this.viewEnd = Math.max(8, end);
      this.draw();
    }

    setPlayhead(t) { this.playhead = t; this.draw(); };
    setCheckpoint(t) { this.checkpoint = t; this.draw(); };

    _plotX() { return 8; }
    _plotW() { return this._w - 16; }
    x(t) { return this._plotX() + ((t - this.viewStart) / (this.viewEnd - this.viewStart)) * this._plotW(); }
    timeAtX(px) { return this.viewStart + ((px - this._plotX()) / this._plotW()) * (this.viewEnd - this.viewStart); }

    /* ---------------- 主绘制 ---------------- */
    draw() {
      if (!this._w) this._resize();
      const ctx = this.ctx;
      ctx.clearRect(0, 0, this._w, this._h);
      ctx.fillStyle = COLORS.bg;
      ctx.fillRect(0, 0, this._w, this._h);
      if (!this.chart) return;

      const topH = 46;                 // 双行刻度区高度
      const laneTop = topH + 6;
      const laneH = this._h - laneTop - 10;
      const laneMid = laneTop + laneH * 0.55;

      this._drawSegments(laneTop, laneH);
      this._drawGrids(topH, laneTop, laneH);
      this._drawJudgeWindows(laneTop, laneH);
      this._drawNotes(laneTop, laneH, laneMid);
      this._drawInputs(laneTop, laneH, laneMid);
      this._drawPlayhead(topH, laneTop, laneH);
      this._drawCheckpoint(topH, laneTop, laneH);
    }

    _drawSegments(laneTop, laneH) {
      const ctx = this.ctx;
      for (let i = 0; i < this.segs.length; i++) {
        const s = this.segs[i];
        const x0 = this.x(s.startTime);
        const x1 = i + 1 < this.segs.length ? this.x(this.segs[i + 1].startTime) : this._plotX() + this._plotW();
        ctx.fillStyle = i % 2 ? COLORS.segB : COLORS.segA;
        ctx.fillRect(x0, laneTop, Math.max(0, x1 - x0), laneH);
        if (i > 0) {
          ctx.strokeStyle = COLORS.segLine;
          ctx.setLineDash([5, 4]);
          ctx.beginPath();
          ctx.moveTo(x0, laneTop - 2);
          ctx.lineTo(x0, laneTop + laneH);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = COLORS.segLine;
          ctx.font = '10px ui-monospace, monospace';
          ctx.fillText(`${s.bpm} BPM`, x0 + 3, laneTop + 12);
        }
      }
      // 初始 BPM 标注
      ctx.fillStyle = COLORS.segLine;
      ctx.font = '10px ui-monospace, monospace';
      ctx.fillText(`${this.segs[0].bpm} BPM`, this._plotX() + 3, laneTop + 12);
    }

    /** 双行刻度：拍号（按拍号取整，小节线加重）+ 秒数（等间距 1s）。 */
    _drawGrids(topH, laneTop, laneH) {
      const ctx = this.ctx;
      const beatsPerBar = (this.chart.timeSignature && this.chart.timeSignature[0]) || 4;
      const span = this.viewEnd - this.viewStart;

      // --- 拍号刻度：以 0.5 拍为最小粒度，按视野密度抽稀 ---
      const minGap = 26;
      const b0 = Math.floor(this.engine.timeToBeat(this.segs, this.viewStart) * 2) / 2;
      const b1 = Math.ceil(this.engine.timeToBeat(this.segs, this.viewEnd) * 2) / 2;
      let step = 0.5;
      while (true) {
        const tMid = this.engine.beatToTime(this.segs, (b0 + b1) / 2);
        const pxPerStep = (60 / this._guessBpm(tMid)) * step / span * this._plotW();
        if (pxPerStep >= minGap || step >= 4) break;
        step *= 2;
      }
      ctx.textAlign = 'center';
      for (let b = Math.ceil(b0 / step) * step; b <= b1 + 1e-9; b += step) {
        const t = this.engine.beatToTime(this.segs, b);
        if (t < this.viewStart || t > this.viewEnd) continue;
        const x = this.x(t);
        const isBar = Math.abs(b / beatsPerBar - Math.round(b / beatsPerBar)) < 1e-9;
        const isBeat = Math.abs(b - Math.round(b)) < 1e-9;
        ctx.strokeStyle = isBar ? COLORS.barLine : COLORS.beatLine;
        ctx.lineWidth = isBar ? 1.4 : 1;
        ctx.beginPath();
        ctx.moveTo(x, topH - 14);
        ctx.lineTo(x, laneTop + laneH);
        ctx.stroke();
        if (isBar || isBeat) {
          ctx.fillStyle = isBar ? '#cdd9f2' : COLORS.beatText;
          ctx.font = isBar ? 'bold 10px ui-monospace, monospace' : '10px ui-monospace, monospace';
          const label = isBar ? `${Math.round(b / beatsPerBar) + 1}小` : (Number.isInteger(b) ? `${b}` : b.toFixed(1));
          ctx.fillText(label, x, 12);
        }
      }
      ctx.fillStyle = COLORS.beatText;
      ctx.font = '9px ui-monospace, monospace';
      ctx.textAlign = 'left';
      ctx.fillText('拍号 →', this._plotX(), 12);

      // --- 秒数刻度：固定 1 秒 ---
      ctx.textAlign = 'center';
      for (let s = Math.ceil(this.viewStart); s <= this.viewEnd; s++) {
        const x = this.x(s);
        ctx.fillStyle = COLORS.secText;
        ctx.font = '10px ui-monospace, monospace';
        ctx.fillText(`${s}s`, x, topH - 2);
      }
      ctx.fillStyle = COLORS.secText;
      ctx.font = '9px ui-monospace, monospace';
      ctx.textAlign = 'left';
      ctx.fillText('秒数 →', this._plotX(), topH - 2);
      ctx.lineWidth = 1;
    }

    _guessBpm(t) {
      let s = this.segs[0];
      for (const seg of this.segs) if (seg.startTime <= t) s = seg;
      return s.bpm;
    }

    _drawJudgeWindows(laneTop, laneH) {
      if (!this.windows) return;
      const ctx = this.ctx;
      const late = this.windows.lateMs / 1000;
      const rel = this.windows.releaseMs / 1000;
      for (const n of this.notes) {
        // 头部窗口
        const x0 = this.x(n.startTime - late), x1 = this.x(n.startTime + late);
        ctx.fillStyle = COLORS.window;
        ctx.fillRect(x0, laneTop, Math.max(1, x1 - x0), laneH);
        ctx.strokeStyle = COLORS.windowEdge;
        ctx.lineWidth = 1;
        ctx.strokeRect(x0 + 0.5, laneTop + 0.5, Math.max(1, x1 - x0 - 1), laneH - 1);
        if (n.type === 'hold') {
          // 尾部松开容差窗
          const rx = this.x(n.endTime - rel);
          ctx.fillStyle = COLORS.relWindow;
          ctx.fillRect(rx, laneTop, Math.max(1, this.x(n.endTime) - rx), laneH);
        }
      }
    }

    _drawNotes(laneTop, laneH, laneMid) {
      const ctx = this.ctx;
      for (const n of this.notes) {
        const x = this.x(n.startTime);
        if (n.type === 'tap') {
          // 菱形单点
          ctx.fillStyle = COLORS.tap;
          ctx.beginPath();
          ctx.moveTo(x, laneMid - 11);
          ctx.lineTo(x + 9, laneMid);
          ctx.lineTo(x, laneMid + 11);
          ctx.lineTo(x - 9, laneMid);
          ctx.closePath();
          ctx.fill();
          this._label(n.id, x, laneMid + 26);
        } else {
          const x2 = this.x(n.endTime);
          // 长按体
          ctx.fillStyle = COLORS.holdBody;
          ctx.strokeStyle = COLORS.holdBorder;
          ctx.lineWidth = 1.5;
          const bodyH = 18;
          ctx.beginPath();
          ctx.roundRect(x, laneMid - bodyH / 2, Math.max(2, x2 - x), bodyH, 6);
          ctx.fill();
          ctx.stroke();
          // 头部圆 + 尾部圆
          for (const hx of [x, x2]) {
            ctx.fillStyle = COLORS.hold;
            ctx.beginPath();
            ctx.arc(hx, laneMid, 7, 0, Math.PI * 2);
            ctx.fill();
          }
          this._label(n.id, (x + x2) / 2, laneMid - 16);
        }
      }
    }

    _label(text, x, y) {
      const ctx = this.ctx;
      ctx.fillStyle = '#9db0d0';
      ctx.font = '9px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(text, x, y);
    }

    _drawInputs(laneTop, laneH, laneMid) {
      const ctx = this.ctx;
      const downY = laneTop + laneH - 14;
      const upY = laneTop + 6;
      // 配对 down->up 画按住连线
      let held = false, downX = 0;
      for (const inp of this.inputs) {
        const x = this.x(inp.time);
        if (inp.type === 'down') { held = true; downX = x; }
        else if (inp.type === 'up' && held) {
          ctx.strokeStyle = 'rgba(255, 209, 102, 0.35)';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(downX, downY);
          ctx.lineTo(x, downY);
          ctx.stroke();
          held = false;
        }
      }
      for (const inp of this.inputs) {
        const x = this.x(inp.time);
        if (inp.type === 'down') {
          ctx.fillStyle = COLORS.inputDown;
          ctx.beginPath();
          ctx.moveTo(x, downY - 7);
          ctx.lineTo(x + 5, downY);
          ctx.lineTo(x, downY + 7);
          ctx.lineTo(x - 5, downY);
          ctx.closePath();
          ctx.fill();
        } else {
          ctx.fillStyle = COLORS.inputUp;
          ctx.beginPath();
          ctx.moveTo(x, upY + 7);
          ctx.lineTo(x + 5, upY);
          ctx.lineTo(x, upY - 7);
          ctx.lineTo(x - 5, upY);
          ctx.closePath();
          ctx.fill();
        }
      }
      // 图例
      ctx.font = '9px ui-monospace, monospace';
      ctx.textAlign = 'left';
      ctx.fillStyle = COLORS.inputDown;
      ctx.fillText('▼ down', this._plotX() + 2, upY - 1);
      ctx.fillStyle = COLORS.inputUp;
      ctx.fillText('▲ up', this._plotX() + 48, upY - 1);
    }

    _drawPlayhead(topH, laneTop, laneH) {
      if (this.playhead == null) return;
      const x = this.x(this.playhead);
      const ctx = this.ctx;
      ctx.strokeStyle = COLORS.playhead;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, laneTop + laneH);
      ctx.stroke();
      ctx.fillStyle = COLORS.playhead;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x - 5, 8);
      ctx.lineTo(x + 5, 8);
      ctx.closePath();
      ctx.fill();
    }

    _drawCheckpoint(topH, laneTop, laneH) {
      if (this.checkpoint == null) return;
      const x = this.x(this.checkpoint);
      const ctx = this.ctx;
      ctx.strokeStyle = COLORS.checkpoint;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x, topH - 14);
      ctx.lineTo(x, laneTop + laneH);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = COLORS.checkpoint;
      ctx.font = '9px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('检查点', x, topH - 16);
    }
  }

  global.Timeline = Timeline;
  global.TimelineColors = COLORS;
})(window);
