// storage.js — 保存/载入、重放与规则漂移检测（浏览器端用 localStorage，CLI 用文件注入）

import {
  applyAction,
  createGame,
  endTurn,
  hashAction,
  hashRule,
  hashRuleset,
} from './engine.js';

export function makeBundle(state, ruleset, meta = {}) {
  return {
    kind: 'rule-testbench-bundle',
    schema: 1,
    savedAt: new Date().toISOString(),
    ...meta,
    ruleset,
    rulesetHash: hashRuleset(ruleset),
    state,
  };
}

// 用当前规则集从初始状态重放某条存档的全部行动；回合切换由历史记录推断
export function replayHistory(history, ruleset) {
  let state = createGame(ruleset);
  const trace = [];
  for (const entry of history) {
    if (state.turn.index !== entry.turnIndex || state.turn.side !== entry.side) {
      state = endTurn(state, ruleset);
      // 多回合跳跃（一般只会跳一步）
      while (state.turn.index !== entry.turnIndex || state.turn.side !== entry.side) {
        state = endTurn(state, ruleset);
      }
    }
    const result = applyAction(state, ruleset, entry.actionId, entry.params);
    trace.push({ entry, result });
    if (!result.ok) {
      return { ok: false, state, trace, reason: `第 ${entry.seq} 步行动现在不再合法：${result.preview.reason}` };
    }
    state = result.state;
  }
  return { ok: true, state, trace };
}

// 对照当前规则集检查存档引用的规则/行动是否已变更
// 返回 { compatible, problems:[{level, text}] }
export function checkDrift(bundle, currentRuleset) {
  const problems = [];
  if (bundle.rulesetHash !== hashRuleset(currentRuleset)) {
    problems.push({ level: 'warn', text: '规则集整体哈希不一致：当前规则集与存档保存时不同。' });
  }
  const currentActions = new Map(currentRuleset.actions.map((a) => [a.id, a]));
  const currentRules = new Map(currentRuleset.rules.map((r) => [r.id, r]));

  for (const entry of bundle.state.history ?? []) {
    const action = currentActions.get(entry.actionId);
    if (!action) {
      problems.push({ level: 'error', text: `第 ${entry.seq} 步行动「${entry.actionId}」已不存在，无法重放。` });
    } else if (hashAction(action) !== entry.actionHash) {
      problems.push({ level: 'error', text: `第 ${entry.seq} 步使用的行动「${action.name}」定义已变更（条件/费用/类型），重放结果可能不同，拒绝直接重放。` });
    }
    for (const f of entry.fired ?? []) {
      const rule = currentRules.get(f.ruleId);
      if (!rule) {
        problems.push({ level: 'error', text: `第 ${entry.seq} 步触发过的规则「${f.ruleId}」已被删除，无法保证当时的连锁效果，拒绝重放。` });
      } else if (hashRule(rule) !== f.hash) {
        problems.push({ level: 'error', text: `第 ${entry.seq} 步触发过的规则「${rule.name}」定义已变更（触发条件/效果/上限/优先级），连锁结果不可复现，拒绝重放。` });
      }
    }
  }
  return { compatible: !problems.some((p) => p.level === 'error'), problems };
}

// 载入入口：bundle 自带规则集，currentRuleset 为界面上当前编辑的规则集（可为同一份）
// mode:
//   'snapshot' —— 直接恢复保存的棋盘快照（总能做，但规则漂移时只看不重放）
//   'replay'   —— 用当前规则集从零重放；漂移则返回错误说明
export function loadBundle(bundle, currentRuleset, mode = 'snapshot') {
  const drift = checkDrift(bundle, currentRuleset);
  if (mode === 'snapshot') {
    return { ok: true, mode, state: structuredClone(bundle.state), ruleset: structuredClone(bundle.ruleset), drift };
  }
  if (!drift.compatible) {
    return { ok: false, mode, drift, reason: '规则已变更，无法直接重放：' + drift.problems.filter((p) => p.level === 'error').map((p) => p.text).join(' ') };
  }
  const replay = replayHistory(bundle.state.history, currentRuleset);
  if (!replay.ok) return { ok: false, mode, drift, reason: replay.reason };
  return { ok: true, mode, state: replay.state, ruleset: currentRuleset, drift };
}

// ---------- localStorage 持久化（仅浏览器环境） ----------

const KEY = 'rule-testbench:saves';

export function listSaves() {
  if (typeof localStorage === 'undefined') return [];
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]');
  } catch {
    return [];
  }
}

export function saveToSlot(name, bundle) {
  const saves = listSaves();
  const idx = saves.findIndex((s) => s.name === name);
  const summary = {
    name,
    savedAt: bundle.savedAt,
    rulesetName: bundle.ruleset.name,
    rulesetHash: bundle.rulesetHash,
    turn: bundle.state.turn.index,
    side: bundle.state.turn.side,
    steps: bundle.state.history.length,
  };
  const record = { ...summary, bundle };
  if (idx >= 0) saves[idx] = record;
  else saves.push(record);
  localStorage.setItem(KEY, JSON.stringify(saves));
  return summary;
}

export function loadSlot(name) {
  const record = listSaves().find((s) => s.name === name);
  return record ? record.bundle : null;
}

export function deleteSlot(name) {
  localStorage.setItem(KEY, JSON.stringify(listSaves().filter((s) => s.name !== name)));
}
