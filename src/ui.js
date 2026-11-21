// ui.js — 浏览器试验台界面逻辑，只调用 engine.js / storage.js 的纯函数
import {
  applyAction,
  cellMarkers,
  cloneState,
  countAt,
  createGame,
  describeCondition,
  endTurn,
  markerName,
  cellName,
  previewAction,
} from './engine.js';
import {
  checkDrift,
  deleteSlot,
  listSaves,
  loadBundle,
  loadSlot,
  makeBundle,
  replayHistory,
  saveToSlot,
} from './storage.js';
import { demoRuleset, demoScript } from './demo.js';

// ---------- 全局状态 ----------

let ruleset = structuredClone(demoRuleset);
const branches = new Map(); // branchId -> state（各自独立的深拷贝）
let currentId = null;
let branchSeq = 1;
let selectedActionId = null;

const $ = (id) => document.getElementById(id);

function state() {
  return branches.get(currentId);
}
function markerColor(id) {
  const idx = ruleset.markers.findIndex((m) => m.id === id);
  return ['var(--m1)', 'var(--m2)', 'var(--m3)', 'var(--m4)'][idx % 4];
}

function newBranch(srcState = null, label = null) {
  const id = `b${branchSeq++}`;
  const s = srcState ? cloneState(srcState) : createGame(ruleset);
  s.branchTag = label ?? (id === 'b1' ? '主干' : `分支#${branchSeq - 1}`);
  branches.set(id, s);
  return id;
}

// ---------- 渲染 ----------

function renderAll() {
  renderTurn();
  renderPools();
  renderBoard();
  renderActions();
  renderPreview();
  renderBranches();
  renderLog();
  renderSaves();
  $('rulesetName').textContent = `${ruleset.name}（哈希 ${state().rulesetHash.slice(0, 8)}）`;
}

function renderTurn() {
  const s = state();
  const limits = Object.entries(ruleset.turnLimits ?? {})
    .map(([aid, limit]) => {
      const used = s.turn.used[aid] ?? 0;
      const name = ruleset.actions.find((a) => a.id === aid)?.name ?? aid;
      const exhausted = used >= limit;
      return `<span class="limit ${exhausted ? 'exhausted' : ''}">${name} ${used}/${limit}</span>`;
    })
    .join('');
  $('turnInfo').innerHTML = `
    <div class="turn-line">第 <b>${s.turn.index}</b> 回合 · 轮到 <b class="side side-${s.turn.side}">${s.turn.side}</b> 方</div>
    <div class="turn-line small">顺序：${s.turn.sides.join(' → ')}</div>
    <div class="limits">${limits}</div>
    <div class="turn-line small">本分支累计行动：${s.history.length} 步</div>`;
}

function renderPools() {
  const s = state();
  $('pools').innerHTML = (ruleset.pools ?? [])
    .map((p) => {
      const scope = p.scope === 'turn' ? '每回合重置' : '整局保留';
      return `<div class="pool">
        <span>${p.name}</span>
        <b>${s.poolValues[p.id] ?? 0}</b>
        <span class="badge">${scope}</span>
      </div>`;
    })
    .join('');
}

function renderBoard() {
  const s = state();
  $('board').innerHTML = ruleset.cells
    .map((cell) => {
      const markers = cellMarkers(s, cell.id);
      const chips = Object.entries(markers).length
        ? Object.entries(markers)
            .map(([m, n]) => `<span class="chip" style="--chip:${markerColor(m)}">${markerName(ruleset, m)}×${n}</span>`)
            .join('')
        : '<span class="empty">空</span>';
      return `<div class="cell"><div class="cell-name">${cell.name}</div><div class="cell-markers">${chips}</div></div>`;
    })
    .join('');
}

function renderActions() {
  const s = state();
  $('actionList').innerHTML = ruleset.actions
    .map((a) => {
      const limit = ruleset.turnLimits?.[a.id];
      const used = s.turn.used[a.id] ?? 0;
      const exhausted = limit !== undefined && used >= limit;
      const active = selectedActionId === a.id ? 'active' : '';
      const kindLabel = { place: '放置', move: '移动', consume: '消耗' }[a.kind] ?? a.kind;
      return `<button class="action-btn ${active} ${exhausted ? 'exhausted' : ''}" data-action="${a.id}">
        <span class="kind">${kindLabel}</span>${a.name}
        ${limit !== undefined ? `<span class="limit-tag">${used}/${limit}</span>` : ''}
      </button>`;
    })
    .join('');
  document.querySelectorAll('.action-btn').forEach((btn) =>
    btn.addEventListener('click', () => {
      selectedActionId = selectedActionId === btn.dataset.action ? null : btn.dataset.action;
      renderActions();
      renderPreview();
    })
  );
}

function readParams(action) {
  const params = {};
  for (const p of action.params ?? []) {
    const el = $(`param-${action.id}-${p.key}`);
    if (el) params[p.key] = p.kind === 'cell' || p.kind === 'marker' ? el.value : Number(el.value);
  }
  return params;
}

function renderPreview() {
  const card = $('previewCard');
  if (!selectedActionId) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  const action = ruleset.actions.find((a) => a.id === selectedActionId);
  const s = state();
  // 先从现有表单读值（重渲染时保留用户选择），首次渲染取默认值
  const prevParams = readParams(action);
  const valueOf = (p) => {
    const v = prevParams[p.key];
    if (v !== undefined && v !== '') return v;
    if (p.kind === 'cell') return ruleset.cells[0].id;
    if (p.kind === 'marker') return ruleset.markers[0].id;
    return 1;
  };
  const form = (action.params ?? [])
    .map((p) => {
      const cur = valueOf(p);
      if (p.kind === 'cell') {
        const opts = ruleset.cells
          .map((c) => `<option value="${c.id}" ${c.id === cur ? 'selected' : ''}>${c.name}</option>`)
          .join('');
        return `<label>${p.label}<select id="param-${action.id}-${p.key}">${opts}</select></label>`;
      }
      if (p.kind === 'marker') {
        const opts = ruleset.markers
          .map((m) => `<option value="${m.id}" ${m.id === cur ? 'selected' : ''}>${m.name}</option>`)
          .join('');
        return `<label>${p.label}<select id="param-${action.id}-${p.key}">${opts}</select></label>`;
      }
      return `<label>${p.label}<input id="param-${action.id}-${p.key}" type="number" value="${cur}" min="1" /></label>`;
    })
    .join('');

  const params = Object.fromEntries((action.params ?? []).map((p) => [p.key, valueOf(p)]));
  const preview = previewAction(s, ruleset, action.id, params);
  const checks = preview.checks
    .map(
      (c) => `<li class="${c.ok ? 'ok' : 'fail'}">
        <span>${c.ok ? '✓' : '✗'}</span>
        <div><div>${c.description}</div>${c.ok ? '' : `<div class="reason">阻止状态：${c.reason}</div>`}</div>
      </li>`
    )
    .join('');

  $('preview').innerHTML = `
    <div class="param-form">${form || '<p class="hint">该行动无需参数</p>'}</div>
    <ul class="checks">${checks}</ul>
    <p class="verdict ${preview.ok ? 'ok' : 'fail'}">${preview.ok ? '条件全部满足，可以执行' : '行动将被阻止（不消耗次数）'}</p>`;

  document.querySelectorAll('.param-form select, .param-form input').forEach((el) =>
    el.addEventListener('change', renderPreview)
  );
}

function renderBranches() {
  $('branchList').innerHTML = [...branches.entries()]
    .map(([id, s]) => {
      const cur = id === currentId ? 'current' : '';
      return `<div class="branch ${cur}">
        <div><b>${s.branchTag}</b> <span class="small">T${s.turn.index}/${s.turn.side} · ${s.history.length} 步</span></div>
        <div class="branch-btns">
          ${cur ? '<span class="badge">当前</span>' : `<button data-switch="${id}">切换</button>`}
          <button class="ghost" data-del-branch="${id}">删除</button>
        </div>
      </div>`;
    })
    .join('');
  document.querySelectorAll('[data-switch]').forEach((b) =>
    b.addEventListener('click', () => {
      currentId = b.dataset.switch;
      selectedActionId = null;
      renderAll();
    })
  );
  document.querySelectorAll('[data-del-branch]').forEach((b) =>
    b.addEventListener('click', () => {
      if (branches.size <= 1) return alert('至少保留一个分支');
      const id = b.dataset.delBranch;
      branches.delete(id);
      if (currentId === id) currentId = branches.keys().next().value;
      renderAll();
    })
  );
}

const KIND_LABEL = {
  action: '行动',
  event: '事件',
  trigger: '触发',
  effect: '效果',
  skip: '跳过',
  loop: '循环',
  blocked: '阻止',
  turn: '回合',
};

function renderLog() {
  const s = state();
  $('log').innerHTML = s.log
    .map(
      (l) => `<div class="log-line log-${l.kind}">
        <span class="log-kind">${KIND_LABEL[l.kind] ?? l.kind}</span>${l.text}
      </div>`
    )
    .join('');
  const box = $('log');
  box.scrollTop = box.scrollHeight;
}

function renderSaves() {
  const saves = listSaves();
  $('saveList').innerHTML = saves.length
    ? saves
        .map(
          (sv) => `<div class="save">
          <div><b>${sv.name}</b> <span class="small">${sv.rulesetName} · T${sv.turn}/${sv.side} · ${sv.steps} 步 · ${new Date(sv.savedAt).toLocaleString()}</span></div>
          <div class="branch-btns">
            <button data-snapshot="${sv.name}">快照载入</button>
            <button data-replay="${sv.name}">重放</button>
            <button class="ghost" data-export="${sv.name}">导出</button>
            <button class="ghost danger" data-del-save="${sv.name}">删除</button>
          </div>
        </div>`
        )
        .join('')
    : '<p class="hint">暂无存档</p>';

  document.querySelectorAll('[data-snapshot]').forEach((b) =>
    b.addEventListener('click', () => loadSaved(b.dataset.snapshot, 'snapshot'))
  );
  document.querySelectorAll('[data-replay]').forEach((b) =>
    b.addEventListener('click', () => loadSaved(b.dataset.replay, 'replay'))
  );
  document.querySelectorAll('[data-del-save]').forEach((b) =>
    b.addEventListener('click', () => {
      deleteSlot(b.dataset.delSave);
      renderSaves();
    })
  );
  document.querySelectorAll('[data-export]').forEach((b) =>
    b.addEventListener('click', () => exportSave(b.dataset.export))
  );
}

// ---------- 交互 ----------

function loadSaved(name, mode) {
  const bundle = loadSlot(name);
  if (!bundle) return;
  const result = loadBundle(bundle, ruleset, mode);
  if (!result.ok) {
    showModal('无法直接重放', result.reason + '\n\n仍可使用「快照载入」查看保存时的棋盘。');
    return;
  }
  const warnings = result.drift.problems.map((p) => `[${p.level === 'error' ? '错误' : '警告'}] ${p.text}`);
  const id = newBranch(result.state, `存档:${name}${mode === 'replay' ? '(重放)' : '(快照)'}`);
  currentId = id;
  selectedActionId = null;
  renderAll();
  if (warnings.length) showModal('载入完成，但存在规则漂移', warnings.join('\n'));
}

function showModal(title, body) {
  $('modalTitle').textContent = title;
  $('modalBody').textContent = body;
  $('modal').hidden = false;
}

function exportSave(name) {
  const bundle = loadSlot(name);
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${name}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

$('btnExecute').addEventListener('click', () => {
  if (!selectedActionId) return;
  const action = ruleset.actions.find((a) => a.id === selectedActionId);
  const params = readParams(action);
  const result = applyAction(state(), ruleset, selectedActionId, params);
  branches.set(currentId, result.state);
  if (!result.ok) showModal('行动被阻止', result.preview.reason);
  renderAll();
});

$('btnCancelPreview').addEventListener('click', () => {
  selectedActionId = null;
  renderAll();
});

$('btnEndTurn').addEventListener('click', () => {
  branches.set(currentId, endTurn(state(), ruleset));
  selectedActionId = null;
  renderAll();
});

$('btnRestart').addEventListener('click', () => {
  if (!confirm('在当前分支位置重新开局？该分支的行动记录将被清空（其他分支不受影响）。')) return;
  const tag = state().branchTag;
  const s = createGame(ruleset);
  s.branchTag = tag;
  branches.set(currentId, s);
  selectedActionId = null;
  renderAll();
});

$('btnBranch').addEventListener('click', () => {
  const s = state();
  const id = newBranch(s, `分支#${branchSeq - 1}（复制自 T${s.turn.index}/${s.turn.side} 第${s.history.length}步）`);
  currentId = id;
  selectedActionId = null;
  renderAll();
});

$('btnSave').addEventListener('click', () => {
  const name = $('saveName').value.trim() || `存档-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}`;
  saveToSlot(name, makeBundle(state(), ruleset, { name }));
  $('saveName').value = '';
  renderSaves();
});

$('btnDemo').addEventListener('click', () => {
  ruleset = structuredClone(demoRuleset);
  branches.clear();
  branchSeq = 1;
  currentId = newBranch();
  selectedActionId = null;
  renderAll();
});

// 按演示脚本自动回放三回合
$('btnReplayDemo').addEventListener('click', () => {
  let s = createGame(ruleset);
  for (const step of demoScript) {
    while (s.turn.index !== step.turn || s.turn.side !== step.side) s = endTurn(s, ruleset);
    s = applyAction(s, ruleset, step.actionId, step.params).state;
  }
  s.branchTag = '三回合演示回放';
  const id = `b${branchSeq++}`;
  branches.set(id, s);
  currentId = id;
  selectedActionId = null;
  renderAll();
});

// 规则集 JSON 配置
$('btnShowRules').addEventListener('click', () => {
  $('rulesJson').value = JSON.stringify(ruleset, null, 2);
});

$('btnApplyRules').addEventListener('click', () => {
  let next;
  try {
    next = JSON.parse($('rulesJson').value);
  } catch (e) {
    return showModal('JSON 解析失败', String(e));
  }
  try {
    createGame(next); // 用开局做一次结构校验
  } catch (e) {
    return showModal('规则集结构不合法', String(e));
  }
  if (!confirm('应用新规则将清空所有分支并重新开局，确定？')) return;
  window.__testbench.setRuleset(next);
  $('rulesJson').value = '';
});

// 导入存档文件
function setupImport() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json';
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const bundle = JSON.parse(await file.text());
      const result = loadBundle(bundle, ruleset, 'snapshot');
      const id = newBranch(result.state, `导入:${file.name}`);
      currentId = id;
      renderAll();
      const warnings = result.drift.problems.map((p) => `[${p.level === 'error' ? '错误' : '警告'}] ${p.text}`);
      if (warnings.length) showModal('导入完成，但存在规则漂移', warnings.join('\n'));
    } catch (e) {
      showModal('导入失败', String(e));
    }
    input.value = '';
  });
  const btn = $('btnImport');
  if (btn) btn.addEventListener('click', () => input.click());
}

// ---------- 启动 ----------

currentId = newBranch();
setupImport();
renderAll();

// 暴露给规则编辑器卡片使用
window.__testbench = {
  getRuleset: () => ruleset,
  setRuleset: (next) => {
    ruleset = next;
    branches.clear();
    branchSeq = 1;
    currentId = newBranch();
    selectedActionId = null;
    renderAll();
  },
  replayHistory,
  checkDrift,
  previewAction: (actionId, params) => previewAction(state(), ruleset, actionId, params),
};
