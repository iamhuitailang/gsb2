// 项目数据模型：时间段、关键帧插值、遮罩笔画
import { clamp, lerp, smoothstep, uid } from "./utils.js";

export const PARAM_KEYS = ["similarity", "softness", "spill", "shadow"];

export function defaultParams() {
  return { similarity: 42, softness: 30, spill: 55, shadow: 35 };
}

export function createProject() {
  const firstSeg = createSegment(0, null);
  return {
    version: 1,
    name: "未命名项目",
    keyColor: "#12c020",
    source: null,          // { name, type, dataUrl } 或示例标记 { sample: true }
    background: { mode: "none", name: "", dataUrl: null, fit: "cover" },
    temporal: 0.4,
    segments: [firstSeg],
  };
}

export function createSegment(start, end) {
  return {
    id: uid("seg"),
    start,               // 秒，末段 end = null 表示到视频结束
    end,
    keyframes: [
      { id: uid("kf"), t: 0, params: defaultParams() },
    ],
    masks: [],           // { mode: 'keep'|'remove', feather, points:[{x,y,r}] }
  };
}

// ---------- 时间段 ----------
export function segmentAt(project, t) {
  const segs = project.segments;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (t >= s.start && (s.end === null || t < s.end)) return s;
  }
  return segs[segs.length - 1];
}

export function segmentIndexAt(project, t) {
  const idx = project.segments.findIndex(
    (s) => t >= s.start && (s.end === null || t < s.end)
  );
  return idx < 0 ? project.segments.length - 1 : idx;
}

// 在 t 处切分时间段；返回新时间段（若切分点在边界上则返回 null）
export function splitSegment(project, t) {
  const idx = segmentIndexAt(project, t);
  const seg = project.segments[idx];
  if (t <= seg.start + 0.05) return null;
  if (seg.end !== null && t >= seg.end - 0.05) return null;

  const newSeg = createSegment(t, seg.end);
  // 拷贝当前参数作为新段首帧
  newSeg.keyframes[0].params = { ...paramsAt(project, t) };
  // 新段继承当前遮罩，避免硬切（拷贝一份，之后互不影响）
  newSeg.masks = seg.masks.map((m) => ({ ...m, points: m.points.map((p) => ({ ...p })) }));

  // 把切点之后的关键帧迁移到新段，时间改为相对新段起点
  const cutLocal = t - seg.start;
  const moved = seg.keyframes.filter((kf) => kf.t > cutLocal + 0.001);
  if (moved.length) {
    newSeg.keyframes = moved.map((kf) => ({
      id: kf.id, t: kf.t - cutLocal, params: { ...kf.params },
    }));
    newSeg.keyframes.sort((a, b) => a.t - b.t);
    seg.keyframes = seg.keyframes.filter((kf) => kf.t <= cutLocal + 0.001);
    // 切点处补一个关键帧，保证切分瞬间参数不跳变
    if (!seg.keyframes.some((kf) => Math.abs(kf.t - cutLocal) <= 0.001)) {
      seg.keyframes.push({ id: uid("kf"), t: cutLocal, params: { ...paramsAt(project, t) } });
      seg.keyframes.sort((a, b) => a.t - b.t);
    }
  }

  seg.end = t;
  project.segments.splice(idx + 1, 0, newSeg);
  return newSeg;
}

export function deleteSegment(project, segId) {
  const idx = project.segments.findIndex((s) => s.id === segId);
  if (idx <= 0) return false; // 首段不可删
  const seg = project.segments[idx];
  const prev = project.segments[idx - 1];
  prev.end = seg.end;
  project.segments.splice(idx, 1);
  return true;
}

// ---------- 关键帧 ----------
// 返回 t 时刻的插值参数（关键帧之间 smoothstep 平滑过渡）
export function paramsAt(project, t) {
  const seg = segmentAt(project, t);
  const kfs = seg.keyframes;
  if (kfs.length === 1) return { ...kfs[0].params };

  // 段内相对时间 → 关键帧时间（关键帧 t 是相对段起点的秒数）
  const local = clamp(t - seg.start, 0, seg.end === null ? Infinity : seg.end - seg.start);

  if (local <= kfs[0].t) return { ...kfs[0].params };
  const last = kfs[kfs.length - 1];
  if (local >= last.t) return { ...last.params };

  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i], b = kfs[i + 1];
    if (local >= a.t && local <= b.t) {
      const f = smoothstep((local - a.t) / (b.t - a.t || 1));
      const out = {};
      for (const k of PARAM_KEYS) out[k] = lerp(a.params[k], b.params[k], f);
      return out;
    }
  }
  return { ...last.params };
}

// 找到 t 时刻（容差内）的关键帧
export function keyframeAt(seg, t, tolerance = 0.08) {
  const local = t - seg.start;
  return seg.keyframes.find((kf) => Math.abs(kf.t - local) <= tolerance) || null;
}

// 添加/更新关键帧。若附近已有关键帧则更新它
export function upsertKeyframe(project, t, params) {
  const seg = segmentAt(project, t);
  const local = t - seg.start;
  const exist = keyframeAt(seg, t);
  if (exist) {
    exist.params = { ...params };
    return exist;
  }
  const kf = { id: uid("kf"), t: local, params: { ...params } };
  seg.keyframes.push(kf);
  seg.keyframes.sort((a, b) => a.t - b.t);
  return kf;
}

export function removeKeyframeAt(project, t) {
  const seg = segmentAt(project, t);
  if (seg.keyframes.length <= 1) return false;
  const kf = keyframeAt(seg, t);
  if (!kf) return false;
  seg.keyframes = seg.keyframes.filter((k) => k.id !== kf.id);
  return true;
}

// 滑块拖动时调用：更新当前关键帧（若当前时间没有关键帧，则插一个）
export function writeParam(project, t, key, value) {
  const seg = segmentAt(project, t);
  const local = t - seg.start;
  let kf = keyframeAt(seg, t);
  if (!kf) {
    kf = { id: uid("kf"), t: local, params: paramsAt(project, t) };
    seg.keyframes.push(kf);
    seg.keyframes.sort((a, b) => a.t - b.t);
  }
  kf.params[key] = clamp(value, 0, 100);
  return kf;
}
