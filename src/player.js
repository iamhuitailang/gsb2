/* 视频播放与逐帧控制。
 * 帧是唯一事实来源：currentTime 只用来驱动 <video>，界面时间码永远由
 * Math.round(currentTime * fps) 反算，保证显示帧号与画面一致。 */
'use strict';

class Player extends EventTarget {
  constructor(videoEl) {
    super();
    this.video = videoEl;
    this.fps = 30;
    this.frameCount = 0;
    this.currentFrame = 0;
    this.objectUrl = null;
    this._raf = null;
    this._seekBlockers = new Set();

    videoEl.addEventListener('loadedmetadata', () => this._onLoaded());
    videoEl.addEventListener('seeked', () => this._onSeeked());
    videoEl.addEventListener('play', () => {
      this._startRaf();
      this.dispatchEvent(new CustomEvent('play'));
    });
    videoEl.addEventListener('pause', () => {
      this._stopRaf();
      this.dispatchEvent(new CustomEvent('pause'));
    });
  }

  async load(file, fpsOverride) {
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = URL.createObjectURL(file);
    this.video.src = this.objectUrl;
    if (fpsOverride) this.fps = fpsOverride;
    await new Promise((resolve, reject) => {
      this.video.addEventListener('loadedmetadata', resolve, { once: true });
      this.video.addEventListener('error', () => reject(new Error('视频解码失败，可能是浏览器不支持的编码')), { once: true });
    });
  }

  setFps(fps) {
    this.fps = fps;
    this.frameCount = Math.max(1, Math.round(this.video.duration * fps) || 1);
    this.currentFrame = this._frameFromTime(this.video.currentTime);
    this._emitFrame(true);
  }

  _onLoaded() {
    this.frameCount = Math.max(1, Math.round(this.video.duration * this.fps) || 1);
    this.video.pause();
    this.seekToFrame(0);
    this.dispatchEvent(new CustomEvent('loaded', { detail: { frameCount: this.frameCount } }));
  }

  _frameFromTime(t) {
    return clamp(Math.round(t * this.fps), 0, this.frameCount - 1);
  }

  _onSeeked() {
    const f = this._frameFromTime(this.video.currentTime);
    if (f !== this.currentFrame) {
      this.currentFrame = f;
      this._emitFrame();
    }
  }

  _startRaf() {
    const tick = () => {
      if (this.video.paused || this.video.ended) return;
      const f = this._frameFromTime(this.video.currentTime);
      if (f !== this.currentFrame) {
        this.currentFrame = f;
        this._emitFrame();
      }
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }

  _stopRaf() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
  }

  _emitFrame(force = false) {
    this.dispatchEvent(new CustomEvent('framechange', {
      detail: { frame: this.currentFrame, force },
    }));
  }

  /** 精确跳到某一帧，返回 seeked 完成的 Promise */
  seekToFrame(frame) {
    const target = clamp(Math.round(frame), 0, this.frameCount - 1);
    const targetTime = target / this.fps;
    if (Math.abs(this.video.currentTime - targetTime) < 1e-6 && this.currentFrame === target) {
      this.currentFrame = target;
      this._emitFrame(true);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const onSeeked = () => {
        this.video.removeEventListener('seeked', onSeeked);
        this.currentFrame = this._frameFromTime(this.video.currentTime);
        this._emitFrame(true);
        resolve();
      };
      this.video.addEventListener('seeked', onSeeked);
      this.video.currentTime = targetTime;
    });
  }

  step(delta) {
    this.video.pause();
    return this.seekToFrame(this.currentFrame + delta);
  }

  togglePlay() {
    if (this.video.ended) this.video.currentTime = 0;
    if (this.video.paused) this.video.play();
    else this.video.pause();
  }

  get paused() {
    return this.video.paused;
  }

  /** 顺序遍历每一帧取指纹，供修订版画面匹配；onProgress(i, total) 可取消（返回 false 中止） */
  async scanSignatures(onProgress) {
    const total = this.frameCount;
    const sigs = new Array(total);
    this.video.pause();
    await this.seekToFrame(0);
    for (let i = 0; i < total; i++) {
      await this.seekToFrame(i);
      sigs[i] = Thumbnails.signature(this.video);
      if (onProgress && onProgress(i + 1, total) === false) break;
    }
    return sigs;
  }

  dispose() {
    this._stopRaf();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
    this.video.removeAttribute('src');
    this.video.load();
  }
}
