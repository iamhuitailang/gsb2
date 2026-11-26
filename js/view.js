/*
 * view.js — 主画布视图
 *
 * 显示模式：
 *  sbs     并排（左右各一个视口，共用同一 zoom/pan）
 *  overlay 叠加（alpha 半透明 / 红蓝 anaglyph / 差值）
 *  blink   交替（按帧率整眼切换，可暂停单看一只眼）
 *
 * zoom/pan 为屏幕空间的共享变换，两个视口始终同比例、同相对位移。
 */
(function (global) {
  'use strict';

  var C = global.StereoCore;

  function View(canvas, getState) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.getState = getState;
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.fitScale = 1;
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    this._blinkStart = performance.now();
    this._blinkEye = 'left';

    this.onPick = null;      // (eye, sx, sy) => void
    this.pickMode = false;
    this.pickFirst = null;   // 已拾取的左眼点
    this.hoverBox = null;

    this._bindEvents();
  }

  View.prototype._bindEvents = function () {
    var self = this;
    var canvas = this.canvas;
    var dragging = null;

    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      var factor = Math.exp(-e.deltaY * 0.0012);
      self.zoomAt(e.offsetX, e.offsetY, factor);
    }, { passive: false });

    canvas.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      if (self.pickMode) { self._handlePick(e); return; }
      dragging = { x: e.clientX, y: e.clientY, px: self.panX, py: self.panY };
    });

    window.addEventListener('mousemove', function (e) {
      if (dragging) {
        self.panX = dragging.px + (e.clientX - dragging.x);
        self.panY = dragging.py + (e.clientY - dragging.y);
        self.scheduleRender();
      }
    });
    window.addEventListener('mouseup', function () { dragging = null; });
    canvas.addEventListener('dblclick', function () { self.resetView(); });
  };

  View.prototype.zoomAt = function (cx, cy, factor) {
    var nz = C.clamp(this.zoom * factor, 0.1, 16);
    factor = nz / this.zoom;
    this.panX = cx - (cx - this.panX) * factor;
    this.panY = cy - (cy - this.panY) * factor;
    this.zoom = nz;
    this.scheduleRender();
  };

  View.prototype.setZoom = function (z) {
    var cx = this.canvas.clientWidth / 2, cy = this.canvas.clientHeight / 2;
    this.zoomAt(cx, cy, z / this.zoom);
  };

  View.prototype.resetView = function () {
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.scheduleRender();
  };

  View.prototype.fit = function () {
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.scheduleRender();
  };

  /** 重新匹配画布像素尺寸（CSS 尺寸变化 / DPR 变化时调用） */
  View.prototype.resize = function () {
    var rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    this.canvas.width = Math.max(1, Math.round(rect.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * this.dpr));
    this.scheduleRender();
  };

  View.prototype.scheduleRender = function () {
    var self = this;
    if (this._raf) return;
    this._raf = requestAnimationFrame(function () {
      self._raf = null;
      self.render().catch(function (err) {
        if (err && err.message !== 'superseded') console.warn('render error', err);
      });
    });
  };

  /* ---------------- 布局 ---------------- */

  /**
   * 返回 { left: {x,y,w,h, srcW,srcH, scale}, right: {...}, splitX }
   * 盒坐标为 CSS 像素；scale 为素材像素 -> 屏幕像素的基础缩放（未含 zoom）。
   * 尺寸取自 eye.source（state.eyes[k] 本身只有偏移，不带尺寸）。
   */
  View.prototype._layout = function () {
    var s = this.getState();
    var cw = this.canvas.clientWidth, ch = this.canvas.clientHeight;
    var out = { cw: cw, ch: ch };
    if (s.mode === 'sbs') {
      var halfW = cw / 2;
      out.splitX = halfW;
      out.left = this._box(0, 0, halfW, ch, s.eyes.left);
      out.right = this._box(halfW, 0, halfW, ch, s.eyes.right);
    } else {
      out.splitX = null;
      var box = this._box(0, 0, cw, ch, s.eyes.left);
      out.left = box;
      out.right = this._box(box.x, box.y, box.w, box.h, s.eyes.right, box.scale);
    }
    return out;
  };

  View.prototype._box = function (areaX, areaY, areaW, areaH, eye, forceScale) {
    var src = eye && eye.source;
    var srcW = src ? src.width : 640;
    var srcH = src ? src.height : 360;
    var scale = forceScale != null
      ? forceScale
      : Math.min(areaW / srcW, areaH / srcH);
    var w = srcW * scale, h = srcH * scale;
    return {
      x: areaX + (areaW - w) / 2,
      y: areaY + (areaH - h) / 2,
      w: w, h: h,
      srcW: srcW, srcH: srcH,
      scale: scale
    };
  };

  /** 屏幕(CSS) -> 素材坐标，point={x,y}；不在盒内或无素材返回 null */
  View.prototype.screenToSource = function (eyeKey, point) {
    var s = this.getState();
    var eye = s.eyes[eyeKey];
    if (!eye || !eye.source) return null;
    var lay = this._layout();
    var b = lay[eyeKey];
    var x = point.x - this.panX, y = point.y - this.panY;
    if (x < b.x || x > b.x + b.w || y < b.y || y > b.y + b.h) return null;
    var sx = (x - b.x) / (b.scale * this.zoom);
    var sy = (y - b.y) / (b.scale * this.zoom) - eye.verticalOffset;
    return { x: sx, y: sy };
  };

  /** 素材坐标 -> 屏幕(CSS)，无素材返回 null */
  View.prototype.sourceToScreen = function (eyeKey, sx, sy) {
    var s = this.getState();
    var eye = s.eyes[eyeKey];
    if (!eye || !eye.source) return null;
    var lay = this._layout();
    var b = lay[eyeKey];
    return {
      x: b.x + (sx) * b.scale * this.zoom + this.panX,
      y: b.y + (sy + eye.verticalOffset) * b.scale * this.zoom + this.panY
    };
  };

  /* ---------------- 拾取 ---------------- */

  View.prototype._handlePick = function (e) {
    var rect = this.canvas.getBoundingClientRect();
    var point = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    var s = this.getState();
    var eyeKey;
    if (s.mode === 'sbs') {
      eyeKey = point.x < this._layout().splitX ? 'left' : 'right';
    } else {
      eyeKey = this.pickFirst ? 'right' : 'left';
    }
    if (s.frames[eyeKey] && !s.frames[eyeKey].available) return;
    var src = this.screenToSource(eyeKey, point);
    if (!src) return;
    this.onPick && this.onPick(eyeKey, src);
  };

  View.prototype.cancelPick = function () {
    this.pickMode = false;
    this.pickFirst = null;
    this.canvas.style.cursor = '';
    this.scheduleRender();
  };

  /* ---------------- 渲染 ---------------- */

  View.prototype.render = async function () {
    var s = this.getState();
    var lay = this._layout();
    var ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#0a0d16';
    ctx.fillRect(0, 0, lay.cw, lay.ch);

    if (s.mode === 'sbs') {
      await this._renderEye('left', lay.left, s);
      await this._renderEye('right', lay.right, s);
      this._drawDivider(lay);
    } else if (s.mode === 'blink') {
      var now = performance.now();
      var interval = 1000 / (s.baseFps || 25);
      var eye = Math.floor((now - this._blinkStart) / interval) % 2 === 0 ? 'left' : 'right';
      this._blinkEye = eye;
      await this._renderEye(eye, lay.left, s);
      this._drawBlinkBadge(eye);
    } else {
      await this._renderOverlay(lay, s);
    }

    if (s.showGrid) this._drawGrid(lay, s);
    if (s.showCross) this._drawCross(lay);
    if (s.showSafe) this._drawSafe(lay);
    this._drawMarkers(lay, s);
    if (this.pickMode) this._drawPickHint(lay, s);
    this._drawHUD(lay, s);
  };

  /** 取某只眼当前帧对应的可绘制源（video 元素或离屏 canvas），并完成 seek */
  View.prototype._eyeImage = async function (eyeKey, s) {
    var eye = s.eyes[eyeKey];
    if (!eye || !eye.source || !eye.source.ready) return null;
    var fr = s.frames[eyeKey];
    if (!fr || !fr.available) return null;
    if (eye.source.kind === 'video') {
      await eye.source.seekToFrame(fr.frame);
      return eye.source.video;
    }
    return this._sampleCanvas(eye.source, fr.frame);
  };

  View.prototype._renderEye = async function (eyeKey, b, s) {
    var ctx = this.ctx;
    var eye = s.eyes[eyeKey];
    var fr = s.frames[eyeKey];

    var dx = b.x + this.panX, dy = b.y + this.panY;
    var dw = b.w * this.zoom, dh = b.h * this.zoom;

    ctx.save();
    ctx.beginPath();
    ctx.rect(dx, dy, dw, dh);
    ctx.clip();
    ctx.fillStyle = '#000';
    ctx.fillRect(dx, dy, dw, dh);

    if (!eye || !eye.source) {
      this._drawEmpty(dx, dy, dw, dh, eyeKey);
      ctx.restore();
      return;
    }
    if (!eye.source.ready) {
      this._drawMessage(dx, dy, dw, dh, '加载中…');
      ctx.restore();
      return;
    }
    if (!fr || !fr.available) {
      this._drawMissing(dx, dy, dw, dh);
      ctx.restore();
      return;
    }

    var img;
    try {
      img = await this._eyeImage(eyeKey, s);
    } catch (e) {
      if (e.message === 'superseded') { ctx.restore(); return; }
      this._drawMessage(dx, dy, dw, dh, 'seek 失败：' + e.message);
      ctx.restore();
      return;
    }
    var voff = eye.verticalOffset * b.scale * this.zoom;
    ctx.drawImage(img, dx, dy + voff, dw, dh);
    if (voff > 0) ctx.fillRect(dx, dy, dw, voff);
    if (voff < 0) ctx.fillRect(dx, dy + dh + voff, dw, -voff);
    ctx.restore();

    this._drawEyeBadge(eyeKey, b);
  };

  /** 样片源需要走它自己的 drawFrame（含裁切/位移管线），包一层离屏 canvas */
  View.prototype._sampleCanvas = function (source, frame) {
    if (!source._viewCanvas) {
      source._viewCanvas = document.createElement('canvas');
      source._viewCanvas.width = source.width;
      source._viewCanvas.height = source.height;
    }
    var c = source._viewCanvas;
    source.drawFrame(c.getContext('2d'), source.width, source.height, frame);
    return c;
  };

  /**
   * 叠加模式：alpha 半透明 / 红蓝（anaglyph）/ 差值。
   * 两只眼统一画进同一盒（lay.left 盒），各自再叠加垂直偏移。
   */
  View.prototype._renderOverlay = async function (lay, s) {
    var self = this;
    var b = lay.left;
    var ctx = this.ctx;
    var dx = b.x + this.panX, dy = b.y + this.panY;
    var dw = Math.round(b.w * this.zoom), dh = Math.round(b.h * this.zoom);

    ctx.save();
    ctx.beginPath();
    ctx.rect(dx, dy, dw, dh);
    ctx.clip();
    ctx.fillStyle = '#000';
    ctx.fillRect(dx, dy, dw, dh);

    var imgs = {};
    for (var k = 0; k < 2; k++) {
      var eyeKey = k === 0 ? 'left' : 'right';
      var eye = s.eyes[eyeKey], fr = s.frames[eyeKey];
      if (!eye || !eye.source || !eye.source.ready || !fr || !fr.available) continue;
      try {
        imgs[eyeKey] = await this._eyeImage(eyeKey, s);
      } catch (e) {
        if (e.message === 'superseded') { ctx.restore(); return; }
        throw e;
      }
    }

    function drawOne(eyeKey) {
      var eb = lay[eyeKey];
      var voff = s.eyes[eyeKey].verticalOffset * eb.scale * self.zoom;
      ctx.drawImage(imgs[eyeKey], dx, dy + voff, dw, dh);
    }

    if (s.overlayMode === 'anaglyph') {
      // 左眼只保留红通道，右眼只保留绿蓝通道，用 lighter 合成
      var layer = this._getTmpCanvas(dw, dh);
      var lctx = layer.getContext('2d');
      ['left', 'right'].forEach(function (eyeKey) {
        if (!imgs[eyeKey]) return;
        var eb = lay[eyeKey];
        var voff = s.eyes[eyeKey].verticalOffset * eb.scale * self.zoom;
        lctx.clearRect(0, 0, dw, dh);
        lctx.globalCompositeOperation = 'source-over';
        lctx.drawImage(imgs[eyeKey], 0, voff, dw, dh);
        if (eyeKey === 'left') {
          lctx.globalCompositeOperation = 'multiply';
          lctx.fillStyle = '#ff0000';
          lctx.fillRect(0, 0, dw, dh);
        } else {
          lctx.globalCompositeOperation = 'multiply';
          lctx.fillStyle = '#00ffff';
          lctx.fillRect(0, 0, dw, dh);
        }
        ctx.globalCompositeOperation = 'lighter';
        ctx.drawImage(layer, dx, dy);
        ctx.globalCompositeOperation = 'source-over';
      });
    } else if (s.overlayMode === 'diff') {
      if (imgs.left) drawOne('left');
      if (imgs.right) {
        ctx.globalCompositeOperation = 'difference';
        drawOne('right');
        ctx.globalCompositeOperation = 'source-over';
      }
    } else {
      // alpha：左右各 50%
      ctx.globalAlpha = 0.5;
      if (imgs.left) drawOne('left');
      if (imgs.right) drawOne('right');
      ctx.globalAlpha = 1;
    }

    // 缺帧的一只眼给出文字提示
    ['left', 'right'].forEach(function (eyeKey) {
      var fr = s.frames[eyeKey];
      if (s.eyes[eyeKey] && s.eyes[eyeKey].source && (!fr || !fr.available)) {
        self._drawMissing(dx, dy, dw, dh);
      }
    });
    ctx.restore();
    this._drawEyeBadge('overlay', b);
  };

  View.prototype._getTmpCanvas = function (w, h) {
    if (!this._tmp || this._tmp.width < w || this._tmp.height < h) {
      this._tmp = document.createElement('canvas');
      this._tmp.width = w; this._tmp.height = h;
    }
    return this._tmp;
  };

  /* ---------------- 覆盖层 ---------------- */

  View.prototype._drawDivider = function (lay) {
    var ctx = this.ctx;
    ctx.strokeStyle = '#2a3550';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(lay.splitX + 0.5, 0);
    ctx.lineTo(lay.splitX + 0.5, lay.ch);
    ctx.stroke();
  };

  View.prototype._drawGrid = function (lay, s) {
    var ctx = this.ctx;
    var boxes = s.mode === 'sbs' ? [lay.left, lay.right] : [lay.left];
    ctx.save();
    ctx.strokeStyle = 'rgba(120,170,255,0.35)';
    ctx.lineWidth = 1;
    boxes.forEach(function (b) {
      var dx = b.x + this.panX, dy = b.y + this.panY;
      var dw = b.w * this.zoom, dh = b.h * this.zoom;
      ctx.strokeRect(dx + 0.5, dy + 0.5, dw, dh);
      ctx.beginPath();
      for (var i = 1; i < 4; i++) {
        var gx = dx + dw * i / 4, gy = dy + dh * i / 4;
        ctx.moveTo(gx, 0); ctx.lineTo(gx, lay.ch);
        ctx.moveTo(0, gy); ctx.lineTo(lay.cw, gy);
      }
      ctx.stroke();
    }, this);
    ctx.restore();
  };

  View.prototype._drawCross = function (lay) {
    var ctx = this.ctx;
    var cx = lay.cw / 2, cy = lay.ch / 2;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,80,80,0.9)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, 0); ctx.lineTo(cx, lay.ch);
    ctx.moveTo(0, cy); ctx.lineTo(lay.cw, cy);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, 14, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  };

  View.prototype._drawSafe = function (lay) {
    var s = this.getState();
    var ctx = this.ctx;
    var boxes = s.mode === 'sbs' ? [lay.left, lay.right] : [lay.left];
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.setLineDash([8, 6]);
    boxes.forEach(function (b) {
      var dx = b.x + this.panX, dy = b.y + this.panY;
      var dw = b.w * this.zoom, dh = b.h * this.zoom;
      ctx.strokeRect(dx + dw * 0.05, dy + dh * 0.05, dw * 0.9, dh * 0.9);
    }, this);
    ctx.setLineDash([]);
    ctx.restore();
  };

  View.prototype._drawMarkers = function (lay, s) {
    var self = this;
    var ctx = this.ctx;
    s.markers.forEach(function (m, idx) {
      var state = C.markerState(m, s.baseFps, s.eyes);
      var color = state === 'valid' ? '#ffd54a' : '#ff5d5d';
      ['left', 'right'].forEach(function (eyeKey) {
        var p = m[eyeKey];
        var sp = self.sourceToScreen(eyeKey, p.x, p.y);
        if (!sp) return;
        ctx.save();
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, 7, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(sp.x - 12, sp.y); ctx.lineTo(sp.x + 12, sp.y);
        ctx.moveTo(sp.x, sp.y - 12); ctx.lineTo(sp.x, sp.y + 12);
        ctx.stroke();
        ctx.font = 'bold 12px ui-monospace, Menlo, monospace';
        ctx.textAlign = 'center';
        ctx.fillText('#' + (idx + 1), sp.x, sp.y - 12);
        if (state === 'stale') {
          ctx.font = '10px sans-serif';
          ctx.fillText('失效', sp.x, sp.y + 22);
        }
        ctx.restore();
      });
      // 并排模式下把两点连起来
      if (s.mode === 'sbs' && state === 'valid') {
        var a = self.sourceToScreen('left', m.left.x, m.left.y);
        var b2 = self.sourceToScreen('right', m.right.x, m.right.y);
        if (!a || !b2) return;
        ctx.save();
        ctx.strokeStyle = 'rgba(255,213,74,0.65)';
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y); ctx.lineTo(b2.x, b2.y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      }
    });
  };

  View.prototype._drawPickHint = function (lay, s) {
    var ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = 'rgba(10,13,22,0.82)';
    var text = this.pickFirst
      ? '再在右眼对应位置点击（Esc 取消）'
      : s.mode === 'sbs'
        ? '在左眼参考点上点击（Esc 取消）'
        : '先在左眼参考点上点击（Esc 取消）';
    ctx.font = '13px sans-serif';
    var w = ctx.measureText(text).width + 28;
    ctx.fillRect(lay.cw / 2 - w / 2, 10, w, 30);
    ctx.strokeStyle = '#ffd54a';
    ctx.strokeRect(lay.cw / 2 - w / 2 + 0.5, 10.5, w, 30);
    ctx.fillStyle = '#ffd54a';
    ctx.textAlign = 'center';
    ctx.fillText(text, lay.cw / 2, 30);
    ctx.restore();
    this.canvas.style.cursor = 'crosshair';
  };

  View.prototype._drawHUD = function (lay, s) {
    var ctx = this.ctx;
    ctx.save();
    ctx.font = '11px ui-monospace, Menlo, monospace';
    ctx.fillStyle = 'rgba(200,215,240,0.85)';
    ctx.textAlign = 'left';
    ctx.fillText('缩放 ' + Math.round(this.zoom * 100) + '%（滚轮缩放 / 拖拽平移 / 双击复位）', 10, lay.ch - 10);
    ctx.restore();
  };

  View.prototype._drawEyeBadge = function (eyeKey, b) {
    var ctx = this.ctx;
    var label = eyeKey === 'left' ? 'L 左眼' : eyeKey === 'right' ? 'R 右眼' : '叠加';
    var color = eyeKey === 'left' ? '#46d17a' : eyeKey === 'right' ? '#ff9f43' : '#8ab4ff';
    var dx = b.x + this.panX, dy = b.y + this.panY;
    ctx.save();
    ctx.font = 'bold 13px sans-serif';
    ctx.fillStyle = color;
    ctx.fillText(label, dx + 10, dy + 20);
    ctx.restore();
  };

  View.prototype._drawBlinkBadge = function (eye) {
    var ctx = this.ctx;
    ctx.save();
    ctx.font = 'bold 14px sans-serif';
    ctx.fillStyle = eye === 'left' ? '#46d17a' : '#ff9f43';
    ctx.textAlign = 'right';
    ctx.fillText('交替显示 · 当前 ' + (eye === 'left' ? '左眼 L' : '右眼 R'),
      this.canvas.clientWidth - 14, 24);
    ctx.restore();
  };

  View.prototype._drawEmpty = function (x, y, w, h, eyeKey) {
    this._drawMessage(x, y, w, h, (eyeKey === 'left' ? '左眼' : '右眼') + '：请在上方选择素材');
  };

  View.prototype._drawMissing = function (x, y, w, h) {
    var ctx = this.ctx;
    ctx.fillStyle = '#1a1420';
    ctx.fillRect(x, y, w, h);
    ctx.save();
    ctx.strokeStyle = 'rgba(255,93,93,0.55)';
    ctx.lineWidth = 2;
    var gap = 24;
    ctx.beginPath();
    for (var d = -h; d < w; d += gap) {
      ctx.moveTo(x + d, y + h);
      ctx.lineTo(x + d + h, y);
    }
    ctx.stroke();
    ctx.fillStyle = '#ff7a7a';
    ctx.font = 'bold 16px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('缺帧 MISSING', x + w / 2, y + h / 2 - 8);
    ctx.font = '12px ui-monospace, Menlo, monospace';
    ctx.fillText('该时间点此眼没有对应素材帧', x + w / 2, y + h / 2 + 14);
    ctx.restore();
  };

  View.prototype._drawMessage = function (x, y, w, h, text) {
    var ctx = this.ctx;
    ctx.fillStyle = '#111827';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#9fb2d4';
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(text, x + w / 2, y + h / 2);
  };

  global.StereoView = View;
})(typeof window !== 'undefined' ? window : globalThis);
