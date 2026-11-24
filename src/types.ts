/** 共享类型定义 */

export type VelocityLayer = 'soft' | 'hard';

/** manifest 中对单个样本的描述 */
export interface SampleManifestEntry {
  /** 根音 MIDI 音符号 */
  root: number;
  layer: VelocityLayer;
  /** 相对于 manifest 的文件路径 */
  file: string;
  /** 带循环持续段：loopStart/loopEnd 为采样点序号（左闭右开） */
  loopStart?: number;
  loopEnd?: number;
  /** 标记为故意损坏/缺失的样本，仅供生成器与测试参考 */
  fault?: 'corrupt' | 'missing';
}

export interface SampleManifest {
  sampleRate: number;
  channels: number;
  /** 力度分层阈值：velocity <= threshold 走 soft，否则 hard */
  velocityThreshold: number;
  samples: SampleManifestEntry[];
}

/** 加载完成、可用于发声的样本 */
export interface LoadedSample {
  root: number;
  layer: VelocityLayer;
  buffer: AudioBuffer;
  loopStart: number;
  loopEnd: number;
  /** 0 表示无循环段（一次性钟声） */
  get loopLength(): number;
}

export type SampleFaultKind = 'corrupt' | 'missing' | 'decode-failed';

export interface SampleFailure {
  root: number;
  layer: VelocityLayer;
  file: string;
  kind: SampleFaultKind;
  /** 用于 UI 指出对应键区 */
  keyZone: string;
  message: string;
}

export interface LoadResult {
  manifest: SampleManifest;
  samples: LoadedSample[];
  failures: SampleFailure[];
}

/** 选样结果：引擎与 UI 共用 */
export interface SampleChoice {
  sample: LoadedSample;
  /** 重采样倍率：>1 播放得更高更短 */
  playbackRate: number;
  /** 实际用的根音与力度层 */
  usedRoot: number;
  usedLayer: VelocityLayer;
  /** 选中理由，直接展示给用户 */
  reason: string;
  /** 是否发生了跨层/跨根音回退 */
  fallback: boolean;
}

export type VoiceEndReason =
  | 'natural' // 一次性样本自然播完 / 循环声到达最长保持时间
  | 'released' // 收到 noteOff，走完尾音
  | 'retriggered' // 同音重按被抢断
  | 'voice-limit' // 超出发声上限被抢断
  | 'panic'; // 全停

export interface VoiceEvent {
  id: number;
  note: number;
  velocity: number;
  choice: SampleChoice;
  startedAt: number;
  endedAt: number;
  endReason: VoiceEndReason;
  /** 发声期间是否进入过尾音阶段 */
  hadRelease: boolean;
}

export interface NoteEvent {
  /** 相对于录音起点的秒数 */
  time: number;
  type: 'on' | 'off';
  note: number;
  /** off 事件不携带力度 */
  velocity?: number;
}

export interface Recording {
  version: 1;
  duration: number;
  events: NoteEvent[];
}
