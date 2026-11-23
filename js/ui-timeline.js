/* UI 时间轴：坐标换算与 Canvas 绘制。 */
(function () {
  'use strict';

  const U = window.RTUI;
  const M = U.M;
  const state = U.state;
  const canvas = U.canvas;
  const ctx = U.ctx;
  const tooltip = U.tooltip;

  const PAD = { left: 46, right: 16, top: 58, bottom: 26 };

  function canvasCssWidth() {
    return Math.max(320, canvas.getBoundingClientRect().width);
  }

  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const w = canvasCssWidth();
    const h = canvas.getBoundingClientRect().height || 320;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w: w, h: h };
  }

  function makeScale(w) {
    const totalTime = U.chartEnd();
    const totalBeat = M.beatAtSeconds(state.chart, totalTime);
    const innerW = w - PAD.left - PAD.right;
    return {
      totalTime: totalTime,
      totalBeat: totalBeat,
      innerW: innerW,
      timeToX: function (t) {
        if (state.axis === 'time') return PAD.left + (t / totalTime) * innerW;
        const b = M.beatAtSeconds(state.chart, Math.max(0, Math.min(t, totalTime)));
        return PAD.left + (b / totalBeat) * innerW;
      },
      xToTime: function (x) {
        const r = (x - PAD.left) / innerW;
        if (state.axis === 'time') return Math.max(0, Math.min(1, r)) * totalTime;
        const b = Math.max(0, Math.min(1, r)) * totalBeat;
        return M.secondsAtBeat(state.chart, b);
      },
    };
  }

  U.makeScale = makeScale;
  U.canvasCssWidth = canvasCssWidth;
  U.PAD = PAD;

  function hexA(hex, a) {
    const h = (hex || '#888888').trim();
    if (!h.startsWith('#') || (h.length !== 7 && h.length !== 4)) return h;
    let r;
    let g;
    let b;
    if (h.length === 4) {
      r = parseInt(h[1] + h[1], 16);
      g = parseInt(h[2] + h[2], 16);
      b = parseInt(h[3] + h[3], 16);
    } else {
      r = parseInt(h.slice(1, 3), 16);
      g = parseInt(h.slice(3, 5), 16);
      b = parseInt(h.slice(5, 7), 16);
    }
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }

  function roundRect(c, x, y, w, h, r) {
    const rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
    c.beginPath();
    c.moveTo(x + rr, y);
    c.arcTo(x + w, y, x + w, y + h, rr);
    c.arcTo(x + w, y + h, x, y + h, rr);
    c.arcTo(x, y + h, x, y, rr);
    c.arcTo(x, y, x + w, y, rr);
    c.closePath();
  }

  function drawSections(scale, laneTop, laneBottom) {
    const winB = U.cssVar('--win-b');
    const sections = M.getSections(state.chart);
    sections.forEach(function (s, i) {
      const startT = M.secondsAtBeat(state.chart, s.beat);
      const endBeat = i + 1 < sections.length
        ? sections[i + 1].beat : M.chartEndBeat(state.chart) + 4;
      if (i % 2 === 1) {
        ctx.fillStyle = U.cssVar('--surface-2');
        const x1 = scale.timeToX(startT);
        const x2 = scale.timeToX(M.secondsAtBeat(state.chart, endBeat));
        ctx.fillRect(x1, laneTop - 16, Math.max(0, x2 - x1), laneBottom - laneTop + 16);
      }
      if (i === 0) return;
      const x = scale.timeToX(startT);
      ctx.save();
      ctx.strokeStyle = winB;
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, laneTop - 22);
      ctx.lineTo(x, laneBottom);
      ctx.stroke();
      ctx.restore();
      const label = s.bpm + ' BPM';
      ctx.font = '600 10.5px ' + U.cssVar('--sans');
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = winB;
      roundRect(ctx, x + 4, laneTop - 40, tw + 10, 15, 3);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.fillText(label, x + 9, laneTop - 29);
    });
  }

  function drawBars(scale, w, laneBottom) {
    const grid = U.cssVar('--grid');
    const axis = U.cssVar('--axis');
    const bars = M.barLines(state.chart, M.chartEndBeat(state.chart));
    let labelEvery = 1;
    if (bars.length) {
      const minPx = 62;
      let step = 1;
      while (step < 16) {
        const sample = bars.filter(function (_, i) { return i % step === 0; });
        let fits = true;
        for (let i = 1; i < sample.length; i += 1) {
          const d = Math.abs(scale.timeToX(sample[i].time)
            - scale.timeToX(sample[i - 1].time));
          if (d < minPx) { fits = false; break; }
        }
        if (fits) break;
        step += 1;
      }
      labelEvery = step;
    }
    ctx.textBaseline = 'alphabetic';
    bars.forEach(function (b, i) {
      const x = scale.timeToX(b.time);
      if (x < PAD.left - 1 || x > w - PAD.right + 1) return;
      ctx.strokeStyle = b.isSectionStart ? axis : grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, PAD.top - 8);
      ctx.lineTo(x, laneBottom);
      ctx.stroke();
      if (i % labelEvery === 0 || b.isSectionStart) {
        ctx.fillStyle = U.cssVar('--ink-2');
        ctx.font = '600 10.5px ' + U.cssVar('--mono');
        ctx.fillText(String(b.bar), x + 3, PAD.top - 32);
        ctx.fillStyle = U.cssVar('--muted');
        ctx.font = '10px ' + U.cssVar('--mono');
        ctx.fillText(U.fmtSec(b.time, 2), x + 3, PAD.top - 20);
      }
    });
  }

  function drawTicks(scale, w) {
    const grid = U.cssVar('--grid');
    M.beatTicks(state.chart, M.chartEndBeat(state.chart)).forEach(function (tk) {
      const x = scale.timeToX(tk.time);
      if (x < PAD.left || x > w - PAD.right || tk.downbeat) return;
      ctx.strokeStyle = grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, PAD.top - 10);
      ctx.lineTo(x, PAD.top - 4);
      ctx.stroke();
    });
  }

  function drawLaneGrid(w, laneTop, laneH, laneMid) {
    const grid = U.cssVar('--grid');
    const axis = U.cssVar('--axis');
    for (let i = 0; i <= 4; i += 1) {
      const y = laneTop + laneH * i;
      ctx.strokeStyle = i === 0 || i === 4 ? axis : grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(PAD.left, y);
      ctx.lineTo(w - PAD.right, y);
      ctx.stroke();
    }
    ctx.fillStyle = U.cssVar('--muted');
    ctx.font = '10px ' + U.cssVar('--sans');
    [0, 1, 2, 3].forEach(function (l) {
      ctx.fillText('轨道 ' + (l + 1), 6, laneMid(l) + 3.5);
    });
  }

  function drawWindowBands(scale, result, laneTop, laneH) {
    const win = U.activeWindows();
    const tint = state.windowKey === 'A' ? U.cssVar('--win-a') : U.cssVar('--win-b');
    result.noteList.forEach(function (r) {
      const y = laneTop + laneH * r.lane;
      const x1 = scale.timeToX(r.headTime - win.earlyMs / 1000);
      const x2 = scale.timeToX(r.headTime + win.lateMs / 1000);
      ctx.fillStyle = hexA(tint, 0.13);
      ctx.fillRect(x1, y + 3, Math.max(1.5, x2 - x1), laneH - 6);
      const xp = scale.timeToX(r.headTime - win.perfectMs / 1000);
      const xq = scale.timeToX(r.headTime + win.perfectMs / 1000);
      ctx.fillStyle = hexA(tint, 0.18);
      ctx.fillRect(xp, y + 3, Math.max(1.5, xq - xp), laneH - 6);
    });
  }

  function noteColor(overall) {
    const colors = {
      pending: U.cssVar('--s-pending'),
      success: U.cssVar('--s-success'),
      early: U.cssVar('--s-early'),
      late: U.cssVar('--s-late'),
      miss: U.cssVar('--s-miss'),
      earlyRelease: U.cssVar('--s-early-release'),
      holding: U.cssVar('--win-a'),
      complete: U.cssVar('--s-success'),
    };
    return colors[overall] || colors.pending;
  }

  function drawHolds(scale, result, laneMid) {
    result.noteList.forEach(function (r) {
      if (r.type !== 'hold') return;
      const x1 = scale.timeToX(r.headTime);
      const x2 = scale.timeToX(r.tailTime);
      const mid = laneMid(r.lane);
      const color = noteColor(r.overall || 'pending');
      ctx.save();
      ctx.globalAlpha = 0.28;
      ctx.fillStyle = color;
      roundRect(ctx, x1, mid - 6, Math.max(2, x2 - x1), 12, 6);
      ctx.fill();
      ctx.restore();
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.7;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x1, mid);
      ctx.lineTo(x2, mid);
      ctx.stroke();
      ctx.globalAlpha = 1;

      const tail = r.tail;
      if (!tail) return;
      if (tail.state === 'complete') {
        ctx.beginPath();
        ctx.fillStyle = noteColor('success');
        ctx.arc(x2, mid, 4.5, 0, Math.PI * 2);
        ctx.fill();
      } else if (tail.state === 'earlyRelease') {
        const cx = scale.timeToX(tail.t);
        ctx.strokeStyle = noteColor('earlyRelease');
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(cx - 4, mid - 4);
        ctx.lineTo(cx + 4, mid + 4);
        ctx.moveTo(cx + 4, mid - 4);
        ctx.lineTo(cx - 4, mid + 4);
        ctx.stroke();
        ctx.setLineDash([3, 3]);
        ctx.globalAlpha = 0.5;
        ctx.beginPath();
        ctx.moveTo(cx, mid - 8);
        ctx.lineTo(x2, mid - 8);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }
    });
  }

  function drawNotes(scale, result, laneTop, laneH, laneMid, divergenceSet) {
    const surface = U.cssVar('--surface');
    const divergence = U.cssVar('--divergence');
    state.notesDraw = [];
    result.noteList.forEach(function (r) {
      const x = scale.timeToX(r.headTime);
      const mid = laneMid(r.lane);
      const overall = r.overall || 'pending';
      const color = noteColor(overall);
      const hitX = r.head && r.head.state === 'hit' && r.head.t != null
        ? scale.timeToX(r.head.t) : null;

      if (hitX != null) {
        ctx.strokeStyle = hexA(color, 0.55);
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(x, mid - laneH * 0.22);
        ctx.lineTo(hitX, mid - laneH * 0.22);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      if (r.type === 'hold') {
        roundRect(ctx, x - 7, mid - 7, 14, 14, 3);
        ctx.fillStyle = hexA(color, 0.9);
        ctx.fill();
        ctx.strokeStyle = surface;
        ctx.lineWidth = 2;
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(x, mid, 6.5, 0, Math.PI * 2);
        ctx.fillStyle = overall === 'pending' ? hexA(color, 0.35) : color;
        ctx.fill();
        ctx.strokeStyle = surface;
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.strokeStyle = overall === 'pending' ? color : surface;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      if (divergenceSet.has(r.id)) {
        ctx.beginPath();
        ctx.arc(x, mid - laneH * 0.34, 8, 0, Math.PI * 2);
        ctx.fillStyle = surface;
        ctx.fill();
        ctx.strokeStyle = divergence;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.fillStyle = divergence;
        ctx.font = '700 9px ' + U.cssVar('--sans');
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('≠', x, mid - laneH * 0.34 + 0.5);
        ctx.textAlign = 'start';
        ctx.textBaseline = 'alphabetic';
      }

      state.notesDraw.push({ id: r.id, lane: r.lane, x: x, mid: mid, result: r });
    });
  }

  function drawInputs(scale, laneTop, laneH) {
    const color = U.cssVar('--ink-2');
    U.effectiveEvents().forEach(function (e) {
      const x = scale.timeToX(e.t);
      const laneY = laneTop + laneH * e.lane + laneH - 3;
      ctx.beginPath();
      if (e.kind === 'press') {
        ctx.moveTo(x, laneY - 7);
        ctx.lineTo(x + 4.5, laneY);
        ctx.lineTo(x - 4.5, laneY);
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();
      } else {
        ctx.moveTo(x, laneY);
        ctx.lineTo(x + 4, laneY - 7);
        ctx.lineTo(x - 4, laneY - 7);
        ctx.closePath();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }
    });
  }

  function drawPlayhead(scale, laneBottom) {
    const ink = U.cssVar('--ink');
    const px = scale.timeToX(state.playhead);
    ctx.strokeStyle = ink;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(px, PAD.top - 44);
    ctx.lineTo(px, laneBottom + 6);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(px - 4, PAD.top - 44);
    ctx.lineTo(px + 4, PAD.top - 44);
    ctx.lineTo(px, PAD.top - 38);
    ctx.closePath();
    ctx.fillStyle = ink;
    ctx.fill();
  }

  U.drawTimeline = function (result, cmp) {
    const size = resizeCanvas();
    const w = size.w;
    const h = size.h;
    const scale = makeScale(w);

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = U.cssVar('--surface');
    ctx.fillRect(0, 0, w, h);

    const laneTop = PAD.top;
    const laneH = (h - PAD.top - PAD.bottom) / 4;
    const laneMid = function (lane) { return laneTop + laneH * lane + laneH / 2; };
    const laneBottom = laneTop + laneH * 4;

    drawSections(scale, laneTop, laneBottom);
    drawBars(scale, w, laneBottom);
    drawTicks(scale, w);
    drawLaneGrid(w, laneTop, laneH, laneMid);
    if (state.showWindows) drawWindowBands(scale, result, laneTop, laneH);

    const divergenceSet = new Set(cmp ? cmp.divergentNoteIds : []);
    drawHolds(scale, result, laneMid);
    drawNotes(scale, result, laneTop, laneH, laneMid, divergenceSet);
    drawInputs(scale, laneTop, laneH);
    drawPlayhead(scale, laneBottom);

    ctx.fillStyle = U.cssVar('--muted');
    ctx.font = '10px ' + U.cssVar('--sans');
    ctx.fillText(state.axis === 'beat'
      ? '横轴：拍号（小节线同时标注秒数）' : '横轴：秒', PAD.left, h - 7);
    ctx.textAlign = 'right';
    ctx.fillText(U.fmtSec(scale.xToTime(w - PAD.right)), w - PAD.right, h - 7);
    ctx.textAlign = 'start';
  };

  /* ---------- 悬停提示 ---------- */
  U.hideTooltip = function () {
    tooltip.hidden = true;
  };

  U.showHover = function (p, rect) {
    let best = null;
    let bestD = 14;
    const laneH = (rect.height - PAD.top - PAD.bottom) / 4;
    state.notesDraw.forEach(function (n) {
      const midY = PAD.top + laneH * n.lane + laneH / 2;
      const d = Math.abs(n.x - p.x);
      if (d < bestD && Math.abs(midY - p.y) < Math.max(26, laneH / 2)) {
        bestD = d;
        best = n;
      }
    });
    if (!best) {
      U.hideTooltip();
      return;
    }
    const r = best.result;
    const w = U.activeWindows();
    const headState = r.head
      ? (r.head.state === 'miss' ? '漏拍' : U.labelOf(r.head.tier))
      : '待判';
    const tail = r.type === 'hold'
      ? (r.tail ? (r.tail.state === 'complete' ? '完成'
        : r.tail.state === 'earlyRelease' ? '提前松开' : '按住中') : '—')
      : null;
    tooltip.innerHTML = '<div><b>'
      + U.esc(r.type === 'hold' ? '长按 ' + r.id : '单点 ' + r.id)
      + '</b> · 轨道 ' + (r.lane + 1) + '</div>'
      + '<div class="tt-row"><span class="tt-muted">位置</span><span>'
      + U.esc(M.barBeatLabel(state.chart, r.beat).label) + '</span></div>'
      + '<div class="tt-row"><span class="tt-muted">目标</span><span>' + U.fmtSec(r.headTime)
      + (r.type === 'hold' ? ' → ' + U.fmtSec(r.tailTime)
        + '（' + r.durSeconds.toFixed(2) + 's）' : '') + '</span></div>'
      + '<div class="tt-row"><span class="tt-muted">窗口</span><span>−' + w.earlyMs
      + ' / +' + w.lateMs + ' ms</span></div>'
      + '<div class="tt-row"><span class="tt-muted">头部</span><span>' + U.esc(headState)
      + (r.head && r.head.dtMs != null ? ' ' + U.fmtMs(r.head.dtMs) : '') + '</span></div>'
      + (tail != null ? '<div class="tt-row"><span class="tt-muted">尾部</span><span>'
        + U.esc(tail) + '</span></div>' : '');
    tooltip.hidden = false;
    const maxX = rect.width - 12;
    const tw = tooltip.offsetWidth;
    tooltip.style.left = Math.max(8, Math.min(p.x + 14, maxX - tw)) + 'px';
    tooltip.style.top = Math.max(8, p.y - tooltip.offsetHeight - 10) + 'px';
  };
})();
