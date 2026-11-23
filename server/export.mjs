// 导出与成片复检。
//
// 视频：按统一时间线拼接；叠化用 xfade（fade），硬切用 concat。每段先按入点/出点
//       精确裁剪，再统一到项目帧率、画幅。
// 音频：用共享的音频编排混成整轨 WAV，再与视频封装，保证试听与成片一致。
// 复检：独立地从成片里取帧，解出条码帧号与标记色块，量叠化的 alpha 起止；并从成片
//       音频里测起始频率，验证没有把素材片头多播一遍。
import path from 'node:path';
import fs from 'node:fs/promises';
import { FFMPEG, FFPROBE, run, EXPORT_DIR, SAMPLE_DIR, MEDIA_DIR } from './util.mjs';
import { buildTimeline, projectFps } from '../src/timeline.js';
import { mixWindow, encodeWav } from './audio-mix.mjs';
import { normalizeProject } from '../src/project.js';
import { clipLength, clipAudioDuration } from '../src/model.js';
import { SAMPLE_SPECS, patchAlpha, toneFrequencyAt } from '../src/samples.js';

const PATCH = { x: 522, y: 18, w: 64, h: 64 };
const BAR = { bits: 16, cell: 22, x: 18, y: 312, h: 30 };

function safeId(s) {
  return String(s || '').replace(/[^a-zA-Z0-9_-]/g, '');
}

export function resolveSource(src) {
  const base = path.basename(String(src || ''));
  const inSamples = path.join(SAMPLE_DIR, base);
  const inMedia = path.join(MEDIA_DIR, base);
  return { inSamples, inMedia, base };
}

async function existingSource(src) {
  const { inSamples, inMedia } = resolveSource(src);
  for (const p of [inSamples, inMedia]) {
    try { await fs.access(p); return p; } catch { /* keep */ }
  }
  throw new Error(`source not found: ${path.basename(String(src || ''))}`);
}

function buildVideoGraph(project, timeline, sourcePaths) {
  const fps = projectFps(project);
  const W = project.width || 960;
  const H = project.height || 540;
  const filters = [];
  const inputs = [];

  timeline.clips.forEach((row, i) => {
    inputs.push({ path: sourcePaths[i], srcIn: row.srcIn, len: row.len });
    filters.push(
      `[${i}:v]trim=start=${row.srcIn.toFixed(4)}:end=${row.srcOut.toFixed(4)},` +
      `setpts=PTS-STARTPTS,fps=${fps},` +
      `scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
      `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p[v${i}]`,
    );
  });

  let cur = 'v0';
  let curDur = timeline.clips[0] ? clipLength(timeline.clips[0]) : 0;
  let node = 0;
  for (let k = 0; k < timeline.transitions.length; k++) {
    const tr = timeline.transitions[k];
    const next = `v${k + 1}`;
    const out = `c${node++}`;
    if (tr.type === 'dissolve') {
      const offset = Math.max(0, curDur - tr.duration);
      filters.push(
        `[${cur}][${next}]xfade=transition=fade:duration=${tr.duration.toFixed(4)}:offset=${offset.toFixed(4)}[${out}]`,
      );
      curDur = curDur + clipLength(timeline.clips[k + 1]) - tr.duration;
    } else {
      filters.push(`[${cur}][${next}]concat=n=2:v=1:a=0[${out}]`);
      curDur = curDur + clipLength(timeline.clips[k + 1]);
    }
    cur = out;
  }
  return { filters, inputs, outLabel: cur, width: W, height: H, fps };
}

export async function renderProject(rawProject, { onProgress = () => {} } = {}) {
  const project = normalizeProject(rawProject);
  const timeline = buildTimeline(project);
  if (!project.clips.length) throw new Error('没有素材可导出');
  await fs.mkdir(EXPORT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const id = `export-${stamp}-${Math.random().toString(36).slice(2, 6)}`;
  const outPath = path.join(EXPORT_DIR, `${id}.mp4`);
  const wavPath = path.join(EXPORT_DIR, `${id}.wav`);
  const metaPath = path.join(EXPORT_DIR, `${id}.json`);

  const sources = [];
  for (const c of project.clips) sources.push(await existingSource(c.src));

  onProgress({ stage: 'audio', percent: 5 });
  const mixed = await mixWindow(project, timeline, 0, timeline.duration);
  await fs.writeFile(wavPath, encodeWav(mixed.samples, mixed.sampleRate));
  onProgress({ stage: 'video', percent: 25 });

  const graph = buildVideoGraph(project, timeline, sources);
  const args = [];
  for (let i = 0; i < graph.inputs.length; i++) {
    args.push('-i', graph.inputs[i].path);
  }
  args.push('-i', wavPath);
  args.push(
    '-filter_complex', graph.filters.join(';'),
    '-map', `[${graph.outLabel}]`,
    '-map', `${sources.length}:a`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-r', String(graph.fps),
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-t', timeline.duration.toFixed(4),
    '-movflags', '+faststart',
    '-y', outPath,
  );
  await run(FFMPEG, args);
  onProgress({ stage: 'verify', percent: 75 });

  const meta = {
    id,
    file: path.basename(outPath),
    wav: path.basename(wavPath),
    createdAt: new Date().toISOString(),
    // 保存完整工程状态，复检 / 重新导出都靠它还原
    project,
    timeline: {
      duration: timeline.duration,
      hardCutTotal: timeline.hardCutTotal,
      dissolveTotal: timeline.dissolveTotal,
      clips: timeline.clips.map((r) => ({ index: r.index, start: r.start, end: r.end, len: r.len, srcIn: r.srcIn, srcOut: r.srcOut })),
      transitions: timeline.transitions.map((t) => ({ index: t.index, type: t.type, duration: t.duration, start: t.start, end: t.end, cutAt: t.cutAt })),
    },
  };
  await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));
  onProgress({ stage: 'verify', percent: 85 });
  const report = await verifyExport({ ...meta, filePath: outPath }, project, timeline);
  meta.report = report;
  await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));
  onProgress({ stage: 'done', percent: 100 });
  return { ...meta, report, path: outPath, wavPath };
}

// ---------- 复检工具 ----------

async function probe(file) {
  const { stdout } = await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const j = JSON.parse(stdout.toString());
  const v = (j.streams || []).find((s) => s.codec_type === 'video');
  const a = (j.streams || []).find((s) => s.codec_type === 'audio');
  return {
    duration: Number(j.format?.duration) || 0,
    hasAudio: Boolean(a),
    fps: v ? (() => { const [x, y] = String(v.avg_frame_rate).split('/').map(Number); return y ? x / y : x; })() : 0,
    frames: Number(v?.nb_frames) || 0,
    width: Number(v?.width) || 0,
    height: Number(v?.height) || 0,
  };
}

// 取一帧并缩到 1x1 的 rgb24，作为该区域平均颜色。
// 注意：-ss 放在 -i 之后，逐帧解码到精确时间点，避免关键帧取整。
async function sampleColor(file, t, rect) {
  const { stdout } = await run(FFMPEG, [
    '-v', 'error', '-i', file, '-ss', String(Math.max(0, t)), '-frames:v', '1',
    '-vf', `crop=${rect.w}:${rect.h}:${rect.x}:${rect.y},scale=1:1:flags=area`,
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
  ]);
  const b = stdout;
  return [b[0] ?? 0, b[1] ?? 0, b[2] ?? 0];
}

// 取条码区域一行，解出每格平均亮度，得到 16 bit 源帧号。
async function readBarcode(file, t, scaleX, scaleY) {
  const x = Math.round(BAR.x * scaleX);
  const y = Math.round(BAR.y * scaleY);
  const w = Math.round(BAR.bits * BAR.cell * scaleX);
  const h = Math.round(BAR.h * scaleY);
  const { stdout } = await run(FFMPEG, [
    '-v', 'error', '-i', file, '-ss', String(Math.max(0, t)), '-frames:v', '1',
    '-vf', `crop=${w}:${h}:${x}:${y},scale=${BAR.bits}:1:flags=area`,
    '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1',
  ]);
  if (stdout.length < BAR.bits) return null;
  // 白格 ≈ 0.45 白 + 0.55 黑底，灰阶约 110–130；黑格 ≈ 25–60。用中点阈值区分。
  const values = [...stdout.subarray(0, BAR.bits)];
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const threshold = (lo + hi) / 2;
  let value = 0;
  for (let k = 0; k < BAR.bits; k++) {
    if (values[k] > threshold) value += 2 ** k;
  }
  return value;
}

function patchRectIn(width, height) {
  const sx = width / 640;
  const sy = height / 360;
  return {
    x: Math.round(PATCH.x * sx), y: Math.round(PATCH.y * sy),
    w: Math.max(2, Math.round(PATCH.w * sx)), h: Math.max(2, Math.round(PATCH.h * sy)),
    sx, sy,
  };
}

// 从片段的音频可用区间里剔除与相邻片段音频交叠的部分，返回一个只含本段音频的窗口。
function cleanAudioWindow(timeline, row) {
  const dur = clipAudioDuration(row.clip);
  if (dur <= 0) return null;
  let lo = row.start;
  let hi = row.start + dur;
  const prev = timeline.transitions[row.index - 1];
  const next = timeline.transitions[row.index];
  if (prev && prev.type === 'dissolve') lo = Math.max(lo, prev.end);
  if (next && next.type === 'dissolve') hi = Math.min(hi, next.start);
  if (hi <= lo) return null;
  // 边界各留 0.11 s 缓冲，避开斜坡
  const pad = 0.11;
  lo += pad;
  hi -= pad;
  return hi > lo ? [lo, hi] : null;
}

function sampleSpecOf(clip) {
  const src = String(clip?.src || '');
  return SAMPLE_SPECS.find((s) => src.includes(s.fileName)) || null;
}

async function audioSamples(file, duration, sr = 48000) {
  try {
    const { stdout } = await run(FFMPEG, [
      '-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(sr), '-f', 'f32le', 'pipe:1',
    ], { maxBuffer: 512 * 1024 * 1024 });
    const arr = new Float32Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.byteLength / 4));
    return { samples: arr, sr, duration };
  } catch {
    return null;
  }
}

function goertzel(samples, sr, freq, start, length) {
  const N = Math.min(length, samples.length - start);
  if (N <= 0) return 0;
  const k = 2 * Math.PI * freq / sr;
  const coeff = 2 * Math.cos(k);
  let s0 = 0; let s1 = 0; let s2 = 0;
  for (let i = 0; i < N; i++) {
    s0 = samples[start + i] + coeff * s1 - s2;
    s2 = s1; s1 = s0;
  }
  const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
  return Math.sqrt(Math.max(0, power)) / N;
}

function dominantFreq(samples, sr, start, length, lo = 220, hi = 1200, step = 5) {
  let best = { f: 0, m: 0 };
  for (let f = lo; f <= hi; f += step) {
    const m = goertzel(samples, sr, f, start, length);
    if (m > best.m) best = { f, m };
  }
  return best;
}

function expectedToneAt(clip, srcTime) {
  const spec = SAMPLE_SPECS.find((s) => clip.src && clip.src.includes(s.fileName));
  if (!spec?.tone) return null;
  return toneFrequencyAt(spec.tone, srcTime, spec.duration);
}

export async function verifyExport(meta, project, timeline) {
  const file = meta.filePath || path.join(EXPORT_DIR, meta.file);
  const info = await probe(file);
  const report = {
    file: path.basename(file),
    probedDuration: info.duration,
    expectedDuration: timeline.duration,
    durationDelta: info.duration - timeline.duration,
    fps: info.fps,
    hasAudio: info.hasAudio,
    checks: [],
    transitions: [],
    frames: [],
    audio: [],
  };
  const add = (id, ok, label, detail = '') => report.checks.push({ id, ok, label, detail });

  add('duration', Math.abs(report.durationDelta) < 0.12, '成片时长与时间线一致',
    `成片 ${info.duration.toFixed(3)} s / 时间线 ${timeline.duration.toFixed(3)} s（差 ${report.durationDelta.toFixed(3)} s）`);

  // 首帧与末帧的源帧号。末帧取 duration - 半帧，避免落到容器末尾之外。
  const half = info.fps ? 0.5 / info.fps : 0.02;
  const firstFrame = await readBarcode(file, half, info.width / 640, info.height / 360);
  const lastFrame = await readBarcode(file, Math.max(0, info.duration - half), info.width / 640, info.height / 360);
  const firstRow = timeline.clips[0];
  const expectedFirst = Math.round(firstRow.srcIn * firstRow.srcFps);
  add('first-frame', firstFrame != null && Math.abs(firstFrame - expectedFirst) <= 2,
    '首帧来自第一段入点',
    `条码帧号 ${firstFrame} / 期望 ${expectedFirst}`);

  const lastRow = timeline.clips[timeline.clips.length - 1];
  const lastExpectedFrame = Math.max(0, Math.round(lastRow.srcOut * lastRow.srcFps) - 1);
  add('last-frame', lastFrame != null && Math.abs(lastFrame - lastExpectedFrame) <= 3,
    '末帧来自最后一段出点',
    `条码帧号 ${lastFrame} / 期望约 ${lastExpectedFrame}`);

  const rect = patchRectIn(info.width, info.height);

  for (const tr of timeline.transitions) {
    if (tr.type !== 'dissolve') {
      report.transitions.push({ index: tr.index, type: 'cut', boundary: tr.cutAt, ok: true });
      continue;
    }
    // 起点前、起点、中点、终点、终点后各采一帧
    const t0 = Math.max(0, tr.start - 0.12);
    const t1 = tr.start;
    const tm = (tr.start + tr.end) / 2;
    const t2 = Math.max(0, tr.end - 0.01);
    const t3 = Math.min(info.duration - 0.02, tr.end + 0.12);
    const [c0, c1, cm, c2, c3] = await Promise.all([
      sampleColor(file, t0, rect), sampleColor(file, t1, rect), sampleColor(file, tm, rect),
      sampleColor(file, t2, rect), sampleColor(file, t3, rect),
    ]);
    const a = timeline.clips[tr.a];
    const b = timeline.clips[tr.b];
    const specA = sampleSpecOf(a.clip);
    const specB = sampleSpecOf(b.clip);
    let alpha = null;
    let alphaAtStart = null;
    let alphaAtEnd = null;
    let ok = true;
    let detail = '';
    // 用去饱和 / 亮度检验标记块确实被叠化混合：中点应接近两色均值
    if (specA?.patch && specB?.patch) {
      alpha = patchAlpha(cm, specA.patch.color, specB.patch.color);
      alphaAtStart = patchAlpha(c1, specA.patch.color, specB.patch.color);
      alphaAtEnd = patchAlpha(c2, specA.patch.color, specB.patch.color);
      // 编码在 YUV 空间做混合，RGB 采样会有偏差；只要呈现「起点接近 A、中点居中、
      // 终点接近 B」的单调过渡，就说明叠化的起止与长度成立。
      const midOk = alpha > 0.28 && alpha < 0.78;
      const startOk = alphaAtStart < 0.3;
      const endOk = alphaAtEnd > 0.7;
      const monotonic = alphaAtStart < alpha + 0.05 && alpha < alphaAtEnd + 0.05;
      ok = midOk && startOk && endOk && monotonic;
      detail = `标记块混色 alpha：起点 ${alphaAtStart.toFixed(2)} / 中点 ${alpha.toFixed(2)} / 终点 ${alphaAtEnd.toFixed(2)}（期望 ≈0 / 0.5 / 1，单调过渡）`;
    } else {
      detail = '两侧不是内建素材，跳过标记块 alpha 复检。';
    }
    report.transitions.push({
      index: tr.index, type: 'dissolve',
      start: tr.start, end: tr.end, duration: tr.duration,
      alphaStart: alphaAtStart, alphaMid: alpha, alphaEnd: alphaAtEnd,
      colors: { before: c0, start: c1, mid: cm, end: c2, after: c3 },
      ok, detail,
    });
    add(`dissolve-${tr.index + 1}`, ok, `叠化 ${tr.index + 1} 的起止可验证`, detail);
  }

  // 音频：在每段「不与邻居交叠」的干净区间里测主频，与「源入点处应有的扫频」比对；
  // 同时比较片头频率 (f0) 与入点频率的响应，确认没有把素材开头多播一遍。
  if (info.hasAudio) {
    const audio = await audioSamples(file, info.duration);
    if (audio) {
      for (const row of timeline.clips) {
        const spec = sampleSpecOf(row.clip);
        if (!spec?.tone) continue;
        const win = cleanAudioWindow(timeline, row);
        if (!win || win[1] - win[0] < 0.2) continue;
        const probeDur = Math.min(0.45, (win[1] - win[0]) * 0.6);
        const tProbe = (win[0] + win[1]) / 2;
        const start = Math.floor(tProbe * audio.sr);
        const length = Math.floor(probeDur * audio.sr);
        if (start + length >= audio.samples.length) continue;
        const srcAtProbe = row.srcIn + (tProbe - row.start);
        const expected = toneFrequencyAt(spec.tone, srcAtProbe, spec.duration);
        const headFreq = spec.tone.f0;
        const peak = dominantFreq(audio.samples, audio.sr, start, length, 200, 1300, 5);
        const mExp = goertzel(audio.samples, audio.sr, expected, start, length);
        const mHead = goertzel(audio.samples, audio.sr, headFreq, start, length);
        // 入点频率与片头频率足够分开时，入点处的响应应明显更强。
        const separable = Math.abs(expected - headFreq) > 60;
        const pointsToIn = separable ? mExp > mHead * 1.5 : true;
        const nearExpected = Math.abs(peak.f - expected) < 90;
        const okA = pointsToIn && nearExpected;
        report.audio.push({
          clipIndex: row.index, time: tProbe, srcTime: srcAtProbe, expected, headFreq,
          measured: peak.f, magnitudeAtExpected: mExp, magnitudeAtHead: mHead, ok: okA, separable,
        });
        add(`audio-${row.index + 1}`, okA, `片段 ${row.index + 1} 的音频从入点开始，未多播片头`,
          `统一时间 ${tProbe.toFixed(2)} s（源 ${srcAtProbe.toFixed(2)} s）实测主频 ${peak.f} Hz，` +
          `期望 ${expected.toFixed(0)} Hz；片头 ${headFreq} Hz 响应 ${mHead.toFixed(4)}，` +
          `入点频率响应 ${mExp.toFixed(4)}`);
      }
    } else {
      add('audio-decode', false, '成片音频可解码', '未能解码出音频');
    }
  } else {
    add('audio-track', false, '成片含音轨', '未检测到音轨');
  }

  report.ok = report.checks.every((c) => c.ok);
  return report;
}
