import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeAudio, loadEngine } from './helpers/fake-audio-context.mjs';

installFakeAudio();
const { PlayerEngine } = loadEngine();
const { Samples, TimeStretch } = globalThis;

function loadEngineWith(id) {
  const e = new PlayerEngine();
  const s = Samples.buildAll().find((x) => x.id === id);
  e.loadDecoded({
    sampleRate: s.sampleRate,
    channels: s.channels.map((c) => c.slice()),
    numberOfChannels: s.channels.length,
  });
  return { e, s };
}

test('装载后默认全选，渲染长度按 1/rate 归一化', () => {
  const { e, s } = loadEngineWith('accent');
  e.setPlayback('pitch', 0.5);
  const r = e.renderCurrent();
  assert.equal(r.sourceFrames, s.channels[0].length);
  assert.equal(r.outputFrames, Math.round(s.channels[0].length / 0.5));
  assert.equal(r.buffer.length, r.outputFrames);
});

test('播放中切速度/模式：旧节点被立即 stop，源时间连续（误差<2采样）', async () => {
  const { e } = loadEngineWith('practice');
  e.setPlayback('pitch', 0.5);
  await e.play();
  assert.ok(e.playing);

  // 模拟播放了 0.3 秒输出
  e.ctx.currentTime += 0.3;
  const srcBefore = e.getSourcePosition();

  const oldNode = e.node;
  let stopped = false;
  const origStop = oldNode.stop.bind(oldNode);
  oldNode.stop = () => { stopped = true; origStop(); };

  e.setPlayback('resample', 0.75);
  assert.ok(stopped, '旧声源必须被立即 stop(0)，不能拖音');
  assert.equal(e.ctx._nodes.includes(oldNode) && oldNode.running, false);
  assert.ok(e.playing, '切换后应自动继续播放');

  const srcAfter = e.getSourcePosition();
  assert.ok(Math.abs(srcAfter - srcBefore) < 2,
    '源时间连续：before=' + srcBefore.toFixed(1) + ' after=' + srcAfter.toFixed(1));
  e.stop();
});

test('跳转 seek 后旧声源立即停止，新位置与请求一致', async () => {
  const { e } = loadEngineWith('practice');
  e.setPlayback('pitch', 1);
  await e.play();
  const target = Math.floor(e.source.sampleRate * 3.2);
  e.seek(target);
  assert.equal(e.ctx._nodes.filter((n) => n.running).length, 1, '只剩新节点');
  assert.ok(Math.abs(e.getSourcePosition() - target) < 2);
  e.stop();
});

test('尚未渲染时 seek 也生效（按需渲染后映射到请求位置）', () => {
  const { e } = loadEngineWith('practice');
  assert.equal(e.rendered, null);
  const target = Math.floor(e.source.sampleRate * 2.5);
  e.seek(target);
  assert.ok(e.rendered, 'seek 应触发按需渲染');
  assert.ok(Math.abs(e.getSourcePosition() - target) < 2,
    '位置 ' + e.getSourcePosition() + ' 期望 ' + target);
});

test('循环圈数随输出位置累加，漂移信息有界', async () => {
  const { e } = loadEngineWith('accent');
  e.setPlayback('pitch', 0.5);
  e.renderCurrent();
  await e.play();
  const outSec = e.rendered.outputFrames / e.rendered.sampleRate;
  e.ctx.currentTime += outSec * 3 + outSec * 0.25; // 3.25 圈
  assert.equal(e.getLoopCount(), 3);
  const d = e.getDriftInfo();
  assert.ok(Math.abs(d.accumulatedSec - d.perLoopSec * 3) < 1e-12);
  assert.ok(Math.abs(d.accumulatedSec) < 0.005);
  e.stop();
});

test('非循环播放结束自动回到区间起点', async () => {
  const { e } = loadEngineWith('accent');
  e.setLoop(false);
  e.setPlayback('pitch', 1);
  e.renderCurrent();
  await e.play();
  const node = e.node;
  node.stop(); // 触发假 onended
  assert.equal(e.playing, false);
  assert.equal(e.getSourcePosition(), e.region.start);
});

test('区间过短被拒绝并说明，且不破坏原区间', async () => {
  const { e } = loadEngineWith('practice');
  const before = { ...e.region };
  assert.throws(() => e.setRegion(0, 100), /选中区间过短/);
  assert.deepEqual(e.region, before);
});

test('音量与区间在模式切换间保持不变', async () => {
  const { e } = loadEngineWith('practice');
  e.setVolume(0.33);
  e.setRegion(44100, 88200);
  e.setPlayback('pitch', 0.5);
  await e.play();
  e.setPlayback('resample', 0.5);
  assert.equal(e.gainNode.gain.value, 0.33);
  assert.deepEqual(e.region, { start: 44100, end: 88200 });
  e.stop();
});

test('导出 WAV 并读回：全部校验通过，帧数与所选区间一致', () => {
  const { e } = loadEngineWith('practice');
  e.setRegion(22050, 66150); // 1 秒源区间
  e.setPlayback('pitch', 0.5);
  const { buffer, expected } = e.exportRegionWav();
  assert.equal(expected.frames, Math.round(44100 / 0.5));
  const report = e.verifyExport(buffer, expected);
  assert.ok(report.ok, JSON.stringify(report.checks.filter((c) => !c.pass)));
  assert.equal(report.durationSec, expected.frames / expected.sampleRate);

  // 破坏一个字节后校验应失败
  const corrupted = buffer.slice(0);
  new Uint8Array(corrupted)[44 + 100] ^= 0xff;
  const bad = e.verifyExport(corrupted, expected);
  assert.equal(bad.ok, false);
});

test('重采样模式导出同样通过读回校验', () => {
  const { e } = loadEngineWith('accent');
  e.setPlayback('resample', 2);
  const { buffer, expected } = e.exportRegionWav();
  const report = e.verifyExport(buffer, expected);
  assert.ok(report.ok);
  assert.equal(expected.frames, Math.round(e.region.end / 2));
});

test('stop 是幂等的，废弃节点的 onended 不会回写状态', async () => {
  const { e } = loadEngineWith('accent');
  await e.play();
  const node = e.node;
  e.stop();
  assert.equal(e.playing, false);
  assert.doesNotThrow(() => { node.stop(); e.stop(); e.stop(); });
  assert.equal(e.playing, false);
});

test('未装载素材时操作给出明确错误', async () => {
  const e = new PlayerEngine();
  await assert.rejects(() => e.play(), /尚未载入/);
  assert.throws(() => e.exportRegionWav(), /尚未载入/);
  assert.doesNotThrow(() => e.setPlayback('pitch', 0.5)); // 仅记录参数
  assert.equal(e.rate, 0.5);
});

test('两种模式矩阵：所有合法速度均可渲染且长度精确', () => {
  const { e } = loadEngineWith('accent');
  for (const mode of ['pitch', 'resample']) {
    for (const rate of [0.25, 0.5, 1, 2, 4]) {
      e.setPlayback(mode, rate);
      const r = e.renderCurrent();
      assert.equal(r.outputFrames, Math.round(e.region.end / rate));
      assert.equal(r.mode, mode);
    }
  }
});

test('引擎直接消费 TimeStretch 的边界异常（速度超范围）', () => {
  const { e } = loadEngineWith('accent');
  e.rate = 9;
  assert.throws(() => e.renderCurrent(), /超出可用范围/);
});
