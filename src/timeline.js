// 时间线：把「每段截取 + 转场」解析成统一时间线上的位置、时长与取样。
import {
  EPS, DEFAULTS, clamp, clipLength, fpsOf,
  secondsToFrame, frameToSeconds,
} from './model.js';

export function projectFps(project) {
  return project?.fps || DEFAULTS.fps;
}

// 把秒对齐到某个帧率的帧边界（四舍五入）。
export function snapToFrames(sec, fps) {
  return Math.round(sec * fps) / fps;
}

function floorToFrame(sec, fps) {
  return Math.floor(sec * fps + EPS) / fps;
}

// 解析叠化时长。
// 约束：对每段 b，入口叠化 D[b-1] 与出口叠化 D[b] 之和 <= len(b)，即一段素材不能把同一批
// 帧同时借给左右两处叠化。超限时按「先收出口、再收入口」缩短并向左传播，最后对齐到帧。
export function resolveDissolves(clips, transitions, fps = DEFAULTS.fps) {
  const n = clips.length;
  const lens = clips.map(clipLength);
  const requested = transitions.map((t) =>
    (t.type === 'dissolve' ? Math.max(0, Number(t.duration) || 0) : 0));
  const pre = requested.slice();

  for (let pass = 0; pass < n * 2 + 4; pass++) {
    let changed = false;
    for (let b = 0; b < n; b++) {
      const inIdx = b - 1;
      const outIdx = b; // 出口叠化即 transitions[b]
      const din = inIdx >= 0 ? pre[inIdx] : 0;
      const dout = outIdx <= n - 2 ? pre[outIdx] : 0;
      if (din + dout <= lens[b] + EPS) continue;
      let excess = din + dout - lens[b];
      if (outIdx <= n - 2 && pre[outIdx] > EPS) {
        const take = Math.min(pre[outIdx], excess);
        pre[outIdx] -= take;
        excess -= take;
        if (take > EPS) changed = true;
      }
      if (excess > EPS && inIdx >= 0 && pre[inIdx] > EPS) {
        const take = Math.min(pre[inIdx], excess);
        pre[inIdx] -= take;
        excess -= take;
        if (take > EPS) changed = true;
      }
    }
    if (!changed) break;
  }

  const durations = pre.map((d, i) => (requested[i] <= EPS ? 0 : floorToFrame(d, fps)));

  const issues = [];
  for (let k = 0; k < durations.length; k++) {
    const req = requested[k];
    if (req <= EPS) continue;
    const act = durations[k];
    if (act >= req - EPS) continue;

    const a = k;
    const b = k + 1;
    const dinA = k > 0 ? pre[k - 1] : 0;
    const doutB = k + 1 <= n - 2 ? pre[k + 1] : 0;
    const roomA = Math.max(0, lens[a] - dinA);
    const roomB = Math.max(0, lens[b] - doutB);

    if (pre[k] >= req - EPS) {
      // 没有被可用画面限制，只是对齐到整帧
      const frames = Math.max(0, Math.floor(req * fps + EPS));
      issues.push({
        transitionIndex: k,
        code: 'snap',
        requested: req,
        actual: act,
        message: frames === 0
          ? `叠化 ${k + 1} 请求 ${req.toFixed(3)} s 不足一帧（${fps} fps），无法使用；请加大叠化或改用硬切。`
          : `叠化 ${k + 1} 已对齐到 ${frames} 帧（${act.toFixed(3)} s），未改变画面范围。`,
      });
      continue;
    }

    const why = [];
    if (req > lens[a] + EPS) {
      why.push(`左侧片段 ${a + 1} 只截取了 ${lens[a].toFixed(2)} s`);
    }
    if (req > lens[b] + EPS) {
      why.push(`右侧片段 ${b + 1} 只截取了 ${lens[b].toFixed(2)} s`);
    }
    if (dinA > EPS) {
      why.push(`片段 ${a + 1} 入口叠化已占 ${dinA.toFixed(2)} s，其出口叠化最多再让出 ${roomA.toFixed(2)} s`);
    }
    if (doutB > EPS) {
      why.push(`片段 ${b + 1} 出口叠化已占 ${doutB.toFixed(2)} s，其入口叠化最多再让出 ${roomB.toFixed(2)} s`);
    }
    if (!why.length) {
      why.push(`两侧可用画面合计只支持 ${act.toFixed(2)} s`);
    }
    issues.push({
      transitionIndex: k,
      code: 'clamped',
      requested: req,
      actual: act,
      roomA,
      roomB,
      message: `叠化 ${k + 1} 请求 ${req.toFixed(2)} s，实际只能用 ${act.toFixed(2)} s：`
        + why.join('；')
        + '。叠化只取两边入点 / 出点之间的画面，不向外借帧。',
    });
  }

  return { durations, requested, issues };
}

// 当前设置下，该处叠化在不改动其它转场的前提下最多能用多久。
export function maxDissolveAt(project, index) {
  const clips = project.clips || [];
  const fps = projectFps(project);
  const n = clips.length;
  if (index < 0 || index >= n - 1) return 0;
  const tl = buildTimeline(project);
  const a = tl.clips[index];
  const b = tl.clips[index + 1];
  const din = index > 0 ? tl.transitions[index - 1]?.duration || 0 : 0;
  const dout = index < n - 2 ? tl.transitions[index + 1]?.duration || 0 : 0;
  const roomA = Math.max(0, clipLength(a.clip) - din);
  const roomB = Math.max(0, clipLength(b.clip) - dout);
  return floorToFrame(Math.max(0, Math.min(roomA, roomB)), fps);
}

export function buildTimeline(project) {
  const clips = project.clips || [];
  const transitions = project.transitions || [];
  const fps = projectFps(project);
  const resolved = resolveDissolves(clips, transitions, fps);
  const durations = resolved.durations;

  const rows = [];
  let cursor = 0;
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const len = clipLength(clip);
    const start = cursor;
    const end = start + len;
    rows.push({
      index: i,
      clip,
      id: clip.id,
      name: clip.name,
      srcIn: clip.srcIn,
      srcOut: clip.srcOut,
      srcFps: fpsOf(clip),
      len,
      start,
      end,
      frameCount: Math.round(len * fps),
      sourceFrameIn: Math.round(clip.srcIn * fpsOf(clip)),
      sourceFrameOut: Math.round(clip.srcOut * fpsOf(clip)),
    });
    cursor = end - (i < clips.length - 1 ? durations[i] : 0);
  }

  const hardCutTotal = clips.reduce((sum, c) => sum + clipLength(c), 0);
  const dissolveTotal = durations.reduce((a, b) => a + b, 0);

  const transitionRows = transitions.map((t, k) => {
    const a = rows[k];
    const b = rows[k + 1];
    if (!a || !b) return null;
    const d = durations[k] || 0;
    const isDissolve = t.type === 'dissolve' && d > EPS;
    const cutAt = a.end;
    const start = isDissolve ? b.start : cutAt;
    const end = isDissolve ? start + d : cutAt;
    return {
      index: k,
      a: a.index,
      b: b.index,
      type: isDissolve ? 'dissolve' : 'cut',
      requestedType: t.type,
      requested: resolved.requested[k] || 0,
      duration: d,
      start,
      end,
      cutAt,
      audio: t.audio || { mode: 'follow' },
      issues: resolved.issues.filter((m) => m.transitionIndex === k),
    };
  }).filter(Boolean);

  return {
    fps,
    clips: rows,
    transitions: transitionRows,
    duration: Math.max(0, cursor),
    hardCutTotal,
    dissolveTotal,
    issues: resolved.issues,
  };
}

function lastFrameOf(row) {
  return Math.max(0, Math.ceil(row.srcOut * row.srcFps - 1e-6) - 1);
}

function sourceLayer(row, time, weight, fps, layer) {
  const local = clamp(time - row.start, 0, Math.max(0, row.len - 1e-9));
  const srcTime = clamp(row.srcIn + local, row.srcIn, Math.max(row.srcIn, row.srcOut - 1e-9));
  const srcFps = row.srcFps;
  const firstFrame = Math.round(row.srcIn * srcFps);
  const lastFrame = lastFrameOf(row);
  const frame = clamp(Math.floor(srcTime * srcFps + 1e-6), firstFrame, lastFrame);
  return {
    clipIndex: row.index,
    layer,
    weight,
    srcTime,
    frame,
    fps: srcFps,
    frameCenter: clamp((frame + 0.5) / srcFps, row.srcIn, row.srcOut),
    timelineTime: time,
    outFps: fps,
  };
}

// 统一时间 t 落在哪些片段上（叠化时两层）。返回按绘制顺序（后画在上）的图层。
export function videoLayersAt(timeline, t) {
  const { fps } = timeline;
  if (!timeline.clips.length) return [];
  const time = clamp(t, 0, Math.max(0, timeline.duration - 1e-9));
  for (const tr of timeline.transitions) {
    if (tr.type !== 'dissolve') continue;
    if (time >= tr.start - EPS && time < tr.end - EPS) {
      const a = timeline.clips[tr.a];
      const b = timeline.clips[tr.b];
      const alpha = clamp((time - tr.start) / tr.duration, 0, 1);
      return [
        sourceLayer(a, time, 1 - alpha, fps, 'left'),
        sourceLayer(b, time, alpha, fps, 'right'),
      ];
    }
  }
  let chosen = timeline.clips[timeline.clips.length - 1];
  for (const c of timeline.clips) {
    if (time >= c.start - EPS && time < c.end - EPS) { chosen = c; break; }
  }
  return chosen ? [sourceLayer(chosen, time, 1, fps, 'single')] : [];
}

export function transitionContaining(timeline, t) {
  return timeline.transitions.find((tr) => t >= tr.start - EPS && t <= tr.end + EPS) || null;
}

// 转场两侧在统一时间 t 实际取到的帧（无论此刻是否处于叠化窗口内都给出取样）。
export function transitionFramesAt(timeline, tr, t) {
  const a = timeline.clips[tr.a];
  const b = timeline.clips[tr.b];
  const time = clamp(t, 0, timeline.duration);
  const alpha = tr.type === 'dissolve' && tr.duration > EPS
    ? clamp((time - tr.start) / tr.duration, 0, 1)
    : null;
  return {
    alpha,
    left: sourceLayer(a, time, alpha == null ? 1 : 1 - alpha, timeline.fps, 'left'),
    right: sourceLayer(b, time, alpha == null ? 1 : alpha, timeline.fps, 'right'),
    boundary: {
      aStart: a.start,
      aEnd: a.end,
      bStart: b.start,
      cutAt: tr.cutAt,
      windowStart: tr.start,
      windowEnd: tr.end,
    },
  };
}

export function clipAt(timeline, index) {
  return timeline.clips[index];
}

export function frameAtTime(sec, fps) {
  return secondsToFrame(sec, fps);
}

export function timeOfFrame(frame, fps) {
  return frameToSeconds(frame, fps);
}

// 叠化时长的占用摘要：硬切总长、叠化总量、成片长度、省掉多少。
export function dissolveBudget(timeline) {
  const hard = timeline.hardCutTotal;
  const final = timeline.duration;
  const used = timeline.dissolveTotal;
  return {
    hardCutTotal: hard,
    finalDuration: final,
    dissolveTotal: used,
    saved: hard - final,
    percentOfHard: hard > 0 ? (used / hard) * 100 : 0,
    percentOfFinal: final > 0 ? (used / final) * 100 : 0,
    count: timeline.transitions.filter((tr) => tr.type === 'dissolve').length,
    audioOverlapTotal: timeline.transitions.reduce((sum, tr) => {
      if (tr.type !== 'dissolve') return sum;
      if (tr.audio?.mode === 'mute') return sum;
      return sum + tr.duration;
    }, 0),
  };
}
