// 内建演示素材规格（浏览器 / 服务端 / 生成脚本共用）。
// 每段素材的右侧固定位置有一块纯色标记块，叠化时同位置两色按 alpha 混合，
// 因此可以逐帧量出叠化的起始、中点与结束；画面中央是大号源帧计数。
// 音频是每段不同走向的扫频（chirp），可在成片开头测频率，验证没有把素材片头多播一遍。
export const SAMPLE_VERSION = 3;

export const SAMPLE_SPECS = [
  {
    id: 'sample-a',
    fileName: 'sample-a.mp4',
    label: 'A',
    title: 'A · 计数帧 · 420→820 Hz',
    fps: 30,
    duration: 5,
    width: 640,
    height: 360,
    base: [16, 32, 62],
    accent: [255, 178, 84],
    patch: { x: 522, y: 18, w: 64, h: 64, color: [236, 64, 52] },
    tone: { f0: 420, f1: 820 },
    hasAudio: true,
    marker: 'A',
  },
  {
    id: 'sample-b',
    fileName: 'sample-b.mp4',
    label: 'B',
    title: 'B · 计数帧 · 880→480 Hz',
    fps: 25,
    duration: 4,
    width: 640,
    height: 360,
    base: [12, 46, 38],
    accent: [79, 209, 197],
    patch: { x: 522, y: 18, w: 64, h: 64, color: [48, 208, 92] },
    tone: { f0: 880, f1: 480 },
    hasAudio: true,
    marker: 'B',
  },
  {
    id: 'sample-c',
    fileName: 'sample-c.mp4',
    label: 'C',
    title: 'C · 计数帧 · 无音轨',
    fps: 30,
    duration: 3,
    width: 640,
    height: 360,
    base: [52, 16, 32],
    accent: [244, 114, 182],
    patch: { x: 522, y: 18, w: 64, h: 64, color: [58, 96, 236] },
    tone: null,
    hasAudio: false,
    marker: 'C',
  },
];

export const SAMPLE_AUDIO = {
  sampleRate: 48000,
  amplitude: 0.25,
};

export function specById(id) {
  return SAMPLE_SPECS.find((s) => s.id === id) || null;
}

export function toneFrequencyAt(tone, t, duration) {
  if (!tone) return null;
  const prog = duration > 0 ? Math.max(0, Math.min(1, t / duration)) : 0;
  return tone.f0 + (tone.f1 - tone.f0) * prog;
}

export function patchAlpha(measured, left, right) {
  const dx = right[0] - left[0];
  const dy = right[1] - left[1];
  const dz = right[2] - left[2];
  const len2 = dx * dx + dy * dy + dz * dz;
  if (len2 < 1) return NaN;
  return ((measured[0] - left[0]) * dx + (measured[1] - left[1]) * dy + (measured[2] - left[2]) * dz) / len2;
}
