// Canvas 绘制：波形/包络、首波与反射标注、双响应对比、播放头与点击 seek。
(function (root) {
  const RL = root.RoomLab || (root.RoomLab = {});

  function prepareCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w: rect.width, h: rect.height };
  }

  // 降采样峰值（每像素列取 min/max），channels 可多个，用不同颜色叠加
  function drawWave(canvas, channels, opts = {}) {
    const { ctx, w, h } = prepareCanvas(canvas);
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = opts.grid || '#2a3344';
    ctx.lineWidth = 1;
    for (let g = 1; g < 4; g++) {
      const y = (h / 4) * g;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
    const n = channels[0].length;
    const colors = opts.colors || ['#7cc4ff', '#ffb86b'];
    const mid = h / 2;
    const amp = h / 2 - 4;
    const colsPerChan = Math.max(1, Math.floor(w / channels.length));
    channels.forEach((data, ci) => {
      ctx.strokeStyle = colors[ci % colors.length];
      ctx.lineWidth = 1;
      ctx.beginPath();
      const bucket = n / w;
      for (let x = 0; x < w; x++) {
        const s0 = Math.floor(x * bucket);
        const s1 = Math.max(s0 + 1, Math.floor((x + 1) * bucket));
        let mn = 0, mx = 0;
        for (let s = s0; s < s1 && s < n; s++) {
          const v = data[s];
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
        const xPos = x + (channels.length > 1 ? ci * 0 : 0);
        ctx.moveTo(xPos + 0.5, mid - mx * amp);
        ctx.lineTo(xPos + 0.5, mid - mn * amp);
      }
      ctx.stroke();
    });
    return { w, h };
  }

  // IR 包络 + 首波/主要反射竖线标注
  function drawIR(canvas, env, analysis, sampleRate) {
    const { ctx, w, h } = prepareCanvas(canvas);
    ctx.clearRect(0, 0, w, h);
    const n = env.length;

    // 对数幅度包络填充
    ctx.fillStyle = 'rgba(124,196,255,0.35)';
    const bucket = n / w;
    for (let x = 0; x < w; x++) {
      const s0 = Math.floor(x * bucket);
      const s1 = Math.max(s0 + 1, Math.floor((x + 1) * bucket));
      let mx = 1e-9;
      for (let s = s0; s < s1 && s < n; s++) mx = Math.max(mx, env[s]);
      const db = Math.max(-60, 20 * Math.log10(mx / analysis.envPeak || 1e-9));
      const yTop = h * (1 - (db + 60) / 60);
      ctx.fillRect(x, yTop, 1, h - yTop);
    }

    const xOf = (index) => (index / n) * w;
    // 首波：红色实线
    const fx = xOf(analysis.first.index);
    ctx.strokeStyle = '#ff5d5d';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(fx, 0); ctx.lineTo(fx, h); ctx.stroke();
    ctx.fillStyle = '#ff5d5d';
    ctx.font = '11px ui-monospace, monospace';
    ctx.fillText(`首波 ${analysis.first.timeMs.toFixed(1)}ms`, fx + 4, 12);

    // 主要反射：橙色虚线
    ctx.strokeStyle = '#ffb86b';
    ctx.fillStyle = '#ffb86b';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    analysis.reflections.forEach((r, i) => {
      const x = xOf(r.index);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      if (i < 3) ctx.fillText(`${r.timeMs.toFixed(0)}ms`, x + 2, 26 + i * 13);
    });
    ctx.setLineDash([]);
    return { w, h, xOf };
  }

  // 双响应叠加对比（各自归一化到画布时长，长度不同也可比形状）
  function drawCompare(canvas, irA, irB, analysisA, analysisB) {
    const { ctx, w, h } = prepareCanvas(canvas);
    ctx.clearRect(0, 0, w, h);
    const drawOne = (ir, an, color, fillAlpha) => {
      const n = ir.channels[0].length;
      const peak = an.envPeak;
      const bucket = n / w;
      ctx.fillStyle = color.replace('ALPHA', fillAlpha);
      for (let x = 0; x < w; x++) {
        const s0 = Math.floor(x * bucket);
        const s1 = Math.max(s0 + 1, Math.floor((x + 1) * bucket));
        let mx = 1e-9;
        for (let s = s0; s < s1 && s < n; s++) {
          for (const ch of ir.channels) mx = Math.max(mx, Math.abs(ch[s]));
        }
        const db = Math.max(-60, 20 * Math.log10(mx / peak || 1e-9));
        const yTop = h * (1 - (db + 60) / 60);
        ctx.fillRect(x, yTop, 1, h - yTop);
      }
    };
    drawOne(irA, analysisA, 'rgba(124,196,255,ALPHA)', 0.55);
    drawOne(irB, analysisB, 'rgba(255,138,101,ALPHA)', 0.45);
    ctx.font = '11px ui-monospace, monospace';
    ctx.fillStyle = '#7cc4ff';
    ctx.fillText(`A ${(irA.channels[0].length / irA.sampleRate).toFixed(2)}s`, 8, 14);
    ctx.fillStyle = '#ff8a65';
    ctx.fillText(`B ${(irB.channels[0].length / irB.sampleRate).toFixed(2)}s`, 8, 30);
  }

  function drawPlayhead(canvas, positionSec, durationSec) {
    const rect = canvas.getBoundingClientRect();
    const ctx = canvas.getContext('2d');
    const x = (positionSec / durationSec) * rect.width;
    ctx.save();
    ctx.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0);
    ctx.strokeStyle = '#e8edf6';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, rect.height); ctx.stroke();
    ctx.restore();
  }

  function canvasToSec(canvas, event, durationSec) {
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    return ratio * durationSec;
  }

  RL.ui = { drawWave, drawIR, drawCompare, drawPlayhead, canvasToSec };
})(typeof globalThis !== 'undefined' ? globalThis : this);
