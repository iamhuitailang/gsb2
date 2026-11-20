/**
 * 演示音频合成器（纯 JS，无 DOM / Node 依赖）。
 *
 * 目的：不依赖任何外部音频素材，也不需要在仓库里提交二进制文件。
 * - 浏览器端：用 OfflineAudioContext/AudioContext 创建 AudioBuffer 直接播放；
 * - Node 端（scripts/generate-samples.mjs）：输出 16-bit PCM WAV 供其他工具使用。
 *
 * 生成内容刻意覆盖：多段说话、声音事件、两人重叠说话、听不清的片段、以及空白区间。
 * 所有时间单位为秒。
 */

export const DEMO_ID = 'demo-interview';
export const DEMO_SAMPLE_RATE = 44100;
export const DEMO_DURATION = 28;
export const DEMO_FILE_NAME = 'demo-interview.wav';
export const DEMO_TITLE = '示例：采访录音（含重叠与空白）';

const LABELS = [
  { id: 'label_speech', name: '说话', color: '#f0b35a' },
  { id: 'label_event', name: '声音事件', color: '#a78bfa' },
  { id: 'label_unclear', name: '听不清', color: '#fb7185' },
  { id: 'label_other', name: '其他', color: '#7dd3fc' },
];

const SPEAKERS = [
  { id: 'spk_interviewer', name: '采访者', color: '#60a5fa' },
  { id: 'spk_guest', name: '受访者', color: '#34d399' },
];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

/** 带包络和共振峰的音节，模拟说话声。 */
function renderSpeech(buffer, sampleRate, start, end, { baseFreq = 130, brightness = 0.5, rate = 3.4, seed = 1 } = {}) {
  const localRand = mulberry32(seed);
  const startSample = Math.max(0, Math.floor(start * sampleRate));
  const endSample = Math.min(buffer.length, Math.floor(end * sampleRate));
  const total = endSample - startSample;
  let phase = 0;
  let phase2 = 0;
  let syllablePos = 0;
  let syllableRate = rate;
  let syllableLen = Math.max(1, Math.floor(sampleRate / syllableRate));
  let syllableSeed = localRand();
  const formants = [520 + brightness * 220, 1180 + brightness * 400, 2600];

  for (let i = 0; i < total; i += 1) {
    const t = i / sampleRate;
    if (syllablePos >= syllableLen) {
      syllablePos = 0;
      syllableRate = rate * (0.72 + localRand() * 0.65);
      syllableLen = Math.max(1, Math.floor(sampleRate / syllableRate));
      syllableSeed = localRand();
      phase2 = 0;
    }
    const syllableT = syllablePos / sampleRate;
    const pitch = baseFreq * (0.82 + syllableSeed * 0.5) * (1 + Math.sin(syllableT * 9) * 0.02);
    phase += (2 * Math.PI * pitch) / sampleRate;
    phase2 += (2 * Math.PI * pitch * 2.02) / sampleRate;

    const envelope = Math.sin(Math.PI * clamp(syllablePos / syllableLen, 0, 1)) ** 0.7;
    const vibrato = 1 + Math.sin(2 * Math.PI * 5.2 * t) * 0.12;

    let value = Math.sin(phase) * 0.5 + Math.sin(phase2) * 0.22 + Math.sin(phase * 2.8 + Math.sin(phase * 0.7)) * 0.14;
    for (let f = 0; f < formants.length; f += 1) {
      value += Math.sin((phase * formants[f]) / pitch + f) * (0.1 / (f + 1));
    }
    const sibilant = localRand() < 0.06 ? (localRand() * 2 - 1) * 0.35 : 0;
    value = (value + sibilant) * envelope * vibrato;

    const fade = Math.min(1, i / (0.02 * sampleRate), (total - i) / (0.03 * sampleRate));
    buffer[startSample + i] += value * 0.26 * clamp(fade, 0, 1);
    syllablePos += 1;
  }
}

function renderChime(buffer, sampleRate, start, end) {
  const startSample = Math.max(0, Math.floor(start * sampleRate));
  const endSample = Math.min(buffer.length, Math.floor(end * sampleRate));
  for (let i = startSample; i < endSample; i += 1) {
    const local = i / sampleRate - start;
    const decay = Math.exp(-local * 3.4);
    const env = Math.min(1, local / 0.01) * decay;
    const tone = Math.sin(2 * Math.PI * 987 * local) * 0.32 + Math.sin(2 * Math.PI * 1318 * local) * 0.18;
    buffer[i] += tone * env * 0.55;
  }
}

function renderThud(buffer, sampleRate, start, end, seed = 7) {
  const rand = mulberry32(seed);
  const startSample = Math.max(0, Math.floor(start * sampleRate));
  const endSample = Math.min(buffer.length, Math.floor(end * sampleRate));
  for (let i = startSample; i < endSample; i += 1) {
    const local = i / sampleRate - start;
    const env = Math.exp(-local * 14);
    const thump = Math.sin(2 * Math.PI * 62 * local) * 0.55;
    const noise = (rand() * 2 - 1) * 0.18;
    buffer[i] += (thump + noise) * env;
  }
}

function renderRustle(buffer, sampleRate, start, end, seed = 13) {
  const rand = mulberry32(seed);
  const startSample = Math.max(0, Math.floor(start * sampleRate));
  const endSample = Math.min(buffer.length, Math.floor(end * sampleRate));
  let previous = 0;
  for (let i = startSample; i < endSample; i += 1) {
    const local = i / sampleRate - start;
    const env = Math.sin(Math.PI * clamp(local / (end - start), 0, 1)) ** 1.6;
    const white = rand() * 2 - 1;
    previous = previous * 0.72 + white * 0.28;
    buffer[i] += previous * env * 0.3;
  }
}

/** 合成演示音频，返回 [-1,1] 的单声道 Float32Array。 */
export function synthesizeDemoAudio({ sampleRate = DEMO_SAMPLE_RATE, duration = DEMO_DURATION } = {}) {
  const buffer = new Float32Array(Math.ceil(duration * sampleRate));
  renderSpeech(buffer, sampleRate, 1.2, 4.6, { baseFreq: 118, brightness: 0.45, rate: 3.1, seed: 11 });
  renderSpeech(buffer, sampleRate, 5.4, 9.6, { baseFreq: 165, brightness: 0.72, rate: 3.8, seed: 23 });
  renderChime(buffer, sampleRate, 9.1, 9.9);
  renderSpeech(buffer, sampleRate, 10.7, 14.2, { baseFreq: 121, brightness: 0.5, rate: 3.3, seed: 37 });
  // 重叠：两人同时说话
  renderSpeech(buffer, sampleRate, 14.8, 16.6, { baseFreq: 124, brightness: 0.52, rate: 3.2, seed: 41 });
  renderSpeech(buffer, sampleRate, 15.2, 17.1, { baseFreq: 158, brightness: 0.68, rate: 3.6, seed: 43 });
  // 听不清的低语
  renderSpeech(buffer, sampleRate, 18.0, 19.4, { baseFreq: 96, brightness: 0.22, rate: 2.1, seed: 53 });
  renderThud(buffer, sampleRate, 19.6, 20.05);
  renderSpeech(buffer, sampleRate, 20.8, 24.7, { baseFreq: 168, brightness: 0.74, rate: 3.9, seed: 61 });
  renderRustle(buffer, sampleRate, 25.5, 26.35);
  renderSpeech(buffer, sampleRate, 26.6, 27.4, { baseFreq: 126, brightness: 0.48, rate: 3.0, seed: 71 });

  let peak = 0;
  for (let i = 0; i < buffer.length; i += 1) peak = Math.max(peak, Math.abs(buffer[i]));
  const gain = peak > 0 ? 0.82 / peak : 1;
  for (let i = 0; i < buffer.length; i += 1) buffer[i] = clamp(buffer[i] * gain, -1, 1);
  return buffer;
}

/** 演示标注（时间均为秒，刻意包含重叠、空白、听不清与备注）。 */
export function demoRegions(now = 1700000000000) {
  const make = (id, start, end, labelId, speakerId, confidence, note) => ({
    id,
    start,
    end,
    labelId,
    speakerId,
    confidence,
    note,
    createdAt: now,
    updatedAt: now,
  });
  return [
    make('reg_demo_001', 1.2, 4.6, 'label_speech', 'spk_interviewer', 'certain', '开场提问：先介绍一下你自己。'),
    make('reg_demo_002', 5.4, 9.6, 'label_speech', 'spk_guest', 'certain', '受访者介绍工作经历。'),
    make('reg_demo_003', 9.1, 9.9, 'label_event', null, 'certain', '杯碟碰撞声，与受访者话音尾部重叠。'),
    make('reg_demo_004', 10.7, 14.2, 'label_speech', 'spk_interviewer', 'certain', ''),
    make('reg_demo_005', 14.8, 16.6, 'label_speech', 'spk_interviewer', 'certain', '追问，与受访者插话重叠。'),
    make('reg_demo_006', 15.2, 17.1, 'label_speech', 'spk_guest', 'uncertain', '插话内容部分被盖住，需复核。'),
    make('reg_demo_007', 18.0, 19.4, 'label_unclear', 'spk_guest', 'inaudible', '音量很低，疑似回答，听不清具体词句。'),
    make('reg_demo_008', 19.6, 20.05, 'label_event', null, 'certain', '椅子挪动声。'),
    make('reg_demo_009', 20.8, 24.7, 'label_speech', 'spk_guest', 'certain', '受访者讲述项目细节。'),
    make('reg_demo_010', 25.5, 26.35, 'label_event', null, 'uncertain', '翻纸声，起止点待确认。'),
    make('reg_demo_011', 26.6, 27.4, 'label_speech', 'spk_interviewer', 'certain', '收尾提问。'),
  ];
}

/** 演示工程文档（audio.source = 'sample'，打开时按需重新合成音频）。 */
export function demoProject({ now = 1700000000000 } = {}) {
  return {
    format: 'gsb2.project',
    version: 1,
    timeUnit: 'seconds',
    id: 'prj_demo_12994',
    name: DEMO_TITLE,
    createdAt: now,
    updatedAt: now,
    audio: {
      fileName: DEMO_FILE_NAME,
      duration: DEMO_DURATION,
      sampleRate: DEMO_SAMPLE_RATE,
      channels: 1,
      source: 'sample',
      sampleId: DEMO_ID,
      sizeBytes: 0,
      lastModified: now,
    },
    labels: LABELS.map((label) => ({ ...label })),
    speakers: SPEAKERS.map((speaker) => ({ ...speaker })),
    regions: demoRegions(now),
    view: { start: 0, pxPerSecond: 52 },
  };
}
