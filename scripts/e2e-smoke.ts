/**
 * 端到端接线测试：用 esbuild 把真实 src/main.ts（含全部事件委托）打包，
 * 在 jsdom 中启动，模拟点击 / change，验证六条需求的 UI 接线。
 * 运行：npx tsx scripts/e2e-smoke.ts
 */
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(path.join(root, 'index.html'), 'utf8');

const dom = new JSDOM(html, {
  url: 'http://localhost:4173/',
  pretendToBeVisual: true,
});

const g = globalThis as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
g.HTMLElement = dom.window.HTMLElement;
g.Node = dom.window.Node;
g.SVGElement = dom.window.SVGElement;
g.Element = dom.window.Element;
g.Event = dom.window.Event;
g.CustomEvent = dom.window.CustomEvent;
g.KeyboardEvent = dom.window.KeyboardEvent;
g.MouseEvent = dom.window.MouseEvent;
g.NodeList = dom.window.NodeList;
g.HTMLInputElement = dom.window.HTMLInputElement;
g.HTMLSelectElement = dom.window.HTMLSelectElement;
g.CSS = dom.window.CSS;
g.requestAnimationFrame = (cb: FrameRequestCallback) =>
  setTimeout(() => cb(performance.now()), 0) as unknown as number;
g.cancelAnimationFrame = (id: ReturnType<typeof setTimeout>) => clearTimeout(id);

// jsdom 未实现滚动 API，打桩避免异步回调崩溃
dom.window.Element.prototype.scrollIntoView = () => {};
dom.window.scrollTo = () => {};

// jsdom 的锚点点击 / 对象 URL 不需要真的导航
dom.window.HTMLAnchorElement.prototype.click = () => {};
if (!('createObjectURL' in URL)) {
  (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => 'blob:mock';
  (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
}

/* 打包真实入口（css 用 empty loader 跳过） */
const result = await build({
  entryPoints: [path.join(root, 'src/main.ts')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  write: false,
  logLevel: 'silent',
  loader: { '.css': 'empty' },
});
const bundlePath = path.join(os.tmpdir(), `lab-main-${Date.now()}.mjs`);
writeFileSync(bundlePath, result.outputFiles[0].text, 'utf8');
await import(`file://${bundlePath}`);

const doc = dom.window.document;
let n = 0;
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error('页面文本片段：', doc.body.textContent?.slice(0, 400));
    throw new Error(`E2E 断言失败：${msg}`);
  }
  n += 1;
}

const $ = <T extends Element = HTMLElement>(sel: string): T => doc.querySelector(sel) as T;
const $$ = <T extends Element = HTMLElement>(sel: string): T[] =>
  Array.from(doc.querySelectorAll(sel)) as T[];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* 1. 启动渲染 */
await sleep(20);
assert($$('#app .item-card').length === 9, '应渲染 9 个道具卡片');
assert($$('#app .pack-row').length === 14, '应渲染 14 个包行');
assert(doc.body.textContent?.includes('美术包解析试验场') ?? false, '应有标题');

/* 2. 切换场景到战斗 */
const battleBtn = $$<HTMLButtonElement>('.seg-btn').find((b) => b.textContent === '战斗')!;
battleBtn.click();
await sleep(10);
assert($$<HTMLButtonElement>('.seg-btn').find((b) => b.textContent === '战斗')?.classList.contains('is-active') ?? false, '战斗按钮应为激活态');
const swordCard = $('.item-card[data-id="sword_iron"]');
assert(swordCard.textContent?.includes('同级冲突') ?? false, '战斗下铁剑仍冲突');
// 赤包 precision winner -> its block glyph 战剑·赤 appears in card image alt? alt=glyph
const swordImgAlt = $('.item-card[data-id="sword_iron"] img')?.getAttribute('alt');
assert(swordImgAlt === '战剑·赤', `战斗下卡片图应为赤包战剑变体，实际 alt=${swordImgAlt}`);

/* 3. 切语言到 English */
const select = $<HTMLSelectElement>('#lang-select');
select.value = 'en-US';
select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
await sleep(10);
const potionAlt = $('.item-card[data-id="potion_hp"] img')?.getAttribute('alt');
assert(potionAlt === 'HP', `英文下药水应为 HP 图，实际 ${potionAlt}`);

/* 回到 world / zh-CN 便于后续断言（重渲染后必须重新查询 select） */
const selectAgain = $<HTMLSelectElement>('#lang-select');
selectAgain.value = 'zh-CN';
selectAgain.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
$$<HTMLButtonElement>('.seg-btn').find((b) => b.textContent === '大地图')!.click();
await sleep(10);

/* 4. 点击木箱卡片 -> 追踪面板滚动目标内容存在 */
$('.item-card[data-id="chest_wood"]').click();
await sleep(10);
assert(doc.body.textContent?.includes('资源被「精简 / 移除包」显式移除') ?? false, '应显示移除横幅');

/* 5. 关闭 lite 包 -> 木箱恢复成中文语言包图片 */
const liteToggle = $<HTMLInputElement>('.pack-row[data-pack-id="pack_lite"] input[type=checkbox]');
assert(liteToggle.checked === true, 'lite 默认应开启');
liteToggle.checked = false;
liteToggle.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
await sleep(10);
const chestAlt = $('.item-card[data-id="chest_wood"] img')?.getAttribute('alt');
assert(chestAlt === '木箱', `关闭 lite 后木箱应恢复为中文包图，实际 ${chestAlt}`);
assert($('.item-card[data-id="chest_wood"].card-found') !== null, '木箱卡片应为 found 态');
// 重新开启（必须在重渲染后重新查询节点，旧节点已脱离 document）
const liteToggleAgain = $<HTMLInputElement>('.pack-row[data-pack-id="pack_lite"] input[type=checkbox]');
liteToggleAgain.checked = true;
liteToggleAgain.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
await sleep(10);
assert($('.item-card[data-id="chest_wood"].card-removed') !== null, '重新开启后应为 removed 态');

/* 6. 关闭 hd_red -> neon 被依赖拦截，UI 出现 invalid 行 */
const redToggle = $<HTMLInputElement>('.pack-row[data-pack-id="pack_hd_red"] input[type=checkbox]');
redToggle.checked = false;
redToggle.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
await sleep(10);
assert($('.pack-row[data-pack-id="pack_neon"].is-invalid') !== null, 'neon 应标记为不可用');
assert(doc.body.textContent?.includes('依赖包「高清材质包 · 赤」') ?? false, '应显示具体依赖未开启信息');
const redToggleAgain = $<HTMLInputElement>('.pack-row[data-pack-id="pack_hd_red"] input[type=checkbox]');
redToggleAgain.checked = true;
redToggleAgain.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
await sleep(10);

/* 7. 批量应用健康三包 -> diff 弹窗 4 行 -> 确认应用 */
for (const id of ['pack_ink', 'pack_autumn', 'pack_pixel']) {
  const cb = $<HTMLInputElement>(`.batch-item input[data-id="${id}"]`);
  cb.checked = true;
  cb.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
}
await sleep(10);
const openBtn = $<HTMLButtonElement>('.batch-submit');
assert(openBtn.textContent?.includes('3 个包') ?? false, '按钮应显示已选 3 包');
openBtn.click();
await sleep(10);
assert($('#modal-root .modal-backdrop') !== null, '应打开 diff 弹窗');
assert($$('#modal-root .diff-row').length === 4, '应有 4 个变化行');
assert($('#modal-root .diff-blockers') === null, '健康选择不应有阻断');
const confirmBtn = $$<HTMLButtonElement>('#modal-root button').find((b) =>
  b.textContent?.includes('确认应用'),
);
assert(confirmBtn, '应有确认应用按钮');
confirmBtn!.click();
await sleep(10);
assert($('#modal-root .modal-backdrop') === null, '确认后弹窗应关闭');
assert($('.batch-submit')?.disabled === true, '应用后勾选清空，按钮应禁用');
assert(doc.body.textContent?.includes('已应用 3 个包') ?? false, '应有成功 toast');
// 水墨包生效后，钥匙卡片来源应变为 pack_ink
const keySource = $('.item-card[data-id="key_brass"] .source-chip code')?.textContent;
assert(keySource === 'pack_ink', `钥匙来源应为水墨包，实际 ${keySource}`);

/* 8. 批量勾选坏包 -> 阻断，无确认按钮，原状态不变 */
const badCb = $<HTMLInputElement>('.batch-item input[data-id="pack_darkmod"]');
badCb.checked = true;
badCb.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
await sleep(10);
$<HTMLButtonElement>('.batch-submit').click();
await sleep(10);
assert($('#modal-root .diff-blockers') !== null, '坏包应显示阻断框');
const hasConfirm = $$('#modal-root button').some((b) => b.textContent?.includes('确认应用'));
assert(!hasConfirm, '阻断态不应有确认应用按钮');
const backBtn = $$<HTMLButtonElement>('#modal-root button').find((b) =>
  b.textContent?.includes('返回修改'),
)!;
backBtn.click();
await sleep(10);

/* 9. 导出 JSON：拦截 Blob 内容并走解析往返 */
let captured = '';
const OrigBlob = globalThis.Blob;
g.Blob = class extends OrigBlob {
  constructor(parts?: BlobPart[], options?: BlobPropertyBag) {
    super(parts as BlobPart[], options);
    captured = (parts ?? []).map((p) => (typeof p === 'string' ? p : '')).join('');
  }
} as typeof Blob;
$<HTMLButtonElement>('[data-action="export-json"]').click();
await sleep(30);
assert(captured.includes('"app": "asset-pack-lab"'), '应导出标识头');
const doc2 = JSON.parse(captured);
assert(doc2.provenance.length === 108, '导出应含 108 行来源');
assert(doc2.config.enabled.pack_ink === true, '导出配置应包含刚应用的 ink');
g.Blob = OrigBlob;

/* 10. 优先级 + 按钮：把蓝包 +5 后冲突消失、蓝包稳定胜出 */
const incBlue = $<HTMLButtonElement>('.prio-btn[data-action="prio-inc"][data-id="pack_hd_blue"]');
incBlue.click();
await sleep(10);
const swordCard2 = $('.item-card[data-id="sword_iron"]');
assert(swordCard2.classList.contains('card-found'), '蓝包提权后铁剑应变为普通 found（冲突消失）');
assert(swordCard2.textContent?.includes('pack_hd_blue') ?? false, '图源仍应是蓝包');

console.log(`E2E 接线测试全部通过（${n} 个断言）✅`);
dom.window.close();
process.exit(0);
