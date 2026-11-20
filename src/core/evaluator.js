// 样例请求验证引擎（纯离线，不发起任何网络请求）。
// 关键安全约定：
//  - 任何策略/指令解析失败，都只能作为“拒绝/无法证明允许”的依据，绝不放行；
//  - 输入的地址只做字符串层面的 URL 解析与匹配，不访问、不解析其内容、不执行任何导入内容；
//  - 多策略时逐条评估，资源必须通过全部强制策略才允许加载（CSP3 多策略语义）。

import { FALLBACK_CHAINS, INLINE_CAPABLE, RESOURCE_TYPE_LABELS } from './directives.js';
import { parseUrl, sourceMatches } from './sources.js';

const isKwd = (s, name) => s.kind === 'keyword' && s.value === name;

/**
 * 评估一个样例请求。
 * @param {object} sample
 * @param {string} sample.resourceType  资源类型（见 FALLBACK_CHAINS 的 key）
 * @param {string} [sample.url]         外部资源地址（内联时可空）
 * @param {boolean} [sample.inline]     是否内联资源
 * @param {boolean} [sample.redirected] 是否经过重定向（CSP3：重定向前后都要检查）
 * @param {boolean} [sample.trusted]    strict-dynamic 下是否由已信任脚本传播加载
 * @param {string} [sample.nonce]       内联元素携带的 nonce
 * @param {string} [sample.hashAlgo]    内联元素哈希算法 sha256/sha384/sha512
 * @param {string} [sample.hashValue]   内联元素哈希值（base64）
 * @param {string} [sample.documentOrigin] 文档源，默认使用本地演示源
 * @param {object[]} policies           已解析策略数组（parser.parsePolicy 的结果）
 */
export function evaluateSample(sample, policies) {
  const errors = [];
  if (!FALLBACK_CHAINS[sample.resourceType]) {
    return {
      decision: 'error',
      reason: `未知资源类型 "${sample.resourceType}"`,
      perPolicy: [],
      urlInfo: null,
    };
  }
  if (!Array.isArray(policies) || policies.length === 0) {
    return {
      decision: 'error',
      reason: '没有可用于评估的策略',
      perPolicy: [],
      urlInfo: null,
    };
  }

  const documentOrigin = sample.documentOrigin || 'https://app.demo.local';
  const context = { documentOrigin };
  const isInline = !!sample.inline;

  let urlInfo = null;
  if (!isInline) {
    if (!sample.url || !sample.url.trim()) {
      return {
        decision: 'error',
        reason: '外部资源请求缺少来源地址',
        perPolicy: [],
        urlInfo: null,
      };
    }
    urlInfo = parseUrl(sample.url.trim());
    if (!urlInfo) {
      // 地址本身无法解析：无法证明其符合任何来源 → 拒绝，而不是放行
      return {
        decision: 'blocked',
        reason: `地址 "${sample.url}" 无法解析为合法 URL，按安全默认拒绝处理（解析失败不得作为放行理由）`,
        perPolicy: [],
        urlInfo: null,
      };
    }
  }

  const perPolicy = policies.map((policy, idx) =>
    evaluateOnePolicy(policy, idx, sample, { urlInfo, isInline, context })
  );

  // 含解析错误的策略：错误指令已被浏览器忽略，但策略整体仍参与评估；
  // 若策略整体无法构成有效判断（hasErrors 且命中的正是出错指令），按拒绝处理。
  const enforceResults = perPolicy.filter((r) => r.mode === 'enforce');
  const reportResults = perPolicy.filter((r) => r.mode === 'report-only');

  const enforceBlocked = enforceResults.some((r) => r.decision === 'blocked' || r.decision === 'error');
  const enforceChecked = enforceResults.length > 0;

  let decision;
  let reason;
  if (!enforceChecked) {
    // 只有报告模式策略
    const reportBlocked = reportResults.some((r) => r.decision === 'blocked' || r.decision === 'error');
    decision = 'allowed-report-only';
    reason = reportBlocked
      ? '仅有报告模式策略：资源会被浏览器加载，但会产生违规上报（详见各策略判定）'
      : '仅有报告模式策略且未发现违规：资源正常加载，也不会上报';
  } else if (enforceBlocked) {
    decision = 'blocked';
    const first = enforceResults.find((r) => r.decision === 'blocked' || r.decision === 'error');
    reason = `被强制策略「${first.policyName}」拦截：${first.reason}`;
  } else {
    const reportBlocked = reportResults.some((r) => r.decision === 'blocked' || r.decision === 'error');
    decision = reportBlocked ? 'allowed-with-report' : 'allowed';
    reason = reportBlocked
      ? '通过全部强制策略，但报告模式策略会产生违规上报'
      : '通过全部强制策略的检查，资源允许加载';
  }

  return {
    decision,
    reason,
    perPolicy,
    urlInfo: urlInfo
      ? { href: urlInfo.href, scheme: urlInfo.scheme, host: urlInfo.host, port: urlInfo.port, path: urlInfo.path, origin: urlInfo.origin }
      : null,
    isInline,
    redirected: !!sample.redirected,
    resourceType: sample.resourceType,
    resourceLabel: RESOURCE_TYPE_LABELS[sample.resourceType],
  };
}

function evaluateOnePolicy(policy, policyIndex, sample, ctx) {
  const { urlInfo, isInline, context } = ctx;
  const base = {
    policyName: policy.name || `策略 ${policyIndex + 1}`,
    mode: policy.mode,
    decision: 'blocked',
    reason: '',
    directive: null,
    matchedSource: null,
    trace: [],
  };

  const chain = FALLBACK_CHAINS[sample.resourceType] || ['default-src'];
  const validMap = new Map(
    policy.directives.filter((d) => d.known && !d.duplicate).map((d) => [d.name, d])
  );

  const addTrace = (text) => base.trace.push(text);
  addTrace(`回退链：${chain.join(' → ')}`);

  // 找到第一个存在且有有效值的指令（空值指令按规范忽略，继续回退）
  let directive = null;
  for (const name of chain) {
    const d = validMap.get(name);
    if (!d) {
      addTrace(`${name}：未定义，继续回退`);
      continue;
    }
    if (d.valueTokens.length === 0) {
      addTrace(`${name}：存在但无值，按规范被浏览器忽略，继续回退`);
      continue;
    }
    if (d.sourceErrors.length > 0) {
      addTrace(`${name}：含 ${d.sourceErrors.length} 个无法解析的来源值，这些值已被浏览器忽略`);
    }
    directive = d;
    addTrace(`${name}：命中，作为生效指令`);
    break;
  }

  if (!directive) {
    // 整条策略没有任何适用指令 → 该策略不限制此类资源
    base.decision = 'allowed';
    base.reason = `策略中没有适用于 ${RESOURCE_TYPE_LABELS[sample.resourceType]} 的有效指令（回退链全部缺失），该策略不限制此请求`;
    addTrace('结论：本策略无适用指令，视为允许（其他策略仍可能拦截）');
    return base;
  }
  base.directive = directive.name;

  // 指令整体非法（'none' 与其他值共存等）→ 指令被忽略 → 无法证明允许 → 拒绝
  const none = directive.sources.find((s) => isKwd(s, 'none'));
  if (none && directive.sources.length > 1) {
    base.decision = 'blocked';
    base.reason = `${directive.name} 中 'none' 与其他来源共存，整条指令被浏览器忽略；无法据此放行，按拒绝处理`;
    addTrace("结论：'none' 互斥规则导致指令失效，安全默认拒绝");
    return base;
  }

  if (isInline) {
    return evaluateInline(base, directive, sample, addTrace);
  }

  // 外部资源
  const strictDynamic = directive.sources.find((s) => isKwd(s, 'strict-dynamic'));
  const isScriptType = sample.resourceType.startsWith('script');

  if (strictDynamic && isScriptType) {
    addTrace("'strict-dynamic' 生效：主机白名单/协议源/'self' 均不参与外部脚本匹配");
    if (sample.trusted) {
      base.decision = 'allowed';
      base.reason = `脚本由已信任的 nonce/哈希脚本动态加载，'strict-dynamic' 传播信任予以放行`;
      base.matchedSource = "'strict-dynamic'";
      addTrace('结论：信任链传播命中，允许');
    } else {
      base.decision = 'blocked';
      base.reason = `'strict-dynamic' 下，未携带 nonce/哈希且不由受信脚本加载的外部脚本被拒绝`;
      addTrace('结论：无信任传播，拒绝');
    }
    return base;
  }

  if (none) {
    base.decision = 'blocked';
    base.reason = `${directive.name} 为 'none'，禁止全部外部资源`;
    addTrace("结论：命中 'none'，拒绝");
    return base;
  }

  // 常规来源匹配（OR 语义）
  const checks = sample.redirected ? ['重定向前地址', '重定向后地址'] : ['请求地址'];
  // 重定向场景：两个 URL 都必须通过（CSP3 §6.7）。演示环境下“重定向后地址”由 sample.redirectUrl 给出。
  const urlsToCheck = [];
  if (sample.redirected && sample.redirectUrl) {
    const after = parseUrl(sample.redirectUrl.trim());
    if (!after) {
      base.decision = 'blocked';
      base.reason = `重定向后的地址 "${sample.redirectUrl}" 无法解析，按安全默认拒绝处理`;
      return base;
    }
    urlsToCheck.push({ label: '重定向前', info: urlInfo }, { label: '重定向后', info: after });
  } else {
    urlsToCheck.push({ label: '请求', info: urlInfo });
  }

  for (const item of urlsToCheck) {
    const hit = directive.sources.find((s) => sourceMatches(s, item.info, context));
    if (!hit) {
      base.decision = 'blocked';
      base.reason = `${item.label}地址 ${item.info.href} 不匹配 ${directive.name} 的任何有效来源`;
      addTrace(`${item.label}地址与 ${directive.sources.length} 个来源逐一比较，均未命中`);
      addTrace('结论：拒绝');
      return base;
    }
    addTrace(`${item.label}地址命中来源 "${hit.raw}"`);
    base.matchedSource = hit.raw;
  }

  base.decision = 'allowed';
  base.reason = `${checks.join('与')}均命中 ${directive.name} 的来源 "${base.matchedSource}"`;
  addTrace('结论：允许');
  return base;
}

function evaluateInline(base, directive, sample, addTrace) {
  if (!INLINE_CAPABLE.has(sample.resourceType)) {
    base.decision = 'blocked';
    base.reason = `${sample.resourceType} 类型资源不存在内联形态`;
    return base;
  }

  const srcs = directive.sources;
  const none = srcs.find((s) => isKwd(s, 'none'));
  if (none) {
    base.decision = 'blocked';
    base.reason = `${directive.name} 为 'none'，内联资源被禁止`;
    addTrace("结论：'none' 命中，拒绝内联");
    return base;
  }

  // 1) nonce
  if (sample.nonce) {
    const hit = srcs.find((s) => s.kind === 'nonce' && s.value === sample.nonce);
    if (hit) {
      base.decision = 'allowed';
      base.matchedSource = hit.raw;
      base.reason = `内联元素携带的 nonce 命中 ${directive.name} 的 ${hit.raw}`;
      addTrace('结论：nonce 匹配，允许');
      return base;
    }
    addTrace(`nonce "${sample.nonce}" 未在 ${directive.name} 中找到匹配项`);
  }

  // 2) 哈希
  if (sample.hashAlgo && sample.hashValue) {
    const wanted = `'${sample.hashAlgo}-${sample.hashValue}'`;
    const hit = srcs.find((s) => s.kind === 'hash' && s.algo === sample.hashAlgo && s.value === sample.hashValue);
    if (hit) {
      base.decision = 'allowed';
      base.matchedSource = hit.raw;
      base.reason = `内联内容哈希命中 ${directive.name} 的 ${hit.raw}`;
      addTrace(`结论：哈希 ${wanted} 匹配，允许`);
      return base;
    }
    addTrace(`哈希 ${wanted} 未在 ${directive.name} 中找到匹配项`);
  }

  // 3) 'unsafe-inline'（CSP3：同指令存在 nonce/哈希时被忽略）
  const unsafeInline = srcs.find((s) => isKwd(s, 'unsafe-inline'));
  const hasNonceOrHash = srcs.some((s) => s.kind === 'nonce' || s.kind === 'hash');
  if (unsafeInline && !hasNonceOrHash) {
    base.decision = 'allowed';
    base.matchedSource = "'unsafe-inline'";
    base.reason = `${directive.name} 包含 'unsafe-inline' 且没有 nonce/哈希，内联内容被放行`;
    addTrace("结论：'unsafe-inline' 命中，允许（注意这是危险放宽）");
    return base;
  }
  if (unsafeInline && hasNonceOrHash) {
    addTrace("存在 nonce/哈希，'unsafe-inline' 在 CSP3 浏览器中被忽略");
  }

  // 4) 事件处理器需要 unsafe-hashes + 哈希的组合
  if (sample.resourceType === 'script-attr') {
    const unsafeHashes = srcs.some((s) => isKwd(s, 'unsafe-hashes'));
    addTrace(unsafeHashes
      ? "存在 'unsafe-hashes'，事件处理器哈希可参与匹配（但本次未命中任何哈希）"
      : "事件处理器内联需要 'unsafe-hashes' 配合哈希源，当前不满足");
  }

  base.decision = 'blocked';
  base.reason = `内联资源未命中 ${directive.name} 中任何 nonce、哈希或（未被忽略的）'unsafe-inline'`;
  addTrace('结论：拒绝内联');
  return base;
}
