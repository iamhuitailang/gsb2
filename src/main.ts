import { h, clear } from './ui/dom';
import { store } from './state';
import { renderDecksTab } from './ui/tab-decks';
import { createExchangeTab } from './ui/tab-exchange';
import { createOpeningTab } from './ui/tab-opening';
import { createSimulateTab } from './ui/tab-simulate';
import { createIoTab } from './ui/tab-io';

type TabId = 'decks' | 'exchange' | 'opening' | 'simulate' | 'io';

interface TabController {
  el: HTMLElement;
  onStoreChange?: () => void;
}

const TABS: { id: TabId; label: string; hint: string }[] = [
  { id: 'decks', label: '① 牌组与印次校验', hint: '主牌 / 备选、共享上限、核心阵营' },
  { id: 'exchange', label: '② 备选交换', hint: '整批合法才生效，错误归因到原牌 / 换入牌' },
  { id: 'opening', label: '③ 起手与换手', hint: '固定种子、一次调度、搭配资格' },
  { id: 'simulate', label: '④ 种子对比', hint: '多牌组同批种子，点开失败样本' },
  { id: 'io', label: '⑤ 导入导出 / 版本差异', hint: '认 id 不认名字，不做同名顶替' },
];

let active: TabId = 'decks';
const controllers: Partial<Record<TabId, TabController>> = {};

function getController(id: TabId): TabController {
  const existing = controllers[id];
  if (existing) return existing;
  let c: TabController;
  if (id === 'exchange') c = createExchangeTab();
  else if (id === 'opening') c = createOpeningTab();
  else if (id === 'simulate') c = createSimulateTab();
  else if (id === 'io') c = createIoTab(goTab);
  else {
    const el = h('div', { class: 'tab-decks-host' });
    const update = () => {
      clear(el);
      el.appendChild(renderDecksTab());
    };
    update();
    c = { el, onStoreChange: update };
  }
  controllers[id] = c;
  return c;
}

function goTab(id: string) {
  if (TABS.some((t) => t.id === id)) switchTab(id as TabId);
}

function switchTab(id: TabId) {
  active = id;
  if (location.hash !== `#${id}`) history.replaceState(null, '', `#${id}`);
  const view = document.getElementById('view')!;
  clear(view);
  const c = getController(id);
  c.onStoreChange?.();
  view.appendChild(c.el);
  document.querySelectorAll('.tab-btn').forEach((b) => {
    b.classList.toggle('active', (b as HTMLElement).dataset.tab === id);
  });
}

function boot() {
  const app = document.getElementById('app')!;
  const nav = h(
    'nav',
    { class: 'tab-nav' },
    ...TABS.map((t) =>
      h('button', {
        class: 'tab-btn',
        dataset: { tab: t.id },
        title: t.hint,
        onclick: () => switchTab(t.id),
      }, t.label)),
  );

  const header = h(
    'header',
    { class: 'app-header' },
    h('div', { class: 'brand' },
      h('span', { class: 'brand-diamond' }, '♦'),
      h('div', null,
        h('h1', null, '方片牌组实验室'),
        h('p', { class: 'brand-sub' }, '虚构卡牌桌游 · 本地牌组 / 备选交换 / 起手校验 / 种子横评（数据不出浏览器）'))),
    h('div', { class: 'header-meta' }, 'TypeScript · 单文件打包 · file:// 可开'),
  );

  app.appendChild(header);
  app.appendChild(nav);
  app.appendChild(h('main', { id: 'view', class: 'view' }));

  const initial = (location.hash.replace('#', '') as TabId) || 'decks';
  switchTab(TABS.some((t) => t.id === initial) ? initial : 'decks');

  window.addEventListener('hashchange', () => {
    const id = location.hash.replace('#', '') as TabId;
    if (TABS.some((t) => t.id === id) && id !== active) switchTab(id);
  });

  store.subscribe(() => {
    controllers[active]?.onStoreChange?.();
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
