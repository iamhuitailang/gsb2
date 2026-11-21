import test from 'node:test';
import assert from 'node:assert/strict';
import { mistyLighthouseStory, buildSampleStory } from '../src/sample.js';
import { validateStory, findCycles, buildTranslationReport } from '../src/validation.js';
import { buildRuntimeData, exportRuntimeJSON } from '../src/exporter.js';
import { normalizeStory, setText, getText, renameVariable, createEmptyStory } from '../src/story.js';

test('示例剧情：检测到汇合点与循环路径', () => {
  const story = mistyLighthouseStory();
  const report = validateStory(story);
  const cycleIds = new Set(report.cycles.flatMap((cycle) => cycle.nodeIds));
  assert.ok(cycleIds.has('node_keeper_hub'));
  assert.ok(cycleIds.has('node_keeper_talk'));
  assert.ok(report.cycles.length >= 1);
  assert.ok(report.merges.length >= 1);
  const mergeIds = report.merges.map((merge) => merge.nodeId);
  assert.ok(mergeIds.includes('node_door'), '灯塔门口应是汇合点');
  assert.equal(report.entryList.length, 2, '默认开始 + 一个额外入口');
});

test('未设置出路的节点被标记为错误', () => {
  const story = buildSampleStory();
  story.nodes[0].next = '';
  story.nodes[0].choices = [];
  const report = validateStory(story);
  const issue = report.issues.find((item) => item.code === 'DEAD_END' && item.nodeId === 'sample_start');
  assert.ok(issue);
  assert.equal(issue.severity, 'error');
});

test('失效连线被标记为错误', () => {
  const story = buildSampleStory();
  story.nodes[0].choices[0].target = 'node_missing';
  const report = validateStory(story);
  assert.ok(report.issues.some((item) => item.code === 'MISSING_TARGET'));
});

test('未定义变量与语法错误都会报告', () => {
  const story = buildSampleStory();
  story.nodes[0].choices[0].condition = '不存在 >= 1';
  story.nodes[0].choices[1].condition = '好感 >=';
  const report = validateStory(story);
  assert.ok(report.issues.some((item) => item.code === 'UNDECLARED_VARIABLE'));
  assert.ok(report.issues.some((item) => item.code === 'CONDITION_SYNTAX'));
});

test('无初始值的变量在使用时给出警告', () => {
  const story = buildSampleStory();
  story.variables.push({ id: 'var_unset', name: '待定', type: 'number', hasInitial: false, initial: null, description: '' });
  const merge = story.nodes.find((node) => node.id === 'sample_merge');
  merge.choices[0].condition = '待定 > 0';
  const report = validateStory(story);
  assert.ok(report.issues.some((item) => item.code === 'VARIABLE_UNSET'));
  assert.ok(report.issues.some((item) => item.code === 'UNSET_USAGE'));
});

test('孤立节点被标记', () => {
  const story = buildSampleStory();
  story.nodes.push({
    id: 'orphan',
    title: '孤岛',
    type: 'end',
    position: { x: 3000, y: 3000 },
    characterId: '',
    speaker: {},
    text: { 'zh-CN': '没有人会来到这里。' },
    staleLocales: [],
    entry: false,
    entryLabel: '',
    onEnter: [],
    next: '',
    choices: [],
    notes: '',
  });
  const report = validateStory(story);
  assert.ok(report.issues.some((item) => item.code === 'UNREACHABLE' && item.nodeId === 'orphan'));
});

test('自循环也能被识别', () => {
  const story = createEmptyStory();
  story.nodes[0].next = story.nodes[0].id;
  story.nodes[0].choices = [];
  const cycles = findCycles(story);
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].selfLoop, true);
});

test('翻译报告：日语缺译被统计，英语完整', () => {
  const story = mistyLighthouseStory();
  const report = buildTranslationReport(story);
  const ja = report.find((item) => item.locale === 'ja');
  const en = report.find((item) => item.locale === 'en');
  assert.ok(ja.missingCount >= 2, '示例中两个结局缺日语');
  assert.equal(en.missingCount, 0);
  assert.ok(ja.missing.some((item) => item.nodeId === 'node_end_return'));
  assert.ok(ja.missing.every((item) => item.sourceText.length > 0));
});

test('修改原文不会覆盖译文，只标记待复核', () => {
  const story = mistyLighthouseStory();
  const node = story.nodes[0];
  const before = getText(node.text, 'en');
  // 模拟 store.setNodeText 的行为
  const sourceLocale = 'zh-CN';
  node.staleLocales = story.locales
    .map((item) => item.code)
    .filter((code) => code !== sourceLocale && getText(node.text, code).trim());
  setText(node.text, sourceLocale, '改过后的中文原文');
  assert.equal(getText(node.text, 'en'), before, '英语译文必须保持不变');
  assert.ok(node.staleLocales.includes('en'));

  const report = buildTranslationReport(story);
  const en = report.find((item) => item.locale === 'en');
  assert.ok(en.stale.some((item) => item.nodeId === node.id));
});

test('重命名变量会同步更新条件表达式', () => {
  const story = buildSampleStory();
  const variable = story.variables.find((item) => item.name === '好感');
  assert.ok(variable);
  // 先确保条件里引用了它
  const conditionBefore = story.nodes[4].choices[0].condition;
  assert.equal(conditionBefore, '好感 >= 2');
  const ok = renameVariable(story, variable.id, 'friendship');
  assert.equal(ok, true);
  assert.equal(story.nodes[4].choices[0].condition, 'friendship >= 2');
  const report = validateStory(story);
  assert.ok(!report.issues.some((item) => item.code === 'UNDECLARED_VARIABLE'));
});

test('导出运行时数据：字段精简、条件与赋值按变量名输出', () => {
  const story = mistyLighthouseStory();
  const data = buildRuntimeData(story);
  assert.equal(data.format, 'storyloom.runtime');
  assert.equal(data.story.start, 'node_prologue');
  assert.equal(data.story.locales.length, 3);

  const door = data.story.nodes.find((node) => node.id === 'node_door');
  assert.equal(door.type, 'hub');
  const useKey = door.choices.find((choice) => choice.id === 'choice_use_key');
  assert.equal(useKey.when, '持有钥匙 == true');
  assert.equal(useKey.next, 'node_stairs');

  const beach = data.story.nodes.find((node) => node.id === 'node_beach');
  const takeKey = beach.choices.find((choice) => choice.id === 'choice_take_key');
  assert.deepEqual(takeKey.effects, [{ variable: '持有钥匙', op: 'set', value: true }]);

  // 编辑器专用字段不应出现在导出中
  for (const node of data.story.nodes) {
    assert.equal('position' in node, false);
    assert.equal('notes' in node, false);
  }

  const json = exportRuntimeJSON(story);
  assert.ok(json.includes('"maxVisitsPerNode": 3'));
  assert.ok(json.includes('"en"'));
});

test('导出数据可被运行时引擎直接使用（入口与条件）', () => {
  const story = mistyLighthouseStory();
  const data = buildRuntimeData(story);
  const variables = Object.fromEntries(
    data.story.variables.filter((item) => item.initial !== undefined).map((item) => [item.name, item.initial]),
  );
  assert.equal(variables['持有钥匙'], false);
  assert.equal(variables['信任'], 0);
  const door = data.story.nodes.find((node) => node.id === 'node_door');
  assert.equal(door.choices[0].when, '持有钥匙 == true');
});

test('示例文件与内置示例保持一致', async () => {
  const { readFile } = await import('node:fs/promises');
  const path = new URL('../samples/misty-lighthouse.story.json', import.meta.url);
  const text = await readFile(path, 'utf8');
  const file = normalizeStory(JSON.parse(text));
  const built = mistyLighthouseStory();
  assert.equal(file.nodes.length, built.nodes.length);
  assert.deepEqual(
    file.nodes.map((node) => node.id),
    built.nodes.map((node) => node.id),
  );
});
