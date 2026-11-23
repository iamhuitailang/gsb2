// 音频编排：把每段音轨映射到统一时间线，得到逐段的增益包络（折线点）。
//
// 关键点
// ------
// 1. 音频只从「源入点」开始读，绝不重播素材片头；srcOffset = srcIn。
// 2. 转场音频三种模式：
//      follow —— 跟随画面：叠化时两侧音频等功率交叠；硬切时在切点切换。
//      switch —— 在转场的交叠窗口里选一个统一时间点切换：左源淡出、右源淡入。
//                硬切没有交叠窗口，切换点即切点。
//      mute   —— 转场处静音：叠化窗口内两侧都收到静音，窗口结束后右源再进来。
// 3. 缺音轨 / 音频比画面短时，平滑过渡到静音（missingAudioFade 秒），而不是突然断开。
//
// 增益用若干「门」相乘表示，再以 5 ms 网格采样成折线点；预览（Web Audio）与导出
// （Node PCM 混音）读同一组点。

import { EPS, DEFAULTS, clamp, clipAudioDuration, clipLength } from './model.js';

export const AUDIO_MODES = ['follow', 'switch', 'mute'];
const GRID = 0.005;

export function normalizeAudio(audio) {
  const mode = AUDIO_MODES.includes(audio?.mode) ? audio.mode : 'follow';
  const switchTime = Number.isFinite(audio?.switchTime) ? audio.switchTime : null;
  return { mode, switchTime };
}

export function audioSpan(row) {
  if (!row) return { clipIndex: -1, start: 0, end: 0, duration: 0, srcOffset: 0, hasAudio: false };
  const dur = clipAudioDuration(row.clip);
  return {
    clipIndex: row.index,
    start: row.start,
    end: row.start + dur,
    duration: dur,
    srcOffset: row.srcIn,
    hasAudio: Boolean(row.clip.hasAudio) && dur > EPS,
  };
}

// 某处转场里允许做「定点切换」的交叠窗口（统一时间）。
export function switchWindow(tr) {
  if (!tr) return null;
  if (tr.type === 'dissolve' && tr.duration > EPS) return [tr.start, tr.end];
  // 硬切：只有一个切点，切换只能发生在切点。
  return [tr.cutAt, tr.cutAt];
}

function lerp01(a, b, t) {
  return b - a < EPS ? (t >= b ? 1 : 0) : clamp((t - a) / (b - a), 0, 1);
}
const smooth = (x) => x * x * (3 - 2 * x);
const eqIn = (x) => Math.sin((Math.PI / 2) * x);
const eqOut = (x) => Math.cos((Math.PI / 2) * x);

function gateUp(t0, t1, curve = 'smooth') {
  const fn = curve === 'eq' ? eqIn : curve === 'linear' ? (x) => x : smooth;
  return (t) => fn(lerp01(t0, t1, t));
}
function gateDown(t0, t1, curve = 'smooth') {
  // 等功率用余弦自然收尾；平滑 / 线性需要显式取反，才能从 1 降到 0。
  if (curve === 'eq') return (t) => eqOut(lerp01(t0, t1, t));
  const fn = curve === 'linear' ? (x) => x : smooth;
  return (t) => 1 - fn(lerp01(t0, t1, t));
}
function holdZeroBefore(t) {
  return (x) => (x >= t ? 1 : 0);
}

export function buildAudioPlan(timeline, project = {}) {
  const opts = {
    missingAudioFade: project.missingAudioFade ?? DEFAULTS.missingAudioFade,
    switchRamp: project.switchRamp ?? DEFAULTS.switchRamp,
    antiClick: project.antiClick ?? DEFAULTS.antiClick,
  };
  const rows = timeline.clips;
  return rows.map((row, i) => {
    const span = audioSpan(row);
    if (!span.hasAudio) {
      return {
        ...span,
        silent: true,
        points: [],
        reason: row.clip.hasAudio ? '可用音频长度为 0' : '片段无音轨',
      };
    }
    const prev = rows[i - 1];
    const next = rows[i + 1];
    const trIn = i > 0 ? timeline.transitions[i - 1] : null;
    const trOut = i < rows.length - 1 ? timeline.transitions[i] : null;
    const { start, end, duration } = span;
    const shortAudio = end < row.end - EPS;

    const gates = [];
    const marks = new Set([start, end]);
    const add = (t) => marks.add(clamp(t, start, end));

    // ---- 入场 ----
    let inCurve = 'smooth';
    let inSpan = [start, start + Math.min(opts.antiClick, duration / 2)];

    if (trIn) {
      const audio = normalizeAudio(trIn.audio);
      const win = switchWindow(trIn);
      if (audio.mode === 'switch') {
        const st = clamp(audio.switchTime ?? win[0], Math.max(start, win[0]), Math.min(end, win[1]));
        const rampEnd = Math.min(end, st + opts.switchRamp);
        add(st); add(rampEnd);
        if (st > start + EPS) gates.push(holdZeroBefore(st));
        inSpan = [st, Math.max(st, rampEnd)];
        inCurve = 'linear';
      } else if (audio.mode === 'mute') {
        // 静音贯穿转场窗口：右源等窗口结束再进
        const enter = clamp(trIn.type === 'dissolve' ? trIn.end : trIn.cutAt, start, end);
        const rampEnd = Math.min(end, enter + opts.switchRamp);
        add(enter); add(rampEnd);
        if (enter > start + EPS) gates.push(holdZeroBefore(enter));
        inSpan = [enter, Math.max(enter, rampEnd)];
        inCurve = 'linear';
      } else if (trIn.type === 'dissolve') {
        inSpan = [start, Math.min(end, start + trIn.duration)];
        inCurve = 'eq';
      }
    }
    // 上一段无音轨：从静音平滑淡入
    if (prev && !prev.clip.hasAudio) {
      const f = Math.min(opts.missingAudioFade, duration);
      inSpan = [start, Math.max(inSpan[1], start + f)];
      inCurve = 'smooth';
    }
    gates.push(gateUp(inSpan[0], inSpan[1], inCurve));
    add(inSpan[0]); add(inSpan[1]);

    // ---- 出场 ----
    let outSpan = [end - Math.min(opts.antiClick, duration / 2), end];
    let outCurve = 'smooth';

    if (shortAudio) {
      const f = Math.min(opts.missingAudioFade, duration);
      outSpan = [end - f, end];
      outCurve = 'smooth';
    }

    if (trOut) {
      const audio = normalizeAudio(trOut.audio);
      const win = switchWindow(trOut);
      const nextHasAudio = audioSpan(next).hasAudio;
      if (!nextHasAudio) {
        // 下一段静音：本段平滑淡出
        if (trOut.type === 'dissolve') {
          outSpan = [clamp(trOut.start, start, end), clamp(trOut.end, start, end)];
        } else {
          outSpan = [clamp(trOut.cutAt - opts.missingAudioFade, start, end), clamp(trOut.cutAt, start, end)];
        }
        outCurve = 'smooth';
      } else if (audio.mode === 'switch') {
        const st = clamp(audio.switchTime ?? win[0], Math.max(start, win[0]), Math.min(end, win[1]));
        // 硬切时 win = [cut, cut]，切点就是右段起点，左段音频在这里收到 0。
        outSpan = [Math.max(start, st - opts.switchRamp), st];
        outCurve = 'linear';
      } else if (audio.mode === 'mute') {
        // 静音贯穿转场窗口：本段在窗口开始前收掉
        const leave = clamp(trOut.type === 'dissolve' ? trOut.start : trOut.cutAt, start, end);
        outSpan = [Math.max(start, leave - opts.switchRamp), leave];
        outCurve = 'linear';
      } else if (trOut.type === 'dissolve') {
        outSpan = [clamp(trOut.start, start, end), clamp(trOut.end, start, end)];
        outCurve = 'eq';
      }
    }
    gates.push(gateDown(outSpan[0], outSpan[1], outCurve));
    add(outSpan[0]); add(outSpan[1]);

    const points = sampleGates(gates, start, end, marks);
    return {
      ...span,
      silent: false,
      points,
      srcOffset: row.srcIn,
      shortAudio,
      note: describeAudio(row, span, prev, next, trIn, trOut, opts, shortAudio),
    };
  });
}

function sampleGates(gates, start, end, marks) {
  const times = [];
  for (let t = start; t < end - 1e-9; t += GRID) times.push(t);
  times.push(end);
  for (const m of marks) times.push(m);
  times.sort((a, b) => a - b);
  const pts = [];
  let lastT = -Infinity;
  for (const raw of times) {
    const t = clamp(raw, start, end);
    if (t - lastT < 1e-9) continue;
    lastT = t;
    let g = 1;
    for (const gate of gates) g *= gate(t);
    pts.push([Number(t.toFixed(6)), Number(clamp(g, 0, 1).toFixed(6))]);
  }
  return pts;
}

function describeAudio(row, span, prev, next, trIn, trOut, opts, shortAudio) {
  const bits = [];
  if (trIn?.type === 'dissolve' && normalizeAudio(trIn.audio).mode === 'follow') {
    bits.push(`入场与上一段音频等功率交叠 ${trIn.duration.toFixed(2)} s`);
  }
  if (trOut?.type === 'dissolve' && normalizeAudio(trOut.audio).mode === 'follow') {
    bits.push(`出场与下一段音频等功率交叠 ${trOut.duration.toFixed(2)} s`);
  }
  if (trIn && normalizeAudio(trIn.audio).mode === 'switch') {
    const st = clamp(trIn.audio.switchTime ?? trIn.start, trIn.start, trIn.end);
    bits.push(`在 ${st.toFixed(2)} s 由静音切入`);
  }
  if (prev && !prev.clip.hasAudio) bits.push(`上一段无音轨，前 ${opts.missingAudioFade.toFixed(2)} s 由静音平滑进入`);
  if (next && !next.clip.hasAudio) bits.push(`下一段无音轨，平滑淡出到静音`);
  if (shortAudio) bits.push(`音频比画面短 ${(row.end - span.end).toFixed(2)} s，结束前 ${opts.missingAudioFade.toFixed(2)} s 淡出到静音`);
  if (span.duration + EPS < clipLength(row.clip) && !shortAudio) {
    bits.push(`可用音频 ${span.duration.toFixed(2)} s < 画面 ${clipLength(row.clip).toFixed(2)} s`);
  }
  return bits.join('；');
}

export function gainAt(points, t) {
  if (!points || !points.length) return 0;
  if (t <= points[0][0] || t >= points[points.length - 1][0]) return 0;
  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid][0] <= t) lo = mid; else hi = mid;
  }
  const [t0, g0] = points[lo];
  const [t1, g1] = points[hi];
  if (t1 - t0 < EPS) return g1;
  return clamp(g0 + ((g1 - g0) * (t - t0)) / (t1 - t0), 0, 1);
}

export function planGainAt(plan, t) {
  let sum = 0;
  for (const span of plan) sum += gainAt(span.points, t);
  return sum;
}

export function sourceTimeAt(span, t) {
  return span.srcOffset + (t - span.start);
}

// 转场音频的说明与告警（给检查面板）。
export function audioTransitionPlan(timeline, tr, project = {}) {
  const audio = normalizeAudio(tr.audio);
  const a = timeline.clips[tr.a];
  const b = timeline.clips[tr.b];
  const fadeMissing = project.missingAudioFade ?? DEFAULTS.missingAudioFade;
  const aAudio = clipAudioDuration(a.clip);
  const bAudio = clipAudioDuration(b.clip);
  const win = switchWindow(tr);
  const details = [];
  let switchAt = null;

  if (audio.mode === 'mute') {
    details.push(`转场处静音：${tr.type === 'dissolve'
      ? `叠化窗口 ${tr.start.toFixed(2)}–${tr.end.toFixed(2)} s 内两侧收到静音，窗口后右源再进入。`
      : `在切点 ${tr.cutAt.toFixed(2)} s 静音切换。`}`);
  } else if (audio.mode === 'switch') {
    switchAt = clamp(audio.switchTime ?? win[0], win[0], win[1]);
    details.push(tr.type === 'dissolve'
      ? `在交叠窗口 ${win[0].toFixed(2)}–${win[1].toFixed(2)} s 内选 ${switchAt.toFixed(2)} s 定点切换：左源淡出、右源淡入。`
      : `硬切无交叠窗口，音频在切点 ${switchAt.toFixed(2)} s 切换。`);
  } else if (tr.type === 'dissolve') {
    details.push(`音频跟随画面等功率交叠 ${tr.duration.toFixed(2)} s（${tr.start.toFixed(2)} – ${tr.end.toFixed(2)} s）。`);
  } else {
    details.push('硬切时音频在切点切换（带极短去咔哒斜坡）。');
  }

  if (!a.clip.hasAudio && b.clip.hasAudio) {
    details.push(`左段无音轨；右段在 ${fadeMissing.toFixed(2)} s 内由静音平滑淡入。`);
  } else if (a.clip.hasAudio && !b.clip.hasAudio) {
    details.push('右段无音轨；左段平滑淡出到静音。');
  } else if (!a.clip.hasAudio && !b.clip.hasAudio) {
    details.push('两侧均无音轨，转场处保持静音。');
  }

  return {
    mode: audio.mode,
    switchAt,
    switchWindow: win,
    boundary: tr.cutAt,
    overlap: [tr.start, tr.end],
    aAudioDuration: aAudio,
    bAudioDuration: bAudio,
    details,
    warnings: [
      a.clip.hasAudio && aAudio + EPS < clipLength(a.clip)
        ? `左段音频只有 ${aAudio.toFixed(2)} s，短于其画面 ${clipLength(a.clip).toFixed(2)} s；不足处平滑淡为静音。` : null,
      b.clip.hasAudio && bAudio + EPS < clipLength(b.clip)
        ? `右段音频只有 ${bAudio.toFixed(2)} s，短于其画面 ${clipLength(b.clip).toFixed(2)} s；不足处平滑淡为静音。` : null,
    ].filter(Boolean),
  };
}
