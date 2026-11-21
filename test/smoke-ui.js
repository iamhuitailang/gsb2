// smoke-ui.js — 用最小 DOM mock 冒烟加载 ui.js，验证启动渲染与核心交互不抛错
import { JSDOM } from 'jsdom';

const dom = new JSDOM(`<!DOCTYPE html><html><body>
<div id="rulesetName"></div><button id="btnDemo"></button><button id="btnReplayDemo"></button>
<div id="turnInfo"></div><button id="btnEndTurn"></button><button id="btnRestart"></button>
<div id="pools"></div><div id="board"></div><div id="actionList"></div>
<div id="previewCard" hidden></div><div id="preview"></div><button id="btnExecute"></button><button id="btnCancelPreview"></button>
<button id="btnBranch"></button><div id="branchList"></div><div id="log"></div>
<input id="saveName"/><button id="btnSave"></button><div id="saveList"></div>
<button id="btnImport"></button><textarea id="rulesJson"></textarea><button id="btnApplyRules"></button><button id="btnShowRules"></button>
<div id="modal" hidden><h3 id="modalTitle"></h3><pre id="modalBody"></pre><button id="btnModalClose"></button></div>
</body></html>`, { url: 'http://localhost/' });

globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.confirm = () => true;
globalThis.alert = (m) => { throw new Error('alert: ' + m); };
dom.window.confirm = () => true;

await import('../src/ui.js');

const $ = (id) => document.getElementById(id);
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

assert($('rulesetName').textContent.includes('余烬潮汐'), '规则集名称已渲染');
assert($('board').querySelectorAll('.cell').length === 4, '4 个单元已渲染');
assert($('actionList').querySelectorAll('.action-btn').length === 3, '3 个行动按钮');
assert($('log').querySelectorAll('.log-line').length >= 1, '开局日志存在');

// 选行动 → 预览出现
const placeBtn = [...document.querySelectorAll('.action-btn')].find((b) => b.dataset.action === 'a_consume');
placeBtn.click();
assert($('previewCard').hidden === false, '预览卡片出现');
assert($('preview').textContent.includes('条件预览') || $('preview').querySelectorAll('.checks li').length >= 1, '条件列表渲染');

// 执行一个必然被阻止的行动（安息处消耗水滴）
const cellSelect = $('param-a_consume-cellId');
cellSelect.value = 'rest';
cellSelect.dispatchEvent(new dom.window.Event('change'));
const markerSelect = $('param-a_consume-marker');
markerSelect.value = 'drop';
markerSelect.dispatchEvent(new dom.window.Event('change'));
$('btnExecute').click();
assert($('modal').hidden === false, '被阻止行动弹出原因');
assert($('modalBody').textContent.includes('水滴不足'), '弹窗给出具体阻止状态：' + $('modalBody').textContent);

// 合法行动
document.querySelector('.action-btn[data-action="a_place"]').click();
$('param-a_place-cellId').value = 'src';
$('btnExecute').click();
assert($('log').textContent.includes('顺流') && $('log').textContent.includes('单规则上限'), '连锁与 cap 停止已记录');

// 分支复制与隔离
$('btnBranch').click();
const branchesBefore = document.querySelectorAll('#branchList .branch').length;
assert(branchesBefore === 2, '新分支出现');

// 保存与载入
$('saveName').value = 'smoke';
$('btnSave').click();
assert(document.querySelectorAll('#saveList .save').length === 1, '存档出现');
[...document.querySelectorAll('#branchList button[data-switch]')][0]?.click();
[...document.querySelectorAll('#saveList button[data-replay]')][0].click();
assert($('log').textContent.includes('开局'), '重放载入成功');

// 规则漂移：篡改规则后重放应拒绝
const tb = globalThis.window.__testbench ?? window.__testbench;
const rs2 = structuredClone(tb.getRuleset());
rs2.rules.find((r) => r.id === 'r_evap').cap = 99;
const bundle = JSON.parse(dom.window.localStorage.getItem('rule-testbench:saves'));
// 直接调引擎层漂移校验
const { checkDrift } = await import('../src/storage.js');
const drift = checkDrift(bundle[0].bundle, rs2);
assert(drift.compatible === false && drift.problems.some((p) => /蒸发/.test(p.text)), '漂移被识别');

// 演示回放
$('btnReplayDemo').click();
assert($('log').textContent.includes('凝结'), '三回合演示回放完成');

console.log('UI 冒烟测试全部通过 ✓');
