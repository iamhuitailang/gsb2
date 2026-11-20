import test from 'node:test';
import assert from 'node:assert/strict';
import { ProjectStore, createEmptyDocument, normalizeDocument, makeId } from '../public/js/core/model.js';

function fixedIdFactory() {
  let counter = 0;
  return (prefix = 'id') => `${prefix}_${(counter += 1)}`;
}

function seededStore() {
  const store = new ProjectStore({ idFactory: fixedIdFactory(), now: () => 1700000000000 });
  store.setAudio({ fileName: 'a.wav', duration: 30, sampleRate: 44100, channels: 1, source: 'local' });
  return store;
}

test('新建区间以秒保存并限制在音频范围内', () => {
  const store = seededStore();
  const region = store.addRegion({ start: 1.234, end: 4.567 });
  assert.equal(region.start, 1.234);
  assert.equal(region.end, 4.567);
  const bounded = store.addRegion({ start: 28, end: 40 });
  assert.equal(bounded.end, 30);
  const negative = store.addRegion({ start: -5, end: 0.5 });
  assert.equal(negative.start, 0);
});

test('极短区间自动扩展到最短长度', () => {
  const store = seededStore();
  const region = store.addRegion({ start: 2, end: 2 });
  assert.ok(region.end - region.start >= 0.02);
});

test('移动与拉伸不改变未触及的一端', () => {
  const store = seededStore();
  const region = store.addRegion({ start: 5, end: 9 });
  store.updateRegion(region.id, { start: 6 });
  assert.equal(store.getRegion(region.id).start, 6);
  assert.equal(store.getRegion(region.id).end, 9);
  store.updateRegion(region.id, { end: 11.5 });
  assert.equal(store.getRegion(region.id).end, 11.5);
});

test('拉伸不能让起点越过终点', () => {
  const store = seededStore();
  const region = store.addRegion({ start: 5, end: 9 });
  store.updateRegion(region.id, { start: 12 });
  const updated = store.getRegion(region.id);
  assert.ok(updated.start <= updated.end - 0.02 + 1e-9);
});

test('允许重叠区间，并且删除互不影响', () => {
  const store = seededStore();
  const a = store.addRegion({ start: 1, end: 5 });
  const b = store.addRegion({ start: 3, end: 7 });
  assert.equal(store.doc.regions.length, 2);
  assert.ok(store.doc.regions.some((r) => r.start === 3));
  store.removeRegions([a.id]);
  assert.equal(store.doc.regions.length, 1);
  assert.equal(store.doc.regions[0].id, b.id);
});

test('修改说话人名称后区间引用同步且时间不变', () => {
  const store = seededStore();
  const speaker = store.doc.speakers[1];
  const region = store.addRegion({ start: 2, end: 6, speakerId: speaker.id });
  const before = { start: region.start, end: region.end };
  store.renameSpeaker(speaker.id, '王工程师');
  const after = store.getRegion(region.id);
  assert.equal(store.getSpeaker(after.speakerId).name, '王工程师');
  assert.deepEqual({ start: after.start, end: after.end }, before);
  assert.equal(after.id, region.id);
});

test('修改标注类型名称后区间显示同步且时间不变', () => {
  const store = seededStore();
  const label = store.doc.labels[0];
  const region = store.addRegion({ start: 2, end: 6, labelId: label.id });
  const before = region.start;
  store.updateLabel(label.id, { name: '主持发言' });
  const after = store.getRegion(region.id);
  assert.equal(store.regionLabel(after).name, '主持发言');
  assert.equal(after.start, before);
});

test('备注与置信状态可修改并校验', () => {
  const store = seededStore();
  const region = store.addRegion({ start: 2, end: 6 });
  store.updateRegion(region.id, { note: '听不清“第三季度”', confidence: 'inaudible' });
  const updated = store.getRegion(region.id);
  assert.equal(updated.note, '听不清“第三季度”');
  assert.equal(updated.confidence, 'inaudible');
  store.updateRegion(region.id, { confidence: 'not-a-level' });
  assert.equal(store.getRegion(region.id).confidence, 'inaudible');
});

test('撤销与重做只作用于标注，不涉及音轨', () => {
  const store = seededStore();
  const region = store.addRegion({ start: 2, end: 6 });
  store.updateRegion(region.id, { start: 3.5, note: '待确认' });
  assert.equal(store.getRegion(region.id).start, 3.5);
  store.undo();
  assert.equal(store.getRegion(region.id).start, 2);
  assert.equal(store.getRegion(region.id).note, '');
  store.redo();
  assert.equal(store.getRegion(region.id).start, 3.5);
  store.undo();
  store.undo();
  assert.equal(store.doc.regions.length, 0);
  // 音轨始终保留，撤销不会把音频「撤掉」
  assert.equal(store.doc.audio.duration, 30);
});

test('事务中的连续拖动只产生一条撤销记录', () => {
  const store = seededStore();
  const region = store.addRegion({ start: 2, end: 6 });
  store.beginTransaction('drag');
  store.updateRegion(region.id, { start: 2.1 }, { history: false });
  store.updateRegion(region.id, { start: 2.2 }, { history: false });
  store.updateRegion(region.id, { start: 2.3 }, { history: false });
  store.endTransaction();
  assert.equal(store.getRegion(region.id).start, 2.3);
  store.undo();
  assert.equal(store.getRegion(region.id).start, 2);
  assert.equal(store.getRegion(region.id).end, 6);
});

test('分割区间产生两个共享属性但时间连续的区间', () => {
  const store = seededStore();
  const region = store.addRegion({ start: 2, end: 8, note: '共同备注' });
  const rightId = store.splitRegionAt(region.id, 5);
  assert.ok(rightId);
  const regions = store.sortedRegions();
  assert.equal(regions.length, 2);
  assert.equal(regions[0].end, 5);
  assert.equal(regions[1].start, 5);
  assert.equal(regions[1].note, '共同备注');
  assert.equal(store.splitRegionAt(region.id, 0.5), null);
});

test('删除类型时区间改用兜底类型；删除说话人保留区间', () => {
  const store = seededStore();
  const label = store.addLabel({ name: '环境声' });
  const speaker = store.addSpeaker({ name: '旁白' });
  const region = store.addRegion({ start: 1, end: 3, labelId: label.id, speakerId: speaker.id });
  store.removeLabel(label.id);
  assert.equal(store.getRegion(region.id).labelId, store.doc.labels[0].id);
  store.removeSpeaker(speaker.id);
  assert.equal(store.getRegion(region.id).speakerId, null);
  assert.equal(store.doc.regions.length, 1);
});

test('换用更短音频时保留越界区间，供用户自行修正', () => {
  const store = seededStore();
  const region = store.addRegion({ start: 20, end: 28 });
  store.setAudio({ fileName: 'b.wav', duration: 10, sampleRate: 44100, channels: 1, source: 'local' });
  const updated = store.getRegion(region.id);
  assert.equal(updated.start, 20);
  assert.equal(updated.end, 28);
  // 微调其中一端不应静默改动另一端或按音频裁剪
  store.updateRegion(region.id, { start: 20.5 });
  assert.equal(store.getRegion(region.id).end, 28);
});

test('normalizeDocument 丢弃无效区间并修复悬空引用', () => {
  const doc = normalizeDocument({
    name: '外部导入',
    audio: { fileName: 'x.wav', duration: 10 },
    labels: [{ id: 'l1', name: '说话' }],
    speakers: [{ id: 's1', name: '甲' }],
    regions: [
      { start: 1, end: 3, labelId: 'l1', speakerId: 's1' },
      { start: 5, end: 5, labelId: 'l1' },
      { start: 'bad', end: 6 },
      { start: 7, end: 20, labelId: 'missing' },
    ],
  }, { idFactory: fixedIdFactory() });
  assert.equal(doc.regions.length, 2);
  // 超出音频时长的区间保留原始时间，避免保护性裁剪丢数据
  assert.equal(doc.regions[1].end, 20);
  assert.equal(doc.regions[1].labelId, 'l1');
  assert.equal(doc.timeUnit, 'seconds');
});

test('createEmptyDocument 包含默认类型与时长为空', () => {
  const doc = createEmptyDocument({ idFactory: fixedIdFactory() });
  assert.ok(doc.labels.length >= 2);
  assert.ok(doc.speakers.length >= 2);
  assert.equal(doc.audio, null);
  assert.equal(doc.timeUnit, 'seconds');
});

test('makeId 生成唯一 id', () => {
  const ids = new Set();
  for (let i = 0; i < 500; i += 1) ids.add(makeId());
  assert.equal(ids.size, 500);
});
