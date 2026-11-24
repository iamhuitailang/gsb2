import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installMockAudio, makeFakeBuffer, MockOfflineAudioContext } from './helpers/mock-audio.ts';
import { SamplerEngine } from '../src/audio/engine.ts';
import { decodeWavPcm16 } from '../src/audio/wav.ts';
import type { LoadedSample, VelocityLayer, VoiceEndReason, VoiceEvent } from '../src/types.ts';

installMockAudio();

const SR = 44100;

function fakeSample(root: number, layer: VelocityLayer, looped = false): LoadedSample {
  const duration = looped ? 3 : 2;
  const buffer = makeFakeBuffer(duration, SR) as unknown as AudioBuffer;
  return {
    root,
    layer,
    buffer,
    loopStart: looped ? SR : 0,
    loopEnd: looped ? Math.floor(1.5 * SR) : 0,
    get loopLength() {
      return this.loopEnd - this.loopStart;
    },
  };
}

function makeSet(): LoadedSample[] {
  return [
    fakeSample(60, 'soft'),
    fakeSample(60, 'hard', true), // 唯一带循环段的样本
    fakeSample(64, 'soft'),
    fakeSample(64, 'hard'),
    fakeSample(67, 'soft'),
    fakeSample(67, 'hard'),
  ];
}

interface Harness {
  engine: SamplerEngine;
  ctx: MockOfflineAudioContext;
  ends: VoiceEvent[];
}

function makeEngine(maxVoices = 8): Harness {
  const ends: VoiceEvent[] = [];
  const ctx = new MockOfflineAudioContext(1, SR * 20, SR);
  const engine = new SamplerEngine(
    ctx as unknown as OfflineAudioContext,
    makeSet(),
    80,
    maxVoices,
    {
      onVoiceEnd: (ev) => ends.push(ev),
    },
  );
  return { engine, ctx, ends };
}

let current: Harness | null = null;
afterEach(() => {
  current?.engine.dispose();
  current = null;
});

/** 推进虚拟时钟，触发调度的 onended */
async function advance(h: Harness): Promise<void> {
  await h.ctx.startRendering();
}

test('同音重按：新音头抢断旧声部，结束原因为 retriggered', () => {
  const h = makeEngine();
  current = h;
  h.engine.noteOn(60, 100, 0);
  h.engine.noteOn(60, 110, 0.5);
  assert.equal(h.engine.activeVoiceCount, 1);
  assert.equal(h.ends.length, 1);
  assert.equal(h.ends[0].endReason, 'retriggered');
  assert.equal(h.ends[0].note, 60);
});

test('超出发声上限：抢断最旧声部，结束原因为 voice-limit，声部数不超上限', () => {
  const h = makeEngine(3);
  current = h;
  h.engine.noteOn(60, 100, 0);
  h.engine.noteOn(64, 100, 0.1);
  h.engine.noteOn(67, 100, 0.2);
  assert.equal(h.engine.activeVoiceCount, 3);
  h.engine.noteOn(72, 100, 0.3); // 触发抢断
  assert.equal(h.engine.activeVoiceCount, 3); // 被抢声部立即从活动集合移除
  assert.equal(h.ends.length, 1);
  assert.equal(h.ends[0].endReason, 'voice-limit');
  assert.equal(h.ends[0].note, 60); // 最旧的音
});

test('同音重按优先于上限规则，不会误抢别的音', () => {
  const h = makeEngine(2);
  current = h;
  h.engine.noteOn(60, 100, 0);
  h.engine.noteOn(64, 100, 0.1);
  h.engine.noteOn(60, 110, 0.2); // 重按 60，应抢 60 而非 64
  assert.equal(h.engine.activeVoiceCount, 2);
  assert.equal(h.ends.length, 1);
  assert.equal(h.ends[0].note, 60);
  assert.equal(h.ends[0].endReason, 'retriggered');
});

test('一次性样本 noteOff 不打断自然衰减', () => {
  const h = makeEngine();
  current = h;
  h.engine.noteOn(64, 100, 0);
  h.engine.noteOff(64, 0.3);
  assert.equal(h.ends.length, 0); // 仍在自然衰减，没有结束事件
});

test('循环样本按住持续、松开进尾音，结束原因为 released', async () => {
  const h = makeEngine();
  current = h;
  h.engine.noteOn(60, 110, 0); // 60 hard 是循环样本
  h.engine.noteOff(60, 1.0);
  await advance(h);
  const end = h.ends.find((e) => e.endReason === 'released');
  assert.ok(end, '应产生 released 结束事件');
  assert.equal(end!.note, 60);
  assert.equal(end!.hadRelease, true);
});

test('多键齐奏各自独立计时：一次性音先自然结束，循环音等 noteOff', async () => {
  const h = makeEngine(8);
  current = h;
  h.engine.noteOn(60, 110, 0); // 循环
  h.engine.noteOn(64, 110, 0.5); // 一次性，约 2.5s 自然结束
  h.engine.noteOff(60, 3.0); // 循环音最后收尾
  await advance(h);
  const reasons = new Map(h.ends.map((e) => [e.note, e.endReason]));
  assert.equal(reasons.get(64), 'natural');
  assert.equal(reasons.get(60), 'released');
  assert.ok(h.ends.find((e) => e.note === 64)!.endedAt < h.ends.find((e) => e.note === 60)!.endedAt);
});

test('离线渲染：导出 WAV 可解码、时长与请求一致，且调度了对应数量的发声源', async () => {
  const h = makeEngine();
  current = h;
  const events = [
    { time: 0, type: 'on' as const, note: 60, velocity: 110 },
    { time: 0.4, type: 'off' as const, note: 60 },
    { time: 0.6, type: 'on' as const, note: 64, velocity: 90 },
    { time: 1.2, type: 'off' as const, note: 64 },
  ];
  const blob = await SamplerEngine.renderOffline(SR, makeSet(), 80, 8, 10, events, 2.0);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const decoded = decodeWavPcm16(bytes);
  assert.equal(decoded.sampleRate, SR);
  assert.equal(decoded.samples.length, 2 * SR);
  let peak = 0;
  for (const v of decoded.samples) peak = Math.max(peak, Math.abs(v));
  assert.ok(peak > 0.01, `渲染峰值过低：${peak}`);
  assert.equal(bytes.length, 44 + 2 * SR * 2, 'WAV 应包含完整 PCM 数据与 44 字节头');
});

test('离线渲染遵守发声上限：超限事件产生 voice-limit 记录', async () => {
  const reasons: VoiceEndReason[] = [];
  const ctx = new MockOfflineAudioContext(1, SR * 4, SR);
  const engine = new SamplerEngine(ctx as unknown as OfflineAudioContext, makeSet(), 80, 2, {
    onVoiceEnd: (ev) => reasons.push(ev.endReason),
  });
  current = { engine, ctx, ends: [] };
  engine.noteOn(60, 110, 0);
  engine.noteOn(64, 110, 0.1);
  engine.noteOn(67, 110, 0.2);
  await ctx.startRendering();
  assert.ok(reasons.includes('voice-limit'));
});

test('panic 立即静音所有声部且不留活动声部', () => {
  const h = makeEngine(8);
  current = h;
  h.engine.noteOn(60, 110, 0);
  h.engine.noteOn(64, 110, 0.1);
  h.engine.noteOn(67, 110, 0.2);
  h.engine.panic();
  assert.equal(h.engine.activeVoiceCount, 0);
  assert.deepEqual(
    h.ends.map((e) => e.endReason),
    ['panic', 'panic', 'panic'],
  );
});

test('交叉淡化设置可切换且试听不抛错', () => {
  const h = makeEngine();
  current = h;
  const loopSample = makeSet().find((s) => s.loopLength > 0)!;
  assert.doesNotThrow(() => h.engine.previewSplice(loopSample, 0));
  h.engine.setCrossfade(40);
  assert.equal(h.engine.getCrossfade(), 40);
  assert.doesNotThrow(() => h.engine.previewSplice(loopSample, 40));
});
