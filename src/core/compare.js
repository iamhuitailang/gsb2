// 多策略并排比较。
// 稳定性保证：差异只基于规范化后的指令名与来源集合计算，
// 与用户输入时的指令顺序、来源顺序完全无关；输出按固定字典序排列。

import { breadthRank, parseSourceToken } from './sources.js';
import { KNOWN_DIRECTIVES } from './directives.js';

/**
 * 比较两条已解析策略。
 * @returns {object} { directiveDiffs, sourceChanges, modeChange, summary, stableKey }
 */
export function comparePolicies(a, b) {
  const mapA = directiveSourceMap(a);
  const mapB = directiveSourceMap(b);
  const allNames = [...new Set([...mapA.keys(), ...mapB.keys()])]
    .filter((n) => KNOWN_DIRECTIVES.has(n))
    .sort();

  const directiveDiffs = allNames.map((name) => {
    const setA = mapA.get(name) || null;
    const setB = mapB.get(name) || null;

    if (setA && !setB) {
      return {
        name,
        status: 'removed',
        statusLabel: '删除',
        sourcesA: setA.tokens,
        sourcesB: [],
        changes: [],
      };
    }
    if (!setA && setB) {
      return {
        name,
        status: 'added',
        statusLabel: '新增',
        sourcesA: [],
        sourcesB: setB.tokens,
        changes: [],
      };
    }

    // 两者都有：比较规范化来源集合
    const tokensA = new Set(setA.tokens);
    const tokensB = new Set(setB.tokens);
    const added = [...tokensB].filter((t) => !tokensA.has(t)).sort();
    const removed = [...tokensA].filter((t) => !tokensB.has(t)).sort();

    const changes = [
      ...added.map((token) => classifyChange('added', token, setA, setB)),
      ...removed.map((token) => classifyChange('removed', token, setA, setB)),
    ].sort((x, y) => {
      if (x.direction !== y.direction) return x.direction === 'added' ? -1 : 1;
      return x.token < y.token ? -1 : x.token > y.token ? 1 : 0;
    });

    return {
      name,
      status: changes.length ? 'modified' : 'unchanged',
      statusLabel: changes.length ? '修改' : '相同',
      sourcesA: setA.tokens,
      sourcesB: setB.tokens,
      changes,
    };
  });

  const modeChange =
    a.mode === b.mode
      ? null
      : {
          from: a.mode,
          to: b.mode,
          label: `模式变化：${modeLabel(a.mode)} → ${modeLabel(b.mode)}`,
        };

  const counts = directiveDiffs.reduce(
    (acc, d) => {
      acc[d.status] = (acc[d.status] || 0) + 1;
      return acc;
    },
    { added: 0, removed: 0, modified: 0, unchanged: 0 }
  );

  const loosened = directiveDiffs
    .flatMap((d) => d.changes)
    .filter((c) => c.effect === 'loosened').length;
  const tightened = directiveDiffs
    .flatMap((d) => d.changes)
    .filter((c) => c.effect === 'tightened').length;

  return {
    policyA: { name: a.name, mode: a.mode },
    policyB: { name: b.name, mode: b.mode },
    directiveDiffs,
    modeChange,
    summary: {
      ...counts,
      loosened,
      tightened,
    },
    // stableKey：只依赖规范化内容，重排输入顺序不会改变它
    stableKey: buildStableKey(a) + '||' + buildStableKey(b),
  };
}

function directiveSourceMap(policy) {
  const map = new Map();
  for (const d of policy.directives) {
    if (!d.known || d.duplicate || map.has(d.name)) continue;
    // 规范化 token；无法解析的原始值保留原文但加前缀，保证比较时不会被静默吞掉
    const tokens = d.valueTokens
      .map((raw) => {
        const parsed = parseSourceToken(raw);
        return parsed.ok ? requireCanonical(parsed.source) : `⚠${raw}`;
      })
      .sort();
    map.set(d.name, { tokens: [...new Set(tokens)], raw: d.valueTokens });
  }
  return map;
}

import { canonicalSource } from './sources.js';
function requireCanonical(s) {
  return canonicalSource(s);
}

// 判断新增/删除一个来源属于“放宽”还是“收紧”
function classifyChange(direction, token, setA, setB) {
  const broadToken = (set) => {
    const vals = set.tokens
      .map((t) => parseSourceToken(t.startsWith('⚠') ? t.slice(1) : t))
      .filter((r) => r.ok)
      .map((r) => r.source);
    if (!vals.length) return null;
    return [...vals].sort((x, y) => breadthRank(x) - breadthRank(y))[0];
  };

  let effect = 'neutral';
  let reason = '';

  const parsed = parseSourceToken(token.startsWith('⚠') ? token.slice(1) : token);
  const self = parsed.ok ? parsed.source : null;

  if (direction === 'added') {
    // B 比 A 多了一个来源 → 通常是放宽
    if (self) {
      if (self.kind === 'keyword' && self.value === 'none') {
        effect = 'tightened';
        reason = "新增 'none' 会禁止全部来源（且与其他值互斥）";
      } else if (self.kind === 'keyword' && ['unsafe-inline', 'unsafe-eval', 'strict-dynamic'].includes(self.value)) {
        effect = 'loosened';
        reason = `新增危险关键字 '${self.value}'，显著放宽限制`;
      } else {
        effect = 'loosened';
        reason = `新增可匹配来源 ${token}，允许范围扩大`;
      }
    } else {
      effect = 'neutral';
      reason = '该值无法解析，需人工确认（解析失败不产生放行效果）';
    }
  } else {
    if (self) {
      if (self.kind === 'keyword' && self.value === 'none') {
        effect = 'loosened';
        reason = "移除 'none' 后从全禁变为按来源列表放行";
      } else if (self.kind === 'keyword' && ['unsafe-inline', 'unsafe-eval'].includes(self.value)) {
        effect = 'tightened';
        reason = `移除危险关键字 '${self.value}'，限制收紧`;
      } else {
        effect = 'tightened';
        reason = `移除来源 ${token}，可匹配范围缩小`;
      }
    } else {
      effect = 'neutral';
      reason = '该值无法解析，需人工确认';
    }
  }

  // 仅当两侧都是主机/协议源（同一维度）时，宽泛度覆盖提示才有意义；
  // 关键字（unsafe-inline 等）与主机源作用维度不同，不能互相覆盖。
  const otherSide = direction === 'added' ? broadToken(setA) : broadToken(setB);
  if (
    otherSide &&
    self &&
    ['host', 'scheme'].includes(self.kind) &&
    ['host', 'scheme'].includes(otherSide.kind) &&
    breadthRank(otherSide) < breadthRank(self)
  ) {
    reason += `；但另一侧存在更宽泛的 "${otherSide.raw}"，实际影响可能被其覆盖`;
  }

  return {
    direction, // added | removed
    directionLabel: direction === 'added' ? '新增来源' : '删除来源',
    token,
    effect, // loosened | tightened | neutral
    effectLabel: effect === 'loosened' ? '放宽' : effect === 'tightened' ? '收紧' : '待定',
    reason,
  };
}

function modeLabel(mode) {
  return mode === 'report-only' ? '报告模式' : '强制模式';
}

function buildStableKey(policy) {
  return policy.directives
    .filter((d) => d.known && !d.duplicate)
    .map((d) => `${d.name}=${[...d.valueTokens].sort().join(',')}`)
    .sort()
    .join(';');
}
