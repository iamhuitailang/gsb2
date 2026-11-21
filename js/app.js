/* 投影校正工具 —— 主应用（交互与视图装配） */
(function (global) {
  'use strict';

  var PCAL = global.PCAL;
  var R = PCAL.render;
  var G = PCAL.geometry;
  var M = PCAL.math;
  var S = PCAL.state;

  /* ---------------- 视图画布 ---------------- */
  var views = {
    source: document.getElementById('view-source'),
    warped: document.getElementById('view-warped'),
    output: document.getElementById('view-output')
  };
  var blendCanvas = document.getElementById('blend-curve');
  var offComposite = document.createElement('canvas'); // 变形/输出共用的离屏渲染
  var srcCanvas = document.createElement('canvas');   // 源素材离屏画布
  var customImage = null;
  var probe = null;           // 点击反查探针 {screen, x,y, u,v}
  var invalidReason = null;   // 当前四边形非法原因（画面沿用上一次有效结果）
  var drag = null;            // 拖拽状态
  var state = S.load() || S.defaultState();
  var renderQueued = false;

  // 暴露到全局便于自动化测试与控制台排障（只读使用，修改仍走控件逻辑）
  global.__pcal = { get state() { return state; }, get probe() { return probe; } };

  var statusEl = document.getElementById('status-message');
  var infoEl = document.getElementById('marker-info');

  /* ---------------- 初始化 ---------------- */
  function init() {
    bindStaticControls();
    bindPointer(views.output);
    bindKeyboard();
    syncControlsFromState();
    R.renderSourceCanvas(srcCanvas, state.patternType, customImage);
    resizeCanvases();
    // 窗口尺寸变化后画布被重置，必须重绘（renderAll 内部会重建离屏画面）
    var resizeTimer = null;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () { resizeCanvases(); scheduleRender(); }, 120);
    });
    scheduleRender();
  }

  /** 各视图内部像素尺寸跟随布局宽度，预览保持 16:9 画布；源素材是正方形规范面。 */
  function resizeCanvases() {
    Object.keys(views).forEach(function (key) {
      var c = views[key];
      var rect = c.getBoundingClientRect();
      var cssW = Math.max(240, Math.round(rect.width));
      var cssH = key === 'source' ? cssW : Math.round(cssW * 9 / 16);
      var dpr = Math.min(2, window.devicePixelRatio || 1);
      c.width = Math.round(cssW * dpr);
      c.height = Math.round(cssH * dpr);
      c.style.height = cssH + 'px';
      c._dpr = dpr;
    });
  }

  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(function () {
      renderQueued = false;
      renderAll();
    });
  }

  /* ---------------- 渲染流水线 ---------------- */
  function renderAll() {
    var dims = S.outputDimensions(state);
    // 预览按输出宽高比缩放，最大边约 900px，保证拖动流畅；导出时再按真实尺寸渲染
    var maxEdge = 900;
    var scale = Math.min(1, maxEdge / Math.max(dims.w, dims.h));
    var pw = Math.max(2, Math.round(dims.w * scale));
    var ph = Math.max(2, Math.round(dims.h * scale));

    var models = R.buildScreenModels(state.screens, pw, ph);
    invalidReason = null;
    models.forEach(function (m) {
      if (!m.valid && state.screens[m.index].enabled) invalidReason = m.reason;
    });
    renderStatus(models);

    R.renderComposite(offComposite, srcCanvas, models, pw, ph, {
      showOverflow: state.showOverflow
    }).then(function () {
      drawSourceView(models);
      drawWarpedView(models);
      drawOutputView(models);
      R.drawBlendCurve(blendCanvas, state.screens);
      renderMarkerInfo(models);
    });
  }

  function clearView(ctx, c) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#111418';
    ctx.fillRect(0, 0, c.width, c.height);
  }

  /** 视图一：平面原图（规范正方形源面 + 标记 + 重叠带）。 */
  function drawSourceView(models) {
    var c = views.source, ctx = c.getContext('2d');
    clearView(ctx, c);
    var dpr = c._dpr;
    var size = Math.min(c.width, c.height) * 0.94;
    var ox = (c.width - size) / 2, oy = (c.height - size) / 2;
    ctx.drawImage(srcCanvas, ox, oy, size, size);

    function toPx(p) { return { x: ox + p.x * size, y: oy + p.y * size }; }

    // 重叠带（两块幕各画一次）
    if (state.showOverlapBand) {
      models.forEach(function (m) {
        if (m.enabled) R.drawOverlapBand(ctx, m, toPx, true);
      });
    }
    // 固定标记
    R.drawMarkers(ctx, state.markers.map(function (mk) {
      return { label: mk.label, x: mk.u, y: mk.v };
    }), toPx, '#7ee787');
    // 探针落点（回到源素材的位置）
    if (probe) {
      R.drawMarkers(ctx, [{ label: '探针', x: probe.u, y: probe.v }], toPx, '#ff5c7a');
    }
    drawViewLabel(ctx, c, '① 平面原图（规范源面 0..1）');
  }

  /** 视图二：变形后的幕面，只放像素内容与标记，不给可拖手柄。 */
  function drawWarpedView(models) {
    var c = views.warped, ctx = c.getContext('2d');
    clearView(ctx, c);
    drawContain(ctx, offComposite, c);
    function toPxNorm(p) { // 规范输出坐标→画布像素
      return containMap(p, c, offComposite.width, offComposite.height);
    }
    if (state.showOverlapBand) {
      models.forEach(function (m) {
        if (m.enabled && m.valid) R.drawOverlapBand(ctx, m, toPxNorm, false);
      });
    }
    // 固定标记经单应投到幕面
    var warpedMarkers = [];
    state.markers.forEach(function (mk) {
      models.forEach(function (m) {
        if (!m.enabled || !m.valid) return;
        var p = M.applyH(m.H, mk.u, mk.v);
        warpedMarkers.push({ label: mk.label + '·幕' + (m.index + 1), x: p.x / offComposite.width, y: p.y / offComposite.height });
      });
    });
    R.drawMarkers(ctx, warpedMarkers, toPxNorm, '#7ee787');
    if (probe) {
      R.drawMarkers(ctx, [{
        label: '探针·幕' + (probe.screen + 1),
        x: probe.x / offComposite.width,
        y: probe.y / offComposite.height
      }], toPxNorm, '#ff5c7a');
    }
    drawViewLabel(ctx, c, '② 变形后的幕面（逐像素逆透视，网格自动满足透视关系）');
  }

  /** 视图三：最终输出范围，含可拖四角、遮罩轮廓与全部标记。 */
  function drawOutputView(models) {
    var c = views.output, ctx = c.getContext('2d');
    clearView(ctx, c);
    drawContain(ctx, offComposite, c);
    function toPxNorm(p) {
      return containMap(p, c, offComposite.width, offComposite.height);
    }
    // 输出范围边框
    var box = toPxNorm({ x: 0, y: 0 });
    var box2 = toPxNorm({ x: 1, y: 1 });
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1.5;
    ctx.strokeRect(box.x, box.y, box2.x - box.x, box2.y - box.y);
    ctx.restore();

    if (state.showOverlapBand) {
      models.forEach(function (m) {
        if (m.enabled && m.valid) R.drawOverlapBand(ctx, m, toPxNorm, false);
      });
    }
    R.drawHandles(ctx, models, toPxNorm, state.activeScreen);

    var outMarkers = [];
    state.markers.forEach(function (mk) {
      models.forEach(function (m) {
        if (!m.enabled || !m.valid) return;
        var p = M.applyH(m.H, mk.u, mk.v);
        outMarkers.push({ label: mk.label, x: p.x / offComposite.width, y: p.y / offComposite.height });
      });
    });
    R.drawMarkers(ctx, outMarkers, toPxNorm, '#7ee787');
    if (probe) {
      R.drawMarkers(ctx, [{
        label: '探针',
        x: probe.x / offComposite.width,
        y: probe.y / offComposite.height
      }], toPxNorm, '#ff5c7a');
    }
    drawViewLabel(ctx, c, '③ 最终输出范围（拖动编号角点调整；点击幕面可回溯源素材位置）');
  }

  /** contain 适配：把离屏画面完整放进画布，返回映射信息。 */
  function containMetrics(c, imgW, imgH) {
    var pad = 10 * c._dpr;
    var scale = Math.min((c.width - pad * 2) / imgW, (c.height - pad * 2) / imgH);
    var w = imgW * scale, h = imgH * scale;
    return { scale: scale, ox: (c.width - w) / 2, oy: (c.height - h) / 2, w: w, h: h };
  }
  function drawContain(ctx, img, c) {
    var m = containMetrics(c, img.width, img.height);
    ctx.drawImage(img, m.ox, m.oy, m.w, m.h);
  }
  function containMap(normP, c, imgW, imgH) {
    var m = containMetrics(c, imgW, imgH);
    return { x: m.ox + normP.x * m.w, y: m.oy + normP.y * m.h };
  }
  function containInverse(px, py, c, imgW, imgH) {
    var m = containMetrics(c, imgW, imgH);
    return { x: (px - m.ox) / m.w * imgW, y: (py - m.oy) / m.h * imgH };
  }

  function drawViewLabel(ctx, c, text) {
    ctx.save();
    ctx.font = '600 ' + (13 * c._dpr) + 'px "PingFang SC",sans-serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    var w = ctx.measureText(text).width + 16 * c._dpr;
    ctx.fillRect(8 * c._dpr, 8 * c._dpr, w, 24 * c._dpr);
    ctx.fillStyle = '#d7dce3';
    ctx.fillText(text, 16 * c._dpr, 25 * c._dpr);
    ctx.restore();
  }

  /* ---------------- 状态条与一致性检查 ---------------- */
  function renderStatus(models) {
    var dims = S.outputDimensions(state);
    if (invalidReason) {
      statusEl.className = 'status-banner error show';
      statusEl.textContent = '⚠ 四边形无效：' + invalidReason + ' —— 已保留上一次有效画面，未更新变换';
    } else {
      var anyOver = models.some(function (m) {
        if (!m.enabled) return false;
        var ov = m.overlap;
        if (!ov || ov.a >= ov.b) return false;
        // 带内任一点权重和是否超过目标
        for (var i = 0; i <= 20; i++) {
          var u = ov.a + (ov.b - ov.a) * i / 20, sum = 0;
          state.screens.forEach(function (sc) {
            if (sc.enabled) sum += sc.gain * R.bandWeight(u, sc.overlap, sc.gamma);
          });
          if (sum > 1.02) return true;
        }
        return false;
      });
      statusEl.className = 'status-banner ' + (anyOver ? 'warn show' : 'ok show');
      statusEl.textContent = anyOver
        ? '重叠带权重和超过 1.0（偏亮）：红色区域即过曝位置，请调高 gamma 或降低单幕增益，使白线贴近绿色目标线'
        : ('状态正常 · 输出 ' + dims.w + '×' + dims.h + ' · ' + state.screenCount + ' 块幕 · 角点按规范坐标随尺寸换算');
    }
  }

  /** 两个固定标记：源→幕→源 的来回误差（像素，按当前预览尺寸衡量）。 */
  function renderMarkerInfo(models) {
    var rows = [];
    state.markers.forEach(function (mk) {
      models.forEach(function (m) {
        if (!m.enabled || !m.valid) return;
        var fwd = M.applyH(m.H, mk.u, mk.v);
        var back = M.applyH(m.invH, fwd.x, fwd.y);
        var errU = (back.x - mk.u) * offComposite.width;
        var errV = (back.y - mk.v) * offComposite.height;
        var errPx = Math.sqrt(errU * errU + errV * errV);
        rows.push({
          label: mk.label, screen: m.index + 1,
          fwd: fwd, back: back, err: errPx,
          normErr: Math.sqrt(Math.pow(back.x - mk.u, 2) + Math.pow(back.y - mk.v, 2))
        });
      });
    });
    if (!rows.length) {
      infoEl.innerHTML = '<span class="muted">当前没有启用的有效幕面</span>';
      return;
    }
    infoEl.innerHTML = rows.map(function (r) {
      var cls = r.normErr < 1e-4 ? 'good' : 'bad';
      return '<div class="marker-row">' +
        '<b>' + r.label + ' · 幕' + r.screen + '</b>' +
        ' 源(' + r.back.x.toFixed(4) + ',' + r.back.y.toFixed(4) + ')' +
        ' → 输出(' + r.fwd.x.toFixed(1) + ',' + r.fwd.y.toFixed(1) + 'px)' +
        ' → 回程 <span class="' + cls + '">' + r.err.toFixed(3) + ' px</span>' +
        (r.normErr < 1e-4 ? ' ✓ 来回一致' : ' ✗ 超差') +
        '</div>';
    }).join('');
  }

  /* ---------------- 角点拖拽与点击反查 ---------------- */
  function eventToCanvas(e, c) {
    var rect = c.getBoundingClientRect();
    return { x: (e.clientX - rect.left) * c._dpr, y: (e.clientY - rect.top) * c._dpr };
  }

  function hitHandle(pt, models) {
    var c = views.output;
    var hit = null, best = 14 * c._dpr;
    models.forEach(function (m) {
      if (!m.enabled) return;
      m.quadNorm.forEach(function (p, i) {
        var px = containMap(p, c, offComposite.width, offComposite.height);
        var d = M.dist(pt.x, pt.y, px.x, px.y);
        if (d < best) { best = d; hit = { screen: m.index, corner: i }; }
      });
    });
    return hit;
  }

  function bindPointer(c) {
    c.addEventListener('pointerdown', function (e) {
      var pt = eventToCanvas(e, c);
      var models = R.buildScreenModels(state.screens, offComposite.width, offComposite.height);
      var hit = hitHandle(pt, models);
      if (hit) {
        drag = hit;
        drag.moved = false;
        drag.startX = e.clientX;
        drag.startY = e.clientY;
        state.activeScreen = hit.screen;
        syncScreenControls();
        c.setPointerCapture(e.pointerId);
        e.preventDefault();
      }
    });

    c.addEventListener('pointermove', function (e) {
      var pt = eventToCanvas(e, c);
      if (drag) {
        if (Math.abs(e.clientX - drag.startX) + Math.abs(e.clientY - drag.startY) > 3) drag.moved = true;
        var imgPt = containInverse(pt.x, pt.y, c, offComposite.width, offComposite.height);
        var nx = M.clamp(imgPt.x / offComposite.width, -0.25, 1.25);
        var ny = M.clamp(imgPt.y / offComposite.height, -0.25, 1.25);
        updateCorner(drag.screen, drag.corner, { x: nx, y: ny });
      } else {
        var models = R.buildScreenModels(state.screens, offComposite.width, offComposite.height);
        c.style.cursor = hitHandle(pt, models) ? 'grab' : 'crosshair';
      }
    });

    c.addEventListener('pointerup', function (e) {
      if (drag && !drag.moved) {
        placeProbe(eventToCanvas(e, c));
      }
      drag = null;
    });

    c.addEventListener('pointercancel', function () { drag = null; });
  }

  /** 拖动角点：先校验，非法则回滚并提示，画面保留上一次有效结果。 */
  function updateCorner(screenIdx, corner, pt) {
    var sc = state.screens[screenIdx];
    var previous = S.clone(sc.quad);
    sc.quad[corner] = { x: pt.x, y: pt.y };
    var check = G.validateQuad(sc.quad);
    if (!check.valid) {
      sc.quad = previous; // 回滚：渲染沿用上一次有效四边形
      invalidReason = check.reason;
      renderStatus(R.buildScreenModels(state.screens, offComposite.width, offComposite.height));
      return;
    }
    invalidReason = null;
    scheduleRender();
    persistSoon();
    syncCornerReadouts();
  }

  /** 点击幕面：输出坐标 → 逆单应 → 源素材规范坐标（探针）。 */
  function placeProbe(pt) {
    var c = views.output;
    var imgPt = containInverse(pt.x, pt.y, c, offComposite.width, offComposite.height);
    var models = R.buildScreenModels(state.screens, offComposite.width, offComposite.height);
    // 优先取当前激活幕，其次取包含该点的启用幕
    var candidates = models.filter(function (m) { return m.enabled && m.valid; });
    var target = candidates.filter(function (m) { return m.index === state.activeScreen; })[0];
    if (!target || !G.pointInPolygon(imgPt.x, imgPt.y, target.quadPx)) {
      target = candidates.filter(function (m) {
        return G.pointInPolygon(imgPt.x, imgPt.y, m.quadPx);
      })[0] || null;
    }
    if (!target) return;
    var src = M.applyH(target.invH, imgPt.x, imgPt.y);
    if (src.x < -0.05 || src.x > 1.05 || src.y < -0.05 || src.y > 1.05) return;
    probe = { screen: target.index, x: imgPt.x, y: imgPt.y, u: src.x, v: src.y };
    scheduleRender();
    flashProbeInfo(target, imgPt, src);
  }

  function flashProbeInfo(m, imgPt, src) {
    var dims = S.outputDimensions(state);
    var k = dims.w / offComposite.width;
    infoEl.insertAdjacentHTML('afterbegin',
      '<div class="marker-row probe-row"><b>探针 · 幕' + (m.index + 1) + '</b> ' +
      '输出(' + (imgPt.x * k).toFixed(1) + ',' + (imgPt.y * k).toFixed(1) + 'px) → ' +
      '源素材(' + src.x.toFixed(4) + ',' + src.y.toFixed(4) + ')</div>');
  }

  function bindKeyboard() {
    document.addEventListener('keydown', function (e) {
      if (!drag) return;
      var step = e.shiftKey ? 0.01 : 0.002;
      var delta = {
        ArrowLeft: [-step, 0], ArrowRight: [step, 0],
        ArrowUp: [0, -step], ArrowDown: [0, step]
      }[e.key];
      if (!delta) return;
      e.preventDefault();
      var sc = state.screens[drag.screen];
      var p = sc.quad[drag.corner];
      updateCorner(drag.screen, drag.corner, { x: p.x + delta[0], y: p.y + delta[1] });
    });
  }

  /* ---------------- 控件绑定 ---------------- */
  function $ (id) { return document.getElementById(id); }

  function bindStaticControls() {
    // 测试图
    document.querySelectorAll('input[name="pattern"]').forEach(function (radio) {
      radio.addEventListener('change', function () {
        state.patternType = radio.value;
        R.renderSourceCanvas(srcCanvas, state.patternType, customImage);
        scheduleRender();
        persistSoon();
      });
    });
    $('file-custom').addEventListener('change', function (e) {
      var file = e.target.files && e.target.files[0];
      if (!file) return;
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        customImage = img;
        URL.revokeObjectURL(url);
        state.patternType = 'custom';
        document.querySelector('input[name="pattern"][value="custom"]').checked = true;
        R.renderSourceCanvas(srcCanvas, 'custom', customImage);
        scheduleRender();
      };
      img.src = url;
    });

    // 输出尺寸
    $('output-preset').addEventListener('change', function () {
      state.output.presetId = this.value;
      $('custom-size-row').style.display = this.value === 'custom' ? 'flex' : 'none';
      scheduleRender();
      persistSoon();
    });
    $('custom-w').addEventListener('change', function () {
      state.output.customW = parseInt(this.value, 10) || 1600; scheduleRender(); persistSoon();
    });
    $('custom-h').addEventListener('change', function () {
      state.output.customH = parseInt(this.value, 10) || 900; scheduleRender(); persistSoon();
    });

    // 幕数
    document.querySelectorAll('input[name="screencount"]').forEach(function (radio) {
      radio.addEventListener('change', function () {
        state.screenCount = parseInt(radio.value, 10);
        state.screens.forEach(function (sc, i) { sc.enabled = i < state.screenCount; });
        if (state.activeScreen >= state.screenCount) state.activeScreen = 0;
        syncScreenControls();
        scheduleRender();
        persistSoon();
      });
    });

    // 当前幕选择 / 开关
    $('active-screen').addEventListener('change', function () {
      state.activeScreen = parseInt(this.value, 10);
      syncScreenControls();
      scheduleRender();
    });
    $('screen-enabled').addEventListener('change', function () {
      state.screens[state.activeScreen].enabled = this.checked;
      scheduleRender();
      persistSoon();
    });

    // 重叠带与融合
    $('ov-a').addEventListener('input', function () { setOverlap('a', parseFloat(this.value)); });
    $('ov-b').addEventListener('input', function () { setOverlap('b', parseFloat(this.value)); });
    $('ov-side').addEventListener('change', function () {
      state.screens[state.activeScreen].overlap.side = this.value;
      scheduleRender(); persistSoon();
    });
    $('blend-gamma').addEventListener('input', function () {
      state.screens[state.activeScreen].gamma = parseFloat(this.value);
      $('blend-gamma-val').textContent = parseFloat(this.value).toFixed(2);
      scheduleRender(); persistSoon();
    });
    $('screen-gain').addEventListener('input', function () {
      state.screens[state.activeScreen].gain = parseFloat(this.value);
      $('screen-gain-val').textContent = parseFloat(this.value).toFixed(2);
      scheduleRender(); persistSoon();
    });

    // 显示开关
    $('toggle-overflow').addEventListener('change', function () {
      state.showOverflow = this.checked; scheduleRender(); persistSoon();
    });
    $('toggle-band').addEventListener('change', function () {
      state.showOverlapBand = this.checked; scheduleRender(); persistSoon();
    });

    // 标记坐标
    [0, 1].forEach(function (i) {
      $('mk' + i + '-u').addEventListener('change', function () {
        state.markers[i].u = M.clamp(parseFloat(this.value) || 0, 0, 1); scheduleRender(); persistSoon();
      });
      $('mk' + i + '-v').addEventListener('change', function () {
        state.markers[i].v = M.clamp(parseFloat(this.value) || 0, 0, 1); scheduleRender(); persistSoon();
      });
    });

    // 示例 / 存储 / 截图
    $('preset-front').addEventListener('click', function () {
      S.applyPreset(state, 'front');
      syncControlsFromState(); scheduleRender(); persistSoon();
    });
    $('preset-tilted').addEventListener('click', function () {
      S.applyPreset(state, 'tilted-dual');
      syncControlsFromState(); scheduleRender(); persistSoon();
    });
    $('btn-save').addEventListener('click', function () {
      flashAction(S.save(state) ? '配置已保存到浏览器本地（localStorage）' : '保存失败，请检查浏览器存储权限');
    });
    $('btn-export').addEventListener('click', exportConfig);
    $('btn-import').addEventListener('click', function () { $('file-config').click(); });
    $('file-config').addEventListener('change', importConfig);
    $('btn-reset').addEventListener('click', function () {
      if (!confirm('恢复默认正投示例并清除本地保存的配置？')) return;
      S.clearSaved();
      state = S.defaultState();
      customImage = null;
      syncControlsFromState();
      R.renderSourceCanvas(srcCanvas, state.patternType, null);
      scheduleRender();
    });
    $('btn-shot-output').addEventListener('click', function () { shotComposite(false); });
    $('btn-shot-all').addEventListener('click', function () { shotComposite(true); });
  }

  function setOverlap(key, val) {
    var sc = state.screens[state.activeScreen];
    sc.overlap[key] = M.clamp(val, 0, 1);
    // 保证 a < b，否则权重函数按无重叠处理
    if (sc.overlap.a >= sc.overlap.b) {
      if (key === 'a') sc.overlap.a = sc.overlap.b - 0.01;
      else sc.overlap.b = sc.overlap.a + 0.01;
    }
    syncOverlapControls();
    scheduleRender();
    persistSoon();
  }

  /* ---------------- 控件状态同步 ---------------- */
  function syncControlsFromState() {
    var presetSel = $('output-preset');
    if (!presetSel.options.length) {
      presetSel.innerHTML = S.OUTPUT_PRESETS.map(function (p) {
        return '<option value="' + p.id + '">' + p.label + '</option>';
      }).join('');
    }
    document.querySelector('input[name="pattern"][value="' + state.patternType + '"]').checked = true;
    presetSel.value = state.output.presetId;
    $('custom-size-row').style.display = state.output.presetId === 'custom' ? 'flex' : 'none';
    $('custom-w').value = state.output.customW;
    $('custom-h').value = state.output.customH;
    var cnt = state.screenCount === 2 ? '2' : '1';
    document.querySelector('input[name="screencount"][value="' + cnt + '"]').checked = true;
    $('toggle-overflow').checked = state.showOverflow;
    $('toggle-band').checked = state.showOverlapBand;
    state.markers.forEach(function (mk, i) {
      $('mk' + i + '-u').value = mk.u.toFixed(3);
      $('mk' + i + '-v').value = mk.v.toFixed(3);
    });
    syncScreenControls();
  }

  function syncScreenControls() {
    var sel = $('active-screen');
    sel.innerHTML = state.screens.map(function (sc, i) {
      return '<option value="' + i + '">幕面 ' + (i + 1) + (sc.enabled ? '' : '（已关闭）') + '</option>';
    }).join('');
    sel.value = String(Math.min(state.activeScreen, state.screens.length - 1));
    var sc = state.screens[state.activeScreen];
    $('screen-enabled').checked = sc.enabled;
    syncOverlapControls();
    $('blend-gamma').value = sc.gamma;
    $('blend-gamma-val').textContent = sc.gamma.toFixed(2);
    $('screen-gain').value = sc.gain;
    $('screen-gain-val').textContent = sc.gain.toFixed(2);
    syncCornerReadouts();
  }

  function syncOverlapControls() {
    var sc = state.screens[state.activeScreen];
    var panel = $('ov-a').closest('.panel');
    // 单幕模式或该幕没有重叠带数据时，融合控件整体禁用
    var disabled = state.screenCount === 1 || !sc.overlap;
    if (panel) panel.classList.toggle('panel-disabled', disabled);
    if (!sc.overlap) {
      ['ov-a', 'ov-b', 'ov-side'].forEach(function (id) { $(id).disabled = true; });
      return;
    }
    ['ov-a', 'ov-b', 'ov-side'].forEach(function (id) { $(id).disabled = disabled; });
    $('ov-a').value = sc.overlap.a;
    $('ov-b').value = sc.overlap.b;
    $('ov-side').value = sc.overlap.side;
  }

  function syncCornerReadouts() {
    var sc = state.screens[state.activeScreen];
    var box = $('corner-readout');
    box.innerHTML = sc.quad.map(function (p, i) {
      return '<span class="chip">' + PCAL.pattern.CORNER_NAMES[i] +
        ' (' + p.x.toFixed(3) + ', ' + p.y.toFixed(3) + ')</span>';
    }).join('');
  }

  /* ---------------- 配置导入导出 / 截图 ---------------- */
  function exportConfig() {
    var blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    downloadBlob(blob, 'pcal-config-' + stamp() + '.json');
    flashAction('配置 JSON 已导出');
  }

  function importConfig(e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var incoming = S.migrate(JSON.parse(reader.result));
        state = incoming;
        syncControlsFromState();
        R.renderSourceCanvas(srcCanvas, state.patternType, customImage);
        scheduleRender();
        persistSoon();
        flashAction('配置已导入并应用');
      } catch (err) {
        alert('配置文件解析失败：' + err.message);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  /** 按真实输出尺寸离屏渲染再下载；withViews=true 时拼成三视图对照图。 */
  function shotComposite(withViews) {
    var dims = S.outputDimensions(state);
    var btn = withViews ? $('btn-shot-all') : $('btn-shot-output');
    btn.disabled = true;
    var oldText = btn.textContent;
    btn.textContent = '渲染中…';
    var full = document.createElement('canvas');
    var models = R.buildScreenModels(state.screens, dims.w, dims.h);
    R.renderComposite(full, srcCanvas, models, dims.w, dims.h, {
      showOverflow: state.showOverflow,
      onProgress: function (t) { btn.textContent = '渲染中 ' + Math.round(t * 100) + '%'; }
    }).then(function () {
      var out = full;
      if (withViews) {
        out = composeThreeView(full, models);
      }
      out.toBlob(function (blob) {
        downloadBlob(blob, (withViews ? 'pcal-three-view-' : 'pcal-output-') + dims.w + 'x' + dims.h + '-' + stamp() + '.png');
        btn.disabled = false;
        btn.textContent = oldText;
        flashAction('预览截图已保存（' + (withViews ? '三视图对照' : '最终输出') + '，' + dims.w + '×' + dims.h + '）');
      }, 'image/png');
    });
  }

  /** 三视图对照：左源面、中变形幕面、右带遮罩框的输出。 */
  function composeThreeView(full, models) {
    var pad = 24, labelH = 34;
    var tileH = 540;
    var outW = Math.round(tileH * full.width / full.height);
    var srcW = tileH;
    var W = pad + srcW + pad + outW + pad + outW + pad;
    var H = pad + labelH + tileH + pad;
    var c = document.createElement('canvas');
    c.width = W; c.height = H;
    var ctx = c.getContext('2d');
    ctx.fillStyle = '#111418';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#d7dce3';
    ctx.font = '600 20px "PingFang SC",sans-serif';
    var x0 = pad;
    ctx.fillText('① 平面原图', x0, pad + 22);
    ctx.drawImage(srcCanvas, x0, pad + labelH, srcW, tileH);

    var x1 = x0 + srcW + pad;
    ctx.fillText('② 变形后的幕面', x1, pad + 22);
    ctx.drawImage(full, x1, pad + labelH, outW, tileH);

    var x2 = x1 + outW + pad;
    ctx.fillText('③ 最终输出范围', x2, pad + 22);
    ctx.drawImage(full, x2, pad + labelH, outW, tileH);
    // 输出遮罩框与角点
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.setLineDash([6, 6]);
    ctx.strokeRect(x2, pad + labelH, outW, tileH);
    ctx.setLineDash([]);
    models.forEach(function (m) {
      if (!m.enabled) return;
      ctx.strokeStyle = m.index === state.activeScreen ? '#ffd54a' : '#7fd7ff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      m.quadNorm.forEach(function (p, i) {
        var px = x2 + p.x * outW, py = pad + labelH + p.y * tileH;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      });
      ctx.closePath();
      ctx.stroke();
      m.quadNorm.forEach(function (p, i) {
        var px = x2 + p.x * outW, py = pad + labelH + p.y * tileH;
        ctx.beginPath();
        ctx.arc(px, py, 7, 0, Math.PI * 2);
        ctx.fillStyle = m.index === state.activeScreen ? '#ffd54a' : '#7fd7ff';
        ctx.fill();
      });
    });
    return c;
  }

  function downloadBlob(blob, name) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function stamp() {
    var d = new Date();
    function p(n) { return String(n).padStart(2, '0'); }
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  var saveTimer = null;
  function persistSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { S.save(state); }, 400);
  }

  var flashTimer = null;
  function flashAction(text) {
    var el = $('action-flash');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(function () { el.classList.remove('show'); }, 2600);
  }

  init();
})(window);
