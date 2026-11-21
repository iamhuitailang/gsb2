import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectImageIds,
  createEmptyProject,
  createPairDraft,
  normalizeProject,
  serializeProject,
  alignmentMethodLabel,
  pairStatusLabel,
} from '../src/core/project.js';
import { buildReportData, reportToHtml, reportToMarkdown, resultsToJson } from '../src/core/report.js';

function fakePair(index = 1, overrides = {}) {
  return {
    id: `pair_${index}`,
    name: `对比 ${index}`,
    a: {
      imageId: `img_a_${index}`,
      name: `首页-${index}-A`,
      version: 'v3',
      width: 1200,
      height: 900,
    },
    b: {
      imageId: `img_b_${index}`,
      name: `首页-${index}-B`,
      version: 'v4',
      width: 1080,
      height: 810,
    },
    alignment: { tx: 40, ty: 20, scale: 1.111, rotation: 0 },
    alignmentMethod: 'corners+manual',
    cornerPoints: [
      { ax: 10, ay: 10, bx: 9, by: 9 },
      { ax: 100, ay: 10, bx: 90, by: 9 },
    ],
    cornerFit: { count: 2, rms: 0.4, maxError: 0.6, appliedAt: '2026-03-01T00:00:00Z' },
    notes: '主按钮颜色有变化\n需要设计确认',
    diffSettings: { sensitivity: 62, minRegionArea: 30, includeUncovered: true },
    ignoreStrokes: [
      {
        id: 's1',
        mode: 'paint',
        size: 30,
        points: [
          { x: 10, y: 10 },
          { x: 40, y: 30 },
        ],
      },
    ],
    status: 'attention',
    ...overrides,
  };
}

const fakeStats = {
  comparedArea: 800000,
  changedArea: 4200,
  changedColorArea: 4200,
  coverageArea: 0,
  ignoredArea: 900,
  totalArea: 1200000,
  comparedPixels: 800000,
  changedPixels: 4200,
  ignoredPixels: 900,
  changedPct: 0.53,
  changedPctOfTotal: 0.35,
  ignoredPctOfTotal: 0.08,
  regionCount: 2,
  threshold: 24,
};

function fakeDiffResult() {
  return {
    stats: { ...fakeStats },
    regions: [
      {
        id: 1,
        index: 1,
        type: 'color',
        area: 3200,
        bbox: { x: 120, y: 240, width: 80, height: 40 },
        centroid: { x: 160, y: 260 },
        colorArea: 3200,
        coverageArea: 0,
      },
      {
        id: 2,
        index: 2,
        type: 'coverage',
        area: 1000,
        bbox: { x: 500, y: 300, width: 40, height: 25 },
        centroid: { x: 520, y: 312 },
        colorArea: 0,
        coverageArea: 1000,
      },
    ],
  };
}

test('round-trips a project through serialize + normalize', () => {
  const project = createEmptyProject('首页版本对比');
  project.pairs = [fakePair(1), fakePair(2)];
  const payload = serializeProject(project);
  const { project: restored, warnings } = normalizeProject(payload);
  assert.equal(warnings.length, 0);
  assert.equal(restored.name, '首页版本对比');
  assert.equal(restored.pairs.length, 2);
  assert.deepEqual(restored.pairs[0].alignment, project.pairs[0].alignment);
  assert.equal(restored.pairs[0].notes, '主按钮颜色有变化\n需要设计确认');
  assert.equal(restored.pairs[0].ignoreStrokes.length, 1);
  assert.equal(restored.pairs[0].diffSettings.sensitivity, 62);
  assert.equal(restored.pairs[0].alignmentMethod, 'corners+manual');
});

test('normalizeProject skips malformed pairs and reports warnings', () => {
  const { project, warnings } = normalizeProject({
    name: '坏项目',
    pairs: [{ name: '缺少图片' }, fakePair(1, { id: 'ok' })],
  });
  assert.equal(project.pairs.length, 1);
  assert.equal(project.pairs[0].id, 'ok');
  assert.ok(warnings.length >= 1);
});

test('normalizeProject clamps unknown values to defaults', () => {
  const pair = fakePair(1, {
    alignment: { tx: 0, ty: 0, scale: 0, rotation: NaN },
    diffSettings: { sensitivity: 999, minRegionArea: -4, includeUncovered: 'yes' },
    status: 'bogus',
    alignmentMethod: 'nope',
  });
  const { project } = normalizeProject({ name: 't', pairs: [pair] });
  const normalized = project.pairs[0];
  assert.ok(normalized.alignment.scale > 0);
  assert.equal(normalized.alignment.rotation, 0);
  assert.equal(normalized.diffSettings.sensitivity, 100);
  assert.equal(normalized.diffSettings.minRegionArea, 0);
  assert.equal(normalized.diffSettings.includeUncovered, true);
  assert.equal(normalized.status, 'unreviewed');
  assert.equal(normalized.alignmentMethod, 'initial');
});

test('normalizeProject keeps ignore strokes but drops empty ones', () => {
  const pair = fakePair(1, {
    ignoreStrokes: [
      { id: 'keep', mode: 'paint', size: 20, points: [{ x: 3, y: 4 }] },
      { id: 'drop', mode: 'paint', size: 20, points: [] },
    ],
  });
  const { project } = normalizeProject({ name: 't', pairs: [pair] });
  assert.equal(project.pairs[0].ignoreStrokes.length, 1);
  assert.equal(project.pairs[0].ignoreStrokes[0].id, 'keep');
});

test('createPairDraft fills sensible defaults', () => {
  const draft = createPairDraft({
    a: { imageId: 'a1', name: 'A', width: 100, height: 100 },
    b: { imageId: 'b1', name: 'B', width: 50, height: 50 },
    alignment: { tx: 25, ty: 25, scale: 1, rotation: 0 },
  });
  assert.equal(draft.status, 'unreviewed');
  assert.equal(draft.ignoreStrokes.length, 0);
  assert.equal(draft.alignmentMethod, 'initial');
  assert.equal(draft.diffSettings.sensitivity, 55);
  assert.ok(draft.id.startsWith('pair_'));
});

test('collectImageIds dedupes across pairs', () => {
  const project = createEmptyProject();
  project.pairs = [
    fakePair(1, { a: { imageId: 'shared', name: 'A', width: 1, height: 1 } }),
    fakePair(2, { b: { imageId: 'shared', name: 'B', width: 1, height: 1 } }),
  ];
  assert.deepEqual(collectImageIds(project).sort(), [
    'img_a_2',
    'img_b_1',
    'shared',
  ]);
});

test('labels cover every alignment method and status', () => {
  assert.equal(alignmentMethodLabel('corners'), '角点辅助对齐');
  assert.equal(alignmentMethodLabel('corners+manual'), '角点对齐 + 手动微调');
  assert.equal(alignmentMethodLabel('whatever'), '初始居中对齐');
  assert.equal(pairStatusLabel('confirmed'), '已确认');
  assert.equal(pairStatusLabel('attention'), '需修改');
  assert.equal(pairStatusLabel('nope'), '待检查');
});

test('report data summarises pairs, stats and statuses', () => {
  const project = createEmptyProject('季度视觉回归');
  project.pairs = [fakePair(1), fakePair(2, { status: 'confirmed' })];
  const pairResults = new Map([
    ['pair_1', fakeDiffResult()],
    ['pair_2', { ...fakeDiffResult(), stats: { ...fakeStats, changedArea: 800, regionCount: 1 }, regions: [fakeDiffResult().regions[0]] }],
  ]);
  const data = buildReportData({ project, pairResults, generatedAt: '2026-04-01T10:00:00.000Z' });
  assert.equal(data.summary.pairCount, 2);
  assert.equal(data.summary.imageCount, 4);
  assert.equal(data.summary.statusCounts.attention, 1);
  assert.equal(data.summary.statusCounts.confirmed, 1);
  assert.equal(data.summary.totalRegionCount, 3);
  assert.equal(data.summary.totalChangedArea, 5000);
  assert.equal(data.pairs[0].stats.changedArea, 4200);
  assert.equal(data.pairs[0].alignmentMethodLabel, '角点对齐 + 手动微调');
  assert.equal(data.pairs[0].ignoreStrokeCount, 1);
});

test('HTML report escapes user text and embeds key facts', () => {
  const project = createEmptyProject('报告 <测试>');
  project.pairs = [
    fakePair(1, {
      name: '首页 <script>alert(1)</script>',
      notes: '改动：颜色 & 位置',
      a: { imageId: 'x', name: 'A & B', version: '<v1>', width: 100, height: 100 },
    }),
  ];
  const pairResults = new Map([['pair_1', fakeDiffResult()]]);
  const data = buildReportData({ project, pairResults });
  const html = reportToHtml(data);
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('报告 &lt;测试&gt;'));
  assert.ok(html.includes('改动：颜色 &amp; 位置'));
  assert.ok(html.includes('差异面积'));
  assert.ok(html.includes('本机'));
});

test('Markdown report contains per-pair sections and region table', () => {
  const project = createEmptyProject('Markdown 项目');
  project.pairs = [fakePair(1)];
  const pairResults = new Map([['pair_1', fakeDiffResult()]]);
  const data = buildReportData({ project, pairResults });
  const md = reportToMarkdown(data);
  assert.ok(md.startsWith('# Markdown 项目'));
  assert.ok(md.includes('## 1. 对比 1'));
  assert.ok(md.includes('| 1 | 颜色差异 |'));
  assert.ok(md.includes('主按钮颜色有变化'));
  assert.ok(md.includes('忽略面积'));
});

test('JSON result export omits embedded image assets', () => {
  const project = createEmptyProject('json');
  project.pairs = [fakePair(1)];
  const pairResults = new Map([['pair_1', fakeDiffResult()]]);
  const data = buildReportData({
    project,
    pairResults,
    assets: { pair_1: { diff: 'data:image/png;base64,AAAA' } },
  });
  const parsed = JSON.parse(resultsToJson(data));
  assert.equal(parsed.pairs.length, 1);
  assert.equal(parsed.pairs[0].assets, undefined);
  assert.equal(parsed.pairs[0].regions.length, 2);
  assert.equal(parsed.reportVersion, '1.0');
});

test('report handles pairs without computed results', () => {
  const project = createEmptyProject('空结果');
  project.pairs = [fakePair(1)];
  const data = buildReportData({ project, pairResults: new Map() });
  assert.equal(data.pairs[0].stats, null);
  assert.equal(data.pairs[0].regions.length, 0);
  assert.equal(data.summary.changedPairCount, 0);
  const html = reportToHtml(data);
  assert.ok(html.includes('未检测到超过阈值的差异区域'));
});
