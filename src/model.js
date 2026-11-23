// 短片拼接与转场检查 —— 纯时间线模型（浏览器与 Node 共用，无 DOM / FS 依赖）。
//
// 约定
// ----
// 每段素材先按「入点 / 出点」截取，可用画面长度 len = srcOut - srcIn。
// 硬切：后一段紧接前一段结束。
// 叠化：时长 d 的叠化让后一段提前 d 秒开始，前段最后 d 秒与后段最前 d 秒在统一
//       时间线上重叠；成片总时长因此比全硬切少 d 秒（每处叠化各少 d）。
// 叠化只使用两边「已选画面」里的帧，不向入点 / 出点之外借帧，所以必须满足
//       D[b-1] + D[b] <= len[b]     （b 为片段下标，D[-1] = D[n-1] = 0）
// 某段两侧叠化之和超出其可用长度时收窄，并给出具体原因。
//
// 所有「定位」先落在统一时间线的秒数上，再换算到各源素材自己的帧号，因此不同帧率
// 的素材可以在同一时间点对齐检查。

export const EPS = 1e-6;

export const DEFAULTS = {
  fps: 30,
  width: 960,
  height: 540,
  sampleRate: 48000,
  missingAudioFade: 0.3, // 缺音轨时淡入 / 淡出静音的时长
  switchRamp: 0.012, // 定点切换的去咔哒斜坡
  cutRamp: 0.006, // 硬切处音频的去咔哒斜坡
  antiClick: 0.008, // 音频段自身首尾的去咔哒斜坡
};

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

export function clipLength(clip) {
  return Math.max(0, (clip.srcOut ?? 0) - (clip.srcIn ?? 0));
}

export function clipAudioDuration(clip) {
  if (!clip.hasAudio) return 0;
  // 音频可用长度 = 音频终点与画面出点中较小者 - 入点。
  const srcDur = Number.isFinite(clip.audioDuration) && clip.audioDuration > 0
    ? clip.audioDuration
    : clip.duration;
  const srcOut = Number.isFinite(clip.srcOut) ? clip.srcOut : srcDur;
  return Math.max(0, Math.min(srcDur, srcOut) - (clip.srcIn ?? 0));
}

export function fpsOf(clip) {
  return clip.fps > 0 ? clip.fps : DEFAULTS.fps;
}

export function secondsToFrame(sec, fps) {
  return Math.max(0, Math.floor(sec * (fps || DEFAULTS.fps) + 1e-6));
}

export function frameToSeconds(frame, fps) {
  return frame / (fps || DEFAULTS.fps);
}

export function formatSeconds(sec, digits = 2) {
  return Number.isFinite(sec) ? `${sec.toFixed(digits)} s` : '—';
}

export function formatClock(sec, digits = 2) {
  if (!Number.isFinite(sec)) return '—';
  const sign = sec < 0 ? '-' : '';
  const s = Math.abs(sec);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${sign}${m}:${r.toFixed(digits).padStart(digits + 3, '0')}`;
}

export function formatTimecode(sec, fps = DEFAULTS.fps) {
  if (!Number.isFinite(sec)) return '—';
  const total = Math.max(0, sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const f = Math.floor((total - Math.floor(total)) * fps + 1e-6);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)}:${p(f)}`;
}
