/**
 * 自带的程序生成示例素材。
 *
 * 生成内容：
 *   lesson.mp4        26 秒测试画面（无音轨）
 *   lesson.zh.srt     中文 6 条字幕标记
 *   lesson.en.vtt     英文 6 条字幕标记（与中文同一时点）
 *   audio.zh.wav      中文音轨：比视频晚 0.6 秒才开始录（需要 offset=+0.6）
 *   audio.en.wav      英文音轨：按时开始，末尾多录 1.2 秒（导出会截断）
 *   sample-project.json  推荐的偏移、语言、默认轨与标记时间
 *
 * 音频里的音调让“对齐”可以被机器核对：读出起音时刻 s，加上偏移 off，
 * 应当等于字幕条目时间 v；两种语言在同一时点应当同时起音。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeCapabilities, probeMedia, runFfmpeg } from '../server/ffmpeg.js';
import { detectOnsets, mixInto, readWav, tone, writeWav } from '../server/wav.js';
import { registerFile } from '../server/media.js';
import { parseSubtitles } from '../public/shared/subtitles.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const SAMPLE_DIR = join(ROOT, 'public', 'samples');
const SAMPLE_RATE = 48000;
export const VIDEO_DURATION = 26;
/** 中文音轨比视频晚 0.6 秒才开始录：offset=+0.6 才能对回字幕。 */
export const ZH_LATE_START = 0.6;
/** 英文音轨末尾多录的一枚标记，落在视频结束 0.5 秒之后。 */
export const EN_OVERFLOW_MARKER = 26.5;
/** 音调长度；起音检测按 15ms 窗口，足够稳定。 */
const TONE_DURATION = 0.55;
/** 生成算法变更时递增，旧素材会被自动重建，避免示例语义与代码不一致。 */
const SAMPLE_VERSION = 2;

export const SAMPLE_CUES = [
  { index: 1, start: 1.0, end: 4.0, zh: '欢迎来到双语教学示例。', en: 'Welcome to the bilingual lesson sample.' },
  { index: 2, start: 5.0, end: 8.0, zh: '今天先看两个步骤。', en: 'Today we will look at two steps.' },
  { index: 3, start: 9.0, end: 12.0, zh: '第一步：准备好素材。', en: 'Step one: prepare your materials.' },
  { index: 4, start: 13.0, end: 16.0, zh: '第二步：对齐音轨与字幕。', en: 'Step two: align audio and subtitles.' },
  { index: 5, start: 17.0, end: 20.0, zh: '请跟着读一遍。', en: 'Please read along with me.' },
  { index: 6, start: 21.0, end: 24.0, zh: '最后核对默认轨与语言。', en: 'Finally, check defaults and languages.' },
];

export const SAMPLE_FREQUENCIES = {
  zh: [523.25, 587.33, 659.25, 698.46, 783.99, 880.0],
  en: [392.0, 440.0, 493.88, 523.25, 587.33, 659.25],
};

export const SAMPLE_FILES = {
  video: join(SAMPLE_DIR, 'lesson.mp4'),
  zhSubtitle: join(SAMPLE_DIR, 'lesson.zh.srt'),
  enSubtitle: join(SAMPLE_DIR, 'lesson.en.vtt'),
  zhAudio: join(SAMPLE_DIR, 'audio.zh.wav'),
  enAudio: join(SAMPLE_DIR, 'audio.en.wav'),
  descriptor: join(SAMPLE_DIR, 'sample-project.json'),
};

function srtTime(seconds) {
  const total = Math.round(seconds * 1000);
  const ms = total % 1000;
  const s = Math.floor(total / 1000) % 60;
  const m = Math.floor(total / 60000) % 60;
  const h = Math.floor(total / 3600000);
  const pad = (v, n = 2) => String(v).padStart(n, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

function vttTime(seconds) {
  return srtTime(seconds).replace(',', '.');
}

export function buildZhSrt() {
  return (
    SAMPLE_CUES.map((cue, i) => `${i + 1}\n${srtTime(cue.start)} --> ${srtTime(cue.end)}\n${cue.zh}`).join('\n\n') +
    '\n'
  );
}

export function buildEnVtt() {
  return (
    'WEBVTT\n\n' +
    SAMPLE_CUES.map((cue, i) => `cue-${i + 1}\n${vttTime(cue.start)} --> ${vttTime(cue.end)}\n${cue.en}`).join('\n\n') +
    '\n'
  );
}

/**
 * 构造一条音轨。
 *   shift   整条录音相对视频的时间误差：>0 表示晚开始（起音在源文件里更早）
 *   extraMarkerAt  额外在某个视频时点插一枚标记（可超出视频）
 */
function buildTrack({ frequencies, shift = 0, extraMarkerAt = null }) {
  // 源文件长度：正常音轨录到视频结束；带额外标记的音轨录到标记之后。
  const sourceSeconds =
    extraMarkerAt != null
      ? extraMarkerAt - shift + TONE_DURATION + 0.15
      : Math.max(0.1, VIDEO_DURATION - shift);
  const frames = Math.round(sourceSeconds * SAMPLE_RATE);
  const buffer = new Float32Array(frames);

  for (let index = 0; index < SAMPLE_CUES.length; index += 1) {
    const sourceStart = SAMPLE_CUES[index].start - shift;
    if (sourceStart < 0) continue;
    const burst = tone({
      frequency: frequencies[index % frequencies.length],
      duration: TONE_DURATION,
      sampleRate: SAMPLE_RATE,
      amplitude: 0.3,
    });
    mixInto(buffer, burst, Math.round(sourceStart * SAMPLE_RATE));
  }

  if (extraMarkerAt != null) {
    const extra = tone({
      frequency: 1046.5,
      duration: TONE_DURATION,
      sampleRate: SAMPLE_RATE,
      amplitude: 0.22,
    });
    mixInto(buffer, extra, Math.round((extraMarkerAt - shift) * SAMPLE_RATE));
  }

  return { samples: buffer, duration: frames / SAMPLE_RATE };
}

let ensurePromise = null;

async function generateVideo(filePath) {
  const caps = await probeCapabilities();
  const videoCodec = caps.hasEncoder('libx264')
    ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28']
    : ['-c:v', 'mpeg4', '-q:v', '5'];
  await runFfmpeg([
    '-hide_banner',
    '-nostdin',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc=size=1280x720:rate=25:duration=${VIDEO_DURATION}`,
    ...videoCodec,
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    filePath,
  ]);
}

function fileFingerprint(filePath) {
  try {
    const stat = statSync(filePath);
    return createHash('sha1')
      .update(`${filePath}:${stat.size}:${stat.mtimeMs}`)
      .digest('hex')
      .slice(0, 10);
  } catch {
    return null;
  }
}

/** 生成缺失的示例文件；force=true 时全部重写。 */
export async function ensureSampleSet({ force = false } = {}) {
  if (ensurePromise && !force) return ensurePromise;

  ensurePromise = (async () => {
    mkdirSync(SAMPLE_DIR, { recursive: true });
    const generated = [];

    // 语义升级后旧的音频会和字幕对不上，按描述文件版本整体重建。
    let stale = force;
    try {
      const previous = JSON.parse(readFileSync(SAMPLE_FILES.descriptor, 'utf8'));
      if (previous.sampleVersion !== SAMPLE_VERSION) stale = true;
    } catch {
      stale = true;
    }

    const need = (filePath) => stale || !existsSync(filePath) || statSync(filePath).size === 0;

    if (need(SAMPLE_FILES.zhSubtitle)) {
      writeFileSync(SAMPLE_FILES.zhSubtitle, buildZhSrt(), 'utf8');
      generated.push(SAMPLE_FILES.zhSubtitle);
    }
    if (need(SAMPLE_FILES.enSubtitle)) {
      writeFileSync(SAMPLE_FILES.enSubtitle, buildEnVtt(), 'utf8');
      generated.push(SAMPLE_FILES.enSubtitle);
    }
    if (need(SAMPLE_FILES.zhAudio)) {
      const { samples } = buildTrack({ frequencies: SAMPLE_FREQUENCIES.zh, shift: ZH_LATE_START });
      writeWav(SAMPLE_FILES.zhAudio, samples, { sampleRate: SAMPLE_RATE });
      generated.push(SAMPLE_FILES.zhAudio);
    }
    if (need(SAMPLE_FILES.enAudio)) {
      const { samples } = buildTrack({
        frequencies: SAMPLE_FREQUENCIES.en,
        shift: 0,
        extraMarkerAt: EN_OVERFLOW_MARKER,
      });
      writeWav(SAMPLE_FILES.enAudio, samples, { sampleRate: SAMPLE_RATE });
      generated.push(SAMPLE_FILES.enAudio);
    }
    if (need(SAMPLE_FILES.video)) {
      await generateVideo(SAMPLE_FILES.video);
      generated.push(SAMPLE_FILES.video);
    }

    const descriptor = {
      format: 'trackweave-sample',
      sampleVersion: SAMPLE_VERSION,
      version: 1,
      generatedAt: new Date().toISOString(),
      videoDuration: VIDEO_DURATION,
      cues: SAMPLE_CUES,
      languages: ['zh', 'en'],
      tracks: {
        audio: [
          {
            path: SAMPLE_FILES.zhAudio,
            language: 'zh',
            name: '中文音轨（晚开始 0.6 秒）',
            recommendedOffset: ZH_LATE_START,
            default: true,
          },
          {
            path: SAMPLE_FILES.enAudio,
            language: 'en',
            name: 'English track（末尾多 1.2 秒）',
            recommendedOffset: 0,
            default: false,
          },
        ],
        subtitles: [
          {
            path: SAMPLE_FILES.zhSubtitle,
            language: 'zh',
            name: '中文字幕（SRT）',
            recommendedOffset: 0,
            default: true,
          },
          {
            path: SAMPLE_FILES.enSubtitle,
            language: 'en',
            name: 'English subtitles（WebVTT）',
            recommendedOffset: 0,
            default: false,
          },
        ],
      },
      files: SAMPLE_FILES,
      fingerprint: fileFingerprint(SAMPLE_FILES.video),
    };
    writeFileSync(SAMPLE_FILES.descriptor, `${JSON.stringify(descriptor, null, 2)}\n`, 'utf8');

    return { dir: SAMPLE_DIR, generated, descriptor };
  })();

  try {
    return await ensurePromise;
  } finally {
    ensurePromise = null;
  }
}

/** 生成客户端可直接使用的示例项目（含 token 与推荐偏移）。 */
export async function buildSampleProject() {
  const { dir } = await ensureSampleSet();
  const videoRecord = registerFile(SAMPLE_FILES.video);
  const zhAudio = registerFile(SAMPLE_FILES.zhAudio);
  const enAudio = registerFile(SAMPLE_FILES.enAudio);
  const zhSub = registerFile(SAMPLE_FILES.zhSubtitle);
  const enSub = registerFile(SAMPLE_FILES.enSubtitle);

  const zhWav = readWav(SAMPLE_FILES.zhAudio);
  const enWav = readWav(SAMPLE_FILES.enAudio);

  return {
    name: '双语教学示例',
    video: {
      token: videoRecord.token,
      path: videoRecord.path,
      name: videoRecord.name,
      duration: VIDEO_DURATION,
    },
    audioTracks: [
      {
        id: 'sample-audio-zh',
        token: zhAudio.token,
        path: zhAudio.path,
        name: '中文音轨（晚开始 0.6 秒）',
        language: 'zh',
        offset: ZH_LATE_START,
        enabled: true,
        default: true,
        sourceDuration: zhWav.duration,
      },
      {
        id: 'sample-audio-en',
        token: enAudio.token,
        path: enAudio.path,
        name: 'English track（末尾多 1.2 秒）',
        language: 'en',
        offset: 0,
        enabled: true,
        default: false,
        sourceDuration: enWav.duration,
      },
    ],
    subtitleTracks: [
      {
        id: 'sample-sub-zh',
        token: zhSub.token,
        path: zhSub.path,
        name: '中文字幕（SRT）',
        language: 'zh',
        offset: 0,
        enabled: true,
        default: true,
      },
      {
        id: 'sample-sub-en',
        token: enSub.token,
        path: enSub.path,
        name: 'English subtitles（VTT）',
        language: 'en',
        offset: 0,
        enabled: true,
        default: false,
      },
    ],
    outputPath: join(dir, 'lesson.bilingual.mkv'),
    notes: [
      '中文音轨比视频晚 0.6 秒开始，已设 offset=+0.6；改成 0 会看到“晚开始”提醒。',
      'English 音轨末尾比视频多 1.2 秒，预览中静音、导出时截断并提醒。',
    ],
    sample: {
      dir,
      cues: SAMPLE_CUES,
      frequencies: SAMPLE_FREQUENCIES,
      zhLateStart: ZH_LATE_START,
      enOverflowMarker: EN_OVERFLOW_MARKER,
    },
  };
}

function onsetsFor(filePath) {
  const wav = readWav(filePath);
  return {
    duration: wav.duration,
    sampleRate: wav.sampleRate,
    onsets: detectOnsets(wav.samples, { sampleRate: wav.sampleRate }),
  };
}

function differences(onsets, cueTimes) {
  return cueTimes.map((cue, index) => {
    const onset = onsets[index] ?? null;
    return {
      cueIndex: index + 1,
      cueTime: cue,
      onset: onset == null ? null : Number(onset.toFixed(3)),
      delta: onset == null ? null : Number((onset - cue).toFixed(3)),
    };
  });
}

const round3 = (value) => Number(value.toFixed(3));

/** 核对示例素材：音调起音 vs 字幕时间 vs 两种语言互相对齐。 */
export async function checkSampleSet() {
  await ensureSampleSet();

  const zhAudio = onsetsFor(SAMPLE_FILES.zhAudio);
  const enAudio = onsetsFor(SAMPLE_FILES.enAudio);
  const zhSub = parseSubtitles(readFileSync(SAMPLE_FILES.zhSubtitle, 'utf8'), { fileName: 'lesson.zh.srt' });
  const enSub = parseSubtitles(readFileSync(SAMPLE_FILES.enSubtitle, 'utf8'), { fileName: 'lesson.en.vtt' });

  const zhCueTimes = zhSub.cues.map((cue) => cue.start);
  const enCueTimes = enSub.cues.map((cue) => cue.start);

  const zhDiffs = differences(zhAudio.onsets, zhCueTimes);
  const enDiffs = differences(enAudio.onsets, enCueTimes);
  const zhRecommended = zhDiffs[0]?.delta == null ? 0 : -zhDiffs[0].delta;
  const enRecommended = enDiffs[0]?.delta == null ? 0 : -enDiffs[0].delta;

  const alignedZh = zhAudio.onsets.slice(0, zhCueTimes.length).map((t) => t + zhRecommended);
  const alignedEn = enAudio.onsets.slice(0, enCueTimes.length).map((t) => t + enRecommended);
  const cross = zhCueTimes.map((cue, index) => ({
    cueIndex: index + 1,
    cueTime: cue,
    zhOnsetAligned: alignedZh[index] == null ? null : round3(alignedZh[index]),
    enOnsetAligned: alignedEn[index] == null ? null : round3(alignedEn[index]),
    delta:
      alignedZh[index] == null || alignedEn[index] == null
        ? null
        : round3(Math.abs(alignedZh[index] - alignedEn[index])),
  }));

  const video = await probeMedia(SAMPLE_FILES.video);
  const videoStream = video.streams.find((stream) => stream.codecType === 'video');
  const checks = [];
  const push = (id, label, ok, detail = null) => checks.push({ id, label, ok, detail });

  push('video-exists', '示例视频可读', Boolean(videoStream), { duration: video.duration });
  push('video-duration', `视频时长为 ${VIDEO_DURATION}s`, Math.abs((video.duration ?? 0) - VIDEO_DURATION) < 0.2, {
    actual: video.duration,
  });
  push(
    'zh-onset-count',
    `中文音轨检出 ${zhCueTimes.length} 个起音`,
    zhAudio.onsets.length >= zhCueTimes.length,
    { actual: zhAudio.onsets.length },
  );
  push(
    'en-onset-count',
    `英文音轨检出 ${enCueTimes.length + 1} 个起音（含末尾溢出标记）`,
    enAudio.onsets.length >= enCueTimes.length + 1,
    { actual: enAudio.onsets.length },
  );
  push(
    'zh-offset',
    `中文音轨推荐偏移 ${round3(zhRecommended)}s`,
    Math.abs(zhRecommended - ZH_LATE_START) < 0.05,
    { detected: round3(zhRecommended), expected: ZH_LATE_START },
  );
  push(
    'en-offset',
    `英文音轨推荐偏移 ${round3(enRecommended)}s`,
    Math.abs(enRecommended) < 0.05,
    { detected: round3(enRecommended), expected: 0 },
  );
  push(
    'cross-language',
    '两种语言每个字幕时点起音误差 < 15ms',
    cross.every((item) => item.delta == null || item.delta < 0.015),
    { maxDelta: round3(Math.max(...cross.map((item) => item.delta ?? 0))) },
  );
  push(
    'en-overflow',
    '英文音轨末尾标记位于视频之后（用于演示溢出提醒）',
    (enAudio.duration ?? 0) > VIDEO_DURATION + 1,
    { sourceDuration: round3(enAudio.duration || 0), videoDuration: VIDEO_DURATION },
  );

  return {
    ok: checks.every((item) => item.ok),
    dir: SAMPLE_DIR,
    video: { duration: video.duration, width: videoStream?.width, height: videoStream?.height },
    cues: SAMPLE_CUES,
    languages: {
      zh: {
        audioFile: SAMPLE_FILES.zhAudio,
        subtitleFile: SAMPLE_FILES.zhSubtitle,
        audioDuration: round3(zhAudio.duration),
        onsets: zhAudio.onsets.map(round3),
        subtitleCueTimes: zhCueTimes,
        differences: zhDiffs,
        recommendedOffset: round3(zhRecommended),
      },
      en: {
        audioFile: SAMPLE_FILES.enAudio,
        subtitleFile: SAMPLE_FILES.enSubtitle,
        audioDuration: round3(enAudio.duration),
        onsets: enAudio.onsets.map(round3),
        subtitleCueTimes: enCueTimes,
        differences: enDiffs,
        recommendedOffset: round3(enRecommended),
      },
    },
    crossLanguage: cross,
    checks,
  };
}

/**
 * 导出后核对示例音轨：把成品里的音轨解成 WAV，检测起音，
 * 和源文件起音 + 偏移比对。只用于示例素材，避免对普通语音误判。
 */
export async function verifySampleAudioAlignment({ outputPath, tracks }) {
  const results = [];
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const tempDir = mkdtempSync(join(tmpdir(), 'trackweave-audio-'));

  try {
    for (let i = 0; i < tracks.length; i += 1) {
      const track = tracks[i];
      if (!track.sampleFile || !existsSync(track.sampleFile)) {
        results.push({ ok: null, skipped: true, reason: '非示例音轨，跳过音调校验', name: track.name });
        continue;
      }
      const source = onsetsFor(track.sampleFile);
      const expected = source.onsets
        .map((t) => t + (track.offset || 0))
        .filter((t) => t >= 0 && t < (track.videoDuration || Infinity));

      const outWav = join(tempDir, `audio-${i}.wav`);
      await runFfmpeg([
        '-hide_banner',
        '-nostdin',
        '-y',
        '-i',
        outputPath,
        '-map',
        `0:a:${i}`,
        '-ac',
        '1',
        '-ar',
        String(SAMPLE_RATE),
        '-c:a',
        'pcm_s16le',
        outWav,
      ]);
      const actual = onsetsFor(outWav);
      const countOk = actual.onsets.length === expected.length;
      const pairs = expected.map((time, index) => ({
        expected: round3(time),
        actual: actual.onsets[index] == null ? null : round3(actual.onsets[index]),
        delta: actual.onsets[index] == null ? null : round3(actual.onsets[index] - time),
      }));
      const maxDelta = Math.max(
        0,
        ...pairs.map((pair) => (pair.delta == null ? Infinity : Math.abs(pair.delta))),
      );
      results.push({
        ok: countOk && maxDelta <= 0.12,
        name: track.name,
        language: track.language,
        expectedOnsets: expected.map(round3),
        actualOnsets: actual.onsets.map(round3),
        pairs,
        maxDelta: Number.isFinite(maxDelta) ? round3(maxDelta) : null,
        countOk,
      });
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
  return results;
}

export { SAMPLE_RATE };
