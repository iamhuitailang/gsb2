// 本地素材读取层。全部基于用户选择的 File 对象 + URL.createObjectURL，
// 不发起任何网络请求，文件不会离开本机。

import { parseFps } from './core/time.js';
import { audioBufferToEnvelope, peaksForDisplay, ENVELOPE_RATE } from './core/sync.js';

export class MediaStore {
  constructor() {
    /** sourceId -> 运行期媒体信息（不入工程文件） */
    this.items = new Map();
    this.audioContext = null;
  }

  ensureAudioContext() {
    if (!this.audioContext) {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this.audioContext.state === 'suspended') this.audioContext.resume();
    return this.audioContext;
  }

  /**
   * 读取一个本地文件并探测元数据。
   * kind 可显式指定，否则按 MIME / 扩展名推断。
   * fixedId：重新打开工程时传入工程保存的 source.id，保证运行期媒体
   * 能按稳定 id 取回；不传则按文件对象生成临时 id。
   */
  async loadFile(file, kindOverride = null, fixedId = null) {
    const url = URL.createObjectURL(file);
    const id = fixedId || uidFromFile(file);
    const kind = kindOverride || inferKind(file);
    if (kind === 'audio') {
      const audio = new Audio();
      audio.preload = 'auto';
      audio.muted = true;
      audio.src = url;
      await waitForEvent(audio, 'loadedmetadata', 'error');
      const item = {
        file,
        url,
        kind,
        element: audio,
        duration: Number.isFinite(audio.duration) ? audio.duration : 0,
        fps: null,
        audioBuffer: null,
        envelope: null,
        peaks: null,
        ready: null,
      };
      this.items.set(id, item);
      // 音频分支等待解码完成，ready 始终 resolve（无音轨也 resolve）
      item.ready = this.decodeAudio(item).catch(() => {});
      await item.ready;
      return id;
    }

    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true; // 音频由播放引擎统一调度，避免多路同时出声
    video.playsInline = true;
    video.src = url;
    await waitForEvent(video, 'loadedmetadata', 'error');
    const fps = await detectFps(video);
    const item = {
      file,
      url,
      kind: 'video',
      element: video,
      duration: video.duration,
      fps,
      audioBuffer: null,
      envelope: null,
      peaks: null,
      ready: null,
    };
    this.items.set(id, item);
    // 视频的音频解码在后台进行；同步前可 await item.ready 确保 envelope 就绪
    item.ready = this.decodeAudio(item).catch(() => {
      /* 无音轨的视频：envelope 保持 null，UI 提示该素材不能参与音频同步 */
    });
    return id;
  }

  /** 等待某素材的音频解码完成（无音轨也会 resolve）。 */
  async whenReady(sourceId) {
    const item = this.items.get(sourceId);
    if (item?.ready) await item.ready;
  }

  /** 解码音频用于波形显示与自动同步；无音轨时返回 null。 */
  async decodeAudio(item) {
    const ctx = this.ensureAudioContext();
    const arrayBuf = await item.file.arrayBuffer();
    let audioBuffer;
    try {
      audioBuffer = await ctx.decodeAudioData(arrayBuf.slice(0));
    } catch {
      return null;
    }
    item.audioBuffer = audioBuffer;
    item.envelope = audioBufferToEnvelope(audioBuffer);
    item.peaks = peaksForDisplay(audioBuffer.getChannelData(0));
    return item;
  }

  get(sourceId) {
    return this.items.get(sourceId) || null;
  }

  hasAudio(sourceId) {
    const item = this.items.get(sourceId);
    return !!(item && item.audioBuffer);
  }

  release(sourceId) {
    const item = this.items.get(sourceId);
    if (item) {
      item.element.removeAttribute('src');
      item.element.load();
      URL.revokeObjectURL(item.url);
      this.items.delete(sourceId);
    }
  }

  clear() {
    for (const id of [...this.items.keys()]) this.release(id);
  }
}

let fileSeq = 0;
function uidFromFile(file) {
  if (!file.__mcId) {
    fileSeq += 1;
    Object.defineProperty(file, '__mcId', {
      value: `src_${Date.now().toString(36)}_${fileSeq.toString(36)}`,
      enumerable: false,
    });
  }
  return file.__mcId;
}

export function inferKind(file) {
  if (file.type.startsWith('audio/')) return 'audio';
  if (file.type.startsWith('video/')) return 'video';
  return /\.(wav|mp3|m4a|aac|flac|ogg)$/i.test(file.name) ? 'audio' : 'video';
}

function waitForEvent(el, okEvent, errEvent) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      el.removeEventListener(okEvent, onOk);
      el.removeEventListener(errEvent, onErr);
    };
    const onOk = () => {
      cleanup();
      resolve();
    };
    const onErr = () => {
      cleanup();
      reject(new Error(`素材读取失败：${el.src}`));
    };
    el.addEventListener(okEvent, onOk, { once: true });
    el.addEventListener(errEvent, onErr, { once: true });
  });
}

/**
 * 用 requestVideoFrameCallback 实测帧率；不支持的浏览器回退 30fps。
 * 取若干帧的中位间隔，避免首帧抖动。
 */
async function detectFps(video) {
  if (!('requestVideoFrameCallback' in video)) return 30;
  video.muted = true;
  await video.play().catch(() => {});
  const intervals = [];
  let last = null;
  await new Promise((resolve) => {
    let count = 0;
    const cb = (now, meta) => {
      if (last !== null) intervals.push(now - last);
      last = now;
      count += 1;
      if (count >= 12 || video.ended) {
        video.pause();
        resolve();
        return;
      }
      video.requestVideoFrameCallback(cb);
    };
    video.requestVideoFrameCallback(cb);
    setTimeout(() => {
      video.pause();
      resolve();
    }, 1500);
  });
  if (intervals.length < 3) return 30;
  intervals.sort((a, b) => a - b);
  const medianMs = intervals[Math.floor(intervals.length / 2)];
  const measured = 1000 / medianMs;
  // 吸附到常见帧率（23.976/24/25/29.97/30/50/59.94/60），测不准时回退 30
  const common = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];
  const nearest = common.reduce((best, f) =>
    Math.abs(f - measured) < Math.abs(best - measured) ? f : best,
  );
  return Math.abs(nearest - measured) < 1.5 ? nearest : parseFps(measured.toFixed(3));
}

export { ENVELOPE_RATE };
