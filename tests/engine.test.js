import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../src/engine/engine.js';
import { pointInZone, segmentIntersectsZone, sampleSegment, segmentsIntersect } from '../src/engine/geometry.js';
import { ACTION, EVENT, RULES_LENIENT, RULES_STRICT } from '../src/engine/events.js';
import { buildFrames, createRecorder, replayInto } from '../src/engine/recorder.js';
import { buildPresetScenes, exportBundle } from '../src/engine/presets.js';

const circle = (rules = {}) => ({
  id: 'z1', name: 'C', shape: 'circle',
  center: { x: 100, y: 100 }, radius: 50,
  stayIntervalMs: 100, graceMs: 0, rules,
});

function run(engine, frames) {
  const out = [];
  for (const f of frames) out.push(...engine.pushFrame(f));
  return out;
}

test('几何：圆/矩形/多边形包含判定与边界闭区间', () => {
  assert.equal(pointInZone({ x: 100, y: 100 }, circle()), true);
  assert.equal(pointInZone({ x: 150, y: 100 }, circle()), true); // 边上
  assert.equal(pointInZone({ x: 151, y: 100 }, circle()), false);
  const rect = { shape: 'rect', rect: { x: 0, y: 0, w: 100, h: 80 } };
  assert.equal(pointInZone({ x: 0, y: 0 }, rect), true);
  assert.equal(pointInZone({ x: 100, y: 80 }, rect), true);
  assert.equal(pointInZone({ x: 101, y: 40 }, rect), false);
  const tri = { shape: 'polygon', points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }] };
  assert.equal(pointInZone({ x: 10, y: 10 }, tri), true);
  assert.equal(pointInZone({ x: 60, y: 60 }, tri), false);
  assert.equal(pointInZone({ x: 50, y: 0 }, tri), true); // 边上
});

test('几何：线段穿越（高速穿过薄区域不漏检）', () => {
  const z = circle();
  assert.equal(segmentIntersectsZone({ x: 0, y: 100 }, { x: 200, y: 100 }, z), true);
  assert.equal(segmentIntersectsZone({ x: 0, y: 300 }, { x: 200, y: 300 }, z), false);
  const samples = sampleSegment({ x: 0, y: 100 }, { x: 200, y: 100 }, 12);
  assert.ok(samples.some((p) => pointInZone(p, z)));
  assert.ok(segmentsIntersect({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 10, y: 0 }, { x: 0, y: 10 }));
});

test('进入/退出事件与停留独立计时', () => {
  const eng = createEngine();
  eng.addZone(circle());
  const evs = run(eng, [
    { time: 0, pos: { x: 0, y: 100 }, action: ACTION.IDLE },
    { time: 100, pos: { x: 100, y: 100 }, action: ACTION.WALK }, // enter
    { time: 200, pos: { x: 100, y: 100 }, action: ACTION.IDLE }, // stay 100
    { time: 300, pos: { x: 100, y: 100 }, action: ACTION.IDLE }, // stay 200
    { time: 400, pos: { x: 220, y: 100 }, action: ACTION.WALK }, // exit (grace 0)
  ]);
  const types = evs.map((e) => e.type);
  assert.deepEqual(types, [EVENT.ENTER, EVENT.STAY, EVENT.STAY, EVENT.EXIT]);
  const st = eng.getState('z1');
  assert.equal(st.counts.enter, 1);
  assert.equal(st.counts.stay, 2);
  assert.equal(st.counts.exit, 1);
  assert.equal(st.inside, false);
});

test('边界抖动：宽限窗内来回挪动不重复进入', () => {
  const eng = createEngine();
  eng.addZone({ ...circle(), graceMs: 150 });
  const evs = run(eng, [
    { time: 0, pos: { x: 100, y: 100 }, action: ACTION.IDLE },   // enter
    { time: 100, pos: { x: 155, y: 100 }, action: ACTION.WALK }, // 出，进宽限
    { time: 150, pos: { x: 100, y: 100 }, action: ACTION.WALK }, // 宽限内回来
    { time: 200, pos: { x: 155, y: 100 }, action: ACTION.WALK }, // 再出
    { time: 250, pos: { x: 100, y: 100 }, action: ACTION.WALK }, // 再回来
    { time: 500, pos: { x: 220, y: 100 }, action: ACTION.WALK }, // 正式离开
    { time: 700, pos: { x: 220, y: 100 }, action: ACTION.IDLE }, // 宽限到期 exit
  ]);
  assert.equal(evs.filter((e) => e.type === EVENT.ENTER).length, 1);
  assert.equal(evs.filter((e) => e.type === EVENT.EXIT).length, 1);
});

test('同帧多区变化保持固定顺序（z1->z2->z3）', () => {
  const eng = createEngine();
  eng.addZone({ ...circle(), id: 'z3', center: { x: 100, y: 100 }, radius: 5 });
  eng.addZone({ ...circle(), id: 'z1', center: { x: 100, y: 100 }, radius: 5 });
  eng.addZone({ ...circle(), id: 'z2', center: { x: 100, y: 100 }, radius: 5 });
  const evs = run(eng, [
    { time: 0, pos: { x: 0, y: 0 }, action: ACTION.IDLE },
    { time: 100, pos: { x: 100, y: 100 }, action: ACTION.WALK },
  ]);
  const enters = evs.filter((e) => e.type === EVENT.ENTER).map((e) => e.zoneId);
  assert.deepEqual(enters, ['z1', 'z2', 'z3']);
  // seq 与区域顺序一致
  assert.ok(evs[0].seq < evs[1].seq && evs[1].seq < evs[2].seq);
});

test('动作规则：严格模式瞬移/dash 不算，宽松模式算', () => {
  const strict = createEngine();
  strict.addZone(circle(RULES_STRICT));
  const sEvs = run(strict, [
    { time: 0, pos: { x: 0, y: 100 }, action: ACTION.IDLE },
    { time: 100, pos: { x: 100, y: 100 }, from: { x: 0, y: 100 }, action: ACTION.TELEPORT },
    { time: 200, pos: { x: 300, y: 100 }, from: { x: 100, y: 100 }, action: ACTION.DASH, durationMs: 50 },
  ]);
  assert.equal(sEvs.some((e) => e.type === EVENT.ENTER), false);

  const lenient = createEngine();
  lenient.addZone(circle(RULES_LENIENT));
  const lEvs = run(lenient, [
    { time: 0, pos: { x: 0, y: 100 }, action: ACTION.IDLE },
    { time: 100, pos: { x: 100, y: 100 }, from: { x: 0, y: 100 }, action: ACTION.TELEPORT },
  ]);
  assert.equal(lEvs[0].type, EVENT.ENTER);
  assert.match(lEvs[0].reason, /teleportLand/);

  const dash = createEngine();
  dash.addZone(circle(RULES_LENIENT));
  const dEvs = run(dash, [
    { time: 0, pos: { x: 0, y: 100 }, action: ACTION.IDLE },
    { time: 50, pos: { x: 200, y: 100 }, from: { x: 0, y: 100 }, action: ACTION.DASH, durationMs: 50 },
  ]);
  assert.equal(dEvs[0].type, EVENT.ENTER);
  assert.match(dEvs[0].reason, /采样/);
});

test('teleportExit=false：瞬移出区静默置外不发退出', () => {
  const eng = createEngine();
  eng.addZone(circle({ ...RULES_STRICT, teleportExit: false }));
  const evs = run(eng, [
    { time: 0, pos: { x: 100, y: 100 }, action: ACTION.IDLE }, // enter
    { time: 100, pos: { x: 300, y: 100 }, from: { x: 100, y: 100 }, action: ACTION.TELEPORT },
  ]);
  assert.deepEqual(evs.map((e) => e.type), [EVENT.ENTER]);
  assert.equal(eng.getState('z1').inside, false);
});

test('一次触发模式：每类事件只发一次', () => {
  const eng = createEngine();
  eng.addZone({ ...circle(), triggerMode: 'once', graceMs: 0 });
  run(eng, [
    { time: 0, pos: { x: 100, y: 100 }, action: ACTION.IDLE },
    { time: 100, pos: { x: 300, y: 100 }, action: ACTION.WALK },
    { time: 200, pos: { x: 100, y: 100 }, action: ACTION.WALK },
    { time: 300, pos: { x: 300, y: 100 }, action: ACTION.WALK },
    { time: 400, pos: { x: 100, y: 100 }, action: ACTION.WALK },
  ]);
  const st = eng.getState('z1');
  assert.equal(st.counts.enter, 1);
  assert.equal(st.counts.exit, 1);
});

test('禁用/启用：禁用强制退出，重新启用按位置对账', () => {
  const eng = createEngine();
  eng.addZone(circle());
  run(eng, [
    { time: 0, pos: { x: 100, y: 100 }, action: ACTION.IDLE }, // enter
  ]);
  const off = eng.setEnabled('z1', false);
  assert.equal(off[0].type, EVENT.EXIT);
  assert.match(off[0].reason, /禁用/);
  assert.equal(eng.zoneById('z1').enabled, false);
  // 禁用期间帧不产生事件
  const silent = run(eng, [{ time: 100, pos: { x: 100, y: 100 }, action: ACTION.WALK }]);
  assert.equal(silent.length, 0);
  const on = eng.setEnabled('z1', true);
  assert.equal(on[0].type, EVENT.ENTER);
  assert.match(on[0].reason, /重新启用/);
});

test('存档/恢复：snapshot 后重建事件完全一致', () => {
  const eng = createEngine();
  eng.addZone(circle());
  const frames = buildFrames([
    { pos: { x: 0, y: 100 }, action: ACTION.IDLE },
    { pos: { x: 100, y: 100 }, action: ACTION.WALK },
    { pos: { x: 300, y: 100 }, action: ACTION.WALK },
  ]);
  run(eng, frames);
  const snap = eng.snapshot();
  const eng2 = createEngine();
  eng2.restore(snap);
  assert.deepEqual(eng2.events.map((e) => e.seq), eng.events.map((e) => e.seq));
  assert.deepEqual(eng2.events.map((e) => e.type), eng.events.map((e) => e.type));
  assert.deepEqual(eng2.position, eng.position);
});

test('录制回放：重放产生相同事件，跳转帧可重建场景', () => {
  const preset = buildPresetScenes();
  const eng = createEngine();
  preset.scenes.lenient.zones.forEach((z) => eng.addZone(z));
  const rec = createRecorder();
  rec.start();
  const live = [];
  for (const f of preset.frames) {
    rec.record(f);
    live.push(...eng.pushFrame(f));
  }
  rec.stop();
  const eng2 = createEngine();
  preset.scenes.lenient.zones.forEach((z) => eng2.addZone(z));
  replayInto(eng2, rec.frames);
  assert.deepEqual(
    eng2.events.map((e) => `${e.frame}:${e.zoneId}:${e.type}`),
    eng.events.map((e) => `${e.frame}:${e.zoneId}:${e.type}`)
  );
  // 跳到第 5 帧
  const eng3 = createEngine();
  preset.scenes.lenient.zones.forEach((z) => eng3.addZone(z));
  replayInto(eng3, rec.frames, 5);
  assert.ok(eng3.events.every((e) => e.frame <= 5));
  const bundle = exportBundle(eng, rec.frames, { canvas: preset.canvas });
  assert.equal(bundle.frames.length, rec.frames.length);
  assert.ok(bundle.events.length > 0);
});

test('resetCounters：seek 重建后帧号从 0 重新编号（回归）', () => {
  const preset = buildPresetScenes();
  const eng = createEngine();
  preset.scenes.lenient.zones.forEach((z) => eng.addZone(z));
  for (const f of preset.frames) eng.pushFrame(f);
  assert.ok(eng.frameIndex > 5);
  replayInto(eng, preset.frames, 5);
  assert.equal(eng.frameIndex, 5);
  assert.ok(eng.events.every((e) => e.frame <= 5));
  assert.equal(eng.events[0].seq, 1); // 事件 seq 按引擎实例从 1 开始
});

test('重叠区域独立计时：同一驻留段各自产生停留事件', () => {
  const preset = buildPresetScenes();
  const eng = createEngine();
  preset.scenes.lenient.zones.forEach((z) => eng.addZone(z));
  for (const f of preset.frames) eng.pushFrame(f);
  const z1Stay = eng.events.filter((e) => e.zoneId === 'z1' && e.type === EVENT.STAY).length;
  const z2Stay = eng.events.filter((e) => e.zoneId === 'z2' && e.type === EVENT.STAY).length;
  assert.ok(z1Stay >= 1 && z2Stay >= 1);
  // 同帧的两个停留事件仍按固定区域顺序
  const sameFrame = eng.events.filter((e) => e.type === EVENT.STAY);
  for (let i = 1; i < sameFrame.length; i++) {
    if (sameFrame[i].time === sameFrame[i - 1].time) {
      assert.ok(sameFrame[i - 1].zoneId < sameFrame[i].zoneId);
    }
  }
});

test('规则对照：同一路线严格/宽松产生可解释的差异', () => {
  const preset = buildPresetScenes();
  const runRules = (key) => {
    const eng = createEngine();
    preset.scenes[key].zones.forEach((z) => eng.addZone(z));
    for (const f of preset.frames) eng.pushFrame(f);
    return eng;
  };
  const strict = runRules('strict');
  const lenient = runRules('lenient');
  // 宽松下 dash 穿过必有进入事件；严格下 dash/teleport 的进入与停留被抑制
  // （退出始终算数，因此只统计 enter/stay）
  const dashEnterL = lenient.events.filter((e) => e.action === ACTION.DASH && e.type !== EVENT.EXIT);
  const dashEnterS = strict.events.filter((e) => e.action === ACTION.DASH && e.type !== EVENT.EXIT);
  assert.ok(dashEnterL.length > 0);
  assert.equal(dashEnterS.length, 0);
  const tpL = lenient.events.filter((e) => e.action === ACTION.TELEPORT && e.type !== EVENT.EXIT);
  const tpS = strict.events.filter((e) => e.action === ACTION.TELEPORT && e.type !== EVENT.EXIT);
  assert.ok(tpL.length > tpS.length);
  // 宽松下事件总数不少于严格（同样路线，规则只会抑制不会新增）
  assert.ok(lenient.events.length >= strict.events.length);
});
