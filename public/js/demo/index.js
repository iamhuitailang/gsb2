import {
  DEMO_DURATION,
  DEMO_FILE_NAME,
  DEMO_ID,
  DEMO_SAMPLE_RATE,
  DEMO_TITLE,
  demoProject,
  synthesizeDemoAudio,
} from './synth.js';

let cachedBlob = null;

/** 合成示例音频并作为一个「本地 Blob」返回，便于走统一的加载流程。结果会被缓存。 */
export function demoAudioBlob() {
  if (cachedBlob) return cachedBlob;
  const samples = synthesizeDemoAudio({ sampleRate: DEMO_SAMPLE_RATE, duration: DEMO_DURATION });
  const channels = 1;
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeString = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, DEMO_SAMPLE_RATE, true);
  view.setUint32(28, DEMO_SAMPLE_RATE * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);
  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i] < 0 ? samples[i] * 0x8000 : samples[i] * 0x7fff;
    view.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(value))), true);
  }
  return (cachedBlob = new Blob([buffer], { type: 'audio/wav' }));
}

export { DEMO_DURATION, DEMO_FILE_NAME, DEMO_ID, DEMO_SAMPLE_RATE, DEMO_TITLE, demoProject };
