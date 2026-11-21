import test from 'node:test';
import assert from 'node:assert/strict';
import { mistyLighthouseStory, buildSampleStory } from '../src/sample.js';
import { StoryRuntime } from '../src/runtime.js';
import { normalizeStory, serializeProject, deserializeProject } from '../src/story.js';

function play(runtime, choiceIds) {
  for (const id of choiceIds) {
    const snap = runtime.snapshot();
    assert.ok(snap.current, '当前应有节点');
    const choice = snap.current.choices.find((item) => item.id === id);
    assert.ok(choice, `选项 ${id} 应存在`);
    assert.ok(choice.available, `选项 ${id} 应可选：${choice.error}`);
    runtime.choose(id);
  }
  return runtime.snapshot();
}

test('示例剧情可以跑通主线：取钥匙 → 开门 → 与守夜人交谈 → 点亮灯塔', () => {
  const story = mistyLighthouseStory();
  const runtime = new StoryRuntime(story, { entryNodeId: 'node_prologue' });
  let snap = play(runtime, ['choice_search_beach', 'choice_take_key']);
  assert.equal(snap.variables['持有钥匙'], true);
  assert.equal(snap.current.nodeId, 'node_door');

  // 信任不足时不能借宿；条件选项不可选
  runtime.choose('choice_knock');
  snap = runtime.snapshot();
  assert.equal(snap.current.nodeId, 'node_keeper_hub');
  const rest = snap.current.choices.find((item) => item.id === 'choice_rest');
  assert.equal(rest.available, false);
  assert.match(rest.error, /信任/);

  // 第一次交谈：信任 +1；交谈节点无选项，需要手动继续回到守夜人
  runtime.choose('choice_ask_lighthouse');
  snap = runtime.snapshot();
  assert.equal(snap.current.nodeId, 'node_keeper_talk');
  assert.equal(snap.variables['信任'], 1);
  assert.equal(snap.canAdvance, true);
  runtime.advance();
  snap = runtime.snapshot();
  assert.equal(snap.current.nodeId, 'node_keeper_hub');

  // 第二次交谈：信任 +2
  runtime.choose('choice_ask_lighthouse');
  snap = runtime.snapshot();
  assert.equal(snap.variables['信任'], 2);
  runtime.advance();
  snap = runtime.snapshot();
  assert.equal(snap.current.nodeId, 'node_keeper_hub');

  // 信任达到 2 后可以借宿
  const restAfter = snap.current.choices.find((item) => item.id === 'choice_rest');
  assert.equal(restAfter.available, true);
  runtime.choose('choice_leave_keeper');
  snap = runtime.snapshot();
  assert.equal(snap.current.nodeId, 'node_door');
  runtime.choose('choice_use_key');
  snap = runtime.snapshot();
  assert.equal(snap.current.nodeId, 'node_stairs');
  runtime.advance();
  snap = runtime.snapshot();
  assert.equal(snap.current.nodeId, 'node_lamp_room');
  runtime.choose('choice_light');
  snap = runtime.snapshot();
  assert.equal(snap.current.nodeId, 'node_end_dawn');
  assert.equal(snap.variables['灯塔点亮'], true);
  assert.equal(snap.ended.reason, 'end');
});

test('循环路径：重复访问超过上限后停止，不会无限播放', () => {
  const story = mistyLighthouseStory();
  // 放宽步数，只靠单节点上限拦住循环：门口 → 守夜人 → 交谈 → 回门口 …
  const runtime = new StoryRuntime(story, { entryNodeId: 'node_door', maxSteps: 1000, maxVisitsPerNode: 3 });
  runtime.choose('choice_knock');
  for (let index = 0; index < 30; index += 1) {
    let snap = runtime.snapshot();
    if (snap.ended) break;
    if (snap.current?.nodeId === 'node_keeper_talk') {
      runtime.advance();
      continue;
    }
    if (snap.current?.nodeId === 'node_keeper_hub') {
      runtime.choose('choice_ask_lighthouse');
      continue;
    }
    if (snap.current?.nodeId === 'node_door') {
      runtime.choose('choice_knock');
      continue;
    }
    runtime.advance();
  }
  const snap = runtime.snapshot();
  assert.equal(snap.ended?.reason, 'loop-blocked');
  assert.ok(snap.loopBlocked);
  assert.equal(snap.loopBlocked.limit, 3);
  assert.ok(snap.step < 1000, '应被单节点上限拦下，而不是跑到步数上限');
});

test('步数上限兜底', () => {
  const story = buildSampleStory();
  // 正常流程远低于默认上限；把上限压到极低时应触发 max-steps
  const runtime = new StoryRuntime(story, { maxSteps: 10 });
  runtime.choose('sample_c1');
  runtime.advance();
  let snap = runtime.snapshot();
  assert.equal(snap.current.nodeId, 'sample_merge');
  assert.equal(snap.ended, null);

  const tight = new StoryRuntime(story, { maxSteps: 10 });
  tight.maxSteps = 1;
  tight.choose('sample_c1');
  snap = tight.snapshot();
  assert.equal(snap.ended?.reason, 'max-steps');
});

test('重置后变量回到开始点，历史清空', () => {
  const story = mistyLighthouseStory();
  const runtime = new StoryRuntime(story, { entryNodeId: 'node_prologue' });
  play(runtime, ['choice_search_beach', 'choice_take_key']);
  assert.equal(runtime.snapshot().history.length > 1, true);
  assert.equal(runtime.snapshot().variables['持有钥匙'], true);

  const snap = runtime.reset();
  assert.equal(snap.history.length, 1);
  assert.equal(snap.current.nodeId, 'node_prologue');
  assert.equal(snap.variables['持有钥匙'], false);
  assert.equal(snap.variables['信任'], 0);
  assert.equal(snap.step, 1);
  assert.equal(snap.ended, null);
});

test('多入口：可以从标记入口的节点开始，也可以从默认开始节点开始', () => {
  const story = mistyLighthouseStory();
  const fromStart = new StoryRuntime(story);
  assert.equal(fromStart.snapshot().current.nodeId, 'node_prologue');

  const fromEntry = new StoryRuntime(story, { entryNodeId: 'node_ch2_entry' });
  const snap = fromEntry.snapshot();
  assert.equal(snap.current.nodeId, 'node_ch2_entry');
  fromEntry.advance();
  assert.equal(fromEntry.snapshot().current.nodeId, 'node_lamp_room');
});

test('多语言：预览切换语言时显示对应译文，缺失时回退原文', () => {
  const story = mistyLighthouseStory();
  const runtime = new StoryRuntime(story, { entryNodeId: 'node_end_return', locale: 'ja' });
  let snap = runtime.snapshot();
  // ja 缺失 → 回退中文原文
  assert.match(snap.current.text, /你回到雾里/);

  runtime.setLocale('en');
  snap = runtime.snapshot();
  assert.match(snap.current.text, /You walk back into the fog/);

  runtime.setLocale('zh-CN');
  snap = runtime.snapshot();
  assert.match(snap.current.text, /你回到雾里/);
});

test('选项条件求值失败时不可选且给出原因', () => {
  const story = mistyLighthouseStory();
  const runtime = new StoryRuntime(story, { entryNodeId: 'node_door' });
  const snap = runtime.snapshot();
  const useKey = snap.current.choices.find((item) => item.id === 'choice_use_key');
  assert.equal(useKey.available, false);
  assert.match(useKey.condition, /持有钥匙/);
  assert.match(useKey.error, /条件不满足/);
});

test('未设置变量导致条件无法求值时选项不可选，并说明原因', () => {
  const story = mistyLighthouseStory();
  const variable = story.variables.find((item) => item.name === '信任');
  variable.hasInitial = false;
  variable.initial = null;
  const runtime = new StoryRuntime(story, { entryNodeId: 'node_keeper_hub' });
  const snap = runtime.snapshot();
  const rest = snap.current.choices.find((item) => item.id === 'choice_rest');
  assert.equal(rest.available, false);
  assert.match(rest.error, /信任/);
  // 无条件的选项仍然可选
  assert.equal(snap.current.choices.find((item) => item.id === 'choice_ask_lighthouse').available, true);
});

test('项目序列化后再打开保持可编辑与结构完整', () => {
  const story = mistyLighthouseStory();
  const text = serializeProject(story);
  const reopened = deserializeProject(text);
  assert.equal(reopened.nodes.length, story.nodes.length);
  assert.equal(reopened.meta.title, story.meta.title);
  assert.equal(reopened.startNodeId, story.startNodeId);
  assert.deepEqual(reopened.locales, story.locales);
  assert.deepEqual(
    reopened.nodes.map((node) => node.position),
    story.nodes.map((node) => node.position),
  );
  assert.deepEqual(reopened.nodes[1].choices[0].text, story.nodes[1].choices[0].text);

  // 重新打开后仍然可以继续试玩
  const runtime = new StoryRuntime(reopened, { entryNodeId: 'node_prologue' });
  const snap = play(runtime, ['choice_go_lighthouse', 'choice_knock']);
  assert.equal(snap.current.nodeId, 'node_keeper_hub');
});

test(' normalization 容忍缺失字段与旧格式', () => {
  const story = normalizeStory({
    meta: { title: '旧文件' },
    nodes: [
      { id: 'a', title: 'A', text: '直接写字符串的旧文本', next: 'b' },
      { id: 'b', title: 'B', type: 'end', text: { 'zh-CN': '结束' } },
    ],
  });
  assert.equal(story.nodes[0].text['zh-CN'], '直接写字符串的旧文本');
  assert.equal(story.startNodeId, 'a');
  assert.equal(story.locales.length, 1);
  // 缺失坐标会被自动布局
  assert.ok(Number.isFinite(story.nodes[0].position.x));
  assert.notDeepEqual(story.nodes[0].position, story.nodes[1].position);
});

test('编辑剧情后可原地刷新当前选项而不重置进度', () => {
  const story = mistyLighthouseStory();
  const runtime = new StoryRuntime(story, { entryNodeId: 'node_door' });
  const before = runtime.snapshot();
  assert.equal(before.step, 1);
  const useKey = before.current.choices.find((item) => item.id === 'choice_use_key');
  assert.equal(useKey.available, false);

  // 模拟编辑器修改：给「持有钥匙」一个初始值并把文案改掉
  story.variables.find((item) => item.name === '持有钥匙').initial = true;
  runtime.variables['持有钥匙'] = true;
  story.nodes.find((node) => node.id === 'node_door').choices[0].text['zh-CN'] = '用钥匙开门（已修改）';
  runtime.refreshChoices();

  const after = runtime.snapshot();
  assert.equal(after.step, 1, '步数不应增加');
  assert.equal(after.history.length, 1, '历史不应增加');
  const refreshed = after.current.choices.find((item) => item.id === 'choice_use_key');
  assert.equal(refreshed.available, true, '变量满足后选项应变为可用');
  assert.match(refreshed.text, /已修改/);
});

test('访问计数在重置后清零', () => {
  const story = mistyLighthouseStory();
  const runtime = new StoryRuntime(story, { entryNodeId: 'node_keeper_hub', maxVisitsPerNode: 2 });
  runtime.choose('choice_leave_keeper'); // keeper_hub → node_door
  runtime.choose('choice_knock'); // node_door → keeper_hub（第 2 次访问）
  assert.equal(runtime.snapshot().visits['node_keeper_hub'], 2);
  runtime.reset();
  assert.equal(runtime.snapshot().visits['node_keeper_hub'], 1);
  // 重置后仍可再走一次循环而不立刻触发上限
  runtime.choose('choice_leave_keeper');
  assert.equal(runtime.snapshot().ended, null);
  assert.equal(runtime.snapshot().current.nodeId, 'node_door');
});
