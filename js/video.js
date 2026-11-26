/*
 * video.js — 本地视频文件 FrameSource
 *
 * 用隐藏 <video> 逐帧 seek 后由 view 层 drawImage。
 * 浏览器无法从容器里可靠拿到精确帧率，fps 默认 25，可在界面里手动改
 * （常见值下拉：23.976/24/25/29.97/30/50/60，也可直接输入）。
 */
(function (global) {
  'use strict';

  var SEEK_TIMEOUT = 6000;

  function fileSizeText(bytes) {
    if (bytes == null) return '';
    var u = ['B', 'KB', 'MB', 'GB'];
    var i = 0, v = bytes;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return v.toFixed(i === 0 ? 0 : 1) + ' ' + u[i];
  }

  function VideoSource(file, fpsOverride) {
    var self = this;
    this.kind = 'video';
    this.file = file;
    this.name = file.name;
    this.size = file.size;
    this.url = URL.createObjectURL(file);
    this.video = document.createElement('video');
    this.video.preload = 'auto';
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.src = this.url;
    this.ready = false;
    this.error = null;
    this.fps = fpsOverride || 25;
    this._seekSeq = 0;
    this._seekTimer = null;
    this._pendingResolve = null;
    this._pendingReject = null;
    this._lastTime = null;

    this._onSeeked = function () { self._finishSeek(null); };
    this._onError = function () {
      self._finishSeek(new Error('视频解码失败：' + self.name));
    };
    this.video.addEventListener('seeked', this._onSeeked);
    this.video.addEventListener('error', this._onError);

    this._readyPromise = new Promise(function (resolve, reject) {
      self.video.addEventListener('loadedmetadata', function onMeta() {
        self.video.removeEventListener('loadedmetadata', onMeta);
        self.width = self.video.videoWidth;
        self.height = self.video.videoHeight;
        self.duration = isFinite(self.video.duration) ? self.video.duration : 0;
        self.frameCount = Math.max(1, Math.round(self.duration * self.fps));
        self.ready = true;
        resolve(self);
      });
      self.video.addEventListener('error', function onErr() {
        self.video.removeEventListener('error', onErr);
        self.error = '无法解码该视频（浏览器不支持的编码或容器）：' + self.name;
        reject(new Error(self.error));
      });
    });
  }

  VideoSource.prototype.whenReady = function () { return this._readyPromise; };

  VideoSource.prototype.setFps = function (fps) {
    if (!(fps > 0)) return;
    this.fps = fps;
    if (this.duration) {
      this.frameCount = Math.max(1, Math.round(this.duration * fps));
    }
  };

  VideoSource.prototype._finishSeek = function (err) {
    if (this._seekTimer) { clearTimeout(this._seekTimer); this._seekTimer = null; }
    if (this._pendingResolve) {
      var resolve = this._pendingResolve, reject = this._pendingReject;
      this._pendingResolve = null;
      this._pendingReject = null;
      err ? reject(err) : resolve();
    }
  };

  /**
   * seek 到第 frame 帧。串行化：新请求会顶掉排队中的旧请求。
   * seek 已落在目标帧 ±0.4 帧内时直接 resolve，避免无谓重 seek。
   */
  VideoSource.prototype.seekToFrame = function (frame) {
    var self = this;
    var target = Math.max(0, Math.min(frame, this.frameCount - 1)) / this.fps;
    if (this._lastTime != null && Math.abs(this._lastTime - target) < 0.4 / this.fps) {
      return Promise.resolve();
    }
    this._seekSeq++;
    if (this._pendingReject) {
      var rej = this._pendingReject;
      this._pendingReject = null;
      this._pendingResolve = null;
      rej(new Error('superseded'));
    }
    return new Promise(function (resolve, reject) {
      self._pendingResolve = resolve;
      self._pendingReject = reject;
      self._seekTimer = setTimeout(function () {
        self._finishSeek(new Error('seek 超时（' + self.name + '）'));
      }, SEEK_TIMEOUT);
      try {
        self.video.currentTime = target;
      } catch (e) {
        self._finishSeek(e);
      }
    }).then(function () {
      self._lastTime = target;
    }).catch(function (err) {
      if (err.message === 'superseded') return new Promise(function () {});
      throw err;
    });
  };

  VideoSource.prototype.drawFrame = function (ctx, targetW, targetH, frame) {
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.video, 0, 0, targetW, targetH);
  };

  VideoSource.prototype.destroy = function () {
    this._seekSeq++;
    if (this._seekTimer) clearTimeout(this._seekTimer);
    this.video.removeEventListener('seeked', this._onSeeked);
    this.video.removeEventListener('error', this._onError);
    this.video.removeAttribute('src');
    this.video.load();
    URL.revokeObjectURL(this.url);
  };

  VideoSource.prototype.metaText = function () {
    return this.width + '×' + this.height + ' · ' +
      this.fps.toFixed(3).replace(/0+$/, '').replace(/\.$/, '') + 'fps · ' +
      this.duration.toFixed(2) + 's · ' + this.frameCount + ' 帧 · ' +
      fileSizeText(this.size);
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { VideoSource: VideoSource, fileSizeText: fileSizeText };
  } else {
    global.VideoSource = VideoSource;
    global.formatFileSize = fileSizeText;
  }
})(typeof window !== 'undefined' ? window : globalThis);
