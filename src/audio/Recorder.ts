import { putRecordingBlob } from '../utils/storage';
import { encodeWav } from './wav';

export interface RecordingResult {
  id: string;
  blob: Blob;
  buffer: AudioBuffer;
  duration: number;
}

/**
 * 本地录音：getUserMedia 采集 → ScriptProcessor 收集 PCM → WAV 落盘 IndexedDB。
 * 全部数据留在本机，不经过任何网络。
 * 处理节点经零增益节点接到 destination（ScriptProcessor 必须在图中才会回调），
 * 避免麦克风信号直接从扬声器播放造成回授啸叫。
 */
export class Recorder {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private collected: Float32Array[] = [];
  private active = false;

  get isActive(): boolean {
    return this.active;
  }

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctor();
    await this.ctx.resume();

    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.processor = this.ctx.createScriptProcessor(4096, 1, 1);
    this.collected = [];
    this.processor.onaudioprocess = (e) => {
      this.collected.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    };

    // 零增益桥接：保证处理节点运行，同时不向外放出麦克风声音
    const silence = this.ctx.createGain();
    silence.gain.value = 0;
    this.source.connect(this.processor);
    this.processor.connect(silence);
    silence.connect(this.ctx.destination);
    this.active = true;
  }

  /** 停止并把结果写入 IndexedDB，返回资源描述所需信息 */
  async stop(id: string): Promise<RecordingResult> {
    if (!this.ctx || !this.active) throw new Error('没有进行中的录音');
    const sampleRate = this.ctx.sampleRate;
    const length = this.collected.reduce((n, chunk) => n + chunk.length, 0);
    const buffer = this.ctx.createBuffer(1, length, sampleRate);
    const channel = buffer.getChannelData(0);
    let offset = 0;
    for (const chunk of this.collected) {
      channel.set(chunk, offset);
      offset += chunk.length;
    }

    this.teardown();
    const blob = encodeWav(buffer);
    await putRecordingBlob(id, blob);
    return { id, blob, buffer, duration: buffer.duration };
  }

  cancel(): void {
    this.teardown();
  }

  private teardown(): void {
    try {
      this.processor?.disconnect();
      this.source?.disconnect();
    } catch {
      /* 节点可能已断开 */
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close();
    this.ctx = null;
    this.stream = null;
    this.processor = null;
    this.source = null;
    this.collected = [];
    this.active = false;
  }
}
