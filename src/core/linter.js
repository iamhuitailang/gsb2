// 语义检查器：在解析结果之上执行安全规则检查。
// 解析器负责“语法/结构”问题（重复指令、未知指令、值格式错误），
// 本模块负责“安全含义”问题（过宽来源、危险组合、模式差异、覆盖缺口）。
// 同一条规则可以同时命中多个问题，结果以数组形式全部返回。

import {
  FETCH_DIRECTIVES,
  BOOLEAN_DIRECTIVES,
} from './directives.js';

const isKwd = (s, name) => s.kind === 'keyword' && s.value === name;

/**
 * 检查单个已解析策略。
 * @returns {Array} issue 列表（结构与 parser 的 issue 兼容，额外带 directiveName）
 */
export function lintPolicy(policy) {
  const issues = [];
  const push = (severity, code, message, hint, directiveName = null, sources = []) =>
    issues.push({ severity, code, message, hint, directiveName, sources });

  if (policy.mode === 'report-only') {
    push(
      'info',
      'REPORT_ONLY_MODE',
      '该策略处于报告模式（Report-Only）：违规资源只会被上报，不会被浏览器拦截',
      '发布为正式拦截策略时需通过 Content-Security-Policy 头（而非 Content-Security-Policy-Report-Only）下发'
    );
  }

  const names = new Set(policy.directives.filter((d) => !d.duplicate).map((d) => d.name));

  for (const d of policy.directives) {
    if (d.duplicate || !d.known) continue;
    const srcs = d.sources;
    if (!srcs.length) continue;

    const kwdNone = srcs.some((s) => isKwd(s, 'none'));
    if (kwdNone && srcs.length > 1) {
      push(
        'error',
        'NONE_WITH_OTHER_SOURCES',
        `${d.name} 同时包含 'none' 与其他来源（共 ${srcs.length} 个值）`,
        "'none' 必须单独使用；与其他来源共存时整个指令会被浏览器忽略，等于没有这条规则",
        d.name,
        srcs.map((s) => s.raw)
      );
    }

    const hasNonce = srcs.some((s) => s.kind === 'nonce');
    const hasHash = srcs.some((s) => s.kind === 'hash');
    const hasUnsafeInline = srcs.some((s) => isKwd(s, 'unsafe-inline'));
    const hasUnsafeEval = srcs.some((s) => isKwd(s, 'unsafe-eval'));
    const hasStrictDynamic = srcs.some((s) => isKwd(s, 'strict-dynamic'));

    // 过宽来源
    for (const s of srcs) {
      if (s.kind === 'host' && s.host === '*' && !s.scheme) {
        push(
          'warning',
          'WILDCARD_SOURCE',
          `${d.name} 包含通配符 *（${s.raw}），允许任意协议/主机/端口的资源`,
          '改为明确的主机清单；如确需放宽，优先限定协议与主机范围',
          d.name,
          [s.raw]
        );
      } else if (s.kind === 'host' && s.wildcard && !s.path) {
        push(
          'info',
          'WILDCARD_SUBDOMAIN',
          `${d.name} 包含子域通配 ${s.raw}，该域下任意子域（含被接管的子域）都可提供资源`,
          '确认所有子域都在受控范围内，必要时改为逐主机列举',
          d.name,
          [s.raw]
        );
      } else if (s.kind === 'scheme' && (s.scheme === 'http:' || s.scheme === 'ws:')) {
        push(
          'warning',
          'CLEARTEXT_SCHEME',
          `${d.name} 允许明文协议 ${s.scheme}，资源可被中间人篡改`,
          '改用 https: / wss:，或配合 upgrade-insecure-requests',
          d.name,
          [s.raw]
        );
      } else if (s.kind === 'scheme' && (s.scheme === 'data:' || s.scheme === 'blob:')) {
        push(
          'warning',
          'DANGEROUS_SCHEME',
          `${d.name} 允许 ${s.scheme} 协议，攻击者可构造 data:/blob: URL 注入内容`,
          '如无明确业务需要请移除；脚本场景尤其危险',
          d.name,
          [s.raw]
        );
      }
    }

    // 危险关键字
    if (hasUnsafeInline) {
      const level = d.name.startsWith('script') || d.name === 'default-src' ? 'error' : 'warning';
      push(
        level,
        'UNSAFE_INLINE',
        `${d.name} 包含 'unsafe-inline'，允许内联脚本/样式，可被 XSS 利用`,
        hasNonce || hasHash
          ? '在支持 CSP3 的浏览器中，nonce/哈希存在时 unsafe-inline 会被忽略；旧浏览器仍会生效，建议确认目标环境后移除'
          : '改用 nonce 或哈希（sha256-...）精确放行内联内容',
        d.name,
        ["'unsafe-inline'"]
      );
    }
    if (hasUnsafeEval) {
      push(
        d.name.startsWith('script') || d.name === 'default-src' ? 'warning' : 'info',
        'UNSAFE_EVAL',
        `${d.name} 包含 'unsafe-eval'，允许 eval/ new Function 等动态求值`,
        '重构代码移除 eval 依赖；WASM 场景可用更窄的 \'wasm-unsafe-eval\'',
        d.name,
        ["'unsafe-eval'"]
      );
    }
    if (hasUnsafeInline && hasUnsafeEval) {
      push(
        'error',
        'DANGEROUS_COMBO',
        `${d.name} 同时启用 'unsafe-inline' 与 'unsafe-eval'，XSS 防护基本失效`,
        '两者同时存在意味着任意内联与动态求值均被放行，应优先消除这两个关键字',
        d.name,
        ["'unsafe-inline'", "'unsafe-eval'"]
      );
    }

    // strict-dynamic 相关
    if (hasStrictDynamic && !d.name.startsWith('script') && d.name !== 'default-src') {
      push(
        'error',
        'STRICT_DYNAMIC_WRONG_DIRECTIVE',
        `'strict-dynamic' 只能用于脚本类指令，却出现在 ${d.name}`,
        '将其移动到 script-src',
        d.name,
        ["'strict-dynamic'"]
      );
    }
    if (hasStrictDynamic) {
      const ignored = srcs.filter(
        (s) => s.kind === 'host' || (s.kind === 'scheme' && !['https:'].includes(s.scheme)) || (s.kind === 'keyword' && ['self', 'unsafe-inline'].includes(s.value))
      );
      if (ignored.length) {
        push(
          'warning',
          'STRICT_DYNAMIC_IGNORES_SOURCES',
          `${d.name} 含 'strict-dynamic'，以下来源在 CSP3 浏览器中将被忽略：${ignored.map((s) => s.raw).join(' ')}`,
          "strict-dynamic 下只信任 nonce/哈希脚本再传播的信任，主机白名单与 'self' 不再生效（旧浏览器回退时仍使用白名单）",
          d.name,
          ignored.map((s) => s.raw)
        );
      }
    }

    // unsafe-hashes 但没有任何哈希
    if (srcs.some((s) => isKwd(s, 'unsafe-hashes')) && !hasHash) {
      push(
        'warning',
        'UNSAFE_HASHES_WITHOUT_HASH',
        `${d.name} 包含 'unsafe-hashes' 但没有任何哈希源`,
        "'unsafe-hashes' 只影响事件处理器等内联脚本的哈希匹配，需要配合 'sha256-...' 使用",
        d.name
      );
    }
  }

  // 覆盖缺口
  if (!names.has('default-src')) {
    push(
      'warning',
      'MISSING_DEFAULT_SRC',
      '没有定义 default-src，未单独配置的资源类型将不受限制',
      '建议先设置 default-src 作为兜底，再按需为脚本等类型单独收紧'
    );
  }
  if (!names.has('object-src')) {
    push(
      'info',
      'MISSING_OBJECT_SRC',
      '没有定义 object-src，<object>/<embed> 插件内容缺少约束',
      "如不使用插件，建议设置 object-src 'none'"
    );
  }
  if (!names.has('frame-ancestors')) {
    push(
      'info',
      'MISSING_FRAME_ANCESTORS',
      '没有定义 frame-ancestors，页面可能被任意站点嵌入 iframe（点击劫持风险）',
      "如不允许被嵌入，建议设置 frame-ancestors 'none'"
    );
  }
  if (!names.has('base-uri')) {
    push(
      'info',
      'MISSING_BASE_URI',
      '没有定义 base-uri，<base> 标签可被注入篡改相对路径',
      "建议设置 base-uri 'self' 或具体来源"
    );
  }

  // 冗余指令：与 default-src 完全等价的 fetch 指令
  const def = policy.directives.find((d) => d.name === 'default-src' && !d.duplicate);
  if (def) {
    for (const d of policy.directives) {
      if (d.duplicate || !FETCH_DIRECTIVES.includes(d.name) || d.name === 'default-src' || !d.sources.length) continue;
      const a = d.sources.map((s) => s.raw).sort().join('|');
      const b = def.sources.map((s) => s.raw).sort().join('|');
      if (a && a === b) {
        push(
          'info',
          'REDUNDANT_DIRECTIVE',
          `${d.name} 的来源与 default-src 完全相同，属于冗余配置`,
          '删除该指令后效果不变（回退到 default-src），可减少维护成本',
          d.name
        );
      }
    }
  }

  // upgrade-insecure-requests 与 block-all-mixed-content 同时出现
  if (names.has('upgrade-insecure-requests') && names.has('block-all-mixed-content')) {
    push(
      'info',
      'REDUNDANT_MIXED_CONTENT',
      'upgrade-insecure-requests 已包含 block-all-mixed-content 的效果',
      '可删除 block-all-mixed-content'
    );
  }

  return issues;
}

/**
 * 跨策略检查（多策略头 / enforce 与 report-only 配对场景）。
 */
export function lintPolicies(policies) {
  const issues = [];
  if (policies.length < 2) return issues;

  const modes = new Set(policies.map((p) => p.mode));
  if (modes.size > 1) {
    issues.push({
      severity: 'info',
      code: 'MIXED_MODE_POLICIES',
      message: '同时存在强制模式与报告模式策略：报告模式只产生违规上报，强制模式才会实际拦截',
      hint: '浏览器对两类头分别评估；资源必须通过全部强制策略才会加载，报告策略的判定不影响加载',
      directiveName: null,
      sources: [],
    });
  }

  // 多个强制策略：取交集，任一策略缺少某指令不代表放开（由其他策略兜底）
  const enforce = policies.filter((p) => p.mode === 'enforce');
  if (enforce.length > 1) {
    issues.push({
      severity: 'info',
      code: 'MULTIPLE_ENFORCE_POLICIES',
      message: `存在 ${enforce.length} 条强制策略，浏览器会逐条检查，资源必须同时满足所有策略（效果近似取交集）`,
      hint: '任一条策略解析失败或拒绝该资源，资源即被拦截；排查“为什么被拦”时需要逐条核对',
      directiveName: null,
      sources: [],
    });
  }

  // 任一策略含解析错误时的总体提示
  const broken = policies.filter((p) => p.hasErrors);
  if (broken.length) {
    issues.push({
      severity: 'error',
      code: 'POLICY_PARSE_ERRORS',
      message: `${broken.length} 条策略包含解析错误；含错误的指令会被浏览器忽略，且解析失败绝不能作为放行依据`,
      hint: '先修复所有 error 级问题，再评估实际生效范围',
      directiveName: null,
      sources: [],
    });
  }

  return issues;
}

export function lintAll(policies) {
  return [...policies.flatMap(lintPolicy), ...lintPolicies(policies)];
}

// 供 UI 显示布尔指令清单
export { BOOLEAN_DIRECTIVES };
