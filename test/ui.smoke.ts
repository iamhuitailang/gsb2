/**
 * UI 冒烟测试（不包含在默认 npm test 中，需要 devDependency jsdom）：
 * 用 jsdom 加载真实的 web/app.bundle.js，模拟核心交互，捕获 DOM 运行时错误。
 * 运行：npm run smoke:ui（需先 npm run bundle:web）
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const code = readFileSync(new URL('../web/app.bundle.js', import.meta.url), 'utf8');

const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/' });
const { window } = dom;

const errors: string[] = [];
window.addEventListener('error', (e) => errors.push(e.message));

window.eval(code);

const doc = window.document;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function clickByText(selector: string, text: string) {
  const btn = [...doc.querySelectorAll<HTMLButtonElement>(selector)].find((b) =>
    b.textContent?.includes(text),
  );
  assert.ok(btn, `应找到按钮：${text}`);
  btn!.click();
}

// 1) 首屏挂载
assert.ok(doc.querySelector('.site-header h1')?.textContent?.includes('星港杂货铺'));
const lineCount = doc.querySelectorAll('.dlg-line').length;
assert.equal(lineCount, 13, `应渲染 13 条事件台词，实际 ${lineCount}`);
assert.equal(doc.querySelectorAll('.matrix-table').length, 2);
assert.ok(doc.querySelectorAll('.matrix-cell').length >= 32);
console.log('✔ 首屏：13 条对白 + 2 张矩阵');

// 2) 切到日语，应出现跨语言回退徽章
const localeSelect = doc.querySelectorAll<HTMLSelectElement>('.controls select')[0];
localeSelect.value = 'ja-JP';
localeSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
assert.ok(doc.querySelector('.src-locale-fallback'), '日语下应有跨语言回退徽章');
assert.ok(doc.body.textContent?.includes('跨语言回退 → EN'));
console.log('✔ 日语：跨语言回退徽章正常');

// 3) 数量预设 0 不报错且矩阵仍在
clickByText('.btn-preset', '0');
assert.equal(doc.querySelectorAll('.matrix-table').length, 2);
clickByText('.btn-preset', '2+');
console.log('✔ 数量预设 0 / 2+ 切换无异常');

// 4) 质检 Tab
clickByText('.tab-btn', '质检清单');
assert.ok(doc.querySelectorAll('.issue').length >= 10, '应列出聚合问题卡片');
clickByText('.chip', '变量缺失');
assert.ok(doc.querySelectorAll('.issue.kind-var-missing').length >= 3);
clickByText('.chip', '全部');
console.log(`✔ 质检 Tab：${doc.querySelectorAll('.issue').length} 张问题卡，筛选可用`);

// 5) Diff Tab：填入修订 -> 应用 -> 出现两类变化
clickByText('.tab-btn', '更新语言包对比');
clickByText('.editor-controls .btn', '填入 ja-JP 示例修订 v2');
clickByText('.editor-controls .btn-primary', '应用更新并对比');
await sleep(10);
const diffRows = doc.querySelectorAll('.diff-row').length;
assert.equal(diffRows, 45, `应对 45 个样例生成 diff，实际 ${diffRows}`);
assert.ok(doc.querySelectorAll('.diff-text-changed').length > 0, '应有文字变化行');
assert.ok(doc.querySelectorAll('.diff-source-only').length > 0, '应有仅来源变化行');
console.log(
  `✔ Diff：${diffRows} 行，文字变化 ${doc.querySelectorAll('.diff-text-changed').length}，仅来源变化 ${doc.querySelectorAll('.diff-source-only').length}`,
);

// 6) 应用修订后回到质检 Tab，ja 的 count 漏变量问题应消失
clickByText('.tab-btn', '质检清单');
const jaCountCards = [...doc.querySelectorAll('.issue')].filter(
  (el) => el.textContent?.includes('ja-JP') && el.textContent?.includes('变量 {count}'),
);
assert.equal(jaCountCards.length, 0, '修订后 ja-JP 漏 count 的问题应已消除');
console.log('✔ 应用修订后质检结果联动更新');

assert.deepEqual(errors, [], `window error: ${errors.join('; ')}`);
console.log('\nUI 冒烟全部通过。');
