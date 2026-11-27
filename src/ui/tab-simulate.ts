import type { DrawTrace, MulliganPolicy } from '../types';
import { store } from '../state';
import { validateDeck } from '../validate';
import { trialForSeed } from '../opening';
import { h, clear } from './dom';
import { sectionTitle } from './common';
import { openTraceBrowser } from './traceModal';

interface DeckResult {
  deckId: string;
  traces: DrawTrace[];
  firstPass: number;
  finalPass: number;
  finalFailed: DrawTrace[];
  firstFailed: DrawTrace[];
}

let selectedIds = new Set<string>(['deck-aggro', 'deck-combo', 'deck-grove', 'deck-cycle']);
let count = 1000;
let baseSeed = 1;
let policy: MulliganPolicy = 'smart';
let results: DeckResult[] | null = null;
let lastRunKey = '';

function pct(n: number, d: number): string {
  return d === 0 ? '—' : `${((n / d) * 100).toFixed(1)}%`;
}

function rateBar(r: DeckResult, total: number, rerender: () => void) {
  const finalRate = r.finalPass / total;
  const firstRate = r.firstPass / total;
  const deck = store.decks.find((d) => d.id === r.deckId)!;
  return h(
    'div',
    { class: 'rate-cell' },
    h(
      'div',
      { class: 'rate-bar-track', title: `调度后 ${pct(r.finalPass, total)}；初始 ${pct(r.firstPass, total)}` },
      h('div', { class: 'rate-bar-fill', style: `width:${(finalRate * 100).toFixed(2)}%` }),
      h('div', {
        class: 'rate-tick',
        style: `left:calc(${(firstRate * 100).toFixed(2)}% - 1px)`,
        title: `初始起手达标率 ${pct(r.firstPass, total)}`,
      }),
    ),
    h('div', { class: 'rate-labels' },
      h('span', { class: 'rate-final' }, pct(r.finalPass, total)),
      h('span', { class: 'rate-first muted small' }, `初始 ${pct(r.firstPass, total)}`),
      h('button', {
        class: 'link-btn',
        disabled: r.finalFailed.length === 0,
        onclick: () => openTraceBrowser(deck, r.finalFailed, 0, `调度后仍失败 · ${deck.name}`),
      }, `看 ${r.finalFailed.length} 个调度后失败例`),
      h('button', {
        class: 'link-btn muted-link',
        disabled: r.firstFailed.length === 0,
        onclick: () => openTraceBrowser(deck, r.firstFailed, 0, `初始起手失败 · ${deck.name}`),
      }, `初始失败 ${r.firstFailed.length}`),
    ),
  );
}

export function createSimulateTab() {
  const el = h('div', { class: 'tab-sim' });

  function run() {
    const ids = store.decks.filter((d) => selectedIds.has(d.id)).map((d) => d.id);
    const n = Math.max(1, Math.min(5000, count | 0 || 1));
    results = ids.map((id) => {
      const deck = store.decks.find((d) => d.id === id)!;
      const traces: DrawTrace[] = [];
      for (let i = 0; i < n; i++) traces.push(trialForSeed(deck, (baseSeed + i) >>> 0, policy));
      return {
        deckId: id,
        traces,
        firstPass: traces.filter((t) => t.firstPass).length,
        finalPass: traces.filter((t) => t.finalPass).length,
        finalFailed: traces.filter((t) => !t.finalPass),
        firstFailed: traces.filter((t) => !t.firstPass),
      };
    });
    lastRunKey = `${n}-${baseSeed}-${policy}-${ids.join('|')}`;
  }

  function update() {
    clear(el);

    const controls = h(
      'section',
      { class: 'card-panel sim-controls' },
      sectionTitle('同一批种子，横评不同牌组', '每个牌组对 seed = base … base+N-1 各自从完全相同的数字种子洗牌，结果可复现。'),
      h('div', { class: 'control-grid' },
        h('label', { class: 'control-field' },
          h('span', null, '种子数量 N'),
          (() => {
            const inp = h('input', { type: 'number', min: '1', max: '5000', value: String(count) }) as HTMLInputElement;
            inp.addEventListener('change', () => { count = Number(inp.value) || 1; });
            return inp;
          })()),
        h('label', { class: 'control-field' },
          h('span', null, '起始种子 base'),
          (() => {
            const inp = h('input', { type: 'number', value: String(baseSeed) }) as HTMLInputElement;
            inp.addEventListener('change', () => { baseSeed = Number(inp.value) || 1; });
            return inp;
          })()),
        h('label', { class: 'control-field' },
          h('span', null, '试抽换手策略（仅初始不达标时换一次）'),
          (() => {
            const sel = h('select', null,
              h('option', { value: 'smart', selected: policy === 'smart' }, '智能留牌：保留组合件 / 同阵营贡献牌'),
              h('option', { value: 'all', selected: policy === 'all' }, '全部换走，重抽 5 张'),
              h('option', { value: 'none', selected: policy === 'none' }, '不换手')) as HTMLSelectElement;
            sel.value = policy;
            sel.addEventListener('change', () => { policy = sel.value as MulliganPolicy; });
            return sel;
          })()),
        h('div', { class: 'control-run' },
          h('button', { class: 'btn btn-primary', onclick: () => { run(); update(); } }, '开始试抽对比')),
      ),
      h('div', { class: 'deck-checks' },
        ...store.decks.map((d) => {
          const v = validateDeck(d);
          const cb = h('input', { type: 'checkbox' }) as HTMLInputElement;
          cb.checked = selectedIds.has(d.id);
          cb.addEventListener('change', () => {
            if (cb.checked) selectedIds.add(d.id);
            else selectedIds.delete(d.id);
            update();
          });
          return h('label', { class: `deck-check ${v.legal ? '' : 'is-illegal-deck'}` },
            cb,
            h('span', { class: `valid-dot ${v.legal ? 'is-legal' : 'is-illegal'}` }),
            h('span', null, d.name),
            v.legal ? null : h('span', { class: 'tag tag-danger' }, `规则不合法 ×${v.errors.length}`));
        })),
    );

    el.appendChild(controls);

    if (!results) {
      // 首次进入自动跑一次默认集合
      run();
    }
    if (results && results.length) {
      const total = results[0].traces.length;
      const table = h(
        'section',
        { class: 'card-panel sim-result' },
        h('div', { class: 'sim-legend muted small' },
          h('span', { class: 'legend-swatch bar-swatch' }), '彩色条 = 换手后达标率',
          h('span', { class: 'legend-tick' }), '竖线 = 初始起手达标率',
          ' · 比率旁的按钮可以点开具体失败样本（含当时手牌与判定）'),
        h('div', { class: 'sim-table' },
          h('div', { class: 'sim-row sim-head' },
            h('div', { class: 'sim-name' }, '牌组'),
            h('div', { class: 'sim-goal' }, '开局条件'),
            h('div', { class: 'sim-bar-head' }, '达标率对比'),
            h('div', { class: 'sim-num' }, '初始'),
            h('div', { class: 'sim-num' }, '换手后')),
          ...results.map((r) => {
            const deck = store.decks.find((d) => d.id === r.deckId)!;
            const v = validateDeck(deck);
            return h('div', { class: 'sim-row' },
              h('div', { class: 'sim-name' },
                h('span', { class: `valid-dot ${v.legal ? 'is-legal' : 'is-illegal'}` }),
                h('strong', null, deck.name),
                v.legal ? null : h('span', { class: 'tag tag-danger' }, '不合法仍可试抽')),
              h('div', { class: 'sim-goal muted small' }, deck.goal.label),
              rateBar(r, total, update),
              h('div', { class: 'sim-num' }, `${r.firstPass}/${total} · ${pct(r.firstPass, total)}`),
              h('div', { class: 'sim-num sim-num-final' }, `${r.finalPass}/${total} · ${pct(r.finalPass, total)}`));
          })),
      );
      el.appendChild(table);
    } else {
      el.appendChild(h('div', { class: 'card-panel empty-hint' }, '至少勾选一个牌组再开始。'));
    }
  }

  update();
  return {
    el,
    onStoreChange: () => {
      // 牌组被编辑后，旧结果作废，下次渲染自动重算
      results = null;
      update();
    },
  };
}
