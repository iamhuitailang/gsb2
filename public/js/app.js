/*
 * app.js — 精灵图集工具主逻辑（纯浏览器、零依赖、完全离线）
 * 依赖（均为本地脚本）：SpriteUtil / SpritePacker / SpriteSamples
 */
(function () {
  'use strict';

  var U = window.SpriteUtil;
  var Packer = window.SpritePacker;

  // ---------------- 全局状态 ----------------

  var state = {
    sprites: [], // {id,name,uniqueName,sourcePath,dataUrl,img,srcWidth,srcHeight,
    //  trim:{x,y,w,h}|null, empty, allowRotate, fingerprint, renamed, cellW, cellH}
    settings: {
      trim: true,
      padding: 2,
      extrude: 1,
      mode: 'limit', // limit = 限制最大宽高；fixed = 固定宽高
      width: 1024,
      height: 1024,
      powerOfTwo: false, // 仅 limit 模式生效
      allowRotate: true,
      alphaThreshold: 1,
    },
    selectedId: null,
    result: null,
    prevLayout: new Map(), // 本轮排版前的布局，用于绘制删除幽灵框
    lastLayout: new Map(), // 最近一次排版结果，用于稳定重排/工程保存
    previewMode: 'atlas', // atlas = 实际图集占用；original = 原尺寸对照
    showRegions: true,
    showChanges: true,
    zoom: 'fit',
    atlasCanvas: null,
  };

  var DEFAULTS = JSON.parse(JSON.stringify(state.settings));
  var relayoutTimer = null;

  // ---------------- 初始化 ----------------

  document.addEventListener('DOMContentLoaded', function () {
    bindEvents();
    syncSettingInputs();
    relayout();
  });

  function $(id) {
    return document.getElementById(id);
  }

  function bindEvents() {
    $('fileInput').addEventListener('change', function (e) {
      addFiles(e.target.files);
      e.target.value = '';
    });
    $('projectInput').addEventListener('change', function (e) {
      if (e.target.files[0]) importProject(e.target.files[0]);
      e.target.value = '';
    });
    $('btnSamples').addEventListener('click', loadBuiltInSamples);
    $('btnClear').addEventListener('click', function () {
      if (!state.sprites.length || confirm('确定清空全部精灵吗？')) {
        state.sprites = [];
        state.selectedId = null;
        state.lastLayout = new Map();
        relayout();
      }
    });

    // 拖拽导入
    var dragMask = $('dragMask');
    window.addEventListener('dragenter', function (e) {
      e.preventDefault();
      dragMask.classList.add('show');
    });
    dragMask.addEventListener('dragleave', function (e) {
      if (e.relatedTarget === null) dragMask.classList.remove('show');
    });
    window.addEventListener('dragover', function (e) {
      e.preventDefault();
    });
    window.addEventListener('drop', function (e) {
      e.preventDefault();
      dragMask.classList.remove('show');
      if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
    });

    // 参数区
    [
      'trim',
      'padding',
      'extrude',
      'mode',
      'width',
      'height',
      'powerOfTwo',
      'allowRotate',
      'alphaThreshold',
    ].forEach(function (key) {
      var el = $(key === 'trim' ? 'setTrim' : 'set' + cap(key));
      if (!el) return;
      var evt = el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input';
      el.addEventListener(evt, function () {
        applySettingFromInput(key, el);
      });
    });

    $('btnResetSettings').addEventListener('click', function () {
      state.settings = JSON.parse(JSON.stringify(DEFAULTS));
      syncSettingInputs();
      relayout();
    });

    // 预览切换
    $('viewAtlas').addEventListener('click', function () {
      state.previewMode = 'atlas';
      updateViewButtons();
      drawPreview();
    });
    $('viewOriginal').addEventListener('click', function () {
      state.previewMode = 'original';
      updateViewButtons();
      drawPreview();
    });
    $('toggleRegions').addEventListener('change', function (e) {
      state.showRegions = e.target.checked;
      drawPreview();
    });
    $('toggleChanges').addEventListener('change', function (e) {
      state.showChanges = e.target.checked;
      drawPreview();
    });
    $('zoomFit').addEventListener('click', function () {
      state.zoom = 'fit';
      drawPreview();
    });
    $('zoomOut').addEventListener('click', function () {
      state.zoom = Math.max(0.1, zoomNumber() - 0.1);
      drawPreview();
    });
    $('zoomIn').addEventListener('click', function () {
      state.zoom = Math.min(8, zoomNumber() + 0.1);
      drawPreview();
    });

    // 导出
    $('btnExportPng').addEventListener('click', exportPng);
    $('btnExportManifest').addEventListener('click', exportManifest);
    $('btnExportProject').addEventListener('click', exportProject);
    $('btnExportSprites').addEventListener('click', exportIndividualPngs);

    // 列表事件委托
    $('spriteList').addEventListener('click', onSpriteListClick);
    $('rejectedList').addEventListener('click', function (e) {
      var btn = e.target.closest('.jump-btn');
      if (btn) {
        state.selectedId = btn.dataset.id;
        renderSpriteList();
        drawPreview();
      }
    });
  }

  function cap(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function zoomNumber() {
    if (state.zoom !== 'fit') return state.zoom;
    var wrap = $('previewWrap');
    if (!state.result) return 1;
    var sx = wrap.clientWidth / Math.max(1, state.result.width);
    var sy = wrap.clientHeight / Math.max(1, state.result.height);
    return U.clamp(Math.min(sx, sy) * 0.95, 0.05, 8);
  }

  // ---------------- 设置同步 ----------------

  function syncSettingInputs() {
    var s = state.settings;
    $('setTrim').checked = s.trim;
    $('setPadding').value = s.padding;
    $('setExtrude').value = s.extrude;
    $('setMode').value = s.mode;
    $('setWidth').value = s.width;
    $('setHeight').value = s.height;
    $('setPowerOfTwo').checked = s.powerOfTwo;
    $('setAllowRotate').checked = s.allowRotate;
    $('setAlphaThreshold').value = s.alphaThreshold;
    $('alphaVal').textContent = s.alphaThreshold;
    $('setPowerOfTwo').disabled = s.mode === 'fixed';
    $('modeHint').textContent =
      s.mode === 'fixed'
        ? '固定模式：画布恒为指定宽高，放不下即拒绝；2 的幂选项不可用。'
        : '限制模式：画布不超过指定宽高，按内容收缩，可选 2 的幂。';
  }

  function applySettingFromInput(key, el) {
    var s = state.settings;
    if (el.type === 'checkbox') {
      s[key] = el.checked;
    } else if (el.tagName === 'SELECT') {
      s[key] = el.value;
    } else {
      var v = parseInt(el.value, 10);
      if (isNaN(v) || v < 0) return;
      s[key] = v;
    }
    if (key === 'mode') {
      $('setPowerOfTwo').disabled = s.mode === 'fixed';
      $('modeHint').textContent =
        s.mode === 'fixed'
          ? '固定模式：画布恒为指定宽高，放不下即拒绝；2 的幂选项不可用。'
          : '限制模式：画布不超过指定宽高，按内容收缩，可选 2 的幂。';
    }
    if (key === 'alphaThreshold') {
      $('alphaVal').textContent = s.alphaThreshold;
    }
    scheduleRelayout(key === 'alphaThreshold');
  }

  function scheduleRelayout(recomputeTrims) {
    clearTimeout(relayoutTimer);
    relayoutTimer = setTimeout(function () {
      relayout(recomputeTrims);
    }, 120);
  }

  // ---------------- 导入 ----------------

  function addFiles(fileList) {
    var files = Array.prototype.filter.call(fileList, function (f) {
      return /\.png$/i.test(f.name) || f.type === 'image/png';
    });
    if (!files.length) {
      toast('仅支持 PNG 文件', 'warn');
      return;
    }
    Promise.all(
      files.map(function (f) {
        return U.readFileAsDataURL(f).then(function (dataUrl) {
          return U.loadImage(dataUrl).then(function (img) {
            return { file: f, dataUrl: dataUrl, img: img };
          });
        });
      })
    )
      .then(function (loaded) {
        var existingNames = state.sprites.map(function (s) {
          return s.uniqueName;
        });
        var incomingNames = loaded.map(function (x) {
          return U.baseName(x.file.name);
        });
        var allUnique = U.uniqueNames(existingNames.concat(incomingNames));
        var newUnique = allUnique.slice(existingNames.length);
        loaded.forEach(function (x, i) {
          state.sprites.push(
            makeSprite({
              name: U.baseName(x.file.name),
              uniqueName: newUnique[i],
              sourcePath: x.file.webkitRelativePath || x.file.name,
              dataUrl: x.dataUrl,
              img: x.img,
              srcWidth: x.img.naturalWidth,
              srcHeight: x.img.naturalHeight,
            })
          );
        });
        relayout();
        toast('已导入 ' + loaded.length + ' 张图片');
      })
      .catch(function (err) {
        toast(err.message || '导入失败', 'error');
      });
  }

  function makeSprite(cfg) {
    var sp = {
      id: cfg.id || U.uid('sp'),
      name: cfg.name,
      uniqueName: cfg.uniqueName || cfg.name,
      sourcePath: cfg.sourcePath || cfg.name + '.png',
      dataUrl: cfg.dataUrl,
      img: cfg.img,
      srcWidth: cfg.srcWidth,
      srcHeight: cfg.srcHeight,
      allowRotate:
        cfg.allowRotate === undefined ? true : !!cfg.allowRotate,
      trim: null,
      empty: false,
      renamed: cfg.uniqueName ? cfg.uniqueName !== cfg.name : false,
      cellW: 0,
      cellH: 0,
    };
    computeTrim(sp);
    return sp;
  }

  function loadBuiltInSamples() {
    var data = window.SpriteSamples.buildSampleDataUrls();
    Promise.all(
      data.map(function (d) {
        return U.loadImage(d.dataUrl).then(function (img) {
          return { d: d, img: img };
        });
      })
    ).then(function (loaded) {
      var existingNames = state.sprites.map(function (s) {
        return s.uniqueName;
      });
      var incomingNames = loaded.map(function (x) {
        return U.baseName(x.d.name);
      });
      var allUnique = U.uniqueNames(existingNames.concat(incomingNames));
      var newUnique = allUnique.slice(existingNames.length);
      loaded.forEach(function (x, i) {
        state.sprites.push(
          makeSprite({
            name: U.baseName(x.d.name),
            uniqueName: newUnique[i],
            sourcePath: 'samples/' + x.d.name,
            dataUrl: x.d.dataUrl,
            img: x.img,
            srcWidth: x.d.width,
            srcHeight: x.d.height,
          })
        );
      });
      relayout();
      toast('已载入 ' + loaded.length + ' 张内置示例（含两组重名素材）');
    });
  }

  // ---------------- 透明裁剪 ----------------

  function computeTrim(sp) {
    var w = sp.srcWidth;
    var h = sp.srcHeight;
    var c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    var ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(sp.img, 0, 0);
    var data;
    try {
      data = ctx.getImageData(0, 0, w, h).data;
    } catch (e) {
      sp.trim = { x: 0, y: 0, w: w, h: h };
      sp.empty = false;
      return;
    }
    var threshold = U.clamp(state.settings.alphaThreshold, 0, 255);
    var minX = w;
    var minY = h;
    var maxX = -1;
    var maxY = -1;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var a = data[(y * w + x) * 4 + 3];
        if (a > threshold) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) {
      sp.empty = true;
      sp.trim = null;
    } else {
      sp.empty = false;
      sp.trim = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
    }
  }

  function cellDims(sp) {
    var s = state.settings;
    var w;
    var h;
    if (s.trim && sp.trim) {
      w = sp.trim.w;
      h = sp.trim.h;
    } else {
      w = sp.srcWidth;
      h = sp.srcHeight;
    }
    var margin = 2 * (s.padding + s.extrude);
    return { w: w + margin, h: h + margin };
  }

  // ---------------- 排版 ----------------

  function relayout(recomputeTrims) {
    if (recomputeTrims) {
      state.sprites.forEach(computeTrim);
    }
    var s = state.settings;
    var items = [];
    state.sprites.forEach(function (sp) {
      var d = cellDims(sp);
      sp.cellW = d.w;
      sp.cellH = d.h;
      if (!sp.empty) {
        items.push({
          id: sp.id,
          name: sp.uniqueName,
          w: d.w,
          h: d.h,
          allowRotate: s.allowRotate && sp.allowRotate,
        });
      }
    });

    state.prevLayout = new Map(state.lastLayout);
    var result = Packer.pack(items, {
      mode: s.mode,
      width: s.width,
      height: s.height,
      powerOfTwo: s.powerOfTwo,
      allowRotate: s.allowRotate,
      previous: state.lastLayout,
    });
    state.result = result;
    state.lastLayout = new Map(result.placements);

    renderAll();
  }

  // ---------------- 渲染：精灵列表 / 拒绝列表 ----------------

  function spriteStatus(sp) {
    if (sp.empty) return { cls: 'empty', text: '全透明，已跳过' };
    var rej = state.result.rejected.find(function (r) {
      return r.id === sp.id;
    });
    if (rej) return { cls: 'rejected', text: '放不下' };
    var p = state.result.placements.get(sp.id);
    if (p && p.locked) return { cls: 'locked', text: '位置保持' };
    return { cls: 'ok', text: '已排入' };
  }

  function renderSpriteList() {
    var list = $('spriteList');
    if (!state.sprites.length) {
      list.innerHTML =
        '<div class="empty-tip">还没有精灵。点击「导入 PNG」、拖入文件，或载入内置示例。</div>';
      return;
    }
    var html = state.sprites
      .map(function (sp) {
        var st = spriteStatus(sp);
        var p = state.result && state.result.placements.get(sp.id);
        var dims = sp.empty
          ? '—'
          : sp.cellW + '×' + sp.cellH + (p && p.rotated ? '（旋转）' : '');
        var trimText = sp.empty
          ? '无可见像素'
          : sp.trim
            ? '裁剪 ' + sp.trim.w + '×' + sp.trim.h + ' @(' + sp.trim.x + ',' + sp.trim.y + ')'
            : sp.srcWidth + '×' + sp.srcHeight + '（未裁剪）';
        return (
          '<div class="sprite-row ' +
          (state.selectedId === sp.id ? 'selected' : '') +
          '" data-id="' +
          sp.id +
          '">' +
          '<img class="thumb" src="' +
          sp.dataUrl +
          '" alt="">' +
          '<div class="sprite-meta">' +
          '<div class="sprite-name" title="' +
          U.escapeHtml(sp.sourcePath) +
          '">' +
          U.escapeHtml(sp.uniqueName) +
          (sp.renamed
            ? ' <span class="badge badge-rename" title="与其他精灵重名，已自动加后缀，避免覆盖">重名→' +
              U.escapeHtml(sp.uniqueName) +
              '</span>'
            : '') +
          '</div>' +
          '<div class="sprite-sub">原图 ' +
          sp.srcWidth +
          '×' +
          sp.srcHeight +
          ' · 单元格 ' +
          dims +
          '</div>' +
          '<div class="sprite-sub">' +
          trimText +
          '</div>' +
          '<div class="sprite-row-actions">' +
          '<label class="mini-check"><input type="checkbox" data-rotate="' +
          sp.id +
          '" ' +
          (sp.allowRotate ? 'checked' : '') +
          '> 允许旋转</label>' +
          '<span class="status-pill ' +
          st.cls +
          '">' +
          st.text +
          '</span>' +
          '<button class="btn-mini danger" data-delete="' +
          sp.id +
          '">删除</button>' +
          '</div>' +
          '</div>' +
          '</div>'
        );
      })
      .join('');
    list.innerHTML = html;

    list.querySelectorAll('[data-rotate]').forEach(function (cb) {
      cb.addEventListener('change', function () {
        var sp = findSprite(cb.dataset.rotate);
        if (sp) {
          sp.allowRotate = cb.checked;
          relayout();
        }
      });
    });
  }

  function onSpriteListClick(e) {
    var del = e.target.closest('[data-delete]');
    if (del) {
      var id = del.dataset.delete;
      state.sprites = state.sprites.filter(function (sp) {
        return sp.id !== id;
      });
      if (state.selectedId === id) state.selectedId = null;
      relayout();
      return;
    }
    var row = e.target.closest('.sprite-row');
    if (row) {
      state.selectedId = row.dataset.id;
      renderSpriteList();
      drawPreview();
    }
  }

  function renderRejected() {
    var box = $('rejectedBox');
    var list = $('rejectedList');
    var rej = state.result ? state.result.rejected : [];
    var empties = state.sprites.filter(function (sp) {
      return sp.empty;
    });
    if (!rej.length && !empties.length) {
      box.classList.add('hidden');
      list.innerHTML = '';
      return;
    }
    box.classList.remove('hidden');
    var html = rej
      .map(function (r) {
        return (
          '<div class="rej-item">' +
          '<div><b>' +
          U.escapeHtml(r.name) +
          '</b> <span class="rej-reason">' +
          reasonText(r.reason) +
          '</span></div>' +
          '<div class="rej-detail">' +
          U.escapeHtml(r.detail) +
          '</div>' +
          '<button class="btn-mini jump-btn" data-id="' +
          r.id +
          '">在列表中定位</button>' +
          '</div>'
        );
      })
      .join('');
    html += empties
      .map(function (sp) {
        return (
          '<div class="rej-item warn">' +
          '<div><b>' +
          U.escapeHtml(sp.uniqueName) +
          '</b> <span class="rej-reason">全透明</span></div>' +
          '<div class="rej-detail">整张图没有超过透明度阈值的像素，无法排版，已从图集排除。</div>' +
          '</div>'
        );
      })
      .join('');
    list.innerHTML = html;
  }

  function reasonText(reason) {
    return reason === 'too_large' ? '超出图集尺寸' : '剩余空间不足';
  }

  function findSprite(id) {
    return state.sprites.find(function (sp) {
      return sp.id === id;
    });
  }

  // ---------------- 渲染：统计与变化范围 ----------------

  function renderStats() {
    var r = state.result;
    $('statCount').textContent = r.stats.spriteCount + ' / ' + state.sprites.length;
    $('statSize').textContent = r.width + '×' + r.height;
    $('statUtil').textContent = (r.stats.utilization * 100).toFixed(1) + '%';

    var ch = r.changed;
    var parts = [];
    if (ch.added.length) parts.push('新增 ' + ch.added.length);
    if (ch.removed.length) parts.push('删除 ' + ch.removed.length);
    if (ch.moved.length) parts.push('移位 ' + ch.moved.length);
    if (ch.resized.length) parts.push('尺寸变化 ' + ch.resized.length);
    $('changeSummary').textContent = ch.any ? parts.join('，') : '本次无变化（全部精灵位置保持稳定）';
    $('changeSummary').className = ch.any ? 'change-bar changed' : 'change-bar stable';
  }

  // ---------------- 渲染：图集画布 ----------------

  /** 生成精灵内容画布（裁剪后内容 + 边缘扩展），尺寸 = 内容 + 2*extrude */
  function buildContentCanvas(sp) {
    var s = state.settings;
    var e = s.extrude;
    var trim = s.trim && sp.trim ? sp.trim : { x: 0, y: 0, w: sp.srcWidth, h: sp.srcHeight };
    var sw = trim.w;
    var sh = trim.h;
    var c = document.createElement('canvas');
    c.width = sw + 2 * e;
    c.height = sh + 2 * e;
    var ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    // 中心内容
    ctx.drawImage(sp.img, trim.x, trim.y, sw, sh, e, e, sw, sh);
    if (e > 0) {
      // 上下左右四条边（拉伸 1px 源边缘）
      ctx.drawImage(sp.img, trim.x, trim.y, sw, 1, e, 0, sw, e);
      ctx.drawImage(sp.img, trim.x, trim.y + sh - 1, sw, 1, e, e + sh, sw, e);
      ctx.drawImage(sp.img, trim.x, trim.y, 1, sh, 0, e, e, sh);
      ctx.drawImage(sp.img, trim.x + sw - 1, trim.y, 1, sh, e + sw, e, e, sh);
      // 四角
      ctx.drawImage(sp.img, trim.x, trim.y, 1, 1, 0, 0, e, e);
      ctx.drawImage(sp.img, trim.x + sw - 1, trim.y, 1, 1, e + sw, 0, e, e);
      ctx.drawImage(sp.img, trim.x, trim.y + sh - 1, 1, 1, 0, e + sh, e, e);
      ctx.drawImage(
        sp.img,
        trim.x + sw - 1,
        trim.y + sh - 1,
        1,
        1,
        e + sw,
        e + sh,
        e,
        e
      );
    }
    return c;
  }

  function buildAtlasCanvas() {
    var r = state.result;
    var s = state.settings;
    var c = document.createElement('canvas');
    c.width = r.width;
    c.height = r.height;
    var ctx = c.getContext('2d');
    r.placements.forEach(function (p) {
      var sp = findSprite(p.id);
      if (!sp) return;
      var content = buildContentCanvas(sp);
      var pad = s.padding;
      ctx.imageSmoothingEnabled = false;
      if (p.rotated) {
        ctx.save();
        ctx.translate(p.x + p.w, p.y);
        ctx.rotate(Math.PI / 2);
        ctx.drawImage(content, pad, pad);
        ctx.restore();
      } else {
        ctx.drawImage(content, p.x + pad, p.y + pad);
      }
    });
    return c;
  }

  function drawPreview() {
    var stage = $('previewStage');
    var r = state.result;
    if (!r) return;
    if (!state.atlasCanvas) state.atlasCanvas = buildAtlasCanvas();
    var z = zoomNumber();
    var cw = Math.round(r.width * z);
    var ch = Math.round(r.height * z);

    var canvas = document.createElement('canvas');
    canvas.width = Math.max(1, cw);
    canvas.height = Math.max(1, ch);
    var ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(state.atlasCanvas, 0, 0, cw, ch);

    if (state.previewMode === 'original') {
      drawOriginalOverlay(ctx, z);
    }
    if (state.showRegions) {
      drawRegionBoxes(ctx, z);
    }
    if (state.showChanges) {
      drawChangeHighlights(ctx, z);
    }

    stage.innerHTML = '';
    canvas.style.width = cw + 'px';
    canvas.style.height = ch + 'px';
    stage.appendChild(canvas);
    $('zoomLabel').textContent = Math.round(z * 100) + '%';
  }

  function drawRegionBoxes(ctx, z) {
    var r = state.result;
    ctx.lineWidth = Math.max(1, z);
    r.placements.forEach(function (p) {
      var sp = findSprite(p.id);
      if (!sp) return;
      var selected = state.selectedId === p.id;
      ctx.strokeStyle = selected ? '#ffd166' : 'rgba(120,200,255,0.9)';
      ctx.lineWidth = selected ? 2 * Math.max(1, z) : Math.max(1, z);
      ctx.strokeRect(p.x * z, p.y * z, p.w * z, p.h * z);
      if (p.rotated) {
        ctx.fillStyle = 'rgba(255,209,102,0.95)';
        ctx.font = Math.max(10, 11 * z) + 'px sans-serif';
        ctx.fillText('↻', (p.x + 4) * z, (p.y + 12) * z);
      }
    });
  }

  /** 原尺寸对照：把整张原图（含透明边距）按内容锚点对齐铺回，虚线框为实际单元格 */
  function drawOriginalOverlay(ctx, z) {
    var r = state.result;
    var s = state.settings;
    var pad = s.padding;
    var e = s.extrude;
    ctx.save();
    ctx.globalAlpha = 0.85;
    r.placements.forEach(function (p) {
      var sp = findSprite(p.id);
      if (!sp) return;
      var trim = s.trim && sp.trim ? sp.trim : { x: 0, y: 0, w: sp.srcWidth, h: sp.srcHeight };
      // 让原图的 (trim.x, trim.y) 与图集里内容左上角对齐，超出单元格的部分即被裁掉的透明边距
      if (!p.rotated) {
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(
          sp.img,
          (p.x + pad + e - trim.x) * z,
          (p.y + pad + e - trim.y) * z,
          sp.srcWidth * z,
          sp.srcHeight * z
        );
      } else {
        // 与图集渲染相同的顺时针 90° 变换，在局部坐标系里贴整张原图
        ctx.save();
        ctx.translate((p.x + p.w) * z, p.y * z);
        ctx.rotate(Math.PI / 2);
        ctx.scale(z, z);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(sp.img, pad + e - trim.x, pad + e - trim.y, sp.srcWidth, sp.srcHeight);
        ctx.restore();
      }
      // 实际占用单元格（虚线，物理坐标）
      ctx.setLineDash([4 * z, 3 * z]);
      ctx.strokeStyle = state.selectedId === p.id ? '#ffd166' : 'rgba(255,120,120,0.95)';
      ctx.lineWidth = Math.max(1, z);
      ctx.strokeRect(p.x * z, p.y * z, p.w * z, p.h * z);
      ctx.setLineDash([]);
    });
    ctx.restore();
  }

  function drawChangeHighlights(ctx, z) {
    var r = state.result;
    var ch = r.changed;
    if (!ch.any && !ch.removed.length) return;

    // 已删除精灵的上一轮位置（幽灵框）
    ch.removed.forEach(function (id) {
      var prev = state.prevLayout.get(id);
      if (!prev) return;
      ctx.setLineDash([6 * z, 4 * z]);
      ctx.strokeStyle = 'rgba(255,90,90,0.95)';
      ctx.lineWidth = Math.max(1, z);
      ctx.strokeRect(prev.x * z, prev.y * z, prev.w * z, prev.h * z);
      ctx.setLineDash([]);
    });

    // 新增/移位/尺寸变化的高亮外框 + 总变化范围
    var ids = ch.added.concat(ch.moved).concat(ch.resized);
    var minX = Infinity;
    var minY = Infinity;
    var maxR = 0;
    var maxB = 0;
    ids.forEach(function (id) {
      var p = r.placements.get(id);
      if (!p) return;
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxR = Math.max(maxR, p.x + p.w);
      maxB = Math.max(maxB, p.y + p.h);
      var color = ch.added.indexOf(id) >= 0 ? 'rgba(80,220,120,0.95)' : 'rgba(255,180,60,0.95)';
      ctx.setLineDash([2 * z, 2 * z]);
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1.5, 1.5 * z);
      ctx.strokeRect(p.x * z, p.y * z, p.w * z, p.h * z);
      ctx.setLineDash([]);
    });
    if (isFinite(minX)) {
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = Math.max(1, z);
      ctx.strokeRect(minX * z - 2 * z, minY * z - 2 * z, (maxR - minX) * z + 4 * z, (maxB - minY) * z + 4 * z);
      $('changeRange').textContent =
        '变化范围矩形：x=' + minX + ' y=' + minY + ' w=' + (maxR - minX) + ' h=' + (maxB - minY);
    } else {
      $('changeRange').textContent = '变化范围矩形：无（仅删除）';
    }
  }

  function updateViewButtons() {
    $('viewAtlas').classList.toggle('active', state.previewMode === 'atlas');
    $('viewOriginal').classList.toggle('active', state.previewMode === 'original');
  }

  function renderAll() {
    state.atlasCanvas = null; // 内容可能变化，强制重建
    renderSpriteList();
    renderRejected();
    renderStats();
    updateViewButtons();
    drawPreview();
  }

  // ---------------- 导出 ----------------

  function buildManifest() {
    var r = state.result;
    var s = state.settings;
    var frames = {};
    r.placements.forEach(function (p) {
      var sp = findSprite(p.id);
      if (!sp) return;
      var trim = s.trim && sp.trim
        ? sp.trim
        : { x: 0, y: 0, w: sp.srcWidth, h: sp.srcHeight };
      // 实际像素内容（不含 padding/extrude）在图集中的物理矩形
      var contentRect;
      if (!p.rotated) {
        contentRect = {
          x: p.x + s.padding + s.extrude,
          y: p.y + s.padding + s.extrude,
          w: trim.w,
          h: trim.h,
        };
      } else {
        // 顺时针旋转后：trim 内容物理宽高互换
        contentRect = {
          x: p.x + s.padding + s.extrude,
          y: p.y + s.padding + s.extrude,
          w: trim.h,
          h: trim.w,
        };
      }
      frames[sp.uniqueName + '.png'] = {
        frame: { x: p.x, y: p.y, w: p.w, h: p.h },
        rotated: p.rotated,
        trimmed: s.trim && !!sp.trim,
        spriteSourceSize: { x: trim.x, y: trim.y, w: trim.w, h: trim.h },
        sourceSize: { w: sp.srcWidth, h: sp.srcHeight },
        contentRect: contentRect,
        cell: { w: sp.cellW, h: sp.cellH },
      };
    });
    return {
      meta: {
        app: 'sprite-atlas-tool',
        manifestVersion: 1,
        image: 'atlas.png',
        size: { w: r.width, h: r.height },
        format: 'RGBA8888',
        scale: 1,
        settings: {
          trim: s.trim,
          padding: s.padding,
          extrude: s.extrude,
          allowRotate: s.allowRotate,
          alphaThreshold: s.alphaThreshold,
          powerOfTwo: s.powerOfTwo,
          sizeMode: s.mode,
        },
      },
      frames: frames,
    };
  }

  function exportPng() {
    if (!requireAtlas()) return;
    state.atlasCanvas.toBlob(function (blob) {
      U.downloadBlob(blob, 'atlas.png');
      toast('已导出 atlas.png');
    }, 'image/png');
  }

  function exportManifest() {
    if (!requireAtlas()) return;
    var manifest = buildManifest();
    var blob = new Blob([JSON.stringify(manifest, null, 2)], {
      type: 'application/json',
    });
    U.downloadBlob(blob, 'atlas.json');
    toast('已导出 atlas.json（位置清单）');
  }

  function exportProject() {
    if (!state.sprites.length) {
      toast('工程为空，无可保存内容', 'warn');
      return;
    }
    var project = {
      app: 'sprite-atlas-tool-project',
      projectVersion: 1,
      createdAt: new Date().toISOString(),
      settings: JSON.parse(JSON.stringify(state.settings)),
      sprites: state.sprites.map(function (sp) {
        return {
          id: sp.id,
          name: sp.name,
          uniqueName: sp.uniqueName,
          sourcePath: sp.sourcePath,
          allowRotate: sp.allowRotate,
          width: sp.srcWidth,
          height: sp.srcHeight,
          dataUrl: sp.dataUrl,
        };
      }),
      layout: Array.from(state.lastLayout.values()).map(function (p) {
        return { id: p.id, x: p.x, y: p.y, w: p.w, h: p.h, rotated: p.rotated };
      }),
    };
    var blob = new Blob([JSON.stringify(project, null, 2)], {
      type: 'application/json',
    });
    U.downloadBlob(blob, 'sprite-atlas-project.json');
    toast('已导出工程文件，重新导入即可继续调整');
  }

  function exportIndividualPngs() {
    if (!requireAtlas()) return;
    var r = state.result;
    var s = state.settings;
    var entries = Array.from(r.placements.values());
    var i = 0;
    function next() {
      if (i >= entries.length) {
        toast('已导出 ' + entries.length + ' 张精灵 PNG');
        return;
      }
      var p = entries[i++];
      var sp = findSprite(p.id);
      if (!sp) {
        next();
        return;
      }
      var trim = s.trim && sp.trim
        ? sp.trim
        : { x: 0, y: 0, w: sp.srcWidth, h: sp.srcHeight };
      var cw = p.rotated ? trim.h : trim.w;
      var ch = p.rotated ? trim.w : trim.h;
      var c = document.createElement('canvas');
      c.width = cw;
      c.height = ch;
      var ctx = c.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      var src = state.atlasCanvas;
      var cx = p.x + s.padding + s.extrude;
      var cy = p.y + s.padding + s.extrude;
      if (p.rotated) {
        // 图集里是顺时针 90°，源区域物理尺寸为 ch×cw；
        // 逆时针 90° 转回 cw×ch 的未旋转内容
        ctx.save();
        ctx.translate(0, ch);
        ctx.rotate(-Math.PI / 2);
        ctx.drawImage(src, cx, cy, ch, cw, 0, 0, ch, cw);
        ctx.restore();
      } else {
        ctx.drawImage(src, cx, cy, cw, ch, 0, 0, cw, ch);
      }
      c.toBlob(function (blob) {
        U.downloadBlob(blob, sp.uniqueName + '.png');
        setTimeout(next, 150); // 错开浏览器多文件下载，避免被拦截
      }, 'image/png');
    }
    next();
  }

  function requireAtlas() {
    if (!state.result || !state.result.placements.size) {
      toast('图集为空，请先导入图片', 'warn');
      return false;
    }
    if (state.result.rejected.length) {
      toast('警告：存在放不下的精灵，导出内容仅包含已排入部分', 'warn');
    }
    return true;
  }

  // ---------------- 工程文件导入（往返） ----------------

  function importProject(file) {
    U.readFileAsText(file)
      .then(function (text) {
        var proj;
        try {
          proj = JSON.parse(text);
        } catch (e) {
          throw new Error('工程文件不是合法 JSON');
        }
        if (proj.app !== 'sprite-atlas-tool-project') {
          throw new Error('不是本工具的工程文件');
        }
        var jobs = proj.sprites.map(function (sp) {
          return U.loadImage(sp.dataUrl).then(function (img) {
            return { sp: sp, img: img };
          });
        });
        return Promise.all(jobs).then(function (loaded) {
          state.settings = Object.assign(
            JSON.parse(JSON.stringify(DEFAULTS)),
            proj.settings || {}
          );
          syncSettingInputs();
          state.sprites = loaded.map(function (x) {
            return makeSprite({
              id: x.sp.id,
              name: x.sp.name,
              uniqueName: x.sp.uniqueName,
              sourcePath: x.sp.sourcePath,
              dataUrl: x.sp.dataUrl,
              img: x.img,
              srcWidth: x.sp.width,
              srcHeight: x.sp.height,
              allowRotate: x.sp.allowRotate,
            });
          });
          state.lastLayout = new Map();
          (proj.layout || []).forEach(function (p) {
            state.lastLayout.set(p.id, p);
          });
          relayout();
          toast('工程已载入：' + loaded.length + ' 张精灵，参数与布局已恢复');
        });
      })
      .catch(function (err) {
        toast('工程导入失败：' + (err.message || err), 'error');
      });
  }

  // ---------------- 杂项 ----------------

  var toastTimer = null;
  function toast(msg, type) {
    var el = $('toast');
    el.textContent = msg;
    el.className = 'toast show ' + (type || '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.className = 'toast';
    }, 2600);
  }
})();
