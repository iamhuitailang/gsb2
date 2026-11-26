/*
 * export.js — 并排预览片导出（浏览器内置 MediaRecorder，输出 WebM）
 *
 * 导出范围固定为两路共有的主帧区间，逐帧 seek、逐帧合成后送入
 * canvas.captureStream，保证起止画面与本机预览逐帧一致。
 * 需要帧精确 MP4 时改用 scripts/export_sbs.py（ffmpeg）。
 */
(function (global) {
  'use strict';

  var C = global.StereoCore;

  function pickMimeType() {
    var candidates = [
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm'
    ];
    for (var i = 0; i < candidates.length; i++) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(candidates[i])) {
        return candidates[i];
      }
    }
    return '';
  }

  function StereoExporter(view) {
    this.view = view;
  }

  /**
   * 合成一帧并排画面到目标 canvas（无网格/十字，纯画面 + 黑底）。
   * 输出高度 = max(两眼高)，各自等比缩放到该高度后左右摆放。
   */
  StereoExporter.prototype._compose = function (ctx, outW, outH, s, frameInfo) {
    var self = this;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, outW, outH);

    ['left', 'right'].forEach(function (eyeKey, idx) {
      var eye = s.eyes[eyeKey];
      var fr = frameInfo[eyeKey];
      var h = outH, w = eye.source.width * (h / eye.source.height);
      var x = idx === 0 ? 0 : outW - w;
      var img;
      if (eye.source.kind === 'video') {
        img = eye.source.video;
      } else {
        if (!eye.source._exportCanvas) {
          eye.source._exportCanvas = document.createElement('canvas');
          eye.source._exportCanvas.width = eye.source.width;
          eye.source._exportCanvas.height = eye.source.height;
        }
        eye.source.drawFrame(eye.source._exportCanvas.getContext('2d'),
          eye.source.width, eye.source.height, fr.frame);
        img = eye.source._exportCanvas;
      }
      var voff = eye.verticalOffset * (h / eye.source.height);
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, 0, w, h);
      ctx.clip();
      ctx.drawImage(img, x, voff, w, h);
      if (voff > 0) ctx.fillRect(x, 0, w, voff);
      if (voff < 0) ctx.fillRect(x, h + voff, w, -voff);
      ctx.restore();
    });
  };

  StereoExporter.prototype._frameInfoAt = function (s, masterFrame) {
    var out = {};
    ['left', 'right'].forEach(function (k) {
      out[k] = C.eyeFrameAt(masterFrame, s.baseFps, s.eyes[k]);
    });
    return out;
  };

  /** 导出前先把所有视频源 seek 到指定帧 */
  StereoExporter.prototype._seekAll = function (s, info) {
    return ['left', 'right'].reduce(function (p, k) {
      return p.then(function () {
        var src = s.eyes[k].source;
        if (src && src.kind === 'video') return src.seekToFrame(info[k].frame);
      });
    }, Promise.resolve());
  };

  /** 生成某主帧的缩略图 dataURL（供导出对话框与预览核对） */
  StereoExporter.prototype.thumbnail = async function (s, masterFrame, maxW) {
    var info = this._frameInfoAt(s, masterFrame);
    await this._seekAll(s, info);
    var outH = 360;
    var outW = Math.round(
      (s.eyes.left.source.width * (outH / s.eyes.left.source.height)) +
      (s.eyes.right.source.width * (outH / s.eyes.right.source.height)));
    var c = document.createElement('canvas');
    c.width = outW; c.height = outH;
    this._compose(c.getContext('2d'), outW, outH, s, info);
    if (maxW && outW > maxW) {
      var scaled = document.createElement('canvas');
      scaled.width = maxW;
      scaled.height = Math.round(outH * maxW / outW);
      scaled.getContext('2d').drawImage(c, 0, 0, scaled.width, scaled.height);
      return scaled.toDataURL('image/png');
    }
    return c.toDataURL('image/png');
  };

  /**
   * 逐帧导出。
   * opts: { startFrame, endFrame（不含）, onProgress(pct, frame), signal: {cancel:false} }
   * 返回 Blob。
   */
  StereoExporter.prototype.export = async function (s, opts) {
    if (!window.MediaRecorder) {
      throw new Error('当前浏览器不支持 MediaRecorder，无法在页面内导出；可改用 scripts/export_sbs.py');
    }
    var self = this;
    var start = opts.startFrame, end = opts.endFrame;
    if (!(end > start)) throw new Error('导出区间为空');

    var outH = Math.max(s.eyes.left.source.height, s.eyes.right.source.height);
    var outW = Math.round(
      s.eyes.left.source.width * (outH / s.eyes.left.source.height) +
      s.eyes.right.source.width * (outH / s.eyes.right.source.height)
    );
    // 偶数尺寸对编码器更友好
    outW += outW % 2; outH += outH % 2;

    var canvas = document.createElement('canvas');
    canvas.width = outW; canvas.height = outH;
    var ctx = canvas.getContext('2d');

    var fps = s.baseFps;
    var stream = canvas.captureStream(0); // 手动推帧
    var track = stream.getVideoTracks()[0];
    var mime = pickMimeType();
    var recorder = new MediaRecorder(stream, {
      mimeType: mime || undefined,
      videoBitsPerSecond: Math.min(20_000_000, outW * outH * fps * 0.12)
    });
    var chunks = [];
    recorder.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
    var done = new Promise(function (resolve, reject) {
      recorder.onstop = function () { resolve(new Blob(chunks, { type: 'video/webm' })); };
      recorder.onerror = function (e) { reject(e.error || new Error('MediaRecorder 错误')); };
    });

    recorder.start(250);
    var total = end - start;

    for (var f = start; f < end; f++) {
      if (opts.signal && opts.signal.cancel) {
        recorder.stop();
        throw new Error('已取消导出');
      }
      var info = this._frameInfoAt(s, f);
      await this._seekAll(s, info);
      this._compose(ctx, outW, outH, s, info);
      if (track.requestFrame) track.requestFrame();
      // 给编码器留出处理时间，避免推帧过快导致丢帧
      await new Promise(function (r) { setTimeout(r, 1000 / fps); });
      if (opts.onProgress) opts.onProgress(Math.round((f - start + 1) / total * 100), f);
    }

    recorder.stop();
    var blob = await done;
    return {
      blob: blob,
      mimeType: mime || 'video/webm',
      width: outW,
      height: outH,
      frames: total,
      fps: fps
    };
  };

  global.StereoExporter = StereoExporter;
})(typeof window !== 'undefined' ? window : globalThis);
