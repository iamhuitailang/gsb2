import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createProject,
  addCut,
  removeCut,
  moveCut,
  setSegmentCamera,
  setSourceOffset,
  buildSegments,
  timelineBounds,
  coverageAt,
  segmentAt,
  diffCuts,
  diffOffsets,
} from '../src/core/model.js';
import { parseFps, snapToFrame, timeToFrame, formatTimecode } from '../src/core/time.js';
import { bestCorrelation, estimateOffset, ENVELOPE_RATE } from '../src/core/sync.js';
import { buildEDL, edlToCsv, CSV_COLUMNS } from '../src/core/edl.js';
import { serializeProject, deserializeProject } from '../src/core/persistence.js';

function makeProject() {
  const p = createProject();
  // A: 0..6, 25fps；B: 0..8, 30fps
  p.sources.push(
    { id: 'A', name: 'A.mp4', kind: 'video', duration: 6, fps: 25, offset: 0, hasAudio: true },
    { id: 'B', name: 'B.mp4', kind: 'video', duration: 8, fps: 30, offset: 0, hasAudio: true },
  );
  p.cuts.push({ id: 'c0', time: 0, sourceId: 'A' });
  return p;
}

test('parseFps 支持小数与分数字符串', () => {
  assert.equal(parseFps('30000/1001'), 30000 / 1001);
  assert.equal(parseFps('29.97'), 29.97);
  assert.equal(parseFps(25), 25);
  assert.equal(parseFps('bad'), 30);
});

test('snapToFrame 吸附到帧网格', () => {
  assert.equal(snapToFrame(0.11, 25), 0.12); // 0.11/0.04=2.75 -> 3 帧
  assert.equal(timeToFrame(0.12, 25), 3);
  assert.equal(snapToFrame(0, 30), 0);
});

test('时间线范围支持负偏移', () => {
  const p = makeProject();
  p.sources[1].offset = -2;
  const b = timelineBounds(p);
  assert.equal(b.min, -2);
  assert.equal(b.max, 6);
});

test('加切点并吸附到切入机位帧网格', () => {
  const p = makeProject();
  const i = addCut(p, 1.11, 'B');
  assert.equal(i, 1);
  assert.equal(p.cuts[1].time, snapToFrame(1.11, 30));
  assert.equal(p.cuts[1].sourceId, 'B');
});

test('移动切点不会越过相邻切点', () => {
  const p = makeProject();
  addCut(p, 2, 'A');
  addCut(p, 4, 'A');
  moveCut(p, 1, 100);
  assert.ok(p.cuts[1].time <= p.cuts[2].time);
  moveCut(p, 2, -100);
  assert.ok(p.cuts[2].time >= p.cuts[1].time);
});

test('第一个切点不可删除', () => {
  const p = makeProject();
  assert.equal(removeCut(p, 0), false);
  addCut(p, 2, 'A');
  assert.equal(removeCut(p, 1), true);
});

test('切换机位后切点吸附到新机位帧率', () => {
  const p = makeProject();
  addCut(p, 1, 'A'); // 25fps 网格
  setSegmentCamera(p, 1, 'B'); // 30fps
  const seg = buildSegments(p)[1];
  assert.equal(seg.sourceId, 'B');
  assert.equal(seg.start, snapToFrame(seg.start, 30));
});

test('coverageAt 明确区分 ok/before/after/gap', () => {
  const p = makeProject();
  p.sources[0].offset = 1; // A 覆盖 1..7
  assert.equal(coverageAt(p, 'A', 0.5).status, 'before');
  assert.equal(coverageAt(p, 'A', 2).status, 'ok');
  assert.equal(coverageAt(p, 'A', 8).status, 'after');
  assert.equal(coverageAt(p, 'X', 2).status, 'gap');
});

test('修改偏移只重算切入该机位的切点，其它机位切点不动', () => {
  const p = makeProject();
  addCut(p, 2, 'A'); // cuts[1] 切入 A
  addCut(p, 3, 'B'); // cuts[2] 切入 B
  addCut(p, 4, 'A'); // cuts[3] 切入 A
  const bCutTime = p.cuts[2].time;
  setSourceOffset(p, 'A', 1); // A 整体后移 1s
  assert.equal(p.cuts[2].time, bCutTime, '切入 B 的切点不应改变');
  // 切入 A 的切点跟随平移；cuts[1] 受相邻 B 切点(3s)顺序约束被限制在其左侧一帧
  assert.ok(p.cuts[1].time < 3);
  assert.equal(p.cuts[1].time, snapToFrame(p.cuts[1].time, 25), '仍吸附在 25fps 网格');
  assert.equal(p.cuts[3].time, 5); // 4+1，无冲突，精确落在网格
  assert.equal(p.cuts[0].time, 1); // 首切点切入 A，跟随平移
});

test('无相邻约束时偏移平移精确吸附帧网格', () => {
  const p = makeProject();
  addCut(p, 2, 'B'); // 只有一个 B 切点，A 仅首切点
  setSourceOffset(p, 'A', 1);
  assert.equal(p.cuts[0].time, snapToFrame(1, 25));
  assert.equal(p.cuts[1].time, 2, 'B 切点不动');
});

test('diffCuts / diffOffsets 能报告变化', () => {
  const p = makeProject();
  const before = structuredClone(p);
  setSourceOffset(p, 'A', 0.5);
  const offs = diffOffsets(before, p);
  assert.equal(offs.length, 1);
  assert.equal(offs[0].after, 0.5);
  const cuts = diffCuts(before, p);
  assert.ok(cuts.length >= 1);
});

test('互相关能识别延迟采样', () => {
  const rate = ENVELOPE_RATE;
  const ref = new Float32Array(rate * 6);
  // 在 1s 与 2s 处放尖峰，两侧留足静音避免边界效应
  ref[rate] = 1;
  ref[rate * 2] = 1;
  const target = new Float32Array(rate * 6);
  target[rate + 20] = 1; // target 的声音晚 100ms
  target[rate * 2 + 20] = 1;
  const { lag, score } = bestCorrelation(ref, target);
  // target[r-lag]=ref[r] 时 target 索引更大 -> lag 为负
  assert.equal(lag, -20);
  assert.ok(score > 0.99);
  // target 晚到意味着它的时间线偏移为负（同样的声音在它本地时间轴上更靠后）
  const est = estimateOffset(ref, target, 0);
  assert.ok(Math.abs(est.offset - (-0.1)) < 1 / rate);
});

test('EDL 包含时间线与原素材双时间坐标并标注越界', () => {
  const p = makeProject();
  p.sources[0].offset = 1; // A: 1..7
  addCut(p, 2, 'A');
  addCut(p, 3, 'B');
  // 造一个越界段：A 段延伸到 7 之后
  addCut(p, 7.5, 'A');
  const edl = buildEDL(p);
  assert.ok(edl.cuts.length >= 3);
  const row = edl.cuts.find((c) => c.status !== 'ok');
  assert.ok(row, '应至少有一段越界');
  assert.match(row.status, /out-of-range/);
  // 所有正常段都有素材内帧号
  const ok = edl.cuts.find((c) => c.status === 'ok');
  assert.ok(ok.sourceStartFrame !== null);
  const csv = edlToCsv(edl);
  assert.ok(csv.startsWith(CSV_COLUMNS.join(',')));
});

test('工程保存后可重新打开并按文件名定位素材', () => {
  const p = makeProject();
  addCut(p, 2, 'B');
  const json = serializeProject(p, 't');
  const handles = [
    { name: 'A.mp4', size: 100 },
    { name: 'B.mp4', size: 200 },
  ];
  const { project, missing } = deserializeProject(JSON.parse(json), handles);
  assert.equal(missing.length, 0);
  assert.equal(project.sources.length, 2);
  assert.equal(project.cuts.length, 2);
  assert.equal(project.cuts[1].sourceId, 'B');
});

test('素材缺失时工程仍可打开，缺失源被保留并标记 missing', () => {
  const p = makeProject();
  const json = serializeProject(p, 't');
  const { project, missing } = deserializeProject(JSON.parse(json), [{ name: 'A.mp4', size: 100 }]);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].name, 'B.mp4');
  assert.equal(project.sources.length, 2); // 源记录保留，handle 为 null
  const b = project.sources.find((s) => s.id === 'B');
  assert.equal(b.handle, null);
  // 引用缺失源的切点因找不到有效源被过滤，剩余切点仍完整
  assert.ok(project.cuts.every((c) => c.sourceId === 'A'));
});

test('formatTimecode 帧位随帧率变化', () => {
  assert.equal(formatTimecode(1, 25), '00:00:01:00');
  assert.equal(formatTimecode(1.04, 25), '00:00:01:01');
});

test('segmentAt 与 buildSegments 区间一致', () => {
  const p = makeProject();
  addCut(p, 2, 'B');
  const seg = segmentAt(p, 2.5);
  assert.equal(seg.sourceId, 'B');
  const segs = buildSegments(p);
  assert.equal(segs.length, 2);
  assert.equal(segs[1].start, 2);
});
