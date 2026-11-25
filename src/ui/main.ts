import { h, clear } from './h.ts';
import { createInitialState, type TabId } from './state.ts';
import type { UiContext } from './context.ts';
import { LOCALE_ORDER } from '../data/packs/index.ts';
import { categoryLabel } from '../data/game-data.ts';
import { renderPlayTab } from './panels/play.ts';
import { renderQaTab } from './panels/qa.ts';
import { renderDiffTab } from './panels/diff.ts';

const app = document.getElementById('app');
if (!app) throw new Error('#app root not found');

const state = createInitialState();

// 支持 file:// 下用 #play / #qa / #diff 深链直达，方便分享与无头验证
const HASH_TABS: TabId[] = ['play', 'qa', 'diff'];
const initialHash = window.location.hash.replace('#', '') as TabId;
if (HASH_TABS.includes(initialHash)) state.tab = initialHash;
window.addEventListener('hashchange', () => {
  const t = window.location.hash.replace('#', '') as TabId;
  if (HASH_TABS.includes(t) && t !== state.tab) ctx.update({ tab: t });
});

let tabRoot: HTMLElement;
let navRoot: HTMLElement;
let controlsRoot: HTMLElement;

function renderActiveTab() {
  clear(tabRoot);
  if (state.tab === 'play') tabRoot.appendChild(renderPlayTab(ctx));
  if (state.tab === 'qa') tabRoot.appendChild(renderQaTab(ctx));
  if (state.tab === 'diff') tabRoot.appendChild(renderDiffTab(ctx));
  renderNav();
}

function renderControls() {
  clear(controlsRoot);
  controlsRoot.appendChild(Controls());
}

const ctx: UiContext = {
  state,
  update(patch) {
    Object.assign(state, patch);
    if (patch.tab) {
      const hash = `#${patch.tab}`;
      if (window.location.hash !== hash) window.history.replaceState(null, '', hash);
    }
    renderControls();
    renderActiveTab();
  },
  rerender: renderActiveTab,
};

function renderNav() {
  const tabs: Array<{ id: TabId; label: string; badge?: string }> = [
    { id: 'play', label: '① 试玩 / 批量预演' },
    {
      id: 'qa',
      label: '② 质检清单',
      badge: String(state.issues.filter((i) => i.severity === 'error').length),
    },
    { id: 'diff', label: '③ 更新语言包对比' },
  ];
  clear(navRoot);
  for (const t of tabs) {
    navRoot.appendChild(
      h(
        'button',
        {
          class: `tab-btn ${state.tab === t.id ? 'tab-active' : ''}`,
          onclick: () => ctx.update({ tab: t.id }),
        },
        t.label,
        t.badge && t.badge !== '0' ? h('span', { class: 'tab-badge' }, t.badge) : null,
      ),
    );
  }
}

function Controls() {
  const countInput = h('input', {
    id: 'ctrl-count',
    type: 'number',
    min: '0',
    step: '1',
    value: state.count,
    oninput: (e: Event) => {
      const v = Number((e.target as HTMLInputElement).value);
      state.count = Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;
      renderActiveTab();
    },
  }) as HTMLInputElement;

  const preset = (n: number, label?: string) =>
    h('button', {
      class: `btn btn-preset ${state.count === n ? 'preset-active' : ''}`,
      dataset: { count: String(n) },
      onclick: () => ctx.update({ count: n }),
    }, label ?? String(n));

  return h(
    'section',
    { class: 'controls card' },
    h(
      'div',
      { class: 'ctrl-group' },
      h('label', { class: 'ctrl-label' }, '预览语言'),
      h(
        'select',
        {
          value: state.locale,
          onchange: (e: Event) => ctx.update({ locale: (e.target as HTMLSelectElement).value }),
        },
        ...LOCALE_ORDER.map((l) => h('option', { value: l, selected: l === state.locale }, state.packs[l]?.label ?? l)),
      ),
    ),
    h(
      'div',
      { class: 'ctrl-group' },
      h('label', { class: 'ctrl-label' }, '角色（决定称呼句式）'),
      h(
        'select',
        {
          onchange: (e: Event) => ctx.update({ characterId: (e.target as HTMLSelectElement).value }),
        },
        ...state.characters.map((c) =>
          h(
            'option',
            { value: c.id, selected: c.id === state.characterId },
            `${c.name[state.locale] ?? c.name['zh-CN']} · ${state.packs[state.locale]?.terms.address[c.address] ?? c.address}称呼`,
          ),
        ),
      ),
    ),
    h(
      'div',
      { class: 'ctrl-group' },
      h('label', { class: 'ctrl-label' }, '物品（决定类别句式）'),
      h(
        'select',
        {
          onchange: (e: Event) => ctx.update({ itemId: (e.target as HTMLSelectElement).value }),
        },
        ...state.items.map((i) =>
          h(
            'option',
            { value: i.id, selected: i.id === state.itemId },
            `${i.name[state.locale] ?? i.name['zh-CN']} · ${categoryLabel(i.category, state.locale)}`,
          ),
        ),
      ),
    ),
    h(
      'div',
      { class: 'ctrl-group ctrl-count' },
      h('label', { class: 'ctrl-label' }, '数量（批量覆盖）'),
      h('div', { class: 'count-row' }, countInput, preset(0), preset(1), preset(2, '2+'), preset(5)),
    ),
  );
}

app.appendChild(
  h(
    'header',
    { class: 'site-header' },
    h(
      'div',
      null,
      h('h1', null, '《星港杂货铺》文案上下文检查台'),
      h('p', { class: 'subtitle' }, '数量 · 称呼对象 · 物品类别驱动的多句式语言包检查 / 试玩 / 回退溯源 / 更新对比（纯本地虚构样例）'),
    ),
    h('span', { class: 'offline-badge', title: '所有资源与计算均在本地，无任何网络请求' }, '● 离线可用'),
  ),
);
controlsRoot = h('div', { class: 'controls-slot' });
app.appendChild(controlsRoot);
renderControls();
navRoot = h('nav', { class: 'tabs' });
app.appendChild(navRoot);
tabRoot = h('main', { class: 'tab-root' });
app.appendChild(tabRoot);
app.appendChild(
  h(
    'footer',
    { class: 'site-footer' },
    '默认样例内置了：漏放变量、拼错的多出变量、整数类型错误、漏传变量值、未走到的句式，以及同语言通用句 / 跨语言两种回退。命令行运行 ',
    h('code', null, 'npm run qa'),
    ' 可离线生成 qa-checklist.md。',
  ),
);

renderActiveTab();
