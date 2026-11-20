// 覆盖分析：逐资源类型说明指令回退关系、最终生效来源与优先级。
// 这里只做“静态结构分析”，具体某个 URL 是否放行由 evaluator.js 判定。

import { FALLBACK_CHAINS, RESOURCE_TYPE_LABELS } from './directives.js';
import { breadthRank } from './sources.js';

const isKwd = (s, name) => s.kind === 'keyword' && s.value === name;

/**
 * 分析单个策略对全部资源类型的覆盖情况。
 */
export function analyzeCoverage(policy) {
  const validDirectives = new Map(
    policy.directives.filter((d) => d.known && !d.duplicate).map((d) => [d.name, d])
  );

  const result = {};
  for (const [type, chain] of Object.entries(FALLBACK_CHAINS)) {
    result[type] = analyzeType(type, chain, validDirectives, policy);
  }
  return result;
}

function analyzeType(type, chain, validDirectives, policy) {
  const chainView = chain.map((name) => {
    const d = validDirectives.get(name);
    return {
      name,
      present: !!d,
      raw: d ? d.valueRaw || '(无值)' : null,
      tokens: d ? d.sources.map((s) => s.raw) : [],
      invalidTokens: d ? d.sourceErrors.map((e) => e.raw) : [],
    };
  });

  // 找到第一个存在且有有效值的指令（空值指令按规范忽略，继续沿回退链查找）
  let effectiveName = null;
  let skippedEmpty = false;
  for (const name of chain) {
    const d = validDirectives.get(name);
    if (!d) continue;
    if (d.valueTokens.length === 0) {
      skippedEmpty = true;
      continue;
    }
    effectiveName = name;
    break;
  }
  const effectiveDirective = effectiveName ? validDirectives.get(effectiveName) : null;

  const notes = [];
  if (skippedEmpty) {
    notes.push({
      level: 'warning',
      text: `回退链中存在没有任何值的指令，按规范该指令被浏览器忽略，继续沿回退链查找`,
    });
  }
  if (!effectiveDirective) {
    notes.push({
      level: 'warning',
      text: `${RESOURCE_TYPE_LABELS[type]} 在整条策略中没有任何适用指令，浏览器对该类资源不做限制（等同允许任意来源）`,
    });
  } else if (effectiveName !== chain[0]) {
    notes.push({
      level: 'info',
      text: `未定义 ${chain[0]}，按回退链由 ${effectiveName} 接管（回退顺序：${chain.join(' → ')}）`,
    });
  } else {
    notes.push({ level: 'info', text: `显式指令 ${effectiveName} 优先于回退链中的其他指令` });
  }

  let effectiveSources = [];
  let effectiveMode = 'normal';

  if (effectiveDirective) {
    const srcs = effectiveDirective.sources;
    effectiveSources = srcs;

    const hasNone = srcs.some((s) => isKwd(s, 'none'));
    const hasNonceOrHash = srcs.some((s) => s.kind === 'nonce' || s.kind === 'hash');
    const hasUnsafeInline = srcs.some((s) => isKwd(s, 'unsafe-inline'));
    const hasStrictDynamic = srcs.some((s) => isKwd(s, 'strict-dynamic'));

    if (effectiveDirective.valueTokens.length === 0) {
      effectiveMode = 'empty-ignored';
      notes.push({
        level: 'warning',
        text: `${effectiveName} 没有任何值，按规范该指令被浏览器忽略，需要继续沿回退链查找（本工具将其视为未配置）`,
      });
    } else if (hasNone && srcs.length > 1) {
      effectiveMode = 'invalid-none';
      notes.push({
        level: 'error',
        text: `'none' 与其他来源共存，${effectiveName} 整体被浏览器忽略`,
      });
    } else if (hasNone) {
      effectiveMode = 'deny-all';
      notes.push({ level: 'info', text: "'none' 表示禁止该类型的全部资源（包括同源资源）" });
    }

    if (hasStrictDynamic) {
      effectiveMode = 'strict-dynamic';
      notes.push({
        level: 'warning',
        text: "'strict-dynamic' 生效时，主机白名单、协议源、'self' 与 'unsafe-inline' 在 CSP3 浏览器中被忽略；只有携带正确 nonce/哈希的脚本及其动态加载的脚本可执行",
      });
    } else if (hasNonceOrHash && hasUnsafeInline) {
      notes.push({
        level: 'info',
        text: "同时存在 nonce/哈希与 'unsafe-inline'：CSP3 浏览器忽略 'unsafe-inline'，只认 nonce/哈希；旧版浏览器则忽略 nonce/哈希、采用 'unsafe-inline'",
      });
    }

    // 宽泛度提示
    const broadest = [...srcs].sort((a, b) => breadthRank(a) - breadthRank(b))[0];
    if (broadest && breadthRank(broadest) <= 20) {
      notes.push({
        level: 'warning',
        text: `最终生效来源中最宽泛的是 "${broadest.raw}"，覆盖面很大；显式主机/路径源比通配符与协议源更安全`,
      });
    }
  }

  return {
    type,
    label: RESOURCE_TYPE_LABELS[type],
    chain: chainView,
    effectiveDirective: effectiveName,
    effectiveMode,
    effectiveSources: effectiveSources.map((s) => ({
      raw: s.raw,
      kind: s.kind,
      breadth: breadthRank(s),
      canonical: requireCanonical(s),
    })),
    notes,
    covered: !!effectiveDirective && effectiveMode !== 'empty-ignored',
  };
}

// 小的本地 canonical 包装，避免 coverage 与 sources 之间产生循环依赖感
import { canonicalSource } from './sources.js';
function requireCanonical(s) {
  return canonicalSource(s);
}
