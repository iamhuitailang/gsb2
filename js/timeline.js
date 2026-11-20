/*
 * timeline.js — Canvas 时间轴组件
 *
 * 职责：
 *  - 按缩放级别自适应刻度，绘制字幕块、问题标记与播放头；
 *  - 支持拖动整块（move）、左右边缘（start/end）调整时间，拖动时数值吸附到
 *    当前像素精度，放大时间轴即可获得毫秒级拖动精度；
 *  - 拖动结束后自动把播放器定位到受影响片段并试听（auditionMs 毫秒）；
 *  - 点击字幕块选中并跳转，双击时间轴空白处跳转播放位置。
 * 与列表的联动通过回调 onSelect/onTimeChange/onAudition 完成。
 */
(function (root) {
  'use strict';

  const HANDLE_W = 7;          // 边缘命中宽度（css px）
  const ROW_H = 34;            // 字幕块轨道高度
  const RULER_H = 26;
  const AUDITION_MS = 1200;    // 拖完后试听时长上限

  class Timeline {
    constructor(canvas, opts) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.opts = opts; // { getCues, getSelectedId, getDuration, getMode, getFps,
                        //   onSelect, onTimeChange, onSeek, onAudition, getIssueMap }
      this.pixelsPerSecond = 100;
      this.viewStart = 0;      // 视口左端对应的秒数
      this.drag = null;
      this.hover = null;
      this._bound = false;
      this._bind();
      this.resize();
    }

    // ---- 坐标换算 ----
    secToX(sec) { return (sec - this.viewStart) * this.pixelsPerSecond; }
    msToX(ms) { return this.secToX(ms / 1000); }
    xToSec(x) { return this.viewStart + x / this.pixelsPerSecond; }
    xToMs(x) { return Math.round(this.xToSec(x) * 1000); }

    get durationSec() { return Math.max(1, this.opts.getDuration() || 0); }
    get cssW() { return this.canvas.clientWidth; }
    get cssH() { return this.canvas.clientHeight; }

    // 一像素代表多少毫秒 —— 放大后该值变小，拖动精度随之提高
    msPerPixel() { return 1000 / this.pixelsPerSecond; }

    resize() {
      const dpr = root.devicePixelRatio || 1;
      const w = this.cssW, h = this.cssH;
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.clampView();
      this.draw();
    }

    // 缩放：保持鼠标（或视口中心）对应的时间点不动
    zoomAt(factor, centerX) {
      const cx = centerX != null ? centerX : this.cssW / 2;
      const anchorSec = this.xToSec(cx);
      const next = Math.min(2000, Math.max(5, this.pixelsPerSecond * factor));
      this.pixelsPerSecond = next;
      this.viewStart = anchorSec - cx / next;
      this.clampView();
      this.draw();
    }

    fit() {
      this.pixelsPerSecond = Math.max(5, (this.cssW - 24) / this.durationSec);
      this.viewStart = 0;
      this.draw();
    }

    scrollToMs(ms) {
      const x = this.msToX(ms);
      if (x < 20 || x > this.cssW - 20) {
        this.viewStart = ms / 1000 - (this.cssW / 2) / this.pixelsPerSecond;
        this.clampView();
      }
      this.draw();
    }

    clampView() {
      const viewSpan = this.cssW / this.pixelsPerSecond;
      const max = Math.max(0, this.durationSec - viewSpan);
      if (this.viewStart > max) this.viewStart = max;
      if (this.viewStart < 0) this.viewStart = 0;
    }

    // ---- 命中测试 ----
    hitTest(x, y) {
      if (y < RULER_H) return { kind: 'ruler' };
      const cues = this.opts.getCues();
      for (let i = cues.length - 1; i >= 0; i--) {
        const c = cues[i];
        const x1 = this.msToX(c.start);
        const x2 = this.msToX(c.end);
        const top = RULER_H + 4;
        if (y < top || y > top + ROW_H) continue;
        if (x >= x1 - HANDLE_W && x <= x1 + HANDLE_W) {
          return { kind: 'handle', edge: 'start', cue: c };
        }
        if (x >= x2 - HANDLE_W && x <= x2 + HANDLE_W) {
          return { kind: 'handle', edge: 'end', cue: c };
        }
        if (x >= x1 && x <= x2) {
          return { kind: 'block', cue: c };
        }
      }
      return { kind: 'empty' };
    }

    _bind() {
      if (this._bound) return;
      this._bound = true;
      const c = this.canvas;

      c.addEventListener('mousedown', (e) => {
        const rect = c.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const hit = this.hitTest(x, y);
        if (hit.kind === 'block' || hit.kind === 'handle') {
          this.opts.onSelect(hit.cue.id);
          this.drag = {
            mode: hit.kind === 'handle' ? hit.edge : 'move',
            cue: hit.cue,
            startX: x,
            origStart: hit.cue.start,
            origEnd: hit.cue.end,
            moved: false,
          };
          c.style.cursor = hit.kind === 'handle' ? 'ew-resize' : 'grab';
          e.preventDefault();
        } else if (hit.kind === 'ruler' || hit.kind === 'empty') {
          this.drag = { mode: 'scrub', startX: x, moved: false };
        }
      });

      root.addEventListener('mousemove', (e) => {
        const rect = c.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        if (this.drag) this._onDrag(x, e);
        else {
          const hit = this.hitTest(x, y);
          const cursor = hit.kind === 'handle' ? 'ew-resize'
            : hit.kind === 'block' ? 'grab' : hit.kind === 'ruler' ? 'pointer' : 'default';
          if (c.style.cursor !== cursor) c.style.cursor = cursor;
          this.hover = hit.kind === 'block' || hit.kind === 'handle' ? hit.cue.id : null;
          this.draw();
        }
      });

      root.addEventListener('mouseup', () => this._endDrag());

      c.addEventListener('dblclick', (e) => {
        const rect = c.getBoundingClientRect();
        const ms = this.xToMs(e.clientX - rect.left);
        this.opts.onSeek(Math.max(0, ms));
      });

      c.addEventListener('wheel', (e) => {
        if (!e.ctrlKey && !e.metaKey) return; // 普通滚轮交给页面滚动，Ctrl/⌘+滚轮缩放
        e.preventDefault();
        const rect = c.getBoundingClientRect();
        this.zoomAt(e.deltaY < 0 ? 1.2 : 1 / 1.2, e.clientX - rect.left);
      }, { passive: false });

      // 触屏：单指拖动块，双指捏合缩放（基础支持）
      c.addEventListener('touchstart', (e) => {
        const rect = c.getBoundingClientRect();
        const t = e.touches[0];
        const x = t.clientX - rect.left;
        const y = t.clientY - rect.top;
        const hit = this.hitTest(x, y);
        if (hit.kind === 'block' || hit.kind === 'handle') {
          this.opts.onSelect(hit.cue.id);
          this.drag = {
            mode: hit.kind === 'handle' ? hit.edge : 'move',
            cue: hit.cue, startX: x, lastX: x,
            origStart: hit.cue.start, origEnd: hit.cue.end, moved: false,
          };
        }
      }, { passive: true });
      c.addEventListener('touchmove', (e) => {
        if (!this.drag || this.drag.mode === 'scrub') return;
        const rect = c.getBoundingClientRect();
        const x = e.touches[0].clientX - rect.left;
        this._onDrag(x, e);
      }, { passive: true });
      c.addEventListener('touchend', () => this._endDrag());
    }

    _onDrag(x, e) {
      const d = this.drag;
      if (!d) return;
      if (d.mode === 'scrub') {
        this.opts.onSeek(Math.max(0, this.xToMs(x)));
        d.moved = true;
        return;
      }
      const step = this.msPerPixel();
      const deltaMs = Math.round((x - d.startX) * step);
      if (deltaMs === 0 && d.moved) return;
      d.moved = true;

      let start = d.origStart;
      let end = d.origEnd;
      if (d.mode === 'move') {
        const shift = Math.max(-d.origStart, deltaMs); // 不允许拖到负时间
        start = d.origStart + shift;
        end = d.origEnd + shift;
      } else if (d.mode === 'start') {
        start = Math.max(0, d.origStart + deltaMs);
      } else {
        end = Math.max(0, d.origEnd + deltaMs);
      }
      this.opts.onTimeChange(d.cue.id, d.mode, start, end, /*fromDrag*/ true);
    }

    _endDrag() {
      const d = this.drag;
      this.drag = null;
      this.canvas.style.cursor = 'default';
      if (d && d.moved && d.cue) {
        // 先提交一次历史记录（拖拽过程中的实时修改未写栈），再试听受影响片段
        if (this.opts.onDragCommit) this.opts.onDragCommit(d.cue, d.origStart, d.origEnd);
        const cue = d.cue;
        const from = d.mode === 'end' ? Math.max(0, cue.end - AUDITION_MS) : cue.start;
        const to = cue.end + 300;
        this.opts.onAudition(cue.id, from, to);
      }
    }

    // ---- 绘制 ----
    draw() {
      const ctx = this.ctx;
      const w = this.cssW, h = this.cssH;
      ctx.clearRect(0, 0, w, h);
      this._drawRuler(ctx, w);
      this._drawCues(ctx);
      this._drawPlayhead(ctx, w, h);
    }

    _drawRuler(ctx, w) {
      ctx.fillStyle = '#1d2433';
      ctx.fillRect(0, 0, w, RULER_H);
      ctx.strokeStyle = '#3a4560';
      ctx.beginPath();
      ctx.moveTo(0, RULER_H + 0.5);
      ctx.lineTo(w, RULER_H + 0.5);
      ctx.stroke();

      // 自适应刻度：目标刻度间距 80~160px
      const niceSteps = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60, 300];
      let step = niceSteps[niceSteps.length - 1];
      for (const s of niceSteps) {
        if (s * this.pixelsPerSecond >= 80) { step = s; break; }
      }
      const t0 = Math.floor(this.viewStart / step) * step;
      ctx.font = '10px ui-monospace, monospace';
      ctx.fillStyle = '#8b97b3';
      ctx.textBaseline = 'top';
      const digits = step < 1 ? (step < 0.01 ? 3 : step < 0.1 ? 2 : 1) : 0;
      for (let t = t0; t <= this.xToSec(w); t += step) {
        const x = this.secToX(t);
        if (x < -2 || x > w + 2) continue;
        ctx.strokeStyle = '#3a4560';
        ctx.beginPath();
        ctx.moveTo(x + 0.5, RULER_H - 7);
        ctx.lineTo(x + 0.5, RULER_H);
        ctx.stroke();
        ctx.fillText(root.Time.secondsToLabel(t, digits), x + 3, 4);
      }
    }

    _drawCues(ctx) {
      const cues = this.opts.getCues();
      const issueMap = this.opts.getIssueMap();
      const selectedId = this.opts.getSelectedId();
      const top = RULER_H + 4;
      cues.forEach((cue) => {
        const x1 = this.msToX(cue.start);
        const x2 = this.msToX(cue.end);
        if (x2 < -20 || x1 > this.cssW + 20) return;
        const selected = cue.id === selectedId;
        const hovered = cue.id === this.hover;
        const cueIssues = issueMap.get(cue.id) || [];
        const hasError = cueIssues.some((i) => i.level === 'error');
        const hasWarn = cueIssues.some((i) => i.level === 'warning');
        const hasIgnored = cueIssues.some((i) => i.level === 'ignored');

        let fill = selected ? '#3b82f6' : hovered ? '#2b4a7a' : '#26405f';
        if (hasError) fill = selected ? '#b93548' : '#7a2a38';
        else if (hasWarn) fill = selected ? '#b07b25' : '#6b5326';
        else if (hasIgnored) fill = selected ? '#3d7a52' : '#2c4d3a';

        const bw = Math.max(4, x2 - x1);
        ctx.fillStyle = fill;
        roundRect(ctx, x1, top, bw, ROW_H, 4);
        ctx.fill();
        ctx.strokeStyle = selected ? '#93c5fd' : '#4a5b80';
        ctx.lineWidth = selected ? 1.6 : 1;
        ctx.stroke();

        // 左右拖动手柄
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.fillRect(x1 - 1, top + 6, 2, ROW_H - 12);
        ctx.fillRect(x1 + bw - 1, top + 6, 2, ROW_H - 12);

        // 块内文字（空间不够就截断）
        if (bw > 26) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(x1 + 4, top, bw - 8, ROW_H);
          ctx.clip();
          ctx.font = '11px -apple-system, "PingFang SC", sans-serif';
          ctx.fillStyle = '#e8edf7';
          ctx.textBaseline = 'middle';
          const label = String(cue.text || '').split('\n')[0] || '(空文本)';
          ctx.fillText(label, x1 + HANDLE_W, top + ROW_H / 2 + 1);
          ctx.restore();
        }
      });
    }

    _drawPlayhead(ctx, w, h) {
      const sec = this.opts.getCurrentTime();
      const x = this.secToX(sec);
      if (x < 0 || x > w) return;
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, h);
      ctx.stroke();
      ctx.fillStyle = '#f59e0b';
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x - 6, 0);
      ctx.lineTo(x, 6, 0);
      ctx.closePath();
      ctx.fill();
    }
  }

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  const api = { Timeline, RULER_H, ROW_H, AUDITION_MS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.TimelineUI = api;
})(typeof window !== 'undefined' ? window : globalThis);
