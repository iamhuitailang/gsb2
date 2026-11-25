// 通用工具函数
export const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (t) => t * t * (3 - 2 * t);

export function $(sel, root = document) { return root.querySelector(sel); }
export function $$(sel, root = document) { return [...root.querySelectorAll(sel)]; }

let toastTimer = null;
export function toast(msg, type = "", ms = 2600) {
  const el = $("#toast");
  el.textContent = msg;
  el.className = `toast ${type}`.trim();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), ms);
}

export function formatTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.floor((sec * 100) % 100);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

export function hexToRgb01(hex) {
  const n = parseInt(hex.replace("#", ""), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function rgb01ToHex([r, g, b]) {
  const c = (v) => Math.round(clamp(v) * 255).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// 可取消的等待
export function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

export function uid(prefix = "id") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// MediaRecorder 产出的 WebM 常缺失时长元数据（duration=Infinity），
// 用 Chrome 标准技巧强制浏览器计算真实时长，再回到起点
export async function ensureFiniteDuration(video, hint = null) {
  if (isFinite(video.duration) && video.duration > 0) return video.duration;
  if (hint && isFinite(hint) && hint > 0) {
    // 已知理论时长时直接采用，避免一次额外 seek
    return hint;
  }
  const finite = new Promise((resolve) => {
    const onChange = () => {
      if (isFinite(video.duration) && video.duration > 0) {
        video.removeEventListener("durationchange", onChange);
        resolve(video.duration);
      }
    };
    video.addEventListener("durationchange", onChange);
    setTimeout(() => resolve(isFinite(video.duration) ? video.duration : NaN), 4000);
    try { video.currentTime = 1e7; } catch { /* 忽略 */ }
  });
  const dur = await finite;
  if (isFinite(dur)) {
    video.currentTime = 0;
    await new Promise((res) => {
      video.addEventListener("seeked", res, { once: true });
      setTimeout(res, 1000);
    });
  }
  return dur;
}
