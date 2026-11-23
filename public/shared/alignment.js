/**
 * 音轨滤镜构造，前后端与测试共用。
 *
 * 与 resolveAudioTimeline 的规则一一对应：
 *   headTrim   = max(0, -offset)   裁掉源开头
 *   headSilence= max(0,  offset)   开头补静音
 *   apad + atrim 到视频时长        末尾补静音 / 截断
 */
import { roundSeconds } from './timeline.js';

/**
 * 轨道标题里带一个机器可读的偏移标记，例如：
 *   "中文音轨 [tw-offset=+0.600s]"
 * 这样即使只有成品文件、没有 .tracks.json，也能从容器里读回偏移。
 * 校验器用同一个正则解析。
 */
export const OFFSET_MARKER_RE = /\[tw-offset=([+-]\d+(?:\.\d+)?)s\]/;

export function trackTitle(track) {
  const offset = Number(track.offset) || 0;
  const sign = offset >= 0 ? '+' : '-';
  const marker = `[tw-offset=${sign}${Math.abs(offset).toFixed(3)}s]`;
  const name = String(track.name || '未命名').replace(/[\r\n]+/g, ' ').trim();
  return `${name} ${marker}`;
}

export function offsetFromTitle(title) {
  const match = String(title || '').match(OFFSET_MARKER_RE);
  return match ? Number(match[1]) : null;
}

export function buildAudioFilter({ offset, videoDuration, inputLabel, outputLabel }) {
  const off = Number.isFinite(Number(offset)) ? Number(offset) : 0;
  const duration = roundSeconds(Math.max(0, Number(videoDuration) || 0), 3);
  const headTrim = Math.max(0, -off);
  const headSilence = Math.max(0, off);
  const parts = ['aresample=48000'];

  if (headTrim > 0) {
    parts.push(`atrim=start=${roundSeconds(headTrim, 3)}`, 'asetpts=PTS-STARTPTS');
  }
  if (headSilence > 0) {
    // adelay 在开头插入真实静音采样（不是单纯改时间戳），因此后续 atrim 仍按
    // [0, videoDuration] 取窗口即可：静音段在窗口内，尾部溢出被截掉。
    parts.push(`adelay=${Math.round(headSilence * 1000)}:all=1`);
  }
  parts.push('apad');
  parts.push(`atrim=0:${duration}`);
  parts.push('asetpts=N/SR/TB');
  parts.push('aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo');

  return `${inputLabel}${parts.join(',')}${outputLabel}`;
}
