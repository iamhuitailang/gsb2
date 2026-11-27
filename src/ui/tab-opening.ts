import { CURRENT_POOL, RULES } from '../pool';
import { store } from '../state';
import { applyMulligan, createSession, eligibilityInHand, evaluateGoal, type OpeningSession } from '../opening';
import { h, clear } from './dom';
import { deckPicker } from './common';
import { handTile } from './hand';

let seedText = 'FABLE-16289';
let sessionDeckId: string | null = null;
let session: OpeningSession | null = null;
let chosen = new Set<number>();

function ensureSession() {
  const deck = store.selectedDeck;
  if (sessionDeckId !== deck.id || !session) {
    sessionDeckId = deck.id;
    session = createSession(deck, seedText);
    chosen = new Set();
  }
}

function goalPanel(s: OpeningSession) {
  const deck = store.selectedDeck;
  const checks = evaluateGoal(deck.goal, s.hand);
  const pass = checks.every((c) => c.pass);
  return h(
    'div',
    { class: `goal-panel ${pass ? 'goal-pass' : 'goal-fail'}` },
    h('div', { class: 'goal-head' }, h('strong', null, `开局条件：${deck.goal.label}`), h('span', { class: `verdict-badge ${pass ? 'verdict-ok' : 'verdict-bad'}` }, pass ? '已满足' : '未满足')),
    h('ul', { class: 'goal-checks' }, ...checks.map((c) => h('li', { class: c.pass ? 'check-ok' : 'check-no' }, h('span', null, c.pass ? '✓' : '✕'), h('span', null, c.label), h('span', { class: 'muted small' }, c.detail)))),
  );
}

export function createOpeningTab() {
  const el = h('div', { class: 'tab-opening' });

  function update() {
    clear(el);
    ensureSession();
    const s = session!;
    const deck = store.selectedDeck;
    const elig = eligibilityInHand(s.hand);
    const eligMap = new Map(elig.map((e) => [e.cardId, e]));

    const toolbar = h(
      'div',
      { class: 'tab-toolbar card-panel wrap' },
      deckPicker(deck.id, (id) => {
        store.select(id);
        sessionDeckId = null;
        update();
      }, store.decks),
      h('label', { class: 'seed-field' },
        h('span', { class: 'picker-label' }, '固定种子'),
        (() => {
          const inp = h('input', {
            class: 'seed-input',
            value: seedText,
            onchange: (e: Event) => { seedText = (e.target as HTMLInputElement).value || '0'; },
          }) as HTMLInputElement;
          return inp;
        })(),
      ),
      h('button', {
        class: 'btn btn-primary',
        onclick: () => {
          session = createSession(deck, seedText);
          chosen = new Set();
          update();
        },
      }, '按种子抽起手'),
      h('button', {
        class: 'btn',
        onclick: () => {
          seedText = `seed-${Math.floor(Math.random() * 1e9).toString(36)}`;
          session = createSession(deck, seedText);
          chosen = new Set();
          update();
        },
      }, '随机一个种子'),
      h('span', { class: 'seed-num mono small muted' }, `seedNum = ${s.seedNum >>> 0}`),
    );

    const rule = h('div', { class: 'explain card-panel' },
      `规则：主牌 40 张洗牌后抽 ${RULES.openingHandSize} 张起手；比赛前的起手调度只允许一次 —— 勾选任意数量的牌洗回牌库，再抽等量。某些牌的出场资格会实时检查起手搭配。`);

    // 起手展示：未换手时可勾选；换手后按 kept/drawn/out 标记
    const tiles = s.hand.map((inst) => {
      const status = eligMap.get(inst.cardId);
      if (!s.mulliganUsed) {
        return handTile(inst, {
          status,
          selectable: true,
          selected: chosen.has(inst.iid),
          onToggle: (iid, checked) => {
            if (checked) chosen.add(iid);
            else chosen.delete(iid);
            update();
          },
        });
      }
      const isDrawn = s.lastMulligan?.drawn.some((d) => d.iid === inst.iid);
      return handTile(inst, { status, mark: isDrawn ? 'drawn' : 'kept' });
    });

    const handPanel = h('section', { class: 'card-panel hand-panel' },
      h('div', { class: 'hand-panel-head' },
        h('h2', { class: 'section-title' }, s.mulliganUsed ? '换手后的起手（最终）' : '初始起手（勾选要换走的牌）'),
        h('div', { class: 'hand-actions' },
          s.mulliganUsed
            ? h('span', { class: 'tag' }, '换手机会已使用')
            : [
                h('button', { class: 'btn btn-small', onclick: () => { chosen = new Set(s.hand.map((c) => c.iid)); update(); } }, '全选'),
                h('button', { class: 'btn btn-small', onclick: () => { chosen = new Set(); update(); } }, '清空'),
                h('button', {
                  class: 'btn btn-small btn-primary',
                  disabled: chosen.size === 0,
                  onclick: () => {
                    session = applyMulligan(s, [...chosen]);
                    chosen = new Set();
                    update();
                  },
                }, `换手一次（换走 ${chosen.size} 张）`),
              ],
        ),
      ),
      h('div', { class: 'hand-row' }, ...tiles),
      s.lastMulligan
        ? h('div', { class: 'mulligan-summary' },
            h('div', null, h('strong', null, '洗回：'), s.lastMulligan.sentBack.map((c) => cardLabel(c.cardId)).join('、')),
            h('div', null, h('strong', null, '新抽：'), s.lastMulligan.drawn.map((c) => cardLabel(c.cardId)).join('、')),
          )
        : null,
    );

    // 换走区（换手后展示当时换了什么）
    const outPanel = s.lastMulligan
      ? h('section', { class: 'card-panel' },
          h('h2', { class: 'section-title' }, '本次换走的牌'),
          h('div', { class: 'hand-row hand-row-small' }, ...s.lastMulligan.sentBack.map((c) => handTile(c, { mark: 'out' }))))
      : null;

    const eligPanel = h('section', { class: 'card-panel' },
      h('h2', { class: 'section-title' }, '起手中的出场资格'),
      elig.length
        ? h('div', { class: 'elig-list' }, ...elig.map((e) =>
            h('div', { class: `elig-row ${e.enabled ? 'is-ok' : 'is-no'}` },
              h('span', { class: `elig-dot ${e.enabled ? 'dot-ok' : 'dot-bad'}` }),
              h('strong', null, cardLabel(e.cardId)),
              h('span', { class: 'muted' }, e.reason))))
        : h('p', { class: 'muted' }, '这把手牌里没有带起手搭配限制的牌。'));

    el.appendChild(toolbar);
    el.appendChild(rule);
    el.appendChild(goalPanel(s));
    el.appendChild(handPanel);
    if (outPanel) el.appendChild(outPanel);
    el.appendChild(eligPanel);
  }

  update();
  return { el, onStoreChange: () => { sessionDeckId = null; update(); } };
}

function cardLabel(cardId: string): string {
  return `♦ ${CURRENT_POOL.cardById.get(cardId)?.name ?? cardId}`;
}
