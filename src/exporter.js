// 导出：PNG 透明序列（zip）/ 透明通道 WebM / 合成视频
// 全部本地完成。逐帧 seek 源视频 → 渲染管线 → 编码
import { downloadBlob } from "./utils.js";
import { ZipWriter } from "./zip.js";

function seekTo(video, t) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener("seeked", onSeek);
      video.removeEventListener("error", onErr);
    };
    const onSeek = () => { cleanup(); resolve(); };
    const onErr = () => { cleanup(); reject(new Error("视频 seek 失败")); };
    video.addEventListener("seeked", onSeek, { once: true });
    video.addEventListener("error", onErr, { once: true });
    // 部分浏览器同值 seek 不触发 seeked
    if (Math.abs(video.currentTime - t) < 0.0005) {
      cleanup();
      resolve();
      return;
    }
    video.currentTime = t;
  });
}

// seek 完成后等帧数据真正可用于纹理上传
async function waitFrame(video) {
  if (video.readyState >= 2) return;
  await new Promise((resolve) => {
    const t = setTimeout(resolve, 1500); // 兜底，避免个别格式卡死
    video.addEventListener("loadeddata", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

function pickMime(alpha) {
  const cands = alpha
    ? ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"]
    : ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"];
  for (const m of cands) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  }
  return "";
}

export class Exporter {
  constructor({ renderer, video, bgElement, getFrameOpts, project, duration }) {
    this.renderer = renderer;
    this.video = video;
    this.bgElement = bgElement; // 当前替换背景元素（image 或 video，可为 null）
    this.getFrameOpts = getFrameOpts; // (t, mode) => renderer.render 的 opts
    this.project = project;
    this.duration = duration; // 兜底时长（防止 video.duration=Infinity）
    this.cancelled = false;
  }

  cancel() { this.cancelled = true; }

  async _renderFrames({ fps, scale, useTemporal, mode, onProgress }) {
    // 透明通道导出不带背景；合成导出使用当前替换背景（图片或视频）
    const bgSource = mode === "background" ? this.bgElement : null;
    const v = this.video;
    const dur = isFinite(v.duration) ? v.duration : this.duration;
    if (!isFinite(dur) || dur <= 0) {
      throw new Error("无法读取视频时长，请重新载入源视频后再导出");
    }
    const total = Math.max(1, Math.round(dur * fps));
    const w = Math.round(v.videoWidth * scale);
    const h = Math.round(v.videoHeight * scale);
    const out = document.createElement("canvas");
    out.width = w; out.height = h;
    const ctx = out.getContext("2d");
    const target = this.renderer.makeTarget(w, h);
    const prevTime = v.currentTime;
    const wasPaused = v.paused;
    v.pause();

    const bitmaps = [];
    try {
      for (let i = 0; i < total; i++) {
        if (this.cancelled) break;
        const t = Math.min(dur - 0.001, i / fps);
        await seekTo(v, t);
        await waitFrame(v);
        if (bgSource && bgSource.readyState >= 2) {
          const bgDur = isFinite(bgSource.duration) ? bgSource.duration : dur;
          const bt = t % bgDur;
          if (Math.abs(bgSource.currentTime - bt) > 0.02) {
            await seekTo(bgSource, bt);
            await waitFrame(bgSource);
          }
        }
        const opts = {
          ...this.getFrameOpts(t, mode),
          time: t,
          temporal: useTemporal ? this.project.temporal : 0,
          forceReset: i === 0 || !useTemporal,
        };
        this.renderer.render(v, bgSource, opts, target);
        this.renderer.blitFboToCanvas2D(target.fbo, w, h, ctx, w, h);
        bitmaps.push(await createImageBitmap(out));
        onProgress((i + 1) / total, `已处理 ${i + 1}/${total} 帧`);
        if (i % 2 === 0) await new Promise((r) => setTimeout(r, 0));
      }
    } finally {
      const gl = this.renderer.gl;
      gl.deleteFramebuffer(target.fbo);
      gl.deleteTexture(target.tex);
      await seekTo(v, prevTime).catch(() => {});
      if (!wasPaused) v.play().catch(() => {});
    }
    return { bitmaps, w, h };
  }

  // ---- PNG 序列 zip ----
  async exportPngSequence({ fps, scale, useTemporal, onProgress }) {
    const { bitmaps } = await this._renderFrames({
      fps, scale, useTemporal, mode: "alpha", bgSource: null, onProgress,
    });
    if (this.cancelled) return null;
    const c = document.createElement("canvas");
    c.width = bitmaps[0].width; c.height = bitmaps[0].height;
    const ctx = c.getContext("2d");
    const zip = new ZipWriter();
    for (let k = 0; k < bitmaps.length; k++) {
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.drawImage(bitmaps[k], 0, 0);
      const blob = await new Promise((res) => c.toBlob(res, "image/png"));
      const buf = new Uint8Array(await blob.arrayBuffer());
      zip.addFile(`frame_${String(k).padStart(5, "0")}.png`, buf);
      bitmaps[k].close();
      onProgress(k / bitmaps.length, `打包 PNG ${k + 1}/${bitmaps.length}`);
      if (k % 4 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    const blob = zip.blob();
    downloadBlob(blob, `${this.project.name || "project"}_透明序列_${fps}fps.zip`);
    onProgress(1, `完成：${bitmaps.length} 帧 PNG（含 alpha 通道）`);
    return blob;
  }

  // ---- 视频（alpha 或合成） ----
  async exportVideo({ fps, scale, useTemporal, alpha, onProgress }) {
    if (!alpha && this.project.background.mode !== "none" && !this.bgElement) {
      throw new Error("合成视频需要替换背景已加载");
    }
    const mode = alpha ? "alpha" : "background";
    const { bitmaps, w, h } = await this._renderFrames({
      fps, scale, useTemporal, mode, onProgress,
    });
    if (this.cancelled) { bitmaps.forEach((b) => b.close()); return null; }

    const mime = pickMime(alpha);
    if (!mime) throw new Error("当前浏览器不支持 MediaRecorder 视频编码");
    const out = document.createElement("canvas");
    out.width = w; out.height = h;
    const ctx = out.getContext("2d");
    const stream = out.captureStream(0);
    const track = stream.getVideoTracks()[0];
    const rec = new MediaRecorder(stream, {
      mimeType: mime,
      videoBitsPerSecond: Math.min(16_000_000, Math.round(w * h * fps * 0.12)),
    });
    const parts = [];
    rec.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
    const stopped = new Promise((res) => (rec.onstop = res));
    rec.start(200);

    const frameMs = 1000 / fps;
    for (const bmp of bitmaps) {
      if (this.cancelled) break;
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(bmp, 0, 0);
      track.requestFrame?.();
      await new Promise((r) => setTimeout(r, frameMs));
      bmp.close();
    }
    rec.stop();
    await stopped;
    if (this.cancelled) return null;
    const blob = new Blob(parts, { type: mime });
    const ext = mime.includes("mp4") ? "mp4" : "webm";
    const suffix = alpha ? "透明通道" : "合成";
    downloadBlob(blob, `${this.project.name || "project"}_${suffix}_${fps}fps.${ext}`);
    onProgress(1, "视频编码完成");
    return blob;
  }
}
