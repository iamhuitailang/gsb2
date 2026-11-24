/** MIDI 音符号与音名换算 */

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function midiToName(midi: number): string {
  const octave = Math.floor(midi / 12) - 1;
  return `${NAMES[midi % 12]}${octave}`;
}

export function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** 选样后需要的播放倍率：目标音高 / 样本根音音高 */
export function playbackRateFor(root: number, target: number): number {
  return Math.pow(2, (target - root) / 12);
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}
