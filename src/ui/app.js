// 前端主控:粘贴/导入/切换样例走同一个 sanitizeHtml 入口,
// 保证不同输入路径的安全结果完全一致。

import { sanitizeHtml } from '../sanitizer/sanitizer.js';
import { buildPreviewDocument } from '../sanitizer/preview.js';
import { reasonText, ELEMENT_REASON_TONE } from '../ui/labels.js';

const $ = (id) => document.getElementById(id);

const input = $('html-input');
const frame = $('preview-frame');
const safeSourceView = $('safe-source-view');
const rawInputView = $('raw-input-view');
const reportBody = $('report-body');
const toast = $('toast');

let lastResult = null;

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2200);
}

// ---- 视图切换 -------------------------------------------------------------
const VIEW_TARGETS = {
  safe: frame,
  source: safeSourceView,
  raw: rawInputView
};
const VIEW_TABS = {
  safe: $('tab-safe'),
  source: $('tab-safe-source'),
  raw: $('tab-raw')
};

function switchView(mode) {
  for (const [key, target] of Object.entries(VIEW_TARGETS)) {
    target.classList.toggle('hidden', key !== mode);
    VIEW_TABS[key].classList.toggle('active', key === mode);
  }
}

$('tab-safe').addEventListener('click', () => switchView('safe'));
$('tab-safe-source').addEventListener('click', () => switchView('source'));
$('tab-raw').addEventListener('click', () => {
  // 原始输入只以 textContent 写入 <pre>,浏览器不会解析其中的任何标记
  rawInputView.textContent = input.value;
  switchView('raw');
});

// ---- 报告渲染(全部 textContent,杜绝报告本身成为 XSS 载体) ---------------
function makeLi(text, tone) {
  const li = document.createElement('li');
  if (tone) li.className = tone;
  li.textContent = text;
  return li;
}

function renderGroup(title, items, emptyText) {
  const group = document.createElement('div');
  group.className = 'report-group';
  const h = document.createElement('h3');
  h.textContent = title;
  group.appendChild(h);
  if (!items.length) {
    const p = document.createElement('p');
    p.className = 'report-empty';
    p.textContent = emptyText;
    group.appendChild(p);
    return group;
  }
  const ul = document.createElement('ul');
  for (const item of items) ul.appendChild(item);
  group.appendChild(ul);
  return group;
}

function renderReport(result) {
  const { report, stats } = result;
  reportBody.replaceChildren();

  const statsRow = document.createElement('div');
  statsRow.className = 'stats-row';
  const statDefs = [
    ['移除元素', stats.removedElements, 'danger'],
    ['移除/改写属性', stats.removedAttributes, 'warn'],
    ['拦截 CSS 声明', stats.removedStyleDeclarations, 'warn'],
    ['拒绝地址', stats.rejectedUrls, 'danger'],
    ['放行地址', stats.allowedUrls, 'ok'],
    ['解析容错', stats.parserIssues, 'warn']
  ];
  for (const [label, value, tone] of statDefs) {
    const box = document.createElement('div');
    box.className = `stat ${tone}`;
    const b = document.createElement('b');
    b.textContent = String(value);
    box.append(b, ` ${label}`);
    statsRow.appendChild(box);
  }
  reportBody.appendChild(statsRow);

  // 元素
  reportBody.appendChild(renderGroup(
    '移除的元素',
    report.removedElements.map((e) => makeLi(
      `<${e.tag}> · ${reasonText(e.reason)}${e.withChildren ? ' · 含全部子内容' : ''}`,
      ELEMENT_REASON_TONE[e.reason] || 'warn'
    )),
    '没有元素被移除'
  ));

  // 属性
  reportBody.appendChild(renderGroup(
    '移除或改写的属性',
    report.removedAttributes.map((a) => makeLi(
      `<${a.tag}> 上的 ${a.attribute} · ${reasonText(a.reason)}`,
      a.reason === 'event-handler' ? 'danger' : 'warn'
    )),
    '没有属性被移除'
  ));

  // CSS
  reportBody.appendChild(renderGroup(
    '拦截的样式声明',
    report.removedStyleDeclarations.map((c) => makeLi(
      `<${c.tag}> 的 ${c.property || '(无名声明)'} · ${reasonText(c.reason)}`,
      'warn'
    )),
    '没有样式声明被拦截'
  ));

  // URL 判定明细
  reportBody.appendChild(renderGroup(
    '地址判定明细',
    report.urlDecisions.map((u) => {
      const tone = u.verdict === 'allowed' ? 'ok' : 'danger';
      const verb = u.verdict === 'allowed' ? '放行' : '拒绝';
      return makeLi(
        `<${u.tag}> ${u.attribute} → ${verb} · ${reasonText(
          u.verdict === 'allowed' ? 'ok' : u.reason
        )} · 地址片段:${u.sample || '(空)'}`,
        tone
      );
    }),
    '输入中没有需要判定的地址'
  ));

  // 解析问题
  reportBody.appendChild(renderGroup(
    '解析器容错记录(畸形/混淆输入)',
    report.parserIssues.map((p) => makeLi(
      `${p.type}${p.detail ? ` · ${typeof p.detail === 'string' ? p.detail : JSON.stringify(p.detail)}` : ''}`,
      'warn'
    )),
    '输入结构规范,无容错记录'
  ));
}

// ---- 清理主流程(唯一入口) ------------------------------------------------
function runCleanup() {
  const raw = input.value;
  lastResult = sanitizeHtml(raw);

  // 1) 隔离预览:srcdoc 由属性赋值(不会被内联解析),iframe 无任何 sandbox 令牌
  frame.srcdoc = buildPreviewDocument(lastResult.html);

  // 2) 清理结果源码:纯文本展示
  safeSourceView.textContent = lastResult.html || '(清理后无任何安全内容)';

  // 3) 原始输入视图同步刷新(仍保持纯文本)
  rawInputView.textContent = raw;

  // 4) 报告
  renderReport(lastResult);
  switchView('safe');
}

$('btn-clean').addEventListener('click', runCleanup);

$('btn-clear').addEventListener('click', () => {
  input.value = '';
  lastResult = null;
  frame.srcdoc = '';
  safeSourceView.textContent = '';
  rawInputView.textContent = '';
  reportBody.replaceChildren();
  const p = document.createElement('p');
  p.className = 'report-empty';
  p.textContent = '尚未执行清理。点击「清理并预览」后,这里会列出被移除或改写的内容类别。';
  reportBody.appendChild(p);
  switchView('safe');
  showToast('已清空');
});

// ---- 文件导入(本地读取,不经过任何网络) -----------------------------------
const fileInput = $('file-input');
$('btn-import').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async () => {
  const file = fileInput.files && fileInput.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    input.value = text;
    runCleanup();
    showToast(`已导入:${file.name}`);
  } catch (err) {
    showToast(`导入失败:${err.message}`);
  } finally {
    fileInput.value = '';
  }
});

// ---- 演示样例加载 ----------------------------------------------------------
async function loadSamples() {
  const select = $('sample-select');
  try {
    const resp = await fetch('/api/samples');
    const samples = await resp.json();
    for (const s of samples) {
      const opt = document.createElement('option');
      opt.value = s.file;
      opt.textContent = s.title;
      select.appendChild(opt);
    }
  } catch {
    const opt = document.createElement('option');
    opt.textContent = '样例列表加载失败';
    opt.disabled = true;
    select.appendChild(opt);
  }
}

$('sample-select').addEventListener('change', async (ev) => {
  const file = ev.target.value;
  if (!file) return;
  const resp = await fetch(`/api/samples/${encodeURIComponent(file)}`);
  input.value = await resp.text();
  runCleanup(); // 与粘贴/导入完全相同的清理入口
  showToast('已载入演示样例并完成清理');
});

// ---- 初始化 ----------------------------------------------------------------
loadSamples();
