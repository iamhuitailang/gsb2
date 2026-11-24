import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Recorder, demoRecording } from '../src/audio/recorder.ts';

test('停止时为仍按住的键自动补 noteOff', () => {
  const rec = new Recorder();
  rec.start(0);
  rec.recordOn(0.1, 60, 96);
  rec.recordOn(0.2, 64, 80);
  rec.recordOff(0.5, 60);
  const out = rec.stop(1.0);
  const offs = out.events.filter((e) => e.type === 'off');
  assert.equal(offs.length, 2);
  // 64 没收到 noteOff，停止时刻自动补齐
  const autoOff = out.events.find((e) => e.type === 'off' && e.note === 64);
  assert.ok(autoOff);
  assert.equal(autoOff!.time, 1.0);
  // 导出时长在最后一个事件之后留出尾音余量
  assert.ok(out.duration > 1.0);
});

test('事件按时间排序，同一时刻 off 排在 on 前（先收后起，音头不丢）', () => {
  const rec = new Recorder();
  rec.start(0);
  rec.recordOn(0.3, 60, 96);
  rec.recordOff(0.3, 60);
  const out = rec.stop(0.6);
  assert.equal(out.events[0].type, 'off');
  assert.equal(out.events[1].type, 'on');
});

test('示例片段结构完整：每个 on 都有对应 off', () => {
  const demo = demoRecording();
  const onNotes = demo.events.filter((e) => e.type === 'on');
  const offNotes = demo.events.filter((e) => e.type === 'off');
  assert.equal(onNotes.length, offNotes.length);
  assert.ok(demo.duration >= Math.max(...demo.events.map((e) => e.time)));
});
