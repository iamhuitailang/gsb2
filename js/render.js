/* 投影校正工具 —— 渲染器
 *
 * 关键做法：对输出画面的每个像素，用单应的逆矩阵反查它在源素材上的规范坐标，
 * 再做双线性插值采样。这样得到的等距网格在任何倾斜角度下都严格符合透视关系
 * （平行线正确汇聚到消失点），是逐像素纹理映射，不是把四角做仿射拉伸。
 *
 * 双幕拼接用浮点累加器模拟真实边缘融合：每块幕按重叠带权重贡献亮度，
 * 权重和 >1 的区域可以红色标注，提示操作员“这里偏亮，需要继续压曲线”。
 */
(function (global) {
  'use strict';

  var PCAL = global.PCAL;
  var M = PCAL.math;
  var PATTERN = PCAL.pattern;

  /** 重建/刷新源素材画布。 */
  function renderSourceCanvas(srcCanvas, type, customImage) {
    var S = PATTERN.SRC_SIZE;
    srcCanvas.width = S;
    srcCanvas.height = S;
    var ctx = srcCanvas.getContext('2d');
    PATTERN.renderSource(ctx, S, S, type, customImage);
  }

  /** 双线性采样（uv 为规范坐标 0..1）。 */
  function sampleBilinear(data, size, u, v) {
    var fx = u * (size - 1);
    var fy = v * (size - 1);
    var x0 = fx | 0, y0 = fy | 0;
    var x1 = Math.min(x0 + 1, size - 1), y1 = Math.min(y0 + 1, size - 1);
    var tx = fx - x0, ty = fy - y0;
    var i00 = (y0 * size + x0) * 4, i10 = (y0 * size + x1) * 4;
    var i01 = (y1 * size + x0) * 4, i11 = (y1 * size + x1) * 4;
    var out = [0, 0, 0];
    for (var c = 0; c < 3; c++) {
      var top = data[i00 + c] * (1 - tx) + data[i10 + c] * tx;
      var bot = data[i01 + c] * (1 - tx) + data[i11 + c] * tx;
      out[c] = top * (1 - ty) + bot * ty;
    }
    return out;
  }

  /**
   * 单块幕在源规范 u 坐标上的融合权重。
   * overlap: {a,b,side:'right'|'left'}；side 表示权重在重叠带的哪一侧降为 0。
   * gamma 控制曲线：gamma 越小，两块幕在带内同时保持高权重 → 明显偏亮（示例初始状态）。
   */
  function bandWeight(u, ov, gamma) {
    if (!ov || ov.a >= ov.b) return 1;
    if (u <= ov.a || u >= ov.b) {
      if (ov.side === 'right') return u >= ov.b ? 0 : 1;
      return u <= ov.a ? 0 : 1;
    }
    var t = (u - ov.a) / (ov.b - ov.a); // 0..1
    if (ov.side === 'right') return Math.pow(1 - t, gamma); // 左幕：带内 1→0
    return Math.pow(t, gamma);                               // 右幕：带内 0→1
  }

  /**
   * 渲染一块幕到浮点累加器。
   * acc[3] 存 RGB 累加，wsum 存权重和，均为 w*h 长度/三倍长度。
   */
  function accumulateScreen(model, srcData, srcSize, w, h, acc, wsum, rowStart, rowEnd) {
    var invH = model.invH;
    var quad = model.quadPx;
    var b = PCAL.geometry.quadBounds(quad);
    var xMin = Math.max(0, Math.floor(b.minX));
    var xMax = Math.min(w - 1, Math.ceil(b.maxX));
    var yMin = Math.max(0, Math.floor(b.minY), rowStart);
    var yMax = Math.min(h - 1, Math.ceil(b.maxY), rowEnd);
    var ov = model.overlap, gamma = model.gamma, gain = model.gain;

    for (var y = yMin; y <= yMax; y++) {
      for (var x = xMin; x <= xMax; x++) {
        var s = M.applyH(invH, x + 0.5, y + 0.5);
        var u = s.x, v = s.y;
        if (u < 0 || u > 1 || v < 0 || v > 1) continue;
        var rgb = sampleBilinear(srcData, srcSize, u, v);
        var weight = gain * bandWeight(u, ov, gamma);
        var idx = y * w + x;
        var p = idx * 3;
        acc[p] += rgb[0] * weight;
        acc[p + 1] += rgb[1] * weight;
        acc[p + 2] += rgb[2] * weight;
        wsum[idx] += weight;
      }
    }
  }

  /**
   * 综合渲染（单幕或双幕）。分块异步，避免 4K 导出时界面卡死。
   * models: 由 buildScreenModels 产出；opts: { showOverflow:boolean, onProgress:fn }
   * 返回 Promise。
   */
  function renderComposite(targetCanvas, srcCanvas, models, outW, outH, opts) {
    opts = opts || {};
    targetCanvas.width = outW;
    targetCanvas.height = outH;
    var ctx = targetCanvas.getContext('2d');
    var srcCtx = srcCanvas.getContext('2d');
    var srcSize = srcCanvas.width;
    var srcData = srcCtx.getImageData(0, 0, srcSize, srcSize).data;

    var n = outW * outH;
    var acc = new Float32Array(n * 3);
    var wsum = new Float32Array(n);

    var active = models.filter(function (m) { return m.valid && m.enabled; });
    var CHUNK = 96; // 每块行数
    return new Promise(function (resolve) {
      var row = 0;
      function step() {
        var end = Math.min(outH, row + CHUNK);
        for (var i = 0; i < active.length; i++) {
          accumulateScreen(active[i], srcData, srcSize, outW, outH, acc, wsum, row, end - 1);
        }
        row = end;
        if (opts.onProgress) opts.onProgress(row / outH);
        if (row < outH) {
          setTimeout(step, 0);
        } else {
          var img = ctx.createImageData(outW, outH);
          var d = img.data;
          for (var k = 0; k < n; k++) {
            var p3 = k * 3, p4 = k * 4;
            var r = acc[p3], g = acc[p3 + 1], b = acc[p3 + 2], wgt = wsum[k];
            if (wgt > 0) {
              // 溢出提示：权重和超过 1.02 的像素向红色偏移（真实投影机会直接过曝发白）
              if (opts.showOverflow && wgt > 1.02) {
                var t = Math.min(1, (wgt - 1.02) * 4);
                r = r * (1 - t * 0.55) + 255 * t * 0.55;
                g = g * (1 - t * 0.75);
                b = b * (1 - t * 0.75);
              }
              d[p4] = Math.min(255, r);
              d[p4 + 1] = Math.min(255, g);
              d[p4 + 2] = Math.min(255, b);
              d[p4 + 3] = 255;
            } else {
              d[p4 + 3] = 0; // 幕外保持透明，由 CSS 底色衬托
            }
          }
          ctx.putImageData(img, 0, 0);
          resolve();
        }
      }
      step();
    });
  }

  /**
   * 由状态构造每块幕的计算模型（像素四边形 + 正/逆单应）。
   * quad 为规范输出坐标 (0..1)，按目标画布尺寸换算成像素。
   */
  function buildScreenModels(screens, targetW, targetH) {
    var unit = [
      { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }
    ];
    return screens.map(function (sc) {
      var quadPx = sc.quad.map(function (p) {
        return { x: p.x * targetW, y: p.y * targetH };
      });
      var check = PCAL.geometry.validateQuad(quadPx);
      var H = null, invH = null;
      if (check.valid) {
        H = M.findHomography(unit, quadPx);
        invH = H ? M.invert3(H) : null;
      }
      return {
        index: sc.id,
        enabled: sc.enabled,
        valid: check.valid && !!invH,
        reason: check.reason,
        quadNorm: sc.quad,
        quadPx: quadPx,
        H: H,
        invH: invH,
        overlap: sc.overlap,
        gain: sc.gain,
        gamma: sc.gamma
      };
    });
  }

  /* ---------------- 叠加层：角点、标记、重叠带 ---------------- */

  function traceQuad(ctx, quad, close) {
    ctx.beginPath();
    ctx.moveTo(quad[0].x, quad[0].y);
    for (var i = 1; i < quad.length; i++) ctx.lineTo(quad[i].x, quad[i].y);
    if (close !== false) ctx.closePath();
  }

  /** 输出/变形视图上的角点手柄与幕面轮廓。toPx: 规范坐标→画布像素。 */
  function drawHandles(ctx, models, toPx, activeScreen, disabledStyle) {
    models.forEach(function (m) {
      var q = m.quadNorm.map(toPx);
      ctx.save();
      if (!m.enabled) ctx.setLineDash([8, 6]);
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = m.enabled ? (m.index === activeScreen ? '#ffd54a' : '#7fd7ff') : '#8a8f98';
      traceQuad(ctx, q);
      ctx.stroke();
      ctx.setLineDash([]);
      if (!m.enabled) {
        ctx.fillStyle = 'rgba(138,143,152,0.08)';
        traceQuad(ctx, q);
        ctx.fill();
      }
      // 角点
      q.forEach(function (p, i) {
        var sel = m.enabled && m.index === activeScreen;
        ctx.beginPath();
        ctx.arc(p.x, p.y, sel ? 9 : 7, 0, Math.PI * 2);
        ctx.fillStyle = m.valid ? (sel ? '#ffd54a' : '#7fd7ff') : '#ff5c7a';
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#111418';
        ctx.stroke();
        ctx.fillStyle = '#111418';
        ctx.font = '700 11px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(i + 1), p.x, p.y + 0.5);
      });
      ctx.restore();
    });
  }

  /** 在源视图上画固定标记与探针；在输出视图上画它们经单应映射后的位置。 */
  function drawMarkers(ctx, markers, toPx, color) {
    markers.forEach(function (mk) {
      var p = toPx(mk);
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 10, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(p.x - 15, p.y); ctx.lineTo(p.x + 15, p.y);
      ctx.moveTo(p.x, p.y - 15); ctx.lineTo(p.x, p.y + 15);
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.font = '700 12px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(mk.label, p.x + 14, p.y - 10);
      ctx.restore();
    });
  }

  /** 重叠带：源视图上直接按 u 区间画矩形；输出视图上把带的两条边界通过 H 投过去。 */
  function drawOverlapBand(ctx, model, toPx, isSource) {
    var ov = model.overlap;
    if (!ov || ov.a >= ov.b) return;
    ctx.save();
    ctx.fillStyle = 'rgba(255,138,92,0.16)';
    ctx.strokeStyle = 'rgba(255,138,92,0.8)';
    ctx.lineWidth = 1.5;
    if (isSource) {
      var p1 = toPx({ x: ov.a, y: 0 }), p2 = toPx({ x: ov.b, y: 1 });
      ctx.fillRect(p1.x, p1.y, p2.x - p1.x, p2.y - p1.y);
      ctx.strokeRect(p1.x, p1.y, p2.x - p1.x, p2.y - p1.y);
    } else if (model.H) {
      // 用单应把规范带四角投到输出面
      var c = [
        M.applyH(model.H, ov.a, 0), M.applyH(model.H, ov.b, 0),
        M.applyH(model.H, ov.b, 1), M.applyH(model.H, ov.a, 1)
      ].map(toPx);
      traceQuad(ctx, c);
      ctx.fill();
      traceQuad(ctx, c);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** 融合权重曲线图：两条幕权重 + 权重和，1.0 水平线为校正目标。 */
  function drawBlendCurve(canvas, screens) {
    var W = canvas.width, H = canvas.height;
    var ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    var padL = 44, padR = 12, padT = 14, padB = 26;
    function X(u) { return padL + u * (W - padL - padR); }
    function Y(w) { return H - padB - Math.min(w, 1.25) / 1.25 * (H - padT - padB); }

    // 网格与坐标
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.fillStyle = '#9aa1ab';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'right';
    for (var g = 0; g <= 5; g++) {
      var wv = g / 4;
      ctx.beginPath(); ctx.moveTo(padL, Y(wv)); ctx.lineTo(W - padR, Y(wv)); ctx.stroke();
      ctx.fillText(wv.toFixed(2), padL - 6, Y(wv) + 4);
    }
    // 目标线 w=1
    ctx.strokeStyle = '#7ee787';
    ctx.setLineDash([6, 5]);
    ctx.beginPath(); ctx.moveTo(padL, Y(1)); ctx.lineTo(W - padR, Y(1)); ctx.stroke();
    ctx.setLineDash([]);
    ctx.textAlign = 'left';
    ctx.fillStyle = '#7ee787';
    ctx.fillText('目标权重和 = 1.0', padL + 6, Y(1) - 5);

    var colors = ['#7fd7ff', '#ffb86b'];
    var steps = 160;
    // 单幕权重
    screens.forEach(function (sc, si) {
      if (!sc.enabled) return;
      ctx.strokeStyle = colors[si];
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (var i = 0; i <= steps; i++) {
        var u = i / steps;
        var w = sc.gain * bandWeight(u, sc.overlap, sc.gamma);
        if (i === 0) ctx.moveTo(X(u), Y(w)); else ctx.lineTo(X(u), Y(w));
      }
      ctx.stroke();
    });
    // 权重和
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    for (var j = 0; j <= steps; j++) {
      var u2 = j / steps, sum = 0;
      screens.forEach(function (sc) {
        if (sc.enabled) sum += sc.gain * bandWeight(u2, sc.overlap, sc.gamma);
      });
      if (j === 0) ctx.moveTo(X(u2), Y(sum)); else ctx.lineTo(X(u2), Y(sum));
    }
    ctx.stroke();
    // 横轴标注
    ctx.fillStyle = '#9aa1ab';
    ctx.textAlign = 'center';
    for (var t = 0; t <= 4; t++) {
      ctx.fillText((t / 4).toFixed(2), X(t / 4), H - 8);
    }
  }

  PCAL.render = {
    renderSourceCanvas: renderSourceCanvas,
    renderComposite: renderComposite,
    buildScreenModels: buildScreenModels,
    bandWeight: bandWeight,
    sampleBilinear: sampleBilinear,
    drawHandles: drawHandles,
    drawMarkers: drawMarkers,
    drawOverlapBand: drawOverlapBand,
    drawBlendCurve: drawBlendCurve
  };
})(window);
