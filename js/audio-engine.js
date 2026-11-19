// audio-engine.js — 非破坏性音频处理引擎（纯函数，无 DOM 依赖）。
//
// 设计原则：原始 PCM（source）永不被改写。界面上的每一步操作都是一个 op 描述对象，
// 渲染波形、回放与导出时统一调用 applyOps(source, ops) 从原始数据重新计算，
// 因此修改/删除/旁路任意步骤都能回到原始状态，也不会产生反复处理的累积失真。

export const OP_TYPES = {
  cut: { label: '剪切（删除选区）', hasGain: false },
  mute: { label: '静音选区', hasGain: false },
  gain: { label: '增益', hasGain: true },
  fadeIn: { label: '淡入', hasGain: true },
  fadeOut: { label: '淡出', hasGain: true },
  normalize: { label: '音量归一化', hasGain: true },
};

let opSeq = 1;
export function createOp(type, start, end, params = {}) {
  if (!OP_TYPES[type]) throw new Error(`未知操作类型: ${type}`);
  const op = {
    id: `op-${Date.now().toString(36)}-${opSeq++}`,
    type,
    start, // 秒，始终锚定【原始未剪切时间线】（由 app 层在创建时从界面坐标换算）
    end,
    enabled: true,
    note: '',
  };
  if (type === 'gain') op.gainDb = params.gainDb ?? 0;
  if (type === 'fadeIn' || type === 'fadeOut') op.curve = params.curve || 'linear';
  if (type === 'normalize') {
    op.targetDb = params.targetDb ?? -1;
    op.measured = null; // 执行时记录的实测峰值，用于界面展示处理前后变化
  }
  return op;
}

const toDb = (v) => (v > 0 ? 20 * Math.log10(v) : -Infinity);
const dbToGain = (db) => Math.pow(10, db / 20);

/** 线性插值采样点索引对应的时间（秒） */
export function sampleToTime(i, sampleRate) {
  return i / sampleRate;
}
export function timeToSample(t, sampleRate) {
  return Math.round(t * sampleRate);
}

export function formatTime(seconds) {
  if (!isFinite(seconds)) return '--:--.---';
  const neg = seconds < 0;
  // 先换算成整数毫秒再拆分，避免毫秒四舍五入到 1000 时秒/分不进位
  const totalMs = Math.round(Math.abs(seconds) * 1000);
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${neg ? '-' : ''}${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
}

export function formatDb(db) {
  if (db === -Infinity) return '-∞ dB';
  // 归一化 -0：接近 0 的微小负值显示为 0.00 而不是 -0.00
  const v = Math.abs(db) < 0.005 ? 0 : db;
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)} dB`;
}

/** 计算电平统计：每声道峰值（线性/dB）、RMS（dB）、是否全静音、总时长、是否含非法值 */
export function computeStats(channels, sampleRate) {
  let nanCount = 0;
  const perChannel = channels.map((data) => {
    let peak = 0;
    let sumSq = 0;
    for (let i = 0; i < data.length; i++) {
      const v = data[i];
      if (!Number.isFinite(v)) { nanCount++; continue; } // NaN/Infinity 不计入电平
      const a = Math.abs(v);
      if (a > peak) peak = a;
      sumSq += v * v;
    }
    const rms = Math.sqrt(sumSq / Math.max(1, data.length));
    return { peak, peakDb: toDb(peak), rmsDb: toDb(rms) };
  });
  const globalPeak = perChannel.reduce((m, c) => Math.max(m, c.peak), 0);
  return {
    perChannel,
    globalPeak,
    globalPeakDb: toDb(globalPeak),
    isSilent: globalPeak === 0,
    hasInvalidSamples: nanCount > 0,
    invalidCount: nanCount,
    duration: channels.length ? channels[0].length / sampleRate : 0,
    numFrames: channels.length ? channels[0].length : 0,
    sampleRate,
    numChannels: channels.length,
  };
}

function cloneChannels(channels) {
  return channels.map((c) => c.slice());
}

function fadeCoefficient(type, progress, curve) {
  if (curve === 'equalPower') {
    // 等功率（余弦）曲线：淡入 0→1，淡出 1→0
    return type === 'fadeIn'
      ? Math.cos(((1 - progress) * Math.PI) / 2)
      : Math.cos((progress * Math.PI) / 2);
  }
  return type === 'fadeIn' ? progress : 1 - progress;
}

/**
 * 把处理链按顺序应用到原始 PCM 上，返回全新的平面声道数组。
 *
 * 坐标模型：所有 op 的 start/end 都锚定在【原始未剪切时间线】（见 createOp 注释）。
 * 实现上先在与源等长的缓冲上按顺序处理所有非剪切操作，剪切区间用"保留掩码"收集，
 * 最后一次性移除被删帧。这样：
 *  - 剪切的旁路/重排/编辑/删除都不影响其他 op 的坐标（它们始终引用原始时间）；
 *  - 非剪切 op 的相对处理顺序仍然严格保留（归一化等顺序敏感操作语义不变）；
 *  - 任何一步都不会修改输入。
 */
export function applyOps(sourceChannels, sampleRate, ops) {
  const totalFrames = sourceChannels[0].length;
  const keep = buildKeepMask(ops, totalFrames, sampleRate);
  const channels = applyNonCutOps(sourceChannels, sampleRate, ops, keep);
  return removeCutFrames(channels, keep);
}

/** 构造保留掩码：keep[i]=0 表示第 i 帧落在某个启用的剪切区间内。 */
export function buildKeepMask(ops, totalFrames, sampleRate) {
  const clampFrame = (f) => Math.max(0, Math.min(totalFrames, f));
  const keep = new Uint8Array(totalFrames).fill(1);
  for (const op of ops) {
    if (!op.enabled || op.type !== 'cut') continue;
    const s0 = clampFrame(timeToSample(op.start, sampleRate));
    const s1 = Math.max(s0, clampFrame(timeToSample(op.end, sampleRate)));
    for (let i = s0; i < s1; i++) keep[i] = 0; // 重叠/相邻剪切由掩码自然合并
  }
  return keep;
}

/**
 * 在与源等长的缓冲上按顺序应用所有非剪切操作，返回新缓冲（不移除任何帧）。
 * 传入 keep 后，归一化统计会跳过将被剪切的帧，保证预览与最终结果一致。
 */
export function applyNonCutOps(sourceChannels, sampleRate, ops, keep = null) {
  const totalFrames = sourceChannels[0].length;
  const channels = cloneChannels(sourceChannels);
  const clampFrame = (f) => Math.max(0, Math.min(totalFrames, f));

  for (const op of ops) {
    if (!op.enabled || op.type === 'cut') continue;
    const s0 = clampFrame(timeToSample(op.start, sampleRate));
    const s1 = Math.max(s0, clampFrame(timeToSample(op.end, sampleRate)));

    switch (op.type) {
      case 'mute':
        for (const data of channels) data.fill(0, s0, s1);
        break;
      case 'gain': {
        const g = dbToGain(op.gainDb ?? 0);
        for (const data of channels) {
          for (let i = s0; i < s1; i++) data[i] *= g;
        }
        break;
      }
      case 'fadeIn':
      case 'fadeOut': {
        const len = s1 - s0;
        if (len <= 1) break;
        for (const data of channels) {
          for (let i = s0; i < s1; i++) {
            const k = fadeCoefficient(op.type, (i - s0) / (len - 1), op.curve);
            data[i] *= k;
          }
        }
        break;
      }
      case 'normalize': {
        let peak = 0;
        for (const data of channels) {
          for (let i = s0; i < s1; i++) {
            if (keep && !keep[i]) continue; // 跳过将被剪切的帧
            const a = Math.abs(data[i]);
            if (a > peak) peak = a;
          }
        }
        if (peak === 0) break; // 全静音区间：无法归一化，保持原样
        const gain = Math.min(1, dbToGain(op.targetDb)) / peak;
        for (const data of channels) {
          for (let i = s0; i < s1; i++) data[i] *= gain;
        }
        break;
      }
      default:
        break;
    }
  }
  return channels;
}

/** 按保留掩码把被剪切的帧一次性移除，返回新的平面声道数组 */
function removeCutFrames(channels, keep) {
  const total = keep.length;
  let kept = 0;
  for (let i = 0; i < total; i++) if (keep[i]) kept++;
  if (kept === total) return channels; // 没有任何启用的剪切
  return channels.map((data) => {
    const out = new Float32Array(kept);
    let w = 0;
    for (let i = 0; i < total; i++) {
      if (keep[i]) out[w++] = data[i];
    }
    return out;
  });
}

/**
 * 归一化预览：在当前处理链（含已启用剪切）的结果上，计算原始坐标区间 [start,end] 内、
 * 实际保留（未被剪切）采样的实测峰值与建议增益，不修改数据。全静音返回 silent 标志。
 */
export function planNormalize(sourceChannels, sampleRate, ops, start, end, targetDb) {
  // 复用 applyOps 的同一条处理路径，但在移除剪切帧之前统计，以便用原始坐标定位区间
  const totalFrames = sourceChannels[0].length;
  const keep = buildKeepMask(ops, totalFrames, sampleRate);
  const rendered = applyNonCutOps(sourceChannels, sampleRate, ops);
  const s0 = Math.max(0, Math.min(totalFrames, timeToSample(start, sampleRate)));
  const s1 = Math.max(s0, Math.min(totalFrames, timeToSample(end, sampleRate)));
  let peak = 0;
  let frames = 0;
  for (const data of rendered) {
    for (let i = s0; i < s1; i++) {
      if (!keep[i]) continue; // 被剪切的帧不计入
      frames++;
      const a = Math.abs(data[i]);
      if (a > peak) peak = a;
    }
  }
  const targetGain = Math.min(1, dbToGain(targetDb)); // 目标不允许超过 0 dBFS，避免削波
  if (peak === 0) {
    return {
      silent: true,
      measuredPeak: 0,
      measuredPeakDb: -Infinity,
      targetDb,
      gain: 0,
      gainDb: -Infinity,
    };
  }
  const gain = targetGain / peak;
  return {
    silent: false,
    measuredPeak: peak,
    measuredPeakDb: toDb(peak),
    targetDb,
    gain,
    gainDb: toDb(gain),
    frames,
  };
}

// ============================================================================
// 时间线坐标模型
//
// 所有 op.start/end 与 marker.time 都存储【原始未剪切时间线】上的坐标。
// 界面上看到的"当前时间线"是原始时间线移除所有启用剪切区间后的结果。
// 因此剪切的增删改、旁路、重排都不需要改动任何其他 op/标记的坐标——
// 只需要在"原始坐标"与"当前显示坐标"之间做纯函数换算即可。
// ============================================================================

/** 取出所有启用的剪切区间（秒，原始时间线），并合并重叠/相邻区间，按起点排序。 */
export function activeCutIntervals(ops) {
  const raw = ops
    .filter((o) => o.enabled && o.type === 'cut' && o.end > o.start)
    .map((o) => ({ start: o.start, end: o.end }))
    .sort((a, b) => a.start - b.start);
  const merged = [];
  for (const iv of raw) {
    const last = merged[merged.length - 1];
    if (last && iv.start <= last.end) {
      last.end = Math.max(last.end, iv.end); // 重叠或相邻 → 合并
    } else {
      merged.push({ ...iv });
    }
  }
  return merged;
}

/**
 * 原始时间线时间 → 当前时间线时间（移除启用剪切后）。
 * 落在剪切区间内的时间吸附到该区间在当前时间线上的起点（该帧已被删除）。
 */
export function originalToCurrentTime(t, cuts) {
  let removed = 0;
  for (const c of cuts) {
    if (t < c.start) break;
    if (t >= c.end) {
      removed += c.end - c.start;
    } else {
      // t 落在剪切区间内：吸附到该区间起点对应的当前时间
      return Math.max(0, c.start - removed);
    }
  }
  return Math.max(0, t - removed);
}

/**
 * 当前时间线时间 → 原始时间线时间（用户在界面上选区/定位时用）。
 * 永远返回一个未被剪切的有效原始时间；界面时间不会落到被删区间内部。
 * 做法：沿剪切区间逐个补偿已删时长，直到当前时间落在某剪切起点之前。
 */
export function currentToOriginalTime(t, cuts) {
  let removed = 0;
  for (const c of cuts) {
    const cutStartOnTimeline = c.start - removed;
    if (t < cutStartOnTimeline) break;
    removed += c.end - c.start;
  }
  return t + removed;
}

/** 判断某个原始时间点是否落在启用的剪切区间内（用于过滤标记显示）。 */
export function isInCut(originalTime, cuts) {
  return cuts.some((c) => originalTime >= c.start && originalTime < c.end);
}

/** 当前（移除启用剪切后）时间线的总时长。 */
export function currentDuration(originalDuration, cuts) {
  const removed = cuts.reduce((sum, c) => sum + (c.end - c.start), 0);
  return Math.max(0, originalDuration - removed);
}

/**
 * 把一组标记（原始坐标）换算为当前时间线上的可见标记。
 * 落在剪切区间内的标记随被删音频一起隐藏；其余标记换算为当前时间。
 */
export function visibleMarkers(markers, cuts) {
  const out = [];
  for (const m of markers) {
    if (isInCut(m.time, cuts)) continue;
    out.push({ ...m, currentTime: originalToCurrentTime(m.time, cuts) });
  }
  return out;
}
