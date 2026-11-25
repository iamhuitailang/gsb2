// 内置示例素材：纯 Canvas 程序化生成，完全本地
// 测试点：飘动的头发边缘、5.2s 起的快速移动、与绿幕同色的绿色道具
import { idbSet, idbGet } from "./storage.js";

export const SAMPLE_KEYS = {
  video: "sample:source-video",
  bgImage: "sample:bg-image",
  bgVideo: "sample:bg-video",
};

const W = 960, H = 540, FPS = 30, DURATION = 8;

// 测试模式（?fast=1）下缩短录制时长，无头冒烟测试用
const FAST = new URLSearchParams(location.search).has("fast");
const SAMPLE_DURATION = FAST ? 1.2 : DURATION;

// ---- 基础绘制工具 ----
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ---- 示例绿幕短片的一帧 ----
// cx: 画面平移量（模拟快速移动）
function drawSampleFrame(ctx, t, cx = 0) {
  // 不均匀绿幕（带轻微渐变和噪声，模拟真实棚拍）
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, "#27c93f");
  g.addColorStop(0.55, "#1eb833");
  g.addColorStop(1, "#179e2a");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // 背景噪声（逐帧微变 → 制造闪烁，考验时间稳定）
  const ncount = 260;
  for (let i = 0; i < ncount; i++) {
    const seed = i * 97.13;
    const nx = ((Math.sin(seed) * 0.5 + 0.5) * W + cx * 0.3) % W;
    const ny = (Math.cos(seed * 1.7) * 0.5 + 0.5) * H;
    const tw = Math.sin(t * 9 + seed) * 0.5 + 0.5;
    ctx.fillStyle = `rgba(255,255,255,${0.012 + tw * 0.02})`;
    ctx.fillRect((nx + W) % W, ny, 3, 3);
  }
  // 底部阴影
  const sh = ctx.createRadialGradient(W / 2 + cx, H - 40, 40, W / 2 + cx, H - 40, 380);
  sh.addColorStop(0, "rgba(0,60,10,0.35)");
  sh.addColorStop(1, "rgba(0,60,10,0)");
  ctx.fillStyle = sh;
  ctx.fillRect(0, H - 220, W, 220);

  ctx.save();
  ctx.translate(cx, 0);

  const bob = Math.sin(t * 2.2) * 7;          // 身体上下浮动
  const sway = Math.sin(t * 1.4) * 0.05;      // 轻微转身
  const bodyX = W / 2;
  const bodyY = 330 + bob;

  // ---- 身体（上衣颜色刻意偏冷，检验溢色修正） ----
  ctx.save();
  ctx.translate(bodyX, bodyY);
  ctx.rotate(sway * 0.4);
  const shirt = ctx.createLinearGradient(0, -60, 0, 240);
  shirt.addColorStop(0, "#3e6ea8");
  shirt.addColorStop(1, "#2c4f7d");
  ctx.fillStyle = shirt;
  roundRect(ctx, -95, -50, 190, 260, 42);
  ctx.fill();
  // 脖子
  ctx.fillStyle = "#e0b08c";
  roundRect(ctx, -22, -85, 44, 50, 14);
  ctx.fill();
  ctx.restore();

  // ---- 头部 ----
  const headX = bodyX + Math.sin(sway) * 12;
  const headY = 165 + bob;
  ctx.save();
  ctx.translate(headX, headY);
  ctx.rotate(sway);

  // 长发：很多根贝塞尔发丝，随时间飘动（发丝级边缘测试）
  const hairSway = Math.sin(t * 3.1) * 14;
  const hairSway2 = Math.sin(t * 2.3 + 1.2) * 9;
  ctx.lineCap = "round";
  for (let i = 0; i < 46; i++) {
    const f = i / 45;
    const side = f < 0.5 ? -1 : 1;
    const fx = (f - 0.5) * 130;
    const len = 120 + Math.sin(f * 9 + t * 2.4) * 22 + (f > 0.3 && f < 0.7 ? 26 : 0);
    const alpha = 0.55 + Math.sin(f * 12) * 0.25;
    ctx.strokeStyle = `rgba(48,30,22,${alpha})`;
    ctx.lineWidth = 1.6 + Math.sin(f * 7) * 0.9;
    ctx.beginPath();
    ctx.moveTo(fx, -46);
    ctx.bezierCurveTo(
      fx + side * 14 + hairSway * (0.4 + f), -10,
      fx + side * 26 + hairSway2, len * 0.55,
      fx + side * (20 + 26 * f) + hairSway, len
    );
    ctx.stroke();
  }
  // 头顶发块
  ctx.fillStyle = "#33201a";
  ctx.beginPath();
  ctx.ellipse(0, -38, 56, 52, 0, Math.PI, 0);
  ctx.fill();

  // 脸
  const skin = ctx.createLinearGradient(0, -40, 0, 45);
  skin.addColorStop(0, "#f0c29c");
  skin.addColorStop(1, "#dba37d");
  ctx.fillStyle = skin;
  ctx.beginPath();
  ctx.ellipse(0, 0, 47, 55, 0, 0, Math.PI * 2);
  ctx.fill();

  // 眼睛、嘴
  ctx.fillStyle = "#2b1d16";
  ctx.beginPath(); ctx.ellipse(-17, -6, 4.5, 6, 0, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(17, -6, 4.5, 6, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.beginPath(); ctx.arc(-15.5, -8, 1.4, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(18.5, -8, 1.4, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = "#a05a4d";
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.arc(0, 18, 13, 0.15 * Math.PI, 0.85 * Math.PI);
  ctx.stroke();
  ctx.restore();

  // ---- 手臂 + 与绿幕同色的绿色道具（0.8s 举起，5.6s 放下）----
  const mugPhase = smooth(0.8, 1.3, t) * (1 - smooth(5.6, 6.1, t));
  const armX = bodyX + 120;
  const armY = bodyY - 20 - mugPhase * 120;
  ctx.strokeStyle = "#e0b08c";
  ctx.lineWidth = 26;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(bodyX + 80, bodyY + 10);
  ctx.quadraticCurveTo(armX + 20, bodyY + 30, armX, armY);
  ctx.stroke();

  if (mugPhase > 0.02) {
    ctx.save();
    ctx.translate(armX, armY - 18);
    // 杯身：绿幕同色系 → 不用局部保留遮罩会被一起抠掉
    const mug = ctx.createLinearGradient(-26, 0, 26, 0);
    mug.addColorStop(0, "#149c28");
    mug.addColorStop(0.5, "#23c43a");
    mug.addColorStop(1, "#0f8722");
    ctx.fillStyle = mug;
    roundRect(ctx, -26, -20, 52, 64, 10);
    ctx.fill();
    // 杯把
    ctx.strokeStyle = "#1aa830";
    ctx.lineWidth = 9;
    ctx.beginPath();
    ctx.arc(30, 12, 14, -Math.PI / 2, Math.PI / 2);
    ctx.stroke();
    // 杯口
    ctx.fillStyle = "#0d6e1c";
    ctx.beginPath();
    ctx.ellipse(0, -20, 26, 8, 0, 0, Math.PI * 2);
    ctx.fill();
    // 白色标签，让人能分辨这是道具而非绿幕
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    roundRect(ctx, -14, 2, 28, 22, 4);
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();

  // 角标（仅前 2 秒提示，不影响测试）
  if (t < 2) {
    ctx.fillStyle = `rgba(255,255,255,${0.75 * (1 - smooth(1.4, 2, t))})`;
    ctx.font = "16px sans-serif";
    ctx.fillText("示例：发丝 / 快速移动 / 绿色同色道具", 18, 32);
  }
}

function smooth(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function canvasStream(canvas) {
  // 帧率 0 = 手动 requestFrame 驱动，避免无头/后台标签页下 rAF 被节流导致录制卡死
  if (canvas.captureStream) return canvas.captureStream(0);
  return canvas.mozCaptureStream(0);
}

// 确定性逐帧录制：每画一帧手动推入编码器，不依赖 rAF
async function recordFrames(canvas, fps, totalFrames, drawFn, onProgress) {
  const stream = canvasStream(canvas);
  const track = stream.getVideoTracks()[0];
  const mime = pickMime(false);
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 6_000_000 } : undefined);
  const parts = [];
  rec.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
  const stopped = new Promise((res) => (rec.onstop = res));
  rec.start(200);
  // 等编码器就绪
  await new Promise((r) => setTimeout(r, 60));

  const ctx = canvas.getContext("2d");
  for (let i = 0; i < totalFrames; i++) {
    drawFn(ctx, i);
    track.requestFrame?.();
    onProgress?.(i / totalFrames);
    // 让出事件循环并给编码器留处理时间；后台标签页也能稳定推进
    await new Promise((r) => setTimeout(r, 1000 / fps));
  }
  rec.stop();
  await stopped;
  return new Blob(parts, { type: mime || "video/webm" });
}

function pickMime(preferAlpha) {
  const cands = preferAlpha
    ? ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"]
    : ["video/webm;codecs=vp9", "video/webm;codecs=h264", "video/webm", "video/mp4"];
  for (const m of cands) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  }
  return "";
}

// ---- 生成示例源视频 ----
export async function generateSampleVideo(onProgress = () => {}) {
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const total = SAMPLE_DURATION * FPS;
  const blob = await recordFrames(canvas, FPS, total, (ctx, i) => {
    const t = i / FPS;
    // 5.2–6.8s 快速平移（镜头快速移动测试）
    const pan = smooth(5.2, 6.8, t);
    const cx = Math.sin(t * 1.4) * 10 - pan * 150 +
      Math.sin(Math.max(0, t - 5.2) * 18) * 8 *
      smooth(5.2, 5.6, t) * (1 - smooth(6.4, 6.9, t));
    drawSampleFrame(ctx, t, cx);
  }, (p) => onProgress(0.1 + p * 0.75, "生成示例短片"));

  const ext = blob.type.includes("mp4") ? "mp4" : "webm";
  const dataUrl = await blobToDataURL(blob);
  const meta = { blob, dataUrl, name: `示例绿幕短片.${ext}`, type: blob.type, width: W, height: H, duration: SAMPLE_DURATION };
  await idbSet(SAMPLE_KEYS.video, meta);
  onProgress(1, "生成示例短片");
  return meta;
}

// ---- 静态替换背景：摄影棚风格渐变 + 几何图形 ----
export async function generateBackgroundImage() {
  const c = document.createElement("canvas");
  c.width = 1600; c.height = 900;
  const ctx = c.getContext("2d");
  const g = ctx.createLinearGradient(0, 0, 1600, 900);
  g.addColorStop(0, "#2a3b66");
  g.addColorStop(0.5, "#43599b");
  g.addColorStop(1, "#7d5ba6");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 1600, 900);
  for (let i = 0; i < 14; i++) {
    ctx.fillStyle = `rgba(255,255,255,${0.04 + (i % 3) * 0.03})`;
    ctx.beginPath();
    ctx.arc((i * 281) % 1600, (i * 173) % 900, 60 + (i % 4) * 45, 0, Math.PI * 2);
    ctx.fill();
  }
  const blob = await new Promise((res) => c.toBlob(res, "image/png"));
  const dataUrl = await blobToDataURL(blob);
  const meta = { blob, dataUrl, name: "示例背景图.png", type: "image/png" };
  await idbSet(SAMPLE_KEYS.bgImage, meta);
  return meta;
}

// ---- 动态替换背景：流动光斑视频 ----
export async function generateBackgroundVideo(onProgress = () => {}) {
  const c = document.createElement("canvas");
  c.width = 1280; c.height = 720;
  const dur = 6, fps = 24, total = dur * fps;
  const blob = await recordFrames(c, fps, total, (ctx, i) => {
    const t = i / fps;
    const g = ctx.createLinearGradient(0, 0, 1280, 720);
    g.addColorStop(0, "#101f3d");
    g.addColorStop(1, "#3a2756");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 1280, 720);
    for (let k = 0; k < 9; k++) {
      const x = 640 + Math.cos(t * 0.7 + k * 2.1) * (200 + k * 38);
      const y = 360 + Math.sin(t * 0.9 + k * 1.7) * (120 + k * 24);
      const rg = ctx.createRadialGradient(x, y, 0, x, y, 180);
      rg.addColorStop(0, `hsla(${200 + k * 18},80%,65%,0.35)`);
      rg.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = rg;
      ctx.fillRect(x - 180, y - 180, 360, 360);
    }
  }, (p) => onProgress(p, "生成动态背景"));

  const ext = blob.type.includes("mp4") ? "mp4" : "webm";
  const dataUrl = await blobToDataURL(blob);
  const meta = { blob, dataUrl, name: `示例动态背景.${ext}`, type: blob.type, duration: dur };
  await idbSet(SAMPLE_KEYS.bgVideo, meta);
  return meta;
}

export async function getCachedSamples() {
  const [video, bgImage, bgVideo] = await Promise.all([
    idbGet(SAMPLE_KEYS.video), idbGet(SAMPLE_KEYS.bgImage), idbGet(SAMPLE_KEYS.bgVideo),
  ]);
  return { video, bgImage, bgVideo };
}

export function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
}

export function dataURLToBlob(dataUrl) {
  const [head, b64] = dataUrl.split(",");
  const mime = /data:(.*?);/.exec(head)?.[1] || "application/octet-stream";
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}
