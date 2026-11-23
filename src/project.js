// 工程状态：片段、转场、锁定、波纹编辑与不变量校验。
import { EPS, clamp, clipLength, clipAudioDuration } from './model.js';
import { buildTimeline, snapToFrames, projectFps } from './timeline.js';

export function makeTransition(index, type = 'dissolve', duration = 0.6) {
  return {
    id: `tr${index + 1}`,
    type,
    duration,
    audio: { mode: 'follow', switchTime: null },
  };
}

export function createProject(overrides = {}) {
  return {
    name: '短片拼接检查',
    fps: 30,
    width: 960,
    height: 540,
    sampleRate: 48000,
    missingAudioFade: 0.3,
    switchRamp: 0.012,
    cutRamp: 0.006,
    antiClick: 0.008,
    clips: [],
    transitions: [],
    ...overrides,
  };
}

export function normalizeProject(project) {
  const p = createProject(project);
  p.fps = Number(p.fps) || 30;
  p.clips = (p.clips || []).map((c, i) => ({
    id: c.id || `clip${i + 1}`,
    name: c.name || `片段 ${i + 1}`,
    src: c.src || '',
    duration: Number(c.duration) || 0,
    srcIn: clamp(Number(c.srcIn) || 0, 0, Number(c.duration) || 0),
    srcOut: clamp(Number(c.srcOut) || Number(c.duration) || 0, Number(c.srcIn) || 0, Number(c.duration) || 0),
    fps: Number(c.fps) || p.fps,
    width: Number(c.width) || p.width,
    height: Number(c.height) || p.height,
    hasAudio: Boolean(c.hasAudio),
    audioDuration: Number(c.audioDuration) || 0,
    locked: Boolean(c.locked),
    sample: Boolean(c.sample),
    toneHz: Number(c.toneHz) || null,
    marker: c.marker || null,
  }));
  const want = Math.max(0, p.clips.length - 1);
  const incoming = Array.isArray(p.transitions) ? p.transitions : [];
  p.transitions = Array.from({ length: want }, (_, i) => {
    const t = incoming[i];
    // 没有显式给出的转场默认是硬切，避免新加素材时凭空出现 0 秒叠化。
    return {
      id: t?.id || `tr${i + 1}`,
      type: t ? (t.type === 'dissolve' ? 'dissolve' : 'cut') : 'cut',
      duration: t ? Math.max(0, Number(t.duration) || 0) : 0,
      audio: {
        mode: ['follow', 'switch', 'mute'].includes(t?.audio?.mode) ? t.audio.mode : 'follow',
        switchTime: Number.isFinite(t?.audio?.switchTime) ? t.audio.switchTime : null,
      },
    };
  });
  return p;
}

// 设定某段入点 / 出点，保持 0 <= srcIn < srcOut <= 源时长，并按项目帧率对齐。
export function setTrim(project, index, { srcIn, srcOut }) {
  const p = normalizeProject(project);
  const clip = p.clips[index];
  if (!clip) return p;
  if (clip.locked) return p;
  const fps = clip.fps || p.fps;
  const minLen = 1 / fps;
  let inSec = srcIn != null ? Number(srcIn) : clip.srcIn;
  let outSec = srcOut != null ? Number(srcOut) : clip.srcOut;
  inSec = snapToFrames(clamp(inSec, 0, clip.duration - minLen), fps);
  outSec = snapToFrames(clamp(outSec, inSec + minLen, clip.duration), fps);
  clip.srcIn = inSec;
  clip.srcOut = outSec;
  return p;
}

// 设置片段中点（保持长度，平移截取窗口）。
export function panTrim(project, index, centerSec) {
  const p = normalizeProject(project);
  const clip = p.clips[index];
  if (!clip || clip.locked) return p;
  const len = clipLength(clip);
  const fps = clip.fps || p.fps;
  let inSec = clamp(Number(centerSec) - len / 2, 0, clip.duration - len);
  inSec = snapToFrames(inSec, fps);
  clip.srcIn = inSec;
  clip.srcOut = clamp(snapToFrames(inSec + len, fps), inSec + 1 / fps, clip.duration);
  return p;
}

export function setTransition(project, index, patch) {
  const p = normalizeProject(project);
  const tr = p.transitions[index];
  if (!tr) return p;
  if (patch.type) tr.type = patch.type === 'cut' ? 'cut' : 'dissolve';
  if (patch.duration != null) {
    const max = maxAllowedDuration(p, index);
    tr.duration = Math.max(0, Math.min(Number(patch.duration) || 0, max));
  }
  if (patch.audio) {
    tr.audio = { ...tr.audio, ...patch.audio };
  }
  return p;
}

export function setLocked(project, index, locked) {
  const p = normalizeProject(project);
  if (p.clips[index]) p.clips[index].locked = Boolean(locked);
  return p;
}

// 当前设置下，该处叠化在「不改动其它转场」的前提下最多能用多久：
//   左侧片段出口还能让出的画面 = len(a) - 它入口叠化已占用
//   右侧片段入口还能让出的画面 = len(b) - 它出口叠化已占用
// 取两者的较小值，再向下对齐到项目帧率。
export function maxAllowedDuration(project, index) {
  const p = normalizeProject(project);
  const n = p.clips.length;
  if (index < 0 || index >= n - 1) return 0;
  const a = p.clips[index];
  const b = p.clips[index + 1];
  const fps = projectFps(p);
  const inA = index > 0 ? Math.max(0, Number(p.transitions[index - 1]?.duration) || 0) : 0;
  const outB = index < n - 2 ? Math.max(0, Number(p.transitions[index + 1]?.duration) || 0) : 0;
  const roomA = Math.max(0, clipLength(a) - inA);
  const roomB = Math.max(0, clipLength(b) - outB);
  const raw = Math.max(0, Math.min(roomA, roomB));
  return Math.floor(raw * fps + EPS) / fps;
}

export function removeClip(project, index) {
  const p = normalizeProject(project);
  if (p.clips[index]?.locked) return p;
  p.clips.splice(index, 1);
  return normalizeProject(p);
}

export function reorderClips(project, from, to) {
  const p = normalizeProject(project);
  if (p.clips[from]?.locked || p.clips[to]?.locked) return p;
  const [c] = p.clips.splice(from, 1);
  p.clips.splice(to, 0, c);
  return normalizeProject(p);
}

export function setFps(project, fps) {
  const p = normalizeProject(project);
  p.fps = clamp(Number(fps) || 30, 1, 120);
  return p;
}

// 校验：导出前 / 重新检查时调用。返回 { ok, checks: [...] }
export function validateProject(project) {
  const p = normalizeProject(project);
  const tl = buildTimeline(p);
  const checks = [];
  const push = (id, ok, label, detail = '') => checks.push({ id, ok, label, detail });

  push('clip-count', p.clips.length >= 1, '至少一段素材', `当前 ${p.clips.length} 段`);
  push('duration-positive', tl.duration > EPS, '成片时长大于 0', `${tl.duration.toFixed(3)} s`);

  // 每段截取有效
  let trimOk = true;
  const trimDetail = [];
  p.clips.forEach((c, i) => {
    const len = clipLength(c);
    if (len <= EPS) { trimOk = false; trimDetail.push(`片段 ${i + 1} 截取长度为 0`); }
    if (c.srcIn < -EPS || c.srcOut > c.duration + 1e-3) {
      trimOk = false;
      trimDetail.push(`片段 ${i + 1} 入出点越界（${c.srcIn.toFixed(2)}–${c.srcOut.toFixed(2)} / 源 ${c.duration.toFixed(2)} s）`);
    }
  });
  push('trims-valid', trimOk, '各段入点 / 出点合法', trimDetail.join('；'));

  // 叠化是否被收窄。被收窄不是致命错误（画面依然合法），但必须让用户知道原因，
  // 因此这里记为一个明确的检查项，并在时间线上以提示形式保留。
  const clampIssues = tl.issues.filter((x) => x.transitionIndex != null);
  push('dissolves-fit', clampIssues.length === 0, '叠化全部完整可用',
    clampIssues.map((x) => x.message).join(' ') || '所有叠化都在两侧可用画面内');

  // 每个叠化时长 > 0 且有时间线上的重叠
  const dissoOk = tl.transitions.every((tr) => (tr.requestedType !== 'dissolve' || tr.type !== 'dissolve') || tr.duration > EPS);
  push('dissolves-nonzero', dissoOk, '叠化时长非零', '');

  // 音频覆盖（按源入点之后的可用长度比较）
  const audioChecks = tl.clips.map((row) => {
    if (!row.clip.hasAudio) return `片段 ${row.index + 1} 无音轨（静音过渡）`;
    if (clipAudioDuration(row.clip) + EPS < row.len) return `片段 ${row.index + 1} 音频短于画面`;
    return null;
  }).filter(Boolean);
  push('audio-coverage', true, '音频编排', audioChecks.join('；') || '各段音频覆盖整段画面');

  // 首尾与总时长
  push('starts-at-zero', tl.clips.length === 0 || Math.abs(tl.clips[0].start) < EPS, '首帧位于 0 s', '');
  const last = tl.clips[tl.clips.length - 1];
  push('ends-at-duration', !last || Math.abs(last.end - tl.duration) < 1e-3, '末帧等于成片时长',
    last ? `${last.end.toFixed(3)} s / ${tl.duration.toFixed(3)} s` : '');

  return {
    ok: checks.every((c) => c.ok),
    checks,
    timeline: tl,
  };
}
