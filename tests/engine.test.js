/* 无头测试：node tests/engine.test.js（不依赖浏览器/DOM） */
'use strict';

const assert = require('assert');
const path = require('path');

// 按浏览器中的顺序加载脚本，它们会挂到 globalThis 上
require(path.join(__dirname, '..', 'js', 'utils.js'));
require(path.join(__dirname, '..', 'js', 'blackboard.js'));
require(path.join(__dirname, '..', 'js', 'engine.js'));
require(path.join(__dirname, '..', 'js', 'simulation.js'));
require(path.join(__dirname, '..', 'js', 'project.js'));
require(path.join(__dirname, '..', 'js', 'examples.js'));

const EngineNS = global.BTEngineNS;
const { BTEngine, STATUS, validateConnection, validateTree, getChildren } = EngineNS;
const { Blackboard } = global.BTBlackboard;

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    console.error('  ✗ ' + name);
    console.error('    ' + (e.stack || e.message));
    process.exitCode = 1;
  }
}
function group(name) { console.log('\n' + name); }

const silentLogger = { log() {} };

/** 构造一个带动作处理器的引擎，handler 由调用方提供 */
function makeEngine(tree, bb, handlers) {
  return new BTEngine(tree, bb, handlers || {}, silentLogger);
}

function actionNode(params, name) {
  return BTProject.createNode('action', name || '动作', 0, 0,
    Object.assign({ actionType: 'stub' }, params || {}));
}

/* ---------------- 1. 顺序节点 ---------------- */
group('顺序节点 sequence');

test('全部成功才成功，按顺序执行', () => {
  const tree = BTProject.createTree('t');
  const root = BTProject.createNode('sequence', '顺序', 0, 0);
  const calls = [];
  const a = actionNode(null, 'a');
  const b = actionNode(null, 'b');
  tree.nodes.push(root, a, b);
  tree.edges.push(BTProject.createEdge(root.id, a.id), BTProject.createEdge(root.id, b.id));
  const handlers = {
    stub(h) { calls.push(h.node.name); return STATUS.SUCCESS; }
  };
  const engine = makeEngine(tree, new Blackboard({}), handlers);
  const r = engine.tick(100, {});
  assert.strictEqual(r, STATUS.SUCCESS);
  assert.deepStrictEqual(calls, ['a', 'b']);
});

test('一个失败即失败，且短路后续节点', () => {
  const tree = BTProject.createTree('t');
  const root = BTProject.createNode('sequence', '顺序', 0, 0);
  const calls = [];
  const a = actionNode(null, 'a');
  const b = actionNode(null, 'b');
  tree.nodes.push(root, a, b);
  tree.edges.push(BTProject.createEdge(root.id, a.id), BTProject.createEdge(root.id, b.id));
  const handlers = { stub(h) { calls.push(h.node.name); return h.node.name === 'a' ? STATUS.FAILURE : STATUS.SUCCESS; } };
  const engine = makeEngine(tree, new Blackboard({}), handlers);
  assert.strictEqual(engine.tick(100, {}), STATUS.FAILURE);
  assert.deepStrictEqual(calls, ['a']);
});

/* ---------------- 2. 选择节点 ---------------- */
group('选择节点 selector');

test('前面失败会继续尝试后面，直到成功', () => {
  const tree = BTProject.createTree('t');
  const root = BTProject.createNode('selector', '选择', 0, 0);
  const calls = [];
  const a = actionNode(null, 'a');
  const b = actionNode(null, 'b');
  const c = actionNode(null, 'c');
  tree.nodes.push(root, a, b, c);
  [a, b, c].forEach((n) => tree.edges.push(BTProject.createEdge(root.id, n.id)));
  const handlers = {
    stub(h) {
      calls.push(h.node.name);
      return h.node.name === 'c' ? STATUS.SUCCESS : STATUS.FAILURE;
    }
  };
  const engine = makeEngine(tree, new Blackboard({}), handlers);
  assert.strictEqual(engine.tick(100, {}), STATUS.SUCCESS);
  assert.deepStrictEqual(calls, ['a', 'b', 'c']);
});

test('全部失败才失败', () => {
  const tree = BTProject.createTree('t');
  const root = BTProject.createNode('selector', '选择', 0, 0);
  const a = actionNode(); const b = actionNode();
  tree.nodes.push(root, a, b);
  tree.edges.push(BTProject.createEdge(root.id, a.id), BTProject.createEdge(root.id, b.id));
  const engine = makeEngine(tree, new Blackboard({}), { stub: () => STATUS.FAILURE });
  assert.strictEqual(engine.tick(100, {}), STATUS.FAILURE);
});

/* ---------------- 3. 运行中与恢复 ---------------- */
group('运行中 running 与恢复');

test('动作返回 running 后，下一个 tick 从该动作继续（等待型动作）', () => {
  const tree = BTProject.createTree('t');
  const root = BTProject.createNode('sequence', '顺序', 0, 0);
  const wait = actionNode(null, '等待');
  tree.nodes.push(root, wait);
  tree.edges.push(BTProject.createEdge(root.id, wait.id));
  const handlers = {
    stub(h) {
      h.data.elapsed = (h.data.elapsed || 0) + h.dt;
      return h.data.elapsed >= 300 ? STATUS.SUCCESS : STATUS.RUNNING;
    }
  };
  const engine = makeEngine(tree, new Blackboard({}), handlers);
  assert.strictEqual(engine.tick(100, {}), STATUS.RUNNING);
  assert.strictEqual(engine.getState(wait.id).status, STATUS.RUNNING);
  assert.strictEqual(engine.tick(100, {}), STATUS.RUNNING);
  assert.strictEqual(engine.tick(100, {}), STATUS.SUCCESS);
  assert.strictEqual(engine.tickCount, 3);
});

test('reset 后运行状态与累计数据清空，可重新跑', () => {
  const tree = BTProject.createTree('t');
  const root = BTProject.createNode('sequence', '顺序', 0, 0);
  const wait = actionNode();
  tree.nodes.push(root, wait);
  tree.edges.push(BTProject.createEdge(root.id, wait.id));
  const handlers = {
    stub(h) {
      h.data.elapsed = (h.data.elapsed || 0) + h.dt;
      return h.data.elapsed >= 300 ? STATUS.SUCCESS : STATUS.RUNNING;
    }
  };
  const engine = makeEngine(tree, new Blackboard({}), handlers);
  engine.tick(100, {});
  engine.reset();
  assert.strictEqual(engine.tickCount, 0);
  assert.strictEqual(engine.getState(wait.id).status, STATUS.IDLE);
  assert.deepStrictEqual(engine.getState(wait.id).data, {});
  assert.strictEqual(engine.tick(100, {}), STATUS.RUNNING);
});

/* ---------------- 4. 条件节点 ---------------- */
group('条件节点 condition');

test('条件引用黑板字段，成立成功 / 不成立失败', () => {
  const tree = BTProject.createTree('t');
  const cond = BTProject.createNode('condition', '条件', 0, 0, { key: 'hp', op: '>', value: '50' });
  tree.nodes.push(cond);
  const bb = new Blackboard({ hp: 80 });
  const engine = makeEngine(tree, bb);
  assert.strictEqual(engine.tick(100, {}), STATUS.SUCCESS);
  bb.set('hp', 20);
  assert.strictEqual(engine.tick(100, {}), STATUS.FAILURE);
});

test('布尔字段与字符串 true 比较成立；缺失字段按失败处理', () => {
  const tree = BTProject.createTree('t');
  const c1 = BTProject.createNode('condition', '看见', 0, 0, { key: 'playerVisible', op: '==', value: 'true' });
  const c2 = BTProject.createNode('condition', '缺失', 0, 0, { key: 'ghost', op: '==', value: '1' });
  tree.nodes.push(c1, c2);
  const engine = makeEngine(tree, new Blackboard({ playerVisible: true }));
  assert.strictEqual(engine._visitCondition(c1), STATUS.SUCCESS);
  assert.strictEqual(engine._visitCondition(c2), STATUS.FAILURE);
});

test('暂停修改黑板后，条件在当前节点重新求值（无需重置整树）', () => {
  const tree = BTProject.createTree('t');
  const root = BTProject.createNode('selector', '选择', 0, 0);
  const cond = BTProject.createNode('condition', '门开了', 0, 0, { key: 'doorOpen', op: '==', value: 'true' });
  const fallback = actionNode(null, '兜底');
  tree.nodes.push(root, cond, fallback);
  tree.edges.push(BTProject.createEdge(root.id, cond.id), BTProject.createEdge(root.id, fallback.id));
  const bb = new Blackboard({ doorOpen: false });
  const engine = makeEngine(tree, bb, { stub: () => STATUS.SUCCESS });
  assert.strictEqual(engine.tick(100, {}), STATUS.SUCCESS); // 条件失败 → 兜底成功
  assert.strictEqual(engine.getState(cond.id).status, STATUS.FAILURE);
  bb.set('doorOpen', true); // 模拟暂停期间改黑板
  assert.strictEqual(engine.tick(100, {}), STATUS.SUCCESS);
  assert.strictEqual(engine.getState(cond.id).status, STATUS.SUCCESS);
  assert.strictEqual(engine.getState(fallback.id).status, STATUS.IDLE); // 未走到的分支被复位
});

/* ---------------- 5. 循环节点 ---------------- */
group('循环节点 loop');

test('固定次数：子节点成功 N 次后循环成功', () => {
  const tree = BTProject.createTree('t');
  const loop = BTProject.createNode('loop', '循环3次', 0, 0, { count: 3 });
  const child = actionNode(null, '子');
  tree.nodes.push(loop, child);
  tree.edges.push(BTProject.createEdge(loop.id, child.id));
  let runs = 0;
  const engine = makeEngine(tree, new Blackboard({}), {
    stub(h) { runs++; return STATUS.SUCCESS; }
  });
  assert.strictEqual(engine.tick(100, {}), STATUS.RUNNING);
  assert.strictEqual(engine.tick(100, {}), STATUS.RUNNING);
  const r = engine.tick(100, {});
  assert.strictEqual(r, STATUS.SUCCESS);
  assert.strictEqual(runs, 3);
});

test('无限循环（count=0）持续 running，子节点失败则循环失败', () => {
  const tree = BTProject.createTree('t');
  const loop = BTProject.createNode('loop', '无限', 0, 0, { count: 0 });
  const child = actionNode();
  tree.nodes.push(loop, child);
  tree.edges.push(BTProject.createEdge(loop.id, child.id));
  const engine = makeEngine(tree, new Blackboard({}), { stub: () => STATUS.SUCCESS });
  for (let i = 0; i < 5; i++) assert.strictEqual(engine.tick(100, {}), STATUS.RUNNING);

  const engine2 = makeEngine(tree, new Blackboard({}), { stub: () => STATUS.FAILURE });
  assert.strictEqual(engine2.tick(100, {}), STATUS.FAILURE);
});

/* ---------------- 6. 连线合法性 ---------------- */
group('连线合法性校验');

test('拒绝自连、叶子挂子、双父、环、循环节点第二个子节点', () => {
  const tree = BTProject.createTree('t');
  const seq = BTProject.createNode('sequence', '顺序', 0, 0);
  const sel = BTProject.createNode('selector', '选择', 0, 0);
  const cond = BTProject.createNode('condition', '条件', 0, 0, { key: 'x', op: '==', value: '1' });
  const loop = BTProject.createNode('loop', '循环', 0, 0, { count: 2 });
  const act = BTProject.createNode('action', '动作', 0, 0, { actionType: 'stub' });
  tree.nodes.push(seq, sel, cond, loop, act);

  assert.strictEqual(validateConnection(tree, seq.id, seq.id).ok, false);
  // 条件是叶子，不能当父
  assert.strictEqual(validateConnection(tree, cond.id, act.id).ok, false);
  assert.ok(validateConnection(tree, cond.id, act.id).reason.includes('叶子'));
  // seq -> act 合法
  assert.strictEqual(validateConnection(tree, seq.id, act.id).ok, true);
  tree.edges.push(BTProject.createEdge(seq.id, act.id));
  // act 已有父节点，sel 不能再收
  const rejected = validateConnection(tree, sel.id, act.id);
  assert.strictEqual(rejected.ok, false);
  assert.ok(rejected.reason.includes('父节点'));
  // seq -> sel -> loop，再尝试 loop -> seq 成环
  tree.edges.push(BTProject.createEdge(seq.id, sel.id));
  tree.edges.push(BTProject.createEdge(sel.id, loop.id));
  const cycle = validateConnection(tree, loop.id, seq.id);
  assert.strictEqual(cycle.ok, false);
  assert.ok(cycle.reason.includes('环'));
  // 循环节点只能有一个子
  tree.edges.push(BTProject.createEdge(loop.id, cond.id));
  assert.strictEqual(validateConnection(tree, loop.id, act.id).ok, false);
});

test('重复连线被拒绝', () => {
  const tree = BTProject.createTree('t');
  const seq = BTProject.createNode('sequence', '顺序', 0, 0);
  const act = BTProject.createNode('action', '动作', 0, 0, { actionType: 'stub' });
  tree.nodes.push(seq, act);
  tree.edges.push(BTProject.createEdge(seq.id, act.id));
  assert.strictEqual(validateConnection(tree, seq.id, act.id).ok, false);
});

/* ---------------- 7. 整树校验 ---------------- */
group('整树校验 validateTree');

test('多个根节点报错；复合节点缺子节点报错；孤儿节点告警', () => {
  const tree = BTProject.createTree('t');
  const root1 = BTProject.createNode('sequence', '根1', 0, 0);
  const root2 = BTProject.createNode('sequence', '根2', 0, 0);
  const orphan = BTProject.createNode('action', '孤儿', 0, 0, { actionType: 'stub' });
  const emptySeq = BTProject.createNode('selector', '空选择', 0, 0);
  const act = BTProject.createNode('action', '动作', 0, 0, { actionType: 'stub' });
  tree.nodes.push(root1, root2, orphan, emptySeq, act);
  tree.edges.push(BTProject.createEdge(root1.id, emptySeq.id), BTProject.createEdge(root1.id, act.id));
  const r = validateTree(tree);
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some((e) => e.message.includes('根节点')));
  assert.ok(r.errors.some((e) => e.message.includes('至少需要一个子节点')));
  assert.ok(r.warnings.some((w) => w.message.includes('不会执行')));
});

test('条件节点未选黑板字段时报错', () => {
  const tree = BTProject.createTree('t');
  const cond = BTProject.createNode('condition', '条件', 0, 0, { key: '', op: '==', value: '' });
  tree.nodes.push(cond);
  const r = validateTree(tree);
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors[0].message.includes('黑板字段'));
});

/* ---------------- 8. 重命名与引用保持 ---------------- */
group('重命名与引用保持');

test('重命名黑板字段后，所有树的条件/动作引用同步更新', () => {
  const project = BTExamples.buildExampleProject();
  assert.notStrictEqual(project.blackboard.playerVisible, undefined);
  BTProject.renameBlackboardKey(project, 'playerVisible', 'canSeeTarget');
  assert.strictEqual(project.blackboard.playerVisible, undefined);
  assert.strictEqual(project.blackboard.canSeeTarget, false);
  const refs = [];
  for (const t of project.trees) {
    for (const n of t.nodes) {
      if (n.type === 'condition') refs.push(n.params.key);
    }
  }
  assert.ok(refs.includes('canSeeTarget'));
  assert.ok(!refs.includes('playerVisible'));
  // 重命名后所有示例树仍然结构合法
  for (const t of project.trees) {
    assert.strictEqual(validateTree(t).valid, true, t.name + ' 应当仍然合法');
  }
});

test('节点重命名不影响连线：连线基于稳定 id', () => {
  const tree = BTProject.createTree('t');
  const seq = BTProject.createNode('sequence', '旧名字', 0, 0);
  const act = BTProject.createNode('action', '动作', 0, 0, { actionType: 'stub' });
  tree.nodes.push(seq, act);
  tree.edges.push(BTProject.createEdge(seq.id, act.id));
  seq.name = '全新的名字';
  assert.strictEqual(getChildren(tree, seq.id).length, 1);
  assert.strictEqual(validateTree(tree).valid, true);
});

test('重命名为已存在字段会抛错且不改数据', () => {
  const project = BTExamples.buildExampleProject();
  assert.throws(() => BTProject.renameBlackboardKey(project, 'hp', 'state'));
  assert.notStrictEqual(project.blackboard.hp, undefined);
});

/* ---------------- 9. 项目持久化往返 ---------------- */
group('项目保存/导出往返');

test('JSON 序列化后再 normalize，节点、参数、场景完整恢复', () => {
  const project = BTExamples.buildExampleProject();
  const json = JSON.stringify(project);
  const restored = BTProject.parseImport(json);
  assert.strictEqual(restored.trees.length, 3);
  assert.deepStrictEqual(
    restored.trees.map((t) => t.name),
    project.trees.map((t) => t.name)
  );
  for (let i = 0; i < 3; i++) {
    assert.strictEqual(restored.trees[i].nodes.length, project.trees[i].nodes.length);
    assert.strictEqual(restored.trees[i].edges.length, project.trees[i].edges.length);
  }
  assert.strictEqual(restored.scene.patrolPoints.length, 4);
  assert.strictEqual(restored.blackboard.patrolIndex, 0);
  for (const t of restored.trees) assert.strictEqual(validateTree(t).valid, true);
});

test('损坏数据被兜底：悬空连线被清除，缺失字段补默认值', () => {
  const broken = {
    trees: [{
      name: '坏树',
      nodes: [{ id: 'n1', type: 'condition', name: 'c', x: 0, y: 0, params: {} }],
      edges: [{ id: 'e1', from: 'n1', to: 'ghost' }, { id: 'e2', from: 'ghost', to: 'n1' }]
    }]
  };
  const fixed = BTProject.normalizeProject(broken);
  assert.strictEqual(fixed.trees[0].edges.length, 0);
  assert.strictEqual(fixed.trees[0].nodes[0].params.op, '==');
  assert.ok(fixed.scene && fixed.blackboard);
});

test('空 trees 工程导入时自动补一棵空树，保证应用不会崩溃', () => {
  const fixed = BTProject.normalizeProject({ trees: [] });
  assert.strictEqual(fixed.trees.length, 1);
  assert.strictEqual(fixed.activeTreeId, fixed.trees[0].id);
  assert.throws(() => BTProject.normalizeProject({}));
});

/* ---------------- 10. 示例工程 ---------------- */
group('示例行为树');

test('三个示例树全部通过结构校验', () => {
  const project = BTExamples.buildExampleProject();
  assert.strictEqual(project.trees.length, 3);
  for (const t of project.trees) {
    const r = validateTree(t);
    assert.strictEqual(r.valid, true, t.name + ' 校验失败：' + r.errors.map((e) => e.message).join('; '));
  }
});

test('巡逻示例：无限循环驱动巡逻动作持续 running，黑板 patrolIndex 会被推进', () => {
  const project = BTExamples.buildExampleProject();
  const tree = project.trees[0];
  const bb = new Blackboard(project.blackboard);
  let arrivals = 0;
  const handlers = {
    patrol(h) {
      h.data.elapsed = (h.data.elapsed || 0) + h.dt;
      if (h.data.elapsed < 250) return STATUS.RUNNING;
      h.data.elapsed = 0;
      arrivals++;
      bb.set('patrolIndex', arrivals % 4);
      return STATUS.SUCCESS;
    },
    wait: () => STATUS.SUCCESS,
    log: () => STATUS.SUCCESS
  };
  const engine = makeEngine(tree, bb, handlers);
  for (let i = 0; i < 10; i++) {
    assert.strictEqual(engine.tick(100, {}), STATUS.RUNNING, '无限循环的树根应一直 running');
  }
  assert.ok(arrivals >= 1);
});

test('发现目标示例：playerVisible 切换时走不同分支', () => {
  const project = BTExamples.buildExampleProject();
  const tree = project.trees[1];
  const bb = new Blackboard(project.blackboard);
  const hit = [];
  const handlers = {
    goto: (h) => { hit.push('goto:' + h.params.target); return STATUS.RUNNING; },
    patrol: () => { hit.push('patrol'); return STATUS.SUCCESS; },
    setBlackboard: (h) => { bb.set(h.params.key, BTUtils.coerceValue(h.params.value)); return STATUS.SUCCESS; }
  };
  const engine = makeEngine(tree, bb, handlers);
  bb.set('playerVisible', true);
  engine.tick(100, {});
  assert.ok(hit.some((h) => h === 'goto:player'));
  assert.strictEqual(bb.get('state'), 'combat');

  engine.reset();
  hit.length = 0;
  bb.set('playerVisible', false);
  engine.tick(100, {});
  assert.ok(hit.includes('patrol'));
  assert.strictEqual(bb.get('state'), 'patrol');
});

/* ---------------- 11. 工具函数 ---------------- */
group('工具函数');

test('coerceValue 与 compare 语义', () => {
  assert.strictEqual(BTUtils.coerceValue('true'), true);
  assert.strictEqual(BTUtils.coerceValue('42'), 42);
  assert.strictEqual(BTUtils.coerceValue('hello'), 'hello');
  assert.strictEqual(BTUtils.compare('>', 10, '5'), true);
  assert.strictEqual(BTUtils.compare('==', false, 'false'), true);
  assert.strictEqual(BTUtils.compare('!=', 'a', 'b'), true);
  assert.strictEqual(BTUtils.compare('<=', 3, 3), true);
});

console.log('\n========================================');
console.log(`测试完成：${passed} 个通过` + (process.exitCode ? '，存在失败 ✗' : '，全部通过 ✓'));
console.log('========================================');
