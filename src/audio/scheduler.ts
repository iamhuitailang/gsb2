import type { Project, Track } from '../types';
import { automationValueAt } from '../utils/automation';
import { clamp } from '../utils/helpers';

/** 每个片段首尾的微淡入淡出，避免拼接处爆音（秒） */
const CLIP_FADE = 0.005;

export interface ScheduleHandle {
  /** 停止本次调度创建的所有源节点 */
  stop: () => void;
}

export interface ScheduleOptions {
  ctx: BaseAudioContext;
  destination: AudioNode;
  project: Project;
  /** 资源 id → 已解码音频缓冲 */
  buffers: Map<string, AudioBuffer>;
  /** AudioContext 时间轴上的起始时刻 */
  startTime: number;
  /** 从工程的哪个时间开始播放/渲染 */
  fromTime: number;
  /** 调度的工程时间上限（不传则到工程结尾） */
  untilTime?: number;
  /** 离线渲染时对主输出做末尾淡出 */
  tailFade?: number;
}

/**
 * 把整个工程调度到给定音频上下文。
 * 在线播放与离线导出共用本函数，因此导出结果与播放预览同源。
 * 所有源节点一次性按绝对时间排程，由音频线程保证样本级同步。
 */
export function scheduleProject(opts: ScheduleOptions): ScheduleHandle {
  const { ctx, destination, project, buffers, startTime, fromTime } = opts;
  const until = opts.untilTime ?? project.length;
  const sources: AudioBufferSourceNode[] = [];

  const master = ctx.createGain();
  master.gain.value = 1;

  // 主输出压缩器：多轨/重叠片段相加时防止削顶，在线与导出共用同一条链路
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 6;
  limiter.ratio.value = 12;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.12;
  master.connect(limiter);
  limiter.connect(destination);

  // 导出末尾淡出（仅离线场景传入 tailFade）
  if (opts.tailFade && opts.tailFade > 0 && project.length > 0) {
    const fadeStart = Math.max(0, project.length - opts.tailFade);
    master.gain.setValueAtTime(1, 0);
    if (fadeStart > 0) {
      master.gain.setValueAtTime(1, fadeStart);
    }
    master.gain.linearRampToValueAtTime(0, project.length);
  }

  const anySolo = project.tracks.some((t) => t.solo);

  for (const track of project.tracks) {
    const trackAudible = !track.muted && (!anySolo || track.solo);
    const trackGain = ctx.createGain();
    trackGain.connect(master);

    if (trackAudible) {
      scheduleTrackAutomation(track, trackGain, startTime, fromTime, until);
      for (const clip of track.clips) {
        if (clip.muted) continue; // 静音片段：跳过源节点，该区域为静音
        const buffer = buffers.get(clip.resourceId);
        if (!buffer) continue;
        scheduleClip(ctx, buffer, clip, trackGain, startTime, fromTime, until, sources);
      }
    }
  }

  return {
    stop: () => {
      for (const src of sources) {
        try {
          src.onended = null;
          src.stop();
        } catch {
          /* 节点可能已自然结束 */
        }
        try {
          src.disconnect();
        } catch {
          /* ignore */
        }
      }
      try {
        limiter.disconnect();
      } catch {
        /* ignore */
      }
      try {
        master.disconnect();
      } catch {
        /* ignore */
      }
    },
  };
}

function scheduleTrackAutomation(
  track: Track,
  trackGain: GainNode,
  startTime: number,
  fromTime: number,
  until: number,
): void {
  const param = trackGain.gain;
  const initial = automationValueAt(track.automation, fromTime);
  // 最终增益 = 轨道基础音量 × 自动化值；无自动化时恒为基础音量
  const baseAt = (v: number | null) => track.volume * (v ?? 1);

  param.setValueAtTime(clamp(baseAt(initial), 0, 1), Math.max(0, startTime));

  const points = [...track.automation].sort((a, b) => a.time - b.time);
  for (const point of points) {
    if (point.time <= fromTime || point.time > until) continue;
    param.linearRampToValueAtTime(
      clamp(baseAt(point.value), 0, 1),
      Math.max(0, startTime + (point.time - fromTime)),
    );
  }
}

function scheduleClip(
  ctx: BaseAudioContext,
  buffer: AudioBuffer,
  clip: Project['tracks'][number]['clips'][number],
  trackGain: GainNode,
  startTime: number,
  fromTime: number,
  until: number,
  sources: AudioBufferSourceNode[],
): void {
  const clipEnd = clip.start + clip.duration;
  // 与调度窗口无交集则跳过
  if (clipEnd <= fromTime || clip.start >= until) return;

  // 窗口内实际播放的源偏移与时长
  const playOffset = Math.max(0, fromTime - clip.start) + clip.offset;
  const audibleEnd = Math.min(clipEnd, until);
  const audibleStart = Math.max(clip.start, fromTime);
  const playDuration = Math.max(0.001, audibleEnd - audibleStart);
  const sourceStart = startTime + (audibleStart - fromTime);

  const source = ctx.createBufferSource();
  source.buffer = buffer;

  // 片段级增益：做 5ms 微淡入淡出，防止边界爆音
  const clipGain = ctx.createGain();
  const fadeIn = Math.min(CLIP_FADE, playDuration / 2);
  const fadeOut = Math.min(CLIP_FADE, playDuration / 2);
  clipGain.gain.setValueAtTime(0, sourceStart);
  clipGain.gain.linearRampToValueAtTime(1, sourceStart + fadeIn);
  if (playDuration > fadeIn + fadeOut) {
    clipGain.gain.setValueAtTime(1, sourceStart + playDuration - fadeOut);
  }
  clipGain.gain.linearRampToValueAtTime(0, sourceStart + playDuration);

  source.connect(clipGain);
  clipGain.connect(trackGain);
  source.start(sourceStart, playOffset, playDuration + 0.02);
  sources.push(source);
}
