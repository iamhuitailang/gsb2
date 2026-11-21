/*
 * tests/engine.test.js — 纯 Node 运行：node tests/engine.test.js
 * 覆盖：固定边距/比例位置、最小可读宽、悬空参照、循环、隐藏传播、
 *       窄屏冲突识别、命中测试、运行配置导出剥离
 */
'use strict';
var M = require('../js/model.js');
var E = require('../js/engine.js');
var Ex = require('../js/export.js');

var passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name); }
}
function eq(a, b, name) { ok(a === b, name + '（实际 ' + a + '，期望 ' + b + '）'); }
function fakeMeasure(n) {
  if (n.type === 'icon') return { w: 20, h: 20 };
  if (n.type === 'bar') return { w: n.width.value || 100, h: n.barHeight || 12 };
  if (n.type === 'edge') return { w: 40, h: 2 };
  if (n.type === 'panel') return { w: 40, h: 24 };
  var s = n.textVar === 'nickname' ? (n._long ? 220 : 40) : (n.text || 'x').length * 12 + 4;
  return { w: s, h: 18 };
}
function screen(w, h, safe) {
  return { w: w, h: h, safe: safe || { top: 0, right: 0, bottom: 0, left: 0 } };
}
function anchor(ref, edge, mode, value, align) {
  return { ref: ref, edge: edge, mode: mode, value: value, align: align || 'start' };
}

console.log('\n[1] 固定边距与比例位置');
(function () {
  var box = M.createNode({
    id: 'box', type: 'panel', layout: 'none',
    width: { mode: 'fixed', value: 100 }, height: { mode: 'fixed', value: 40 },
    leftAnchor: anchor(M.SCREEN_ID, 'left', 'fixed', 10),
    topAnchor: anchor(M.SCREEN_ID, 'top', 'fixed', 20)
  });
  var r = E.solveLayout([box], screen(320, 500), {}, fakeMeasure);
  eq(r.frames.box.x, 10, '固定左边距 10px');
  eq(r.frames.box.y, 20, '固定上边距 20px');
  eq(r.frames.box.w, 100, '固定宽度');

  var ratio = M.createNode({
    id: 'rt', type: 'panel', layout: 'none',
    width: { mode: 'fixed', value: 40 }, height: { mode: 'fixed', value: 20 },
    leftAnchor: anchor(M.SCREEN_ID, 'left', 'ratio', 0.5, 'center'),
    topAnchor: anchor(M.SCREEN_ID, 'top', 'ratio', 0.5, 'start')
  });
  var r2 = E.solveLayout([ratio], screen(300, 400), {}, fakeMeasure);
  eq(r2.frames.rt.x, 150 - 20, '比例 0.5 + 居中对齐 → x=130');
  eq(r2.frames.rt.y, 200, '比例 0.5 起点对齐 → y=200');
})();

console.log('\n[2] 安全区偏移');
(function () {
  var n = M.createNode({
    id: 'n', type: 'text', text: 'x',
    leftAnchor: anchor(M.SCREEN_ID, 'left', 'fixed', 0),
    topAnchor: anchor(M.SCREEN_ID, 'top', 'fixed', 0)
  });
  var r = E.solveLayout([n], screen(320, 500, { top: 47, bottom: 21, left: 12, right: 0 }), {}, fakeMeasure);
  eq(r.frames.n.x, 12, '屏幕左锚点自动落入左侧安全区');
  eq(r.frames.n.y, 47, '屏幕上锚点自动落入顶部安全区');
  var safeIssue = r.issues.some(function (i) { return i.type === 'safeArea'; });
  ok(!safeIssue, '锚在安全区边缘不产生保留区警告');
})();

console.log('\n[3] 最小可读宽度冲突 + 修复建议');
(function () {
  var n = M.createNode({
    id: 'n', type: 'text', text: '任务', minWidth: 150,
    leftAnchor: anchor(M.SCREEN_ID, 'left', 'fixed', 10),
    rightAnchor: anchor(M.SCREEN_ID, 'right', 'fixed', 10),
    topAnchor: anchor(M.SCREEN_ID, 'top', 'fixed', 10)
  });
  var r = E.solveLayout([n], screen(120, 300), {}, fakeMeasure);
  var iss = r.issues.find(function (i) { return i.type === 'minSize'; });
  ok(!!iss, '可用跨度 100 < minWidth 150 报冲突');
  ok(iss.fixSuggestions.length >= 2, '给出至少 2 条修复建议');
  // 应用第一条修复
  M.applyOp([n], iss.fixSuggestions[0].ops[0]);
  ok(n.minWidth <= 100, '应用修复后 minWidth 被下调');
})();

console.log('\n[4] 悬空参照（参照被删除）');
(function () {
  var edge = M.createNode({ id: 'e', type: 'edge',
    leftAnchor: anchor(M.SCREEN_ID, 'left', 'fixed', 0),
    topAnchor: anchor(M.SCREEN_ID, 'top', 'fixed', 10) });
  var n = M.createNode({
    id: 'n', type: 'text', text: 'x',
    topAnchor: anchor('e', 'bottom', 'fixed', 4),
    leftAnchor: anchor(M.SCREEN_ID, 'left', 'fixed', 5)
  });
  var nodes = M.removeNode([edge, n], 'e');
  var r = E.solveLayout(nodes, screen(320, 500), {}, fakeMeasure);
  var dangling = r.issues.find(function (i) { return i.type === 'danglingRef'; });
  ok(!!dangling, '删除参照组件后明确报悬空错误');
  ok(/已删除/.test(dangling.message), '错误信息说明参照已删除');
  ok(dangling.fixSuggestions[0].ops[0].kind === 'clearSlot', '提供清除失效锚点的修复');
})();

console.log('\n[5] 参照循环检测');
(function () {
  var a = M.createNode({ id: 'a', type: 'panel', layout: 'none',
    width: { mode: 'fixed', value: 50 }, height: { mode: 'fixed', value: 50 },
    leftAnchor: anchor(M.SCREEN_ID, 'left', 'fixed', 0),
    topAnchor: anchor('b', 'top', 'fixed', 0) });
  var b = M.createNode({ id: 'b', type: 'panel', layout: 'none',
    width: { mode: 'fixed', value: 50 }, height: { mode: 'fixed', value: 50 },
    leftAnchor: anchor(M.SCREEN_ID, 'left', 'fixed', 0),
    topAnchor: anchor('a', 'top', 'fixed', 0) });
  var r = E.solveLayout([a, b], screen(320, 500), {}, fakeMeasure);
  var cyc = r.issues.find(function (i) { return i.type === 'cycle'; });
  ok(!!cyc, '互相参照被识别为循环');
  ok(cyc.nodeIds.indexOf('a') >= 0 && cyc.nodeIds.indexOf('b') >= 0, '循环路径包含两个节点');
})();

console.log('\n[6] 条件隐藏 + 父级传播 + 参照隐藏报错');
(function () {
  var panel = M.createNode({
    id: 'p', type: 'panel', layout: 'none',
    width: { mode: 'fixed', value: 80 }, height: { mode: 'fixed', value: 40 },
    leftAnchor: anchor(M.SCREEN_ID, 'left', 'fixed', 5),
    topAnchor: anchor(M.SCREEN_ID, 'top', 'fixed', 5),
    hiddenWhen: { any: [{ var: 'rightSidebarVisible', op: '==', value: false }] }
  });
  var child = M.createNode({ id: 'c', type: 'icon', parentId: 'p' });
  var dep = M.createNode({
    id: 'd', type: 'text', text: 'x',
    leftAnchor: anchor(M.SCREEN_ID, 'left', 'fixed', 0),
    topAnchor: anchor('p', 'bottom', 'fixed', 2)
  });
  var r = E.solveLayout([panel, child, dep], screen(320, 500),
    { rightSidebarVisible: false }, fakeMeasure);
  ok(!!r.hiddenReason.p, '条件满足时 panel 主动隐藏');
  ok(!!r.hiddenReason.c, '子组件随父级隐藏');
  var refHidden = r.issues.find(function (i) { return i.type === 'refHidden'; });
  ok(!!refHidden, '参照了隐藏组件时报 refHidden 错误');

  var r2 = E.solveLayout([panel, child, dep], screen(320, 500),
    { rightSidebarVisible: true }, fakeMeasure);
  ok(!r2.hiddenReason.p, '条件恢复后 panel 重新可见');
  ok(!r2.issues.some(function (i) { return i.type === 'refHidden'; }), '恢复后参照隐藏错误消失');
})();

console.log('\n[7] 窄屏：两个刚性组件相撞报约束冲突');
(function () {
  var left = M.createNode({
    id: 'L', name: '左组', type: 'panel', layout: 'none',
    width: { mode: 'fixed', value: 150 }, height: { mode: 'fixed', value: 30 },
    minWidth: 150,
    leftAnchor: anchor(M.SCREEN_ID, 'left', 'fixed', 8),
    topAnchor: anchor(M.SCREEN_ID, 'top', 'fixed', 8)
  });
  var right = M.createNode({
    id: 'R', name: '右组', type: 'panel', layout: 'none',
    width: { mode: 'fixed', value: 150 }, height: { mode: 'fixed', value: 30 },
    minWidth: 150,
    rightAnchor: anchor(M.SCREEN_ID, 'right', 'fixed', 8),
    topAnchor: anchor(M.SCREEN_ID, 'top', 'fixed', 8)
  });
  var narrow = E.solveLayout([left, right], screen(260, 400), {}, fakeMeasure);
  var conflict = narrow.issues.find(function (i) { return i.type === 'overlapConflict'; });
  ok(!!conflict, '320 级窄屏两刚性组相撞 → 约束冲突');
  ok(conflict.nodeIds.indexOf('L') >= 0 && conflict.nodeIds.indexOf('R') >= 0, '冲突定位到具体两个组件');
  ok(conflict.fixSuggestions.some(function (f) { return /隐藏/.test(f.label); }), '提供自动隐藏修复');

  // 宽屏无冲突
  var wide = E.solveLayout([left, right], screen(430, 800), {}, fakeMeasure);
  ok(!wide.issues.some(function (i) { return i.type === 'overlapConflict'; }), '430px 宽屏无冲突');
})();

console.log('\n[8] 命中测试随真实帧工作');
(function () {
  var n = M.createNode({
    id: 'n', type: 'panel', layout: 'none',
    width: { mode: 'fixed', value: 50 }, height: { mode: 'fixed', value: 40 },
    leftAnchor: anchor(M.SCREEN_ID, 'left', 'fixed', 100),
    topAnchor: anchor(M.SCREEN_ID, 'top', 'fixed', 100)
  });
  var r = E.solveLayout([n], screen(400, 600), {}, fakeMeasure);
  eq(E.hitTest(r, 120, 120), 'n', '组件内部点命中');
  ok(E.hitTest(r, 10, 10) == null, '组件外部点不命中');
  var r2 = E.solveLayout([M.createNode({
    id: 'h', type: 'text', text: 'x',
    hiddenWhen: { any: [{ var: 'paused', op: '==', value: true }] },
    leftAnchor: anchor(M.SCREEN_ID, 'left', 'fixed', 0),
    topAnchor: anchor(M.SCREEN_ID, 'top', 'fixed', 0)
  })], screen(400, 600), { paused: true }, fakeMeasure);
  ok(E.hitTest(r2, 5, 5) == null, '隐藏组件不响应命中');
})();

console.log('\n[9] 运行配置导出剥离辅助/假数据');
(function () {
  var normal = M.createNode({ id: 'n1', type: 'text', text: 'x', textVar: 'nickname',
    leftAnchor: anchor(M.SCREEN_ID, 'left', 'fixed', 0) });
  var bound = M.createNode({ id: 'n2', type: 'text', text: 'hp', textVar: 'hp', dataBinding: 'player.hp',
    leftAnchor: anchor(M.SCREEN_ID, 'left', 'fixed', 0) });
  var helper = M.createNode({ id: 'h1', type: 'edge', previewOnly: true,
    leftAnchor: anchor(M.SCREEN_ID, 'left', 'fixed', 0) });
  var childOfHelper = M.createNode({ id: 'h2', type: 'icon', parentId: 'h1' });
  var out = Ex.buildRuntimeConfig([normal, bound, helper, childOfHelper], [screen(320, 500)], 'default');
  eq(out.nodes.length, 2, 'previewOnly 组件及其子树被剔除');
  ok(out.nodes[0].textVar == null, '无 dataBinding 的预览假数据绑定被剥离');
  eq(out.nodes.find(function (n) { return n.id === 'n2'; }).textVar, 'hp', '有 dataBinding 的真实绑定保留');
  ok(out.nodes.every(function (n) { return n.previewOnly == null; }), 'previewOnly 字段本身被剥离');
  ok(out.dropped.fakeBindings >= 1, '统计被剥离的假数据数量');
})();

console.log('\n[10] 流式排列与 fill');(function () {
  var p = M.createNode({
    id: 'p', type: 'panel', layout: 'row', gap: 4, padding: [4, 6],
    width: { mode: 'fixed', value: 200 }, height: { mode: 'fixed', value: 30 },
    leftAnchor: anchor(M.SCREEN_ID, 'left', 'fixed', 0),
    topAnchor: anchor(M.SCREEN_ID, 'top', 'fixed', 0)
  });
  var c1 = M.createNode({ id: 'c1', type: 'icon', parentId: 'p',
    width: { mode: 'fixed', value: 20 }, height: { mode: 'fixed', value: 20 } });
  var c2 = M.createNode({ id: 'c2', type: 'bar', parentId: 'p',
    width: { mode: 'fill', value: 0 }, height: { mode: 'fixed', value: 12 } });
  var r = E.solveLayout([p, c1, c2], screen(320, 500), {}, fakeMeasure);
  eq(r.frames.c1.x, 6, '流式第一个子组件落在内边距后');
  ok(r.frames.c2.x > r.frames.c1.x, 'fill 子组件排在固定子组件之后');
  ok(r.frames.c2.w > 100, 'fill 子组件吃掉剩余宽度（实际 ' + Math.round(r.frames.c2.w) + '）');
})();

console.log('\n[11] 模态遮罩层豁免遮挡、组件参照底边语义');
(function () {
  var base = M.createNode({
    id: 'base', type: 'panel', layout: 'none',
    width: { mode: 'fixed', value: 100 }, height: { mode: 'fixed', value: 60 },
    leftAnchor: anchor(M.SCREEN_ID, 'left', 'fixed', 10),
    topAnchor: anchor(M.SCREEN_ID, 'top', 'fixed', 10)
  });
  var modal = M.createNode({
    id: 'modal', type: 'panel', layout: 'none', overlay: true,
    width: { mode: 'fixed', value: 100 }, height: { mode: 'fixed', value: 60 },
    leftAnchor: anchor(M.SCREEN_ID, 'left', 'fixed', 20),
    topAnchor: anchor(M.SCREEN_ID, 'top', 'fixed', 20)
  });
  var r = E.solveLayout([base, modal], screen(320, 500), {}, fakeMeasure);
  ok(!r.issues.some(function (i) { return i.nodeIds.indexOf('modal') >= 0; }),
    '模态层覆盖下层组件不报遮挡/冲突');

  // 组件 bottom 参照：应排在参照下方再加边距（而非向上漂移）
  var ref = M.createNode({
    id: 'ref', type: 'panel', layout: 'none',
    width: { mode: 'fixed', value: 100 }, height: { mode: 'fixed', value: 40 },
    leftAnchor: anchor(M.SCREEN_ID, 'left', 'fixed', 0),
    topAnchor: anchor(M.SCREEN_ID, 'top', 'fixed', 10)
  });
  var below = M.createNode({
    id: 'below', type: 'panel', layout: 'none',
    width: { mode: 'fixed', value: 50 }, height: { mode: 'fixed', value: 20 },
    leftAnchor: anchor(M.SCREEN_ID, 'left', 'fixed', 0),
    topAnchor: anchor('ref', 'bottom', 'fixed', 8)
  });
  var r2 = E.solveLayout([ref, below], screen(320, 500), {}, fakeMeasure);
  eq(r2.frames.below.y, 58, '锚组件底边 +8 → y=58（排在参照下方）');
})();

console.log('\n=======================================');
console.log('通过 ' + passed + '，失败 ' + failed);
process.exit(failed ? 1 : 0);
