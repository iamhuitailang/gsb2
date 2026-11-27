import {
  HINT_CATALOG,
  HINTS_BY_ID,
  TutorialCoordinator,
  ReplaySession,
  RULE_SETS,
  ALL_SCENARIOS,
  newAccountLearned,
  experiencedAccountLearned,
  compareRules,
  zoneFirstRules,
} from '/dist/src/facade.js';

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const els = {
  clock: $('clockNow'),
  account: $('accountSelect'),
  rule: $('ruleSelect'),
  scenario: $('scenarioSelect'),
  btnRun: $('btnRun'),
  btnStep: $('btnStep'),
  btnReset: $('btnReset'),
  active: $('activeHint'),
  queued: $('queuedList'),
  suspended: $('suspendedList'),
  learnedBody: $('learnedBody'),
  traceBody: $('traceBody'),
  compareBox: $('compareBox'),
  logView: $('logView'),
  replayPos: $('replayPos'),
  toast: $('toast'),
};

// ---------- 状态 ----------
let coord = null;
let replay = null; // 非 null 时页面处于重放模式
let scenarioCursor = 0;
let currentScenario = null;

// ---------- 初始化下拉框 ----------
for (const [id, rule] of Object.entries(RULE_SETS)) {
  els.rule.add(new Option(`${id} — ${rule.label}`, id));
}
for (const sc of ALL_SCENARIOS) {
  els.scenario.add(new Option(sc.label, sc.id));
}
els.scenario.value = ALL_SCENARIOS[0].id;

function selectedRules() {
  return RULE_SETS[els.rule.value] ?? zoneFirstRules;
}
function selectedLearned() {
  return els.account.value === 'experienced'
    ? experiencedAccountLearned(0)
    : newAccountLearned();
}
function getScenario() {
  return ALL_SCENARIOS.find((s) => s.id === els.scenario.value) ?? ALL_SCENARIOS[0];
}

// ---------- 协调器生命周期 ----------
function newCoordinator(learned) {
  return new TutorialCoordinator({ rules: selectedRules(), initialLearned: learned });
}

function resetAll() {
  replay = null;
  currentScenario = getScenario();
  scenarioCursor = 0;
  coord = newCoordinator(selectedLearned());
  coord.handle({ type: 'sceneEnter', scene: 'prototype' });
  // 起始站在 hub, 让位置类首条提示(h_pick 或已会时的过滤痕迹)立刻可见
  coord.handle({ type: 'tick', now: 100 });
  coord.handle({ type: 'enterZone', zone: 'hub' });
  render();
}

// ---------- 场景脚本: 单步 / 全跑 ----------
function runOneScriptStep() {
  if (!currentScenario) return false;
  if (scenarioCursor >= currentScenario.events.length) return false;
  const item = currentScenario.events[scenarioCursor];
  coord.handle({ type: 'tick', now: item.t });
  coord.handle(item.event);
  scenarioCursor += 1;
  return true;
}

els.btnRun.addEventListener('click', () => {
  resetAll();
  let guard = 0;
  while (runOneScriptStep() && guard < 10_000) guard += 1;
  render();
  toast(`已跑完 ${currentScenario.id}（${guard} 个脚本事件）`);
});

els.btnStep.addEventListener('click', () => {
  if (replay) {
    replay.step();
  } else {
    if (!runOneScriptStep()) toast('脚本已跑完, 可重置或手动注入事件');
  }
  render();
});

els.btnReset.addEventListener('click', resetAll);

// 切换存档/规则/场景后重置, 保证状态与选择一致
for (const sel of [els.account, els.rule, els.scenario]) {
  sel.addEventListener('change', resetAll);
}

// ---------- 手动事件注入 ----------
document.querySelectorAll('.inject button[data-act]').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (replay) resetAll(); // 重放模式下手动操作 => 回到直播模式
    const [kind, a, b] = btn.dataset.act.split(':');
    const now = coord.time + 250;
    coord.handle({ type: 'tick', now });
    if (kind === 'zone') coord.handle({ type: 'enterZone', zone: a });
    else if (kind === 'leave') {
      if (coord.zone) coord.handle({ type: 'leaveZone', zone: coord.zone });
    } else if (kind === 'use') {
      coord.handle({ type: 'actionUse', action: a, success: b === 'true' });
    } else if (kind === 'dismiss') coord.handle({ type: 'dismiss' });
    else if (kind === 'tick') coord.handle({ type: 'tick', now: coord.time + Number(a.slice(1)) });
    else if (kind === 'sceneLeave') coord.handle({ type: 'sceneLeave', scene: 'prototype' });
    render();
  });
});

// ---------- 存档导入导出 ----------
$('btnExport').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(coord.exportLearned(), null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `tutorial-save-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast('已导出学习状态存档');
});

$('btnImport').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const learned = JSON.parse(await file.text());
    coord = newCoordinator(learned);
    coord.handle({ type: 'sceneEnter', scene: 'prototype' });
    replay = null;
    render();
    toast(`已导入 ${Object.keys(learned).length} 条学习记录`);
  } catch (err) {
    toast('导入失败: ' + err.message);
  }
  e.target.value = '';
});

// ---------- 重放控制 ----------
$('btnReplayReset').addEventListener('click', () => {
  if (!replay) replay = ReplaySession.fromLog(coord.getLog(), { rules: selectedRules() });
  replay.reset();
  render();
});
$('btnReplayStep').addEventListener('click', () => {
  if (!replay) replay = ReplaySession.fromLog(coord.getLog(), { rules: selectedRules() });
  replay.step();
  render();
});
$('btnReplayEnd').addEventListener('click', () => {
  if (!replay) replay = ReplaySession.fromLog(coord.getLog(), { rules: selectedRules() });
  replay.runToEnd();
  render();
});

// ---------- 渲染 ----------
function outcomeClass(o) {
  return o === 'watched' ? 'watched' : o === 'skipped' ? 'skipped' : 'selfDone';
}
function outcomeText(o) {
  return { watched: '看完', skipped: '主动略过', selfDone: '靠自己完成' }[o] ?? o;
}
function reasonClass(kind) {
  if (kind === 'filtered') return 'filter cancel';
  if (kind === 'cancelled') return 'cancel';
  if (kind === 'shown' || kind === 'learned' || kind === 'queued' || kind === 'resumed') return 'show';
  return '';
}
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function renderActive(view) {
  const id = view.activeHintId;
  if (!id) {
    els.active.className = 'active-hint empty';
    els.active.textContent = '暂无展示中的提示';
    return;
  }
  const spec = HINTS_BY_ID.get(id);
  const urgent = spec?.urgent;
  els.active.className = 'active-hint' + (urgent ? ' urgent' : '');
  els.active.innerHTML = `
    <div class="title">${esc(spec?.title ?? id)}
      ${urgent ? '<span class="badge urgent">紧急</span>' : ''}
      <span class="badge">${esc(id)}</span>
    </div>
    <div>${esc(spec?.text ?? '')}</div>
    <div class="meta">绑定位置: ${spec?.zone ?? '无'} · TTL: ${spec?.ttlMs ?? '-'}ms · 允许打断 ${spec?.maxInterruptions ?? '-'} 次</div>`;
}

function renderList(el, entries) {
  if (!entries.length) {
    el.innerHTML = '<li class="muted">（空）</li>';
    return;
  }
  // 直播模式拿到 QueueEntry(含 interruptions/remainingMs); 重放帧只有 hintId
  el.innerHTML = entries
    .map((e) => {
      const id = typeof e === 'string' ? e : e.hintId;
      const spec = HINTS_BY_ID.get(id);
      const state = typeof e === 'string' ? '' : e.state;
      const extra = typeof e === 'object' && e.interruptions ? ` · 打断 ${e.interruptions} 次` : '';
      const remain = typeof e === 'object' ? (e.remainingMs ?? spec?.ttlMs ?? '?') : (spec?.ttlMs ?? '?');
      return `<li><div class="row"><strong>${esc(spec?.title ?? id)}</strong>
        ${state ? `<span class="badge ${state}">${state}</span>` : ''}</div>
        <div class="muted">${esc(id)}${extra} · 剩余 ${remain}ms</div></li>`;
    })
    .join('');
}

function renderLearned(view) {
  const rows = HINT_CATALOG.map((h) => {
    const st = view.learned[h.id];
    if (!st) return `<tr><td>${esc(h.title)}</td><td class="muted">未学</td><td class="num muted">—</td></tr>`;
    return `<tr><td>${esc(h.title)}</td>
      <td><span class="outcome ${outcomeClass(st.outcome)}">${outcomeText(st.outcome)}</span></td>
      <td class="num">${st.at}</td></tr>`;
  });
  els.learnedBody.innerHTML = rows.join('');
}

function renderTraces(view) {
  els.traceBody.innerHTML = HINT_CATALOG.map((h) => {
    const tr = view.lastTrace[h.id];
    if (!tr) return `<tr><td>${esc(h.title)}</td><td class="muted" colspan="2">尚无记录</td></tr>`;
    const detail = tr.reason.kind === 'filtered'
      ? `filtered:${tr.reason.reason}`
      : tr.reason.kind === 'cancelled'
        ? `cancelled:${tr.reason.reason}`
        : tr.reason.kind === 'learned'
          ? `learned:${tr.reason.outcome}`
          : tr.reason.kind === 'suspended'
            ? `suspended:${tr.reason.reason}`
            : tr.reason.kind;
    return `<tr><td>${esc(h.title)}</td>
      <td><span class="reason-tag ${reasonClass(tr.reason.kind)}">${esc(detail)}</span></td>
      <td class="num">t=${tr.now} · seq=${tr.seq}</td></tr>`;
  }).join('');
}

function renderCompare() {
  if (!currentScenario) return;
  // 始终并排跑两套规则, 次序对比不受当前下拉选择影响; 当前规则高亮
  const cmp = compareRules(currentScenario);
  const currentRuleId = els.rule.value;
  const chain = (ids) =>
    ids.map((id, i) => `${i ? '<span class="arrow">→</span>' : ''}<span class="step">${esc(id)}</span>`).join('');
  els.compareBox.innerHTML =
    `<p class="${cmp.sameOrder ? 'same-flag' : 'diff-flag'}">${cmp.sameOrder ? '✓ 两套规则次序一致' : '⚠ 两套规则次序不同'}</p>` +
    cmp.ruleSets
      .map((m) => {
        const isCurrent = m.id === currentRuleId;
        return `<div class="compare-row"${isCurrent ? ' style="outline:1px solid var(--accent)"' : ''}>
        <span class="rule-id">${esc(m.id)}</span>${isCurrent ? ' <span class="badge">当前</span>' : ''}
        <div class="order-chain">${chain(cmp.orders[m.id] ?? []) || '<span class="muted">（无上屏）</span>'}</div></div>`;
      })
      .join('');
}

function renderLog() {
  const view = replay ? replay.coordinator : coord;
  const log = replay
    ? coord.getLog().slice(0, replay.position)
    : view.getLog();
  // 重放时高亮刚处理完的那条(游标前一条), 即当前暂停位置
  const lastProcessed = replay && replay.position > 0 ? log[replay.position - 1] : null;
  const pausedSeq = lastProcessed
    ? (lastProcessed.kind === 'event' ? lastProcessed.event.seq : lastProcessed.entry.seq)
    : null;

  els.logView.innerHTML = log
    .map((rec) => {
      const seq = rec.kind === 'event' ? rec.event.seq : rec.entry.seq;
      const t = rec.kind === 'event' ? eventTime(rec.event) : rec.entry.now;
      const body = rec.kind === 'event' ? describeEvent(rec.event) : describeTrace(rec.entry);
      const kind = rec.kind;
      const paused = seq === pausedSeq ? 'paused' : '';
      return `<div class="log-line ${kind} ${paused}" data-seq="${seq}">
        <span class="seq">#${seq}</span><span class="t">${t}</span>
        <span class="body"><span class="kind">[${kind}]</span> ${esc(body)}</span></div>`;
    })
    .join('');
  els.replayPos.textContent = replay
    ? `重放 ${replay.position} / ${replay.length}（点击日志可在此处暂停）`
    : `直播日志 ${view.getLog().length} 条`;

  els.logView.querySelectorAll('.log-line').forEach((line) => {
    line.addEventListener('click', () => {
      const seq = Number(line.dataset.seq);
      replay = ReplaySession.fromLog(coord.getLog(), { rules: selectedRules() });
      // 语义: 重走到"这条记录处理完"的时刻, 暂停点落在下一条(高亮它)
      replay.runToSeq(seq);
      render();
    });
  });
  els.logView.scrollTop = els.logView.scrollHeight;
}

function eventTime(ev) {
  return ev.type === 'tick' ? ev.now : '(见 tick)';
}
function describeEvent(ev) {
  switch (ev.type) {
    case 'enterZone': return `enterZone → ${ev.zone}`;
    case 'leaveZone': return `leaveZone ← ${ev.zone}`;
    case 'actionUse': return `actionUse ${ev.action} ${ev.success ? '✓成功' : '✗失败'}`;
    case 'dismiss': return 'dismiss 主动略过';
    case 'sceneEnter': return `sceneEnter ${ev.scene}`;
    case 'sceneLeave': return `sceneLeave ${ev.scene}`;
    case 'tick': return `tick now=${ev.now}`;
    default: return JSON.stringify(ev);
  }
}
function describeTrace(en) {
  const r = en.reason;
  const detail = r.reason ? `:${r.reason}` : r.outcome ? `:${r.outcome}` : '';
  return `${en.hintId} ${r.kind}${detail}`;
}

// 重放与直播共用同一组渲染: 通过 frame 取只读状态
function frameOf() {
  if (replay) return replay.frame();
  return {
    now: coord.time,
    activeHintId: coord.active?.hintId ?? null,
    queuedHintIds: coord.getQueued().map((e) => e.hintId),
    suspendedHintIds: coord.getSuspended().map((e) => e.hintId),
    learned: coord.exportLearned(),
    lastTrace: Object.fromEntries(coord.getAllTraces()),
  };
}

function render() {
  const view = replay ? replay.coordinator : coord;
  const frame = frameOf();
  els.clock.textContent = `${frame.now} ms`;
  renderActive(frame);
  renderList(els.queued, replay ? frame.queuedHintIds : view.getQueued());
  renderList(els.suspended, replay ? frame.suspendedHintIds : view.getSuspended());
  renderLearned(frame);
  renderTraces(frame);
  renderCompare();
  renderLog();
}

// ---------- toast ----------
let toastTimer;
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (els.toast.hidden = true), 2600);
}

resetAll();
