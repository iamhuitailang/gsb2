/**
 * UI 渲染冒烟：在 jsdom 里把所有面板 / 弹窗都构建一遍，
 * 并模拟若干状态变更后重新渲染，捕捉 DOM 构造期错误。
 * 运行：npx tsx scripts/dom-smoke.ts
 */
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
  url: 'http://localhost:5173/',
});
(globalThis as Record<string, unknown>).window = dom.window;
(globalThis as Record<string, unknown>).document = dom.window.document;
(globalThis as Record<string, unknown>).HTMLElement = dom.window.HTMLElement;
(globalThis as Record<string, unknown>).Node = dom.window.Node;
(globalThis as Record<string, unknown>).SVGElement = dom.window.SVGElement;
(globalThis as Record<string, unknown>).CustomEvent = dom.window.CustomEvent;
(globalThis as Record<string, unknown>).requestAnimationFrame = (cb: FrameRequestCallback) =>
  setTimeout(() => cb(performance.now()), 0) as unknown as number;

const { createInitialState } = await import('../src/state');
const { analyzePacks } = await import('../src/engine/graph');
const { resolveItem } = await import('../src/engine/resolve');
const { planBatchApply } = await import('../src/engine/batch');
const { renderPackStack, renderBatchPanel } = await import('../src/ui/renderPacks');
const { renderIssueCenter } = await import('../src/ui/renderIssues');
const { renderItemGrid, renderTracePanel } = await import('../src/ui/renderItems');
const { renderProvenanceTable } = await import('../src/ui/renderProvenance');
const { renderModal } = await import('../src/ui/renderModal');

const document_ = dom.window.document;
const root = document_.getElementById('app')!;

let assertions = 0;
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`断言失败：${msg}`);
  assertions += 1;
}

function renderAll(state: ReturnType<typeof createInitialState>) {
  const analysis = analyzePacks(state.library, state.config.enabled, state.config.priorities);
  const results = new Map(
    state.items.map((i) => [
      i.id,
      resolveItem(i.id, state.config.query, state.library, analysis),
    ]),
  );

  root.replaceChildren();
  root.appendChild(renderIssueCenter(state, analysis, results));
  root.appendChild(renderPackStack(state, analysis));
  root.appendChild(renderBatchPanel(state, analysis));
  root.appendChild(
    renderItemGrid(state, results, new Map(state.library.map((p) => [p.id, p.name]))),
  );
  root.appendChild(renderTracePanel(state, results.get(state.config.selectedItemId)));
  root.appendChild(renderProvenanceTable(state, results));

  return { analysis, results };
}

/* 1. 初始状态全量渲染 */
const state = createInitialState();
let { results } = renderAll(state);

assert(root.querySelectorAll('.pack-row').length === state.library.length, '应渲染全部包行');
assert(root.querySelectorAll('.item-card').length === state.items.length, '应渲染全部道具卡片');
assert(root.querySelectorAll('.rung-row').length > 20, '追踪面板应输出逐级行');
assert(root.textContent?.includes('依赖成环') ?? false, '应包含成环问题栏');
assert(root.textContent?.includes('同级替换冲突') ?? false, '应包含冲突问题栏');

const sword = results.get('sword_iron')!;
assert(sword.status === 'conflict', '默认铁剑应为冲突');
assert(root.querySelector('.item-card.card-conflict') !== null, '应有冲突卡片样式');

/* 2. 切场景 / 语言后重新渲染 */
state.config.query.scene = 'battle';
state.config.query.language = 'en-US';
({ results } = renderAll(state));
assert(results.get('sword_iron')!.winnerPackId === 'pack_hd_red', '战斗 + 英文下赤包因精度胜出');
assert(root.textContent?.includes('battle / en-US') ?? false, '追踪副标题应反映新查询');

/* 3. 关闭 lite -> 木箱恢复 */
state.config.query = { scene: 'world', language: 'zh-CN' };
state.config.enabled.pack_lite = false;
({ results } = renderAll(state));
assert(results.get('chest_wood')!.status === 'found', '关闭 lite 后木箱恢复');

/* 4. 关闭 hd_red -> neon 不可用，UI 出现已跳过标记 */
state.config.enabled.pack_hd_red = false;
renderAll(state);
assert(root.textContent?.includes('依赖未开启') ?? false, 'UI 应显示依赖未开启');
assert(root.querySelector('.pack-row.is-invalid') !== null, '应有不可用包样式');
state.config.enabled.pack_hd_red = true;
state.config.enabled.pack_lite = true;

/* 5. 展开全部追踪 */
state.expandAllTraces = true;
renderAll(state);
const openDetails = root.querySelectorAll('details.trace-pack[open]').length;
assert(openDetails === state.library.length, '展开全部时每个包 details 都应 open');
state.expandAllTraces = false;

/* 6. 批量 diff 弹窗（健康包） */
const healthySelection = ['pack_ink', 'pack_autumn', 'pack_pixel'];
let plan = planBatchApply({
  library: state.library,
  items: state.items,
  query: state.config.query,
  currentEnabled: state.config.enabled,
  priorities: state.config.priorities,
  selectedIds: healthySelection,
});
state.modal = { type: 'diff', plan, selectedIds: healthySelection };
let modal = renderModal(state)!;
assert(modal !== null, '应渲染 diff 弹窗');
assert(modal.querySelectorAll('.diff-row').length === 4, '应有 4 个变化道具行');
assert(modal.querySelector('.diff-blockers') === null, '健康选择不应有阻断框');
assert(modal.textContent?.includes('确认应用') ?? false, '应出现确认按钮');

/* 7. 批量 diff 弹窗（坏包） */
const badSelection = ['pack_darkmod', 'pack_cycle_a'];
plan = planBatchApply({
  library: state.library,
  items: state.items,
  query: state.config.query,
  currentEnabled: state.config.enabled,
  priorities: state.config.priorities,
  selectedIds: badSelection,
});
state.modal = { type: 'diff', plan, selectedIds: badSelection };
modal = renderModal(state)!;
assert(modal.querySelector('.diff-blockers') !== null, '坏包应显示阻断框');
assert(modal.textContent?.includes('返回修改选择') ?? false, '阻断时只给返回按钮');
assert(!modal.textContent?.includes('确认应用') ?? true, '阻断时不应有确认应用按钮');

/* 8. 导入报告弹窗 */
state.modal = {
  type: 'import-report',
  ok: true,
  title: '导入成功，覆盖结果已重现',
  lines: ['资源包 13 套'],
  verification: { checked: 108, consistent: 108, mismatchCount: 0 },
};
modal = renderModal(state)!;
assert(modal.textContent?.includes('108/108') ?? false, '应显示复算一致率');

/* 9. 缺图占位：空库渲染不炸 */
const emptyState = createInitialState();
emptyState.library = [];
emptyState.config.enabled = {};
emptyState.config.selectedItemId = 'ghost';
renderAll(emptyState);
assert(root.querySelectorAll('.ph-missing').length === state.items.length, '空库时所有卡片应为缺图占位');

console.log(`DOM 冒烟全部通过（${assertions} 个断言）✅`);
dom.window.close();
