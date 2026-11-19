import type { Project } from '../types';
import { scheduleProject } from './scheduler';
import { decodeAudio, encodeWav } from './wav';
import { getRecordingBlob } from '../utils/storage';

export interface ExportProgress {
  (message: string): void;
}

/**
 * 离线渲染导出：
 * - 渲染长度严格等于项目长度（空工程返回 null，由 UI 拦截提示）
 * - 空轨道 / 静音片段不产生节点，结果中对应区域为静音
 * - 末尾按 project.tailFade 做整体淡出
 * - 与在线播放共用 scheduleProject，混音结果可与预览对照
 */
export async function exportMix(
  project: Project,
  onlineCtx: BaseAudioContext,
  onProgress?: ExportProgress,
): Promise<Blob | null> {
  if (project.length <= 0) return null;

  onProgress?.('准备离线渲染上下文…');
  const sampleRate = onlineCtx.sampleRate;
  const offline = new OfflineAudioContext(2, Math.ceil(project.length * sampleRate), sampleRate);
  const buffers = new Map<string, AudioBuffer>();

  // 收集全部被实际引用的资源并解码
  const ids = new Set<string>();
  for (const track of project.tracks) {
    for (const clip of track.clips) ids.add(clip.resourceId);
  }
  for (const id of ids) {
    const meta = project.resources[id];
    if (!meta) continue;
    try {
      let data: ArrayBuffer;
      if (meta.kind === 'recording') {
        const blob = await getRecordingBlob(id);
        if (!blob) throw new Error(`录音数据缺失：${meta.name}`);
        data = await blob.arrayBuffer();
      } else if (meta.url) {
        const res = await fetch(meta.url);
        data = await res.arrayBuffer();
      } else {
        continue;
      }
      // 重采样到离线上下文采样率
      const decoded = await decodeAudio(onlineCtx, data);
      const buffer = await resampleBuffer(decoded, offline);
      buffers.set(id, buffer);
    } catch (err) {
      console.error('导出时资源解码失败', id, err);
    }
  }

  onProgress?.('调度全部轨道并渲染混音…');
  scheduleProject({
    ctx: offline,
    destination: offline.destination,
    project,
    buffers,
    startTime: 0,
    fromTime: 0,
    untilTime: project.length,
    tailFade: project.tailFade,
  });

  const rendered = await offline.startRendering();
  onProgress?.('编码 WAV 文件…');
  return encodeWav(rendered);
}

/** 把缓冲重采样到目标上下文的采样率（通过离线渲染中转） */
async function resampleBuffer(buffer: AudioBuffer, targetCtx: BaseAudioContext): Promise<AudioBuffer> {
  if (buffer.sampleRate === targetCtx.sampleRate) return buffer;
  const temp = new OfflineAudioContext(
    buffer.numberOfChannels,
    Math.ceil(buffer.duration * targetCtx.sampleRate),
    targetCtx.sampleRate,
  );
  const src = temp.createBufferSource();
  src.buffer = buffer;
  src.connect(temp.destination);
  src.start(0);
  return temp.startRendering();
}
