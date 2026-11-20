import test from 'node:test';
import assert from 'node:assert/strict';
import { ProjectStore } from '../public/js/core/model.js';
import {
  buildExportDocument,
  documentFromCsv,
  documentFromJson,
  parseCsv,
  toCsvString,
  toJsonString,
} from '../public/js/core/export.js';

function makeStore() {
  let counter = 0;
  const store = new ProjectStore({ idFactory: (prefix = 'id') => `${prefix}_${(counter += 1)}`, now: () => 1700000000000 });
  store.setAudio({ fileName: '采访 01.wav', duration: 30, sampleRate: 48000, channels: 2, source: 'local' });
  const speaker = store.doc.speakers[1];
  store.addRegion({
    start: 1.5,
    end: 4.25,
    speakerId: speaker.id,
    confidence: 'uncertain',
    note: '这里有个词听不清，可能是“季度”, 需要复核',
  });
  store.addRegion({ start: 4.0, end: 6.75, labelId: store.doc.labels[2].id, confidence: 'inaudible', note: '低语' });
  return store;
}

test('JSON 导出包含时间、标签、说话人与备注', () => {
  const store = makeStore();
  const doc = buildExportDocument(store);
  assert.equal(doc.timeUnit, 'seconds');
  assert.equal(doc.annotations.length, 2);
  const first = doc.annotations[0];
  assert.equal(first.start, 1.5);
  assert.equal(first.end, 4.25);
  assert.equal(first.label, '说话');
  assert.equal(first.speaker, '受访者');
  assert.equal(first.confidence, 'uncertain');
  assert.match(first.note, /季度/);
  assert.equal(first.startTimecode, '00:01.500');
  const text = toJsonString(store);
  assert.doesNotThrow(() => JSON.parse(text));
});

test('JSON 导出按开始时间排序', () => {
  const store = makeStore();
  const doc = buildExportDocument(store);
  const starts = doc.annotations.map((item) => item.start);
  assert.deepEqual(starts, [...starts].sort((a, b) => a - b));
});

test('CSV 导出包含表头和转义后的备注', () => {
  const store = makeStore();
  const csv = toCsvString(store);
  const rows = parseCsv(csv);
  assert.equal(rows[0][0], 'id');
  assert.ok(rows[0].includes('start_seconds'));
  assert.ok(rows[0].includes('speaker'));
  assert.ok(rows[0].includes('note'));
  const firstRow = rows[1];
  const noteIndex = rows[0].indexOf('note');
  assert.match(firstRow[noteIndex], /“季度”, 需要复核/);
});

test('JSON 导入还原时间、标签、说话人与备注', () => {
  const store = makeStore();
  const text = toJsonString(store);
  const doc = documentFromJson(text);
  assert.equal(doc.regions.length, 2);
  const first = doc.regions[0];
  assert.equal(first.start, 1.5);
  assert.equal(first.end, 4.25);
  assert.equal(doc.labels.find((label) => label.id === first.labelId).name, '说话');
  assert.equal(doc.speakers.find((speaker) => speaker.id === first.speakerId).name, '受访者');
  assert.match(first.note, /季度/);
  assert.equal(first.confidence, 'uncertain');
});

test('CSV 导入还原时间并在缺少类型/说话人时自动补建', () => {
  const csv = [
    'start_seconds,end_seconds,label,speaker,confidence,note',
    '2.5,5.25,说话,甲,certain,第一段',
    '5,7.5,声音事件,,uncertain,"含, 逗号"',
  ].join('\n');
  const doc = documentFromCsv(csv, { audio: { fileName: 'a.wav', duration: 10 } });
  assert.equal(doc.regions.length, 2);
  assert.equal(doc.regions[0].start, 2.5);
  assert.equal(doc.regions[0].note, '第一段');
  assert.equal(doc.regions[1].note, '含, 逗号');
  assert.equal(doc.regions[1].confidence, 'uncertain');
  const names = doc.labels.map((label) => label.name);
  assert.ok(names.includes('说话'));
  assert.ok(names.includes('声音事件'));
  assert.equal(doc.speakers[0].name, '甲');
});

test('CSV 导入支持中文表头', () => {
  const csv = ['开始,结束,类型,说话人,备注', '1,2,说话,乙,测试'].join('\n');
  const doc = documentFromCsv(csv, { audio: { fileName: 'a.wav', duration: 10 } });
  assert.equal(doc.regions.length, 1);
  assert.equal(doc.regions[0].start, 1);
  assert.equal(doc.regions[0].note, '测试');
});

test('CSV 没有任何说话人时不凭空补默认说话人', () => {
  const csv = ['start_seconds,end_seconds,label,note', '1,2,说话,无说话人列'].join('\n');
  const doc = documentFromCsv(csv, { audio: { fileName: 'a.wav', duration: 10 } });
  assert.equal(doc.regions.length, 1);
  assert.equal(doc.speakers.length, 0);
  assert.equal(doc.regions[0].speakerId, null);
});

test('导出的 CSV 可直接再导入（含时间码列回退）', () => {
  const store = makeStore();
  const csv = toCsvString(store);
  const doc = documentFromCsv(csv, { audio: { fileName: 'a.wav', duration: 30 } });
  assert.equal(doc.regions.length, 2);
  assert.equal(doc.regions[0].start, 1.5);
  assert.equal(doc.regions[0].end, 4.25);
});

test('CSV 只有时间码列时也能导入', () => {
  const csv = [
    'start_timecode,end_timecode,label,speaker,confidence,note',
    '00:02.500,00:05.250,说话,甲,certain,时间码',
  ].join('\n');
  const doc = documentFromCsv(csv, { audio: { fileName: 'a.wav', duration: 10 } });
  assert.equal(doc.regions.length, 1);
  assert.equal(doc.regions[0].start, 2.5);
  assert.equal(doc.regions[0].end, 5.25);
  assert.equal(doc.regions[0].note, '时间码');
});

test('CSV 缺少时间列时抛出可读错误', () => {
  assert.throws(() => documentFromCsv('foo,bar\n1,2'), /开始\/结束时间/);
});

test('CSV 解析引号、换行与 BOM', () => {
  const rows = parseCsv('﻿a,b\n"x,1","line\nbreak"\n');
  assert.deepEqual(rows[0], ['a', 'b']);
  assert.deepEqual(rows[1], ['x,1', 'line\nbreak']);
});

test('导出后可再导入，时间与备注保持一致（往返）', () => {
  const store = makeStore();
  const json = toJsonString(store);
  const restored = documentFromJson(json);
  const before = store.sortedRegions().map(({ start, end, note, confidence }) => ({ start, end, note, confidence }));
  const after = restored.regions.map(({ start, end, note, confidence }) => ({ start, end, note, confidence }));
  assert.deepEqual(after, before);

  const csv = toCsvString(store);
  const fromCsv = documentFromCsv(csv, { audio: { fileName: 'a.wav', duration: 30 } });
  const csvTimes = fromCsv.regions.map(({ start, end }) => ({ start, end }));
  assert.deepEqual(csvTimes, before.map(({ start, end }) => ({ start, end })));
});
