// CSP 策略文本解析器。
// 设计原则：
//  1. 容错解析——遇到错误继续解析后面的内容，把所有问题一次性收集起来；
//  2. 精确定位——每个问题携带行列号与原文片段，不做静默丢弃；
//  3. 保留原文——raw 字段始终保留用户输入，规范化结果单独存放。

import {
  KNOWN_DIRECTIVES,
  SOURCE_LIST_DIRECTIVES,
  BOOLEAN_DIRECTIVES,
  SPECIAL_DIRECTIVES,
  DEPRECATED_DIRECTIVES,
  EXPERIMENTAL_DIRECTIVES,
  suggestDirective,
} from './directives.js';
import { parseSourceToken, canonicalSource, sourceAllowedForDirective } from './sources.js';

const SANDBOX_FLAGS = new Set([
  'allow-forms',
  'allow-modals',
  'allow-orientation-lock',
  'allow-pointer-lock',
  'allow-popups',
  'allow-popups-to-escape-sandbox',
  'allow-presentation',
  'allow-same-origin',
  'allow-scripts',
  'allow-top-navigation',
  'allow-top-navigation-by-user-activation',
  'allow-downloads',
]);

const TRUSTED_TYPES_KEYWORDS = new Set(["'script'"]);

/**
 * 解析单个策略文本（分号分隔的指令序列，不含逗号多策略）。
 * @param {string} text
 * @param {object} [opts]
 * @param {number} [opts.baseOffset=0] 该策略在整段文本中的起始偏移（多策略定位用）
 * @param {string} [opts.name]
 * @param {'enforce'|'report-only'} [opts.mode='enforce']
 */
export function parsePolicy(text, opts = {}) {
  const baseOffset = opts.baseOffset || 0;
  const raw = String(text ?? '');
  const issues = [];
  const directives = [];
  const directiveMap = new Map();
  let hasErrors = false;

  const segments = raw.split(';');
  let cursor = 0; // 当前段在 raw 内的起始偏移

  segments.forEach((segment, index) => {
    const segStart = cursor;
    const segEnd = segStart + segment.length;
    cursor = segEnd + 1; // 跳过分号

    const tokens = tokenize(segment);
    if (tokens.length === 0) {
      // 空段：末尾分号属正常，中间空段提示
      if (index < segments.length - 1 && segment.trim() === '') {
        issues.push(makeIssue('error', 'EMPTY_DIRECTIVE', segStart, raw, '出现了空指令（连续分号或分号后没有内容）', '请删除多余分号或补全指令名'));
        hasErrors = true;
      }
      return;
    }

    const nameToken = tokens[0];
    const name = nameToken.value.toLowerCase();
    const nameAbs = baseOffset + segStart + nameToken.start;
    const valueTokens = tokens.slice(1);
    const sources = [];
    const sourceErrors = [];

    const known = KNOWN_DIRECTIVES.has(name);
    if (!known) {
      const suggestion = suggestDirective(name);
      issues.push(
        makeIssue(
          'error',
          'UNKNOWN_DIRECTIVE',
          nameAbs,
          raw,
          `未知指令 "${nameToken.value}"`,
          suggestion ? `你是不是想写 ${suggestion}？` : '请检查指令拼写，参考 CSP3 规范中的指令列表'
        )
      );
      hasErrors = true;
    } else if (DEPRECATED_DIRECTIVES[name]) {
      issues.push(makeIssue('warning', 'DEPRECATED_DIRECTIVE', nameAbs, raw, `指令 "${name}" 已废弃`, DEPRECATED_DIRECTIVES[name]));
    } else if (EXPERIMENTAL_DIRECTIVES[name]) {
      issues.push(makeIssue('info', 'EXPERIMENTAL_DIRECTIVE', nameAbs, raw, `指令 "${name}" 为实验性指令`, EXPERIMENTAL_DIRECTIVES[name]));
    }

    // 重复指令
    const duplicateOf = directiveMap.get(name);
    if (duplicateOf !== undefined) {
      issues.push(
        makeIssue(
          'error',
          'DUPLICATE_DIRECTIVE',
          nameAbs,
          raw,
          `指令 "${name}" 重复出现（第 ${duplicateOf.index + 1} 条指令已定义过）`,
          '浏览器只会采用第一条，后续重复指令被忽略；请合并来源或删除重复项'
        )
      );
      hasErrors = true;
    }

    // 值校验
    if (known && BOOLEAN_DIRECTIVES.includes(name) && valueTokens.length > 0) {
      issues.push(
        makeIssue(
          'error',
          'UNEXPECTED_VALUE',
          baseOffset + segStart + valueTokens[0].start,
          raw,
          `布尔指令 "${name}" 不接受任何值，但发现了 "${valueTokens[0].value}"`,
          `应只写 ${name}，不要带来源列表`
        )
      );
      hasErrors = true;
    }

    if (known && SOURCE_LIST_DIRECTIVES.has(name)) {
      if (valueTokens.length === 0) {
        issues.push(
          makeIssue(
            'warning',
            'EMPTY_VALUE',
            nameAbs,
            raw,
            `指令 "${name}" 没有任何来源值`,
            '按 CSP 规范该指令会被浏览器忽略（不会产生拦截效果），如想禁止所有来源请显式写 ' + "'none'"
          )
        );
      }
      for (const t of valueTokens) {
        const parsed = parseSourceToken(t.value);
        if (!parsed.ok) {
          sourceErrors.push({ raw: t.value });
          issues.push(
            makeIssue(
              'error',
              'INVALID_SOURCE',
              baseOffset + segStart + t.start,
              raw,
              parsed.error.message,
              parsed.error.hint || ''
            )
          );
          hasErrors = true;
          continue;
        }
        if (!sourceAllowedForDirective(parsed.source, name)) {
          issues.push(
            makeIssue(
              'error',
              'SOURCE_NOT_ALLOWED_HERE',
              baseOffset + segStart + t.start,
              raw,
              `源 "${t.value}" 不能用于 ${name} 指令`,
              `${name} 只接受 'self'、'none' 或主机/协议源，不接受 nonce、哈希或 unsafe-inline 类关键字`
            )
          );
          hasErrors = true;
        }
        sources.push(parsed.source);
      }
    } else if (known && name === 'sandbox') {
      for (const t of valueTokens) {
        if (!SANDBOX_FLAGS.has(t.value)) {
          issues.push(
            makeIssue(
              'error',
              'INVALID_SANDBOX_FLAG',
              baseOffset + segStart + t.start,
              raw,
              `"${t.value}" 不是合法的 sandbox 标记`,
              `合法标记例如 ${[...SANDBOX_FLAGS].slice(0, 5).join(', ')} 等`
            )
          );
          hasErrors = true;
        }
      }
    } else if (known && name === 'require-trusted-types-for') {
      const ok = valueTokens.length === 1 && TRUSTED_TYPES_KEYWORDS.has(valueTokens[0].value);
      if (!ok) {
        issues.push(
          makeIssue(
            'error',
            'INVALID_SPECIAL_VALUE',
            nameAbs,
            raw,
            `require-trusted-types-for 的值必须是 'script'`,
            "完整写法：require-trusted-types-for 'script'"
          )
        );
        hasErrors = true;
      }
    } else if (known && name === 'report-uri') {
      for (const t of valueTokens) {
        if (!looksLikeUri(t.value)) {
          issues.push(
            makeIssue(
              'error',
              'INVALID_URI',
              baseOffset + segStart + t.start,
              raw,
              `"${t.value}" 不是合法的 URI`,
              'report-uri 需要一个或多个绝对或相对 URI（注意该指令已废弃，建议改用 report-to）'
            )
          );
          hasErrors = true;
        }
      }
    } else if (known && name === 'report-to') {
      if (valueTokens.length !== 1) {
        issues.push(makeIssue('error', 'INVALID_SPECIAL_VALUE', nameAbs, raw, 'report-to 必须且只能有一个上报组名称', '例如 report-to endpoint-group'));
        hasErrors = true;
      }
    } else if (known && name === 'trusted-types') {
      for (const t of valueTokens) {
        if (t.value === 'allow-duplicates' || /^[a-z0-9-=#\^_@.%-]+$/i.test(t.value)) continue;
        issues.push(
          makeIssue(
            'error',
            'INVALID_SPECIAL_VALUE',
            baseOffset + segStart + t.start,
            raw,
            `"${t.value}" 不是合法的 trusted-types 策略名`,
            "策略名是不含空格的 token，或使用关键字 'allow-duplicates'"
          )
        );
        hasErrors = true;
      }
    }

    const directive = {
      name,
      index: directives.length,
      raw: segment.trim(),
      nameRaw: nameToken.value,
      valueRaw: valueTokens.map((t) => t.value).join(' '),
      valueTokens: valueTokens.map((t) => t.value),
      loc: {
        offset: baseOffset + segStart,
        length: segEnd - segStart,
        line: 0,
        column: 0,
      },
      known,
      duplicate: duplicateOf !== undefined,
      sources,
      sourceErrors,
    };
    fillLineColumn(directive.loc, raw, baseOffset);
    directives.push(directive);
    if (duplicateOf === undefined) directiveMap.set(name, directive);
  });

  return {
    name: opts.name || '',
    mode: opts.mode || 'enforce',
    raw,
    directives,
    directiveMap,
    issues,
    hasErrors,
    baseOffset,
    canonical: buildCanonical(directives),
  };
}

/**
 * 解析 HTTP 头风格文本：多个策略以逗号分隔。
 * 典型来源：Content-Security-Policy 头中携带的多策略，或粘贴的整段头值。
 * 返回 { policies, issues }，问题带整段文本的绝对偏移。
 */
export function parseHeaderText(text, opts = {}) {
  const raw = String(text ?? '');
  const policies = [];
  const allIssues = [];
  let cursor = 0;
  let policyIndex = 0;

  // 逗号可能出现在 report-uri 之外的值里吗？CSP 中逗号是策略分隔符，
  // 源表达式与 token 均不允许逗号，因此可以安全按逗号切分。
  const parts = raw.split(',');
  parts.forEach((part, i) => {
    const start = cursor;
    cursor += part.length + 1;
    if (part.trim() === '') {
      if (i < parts.length - 1) {
        allIssues.push({
          severity: 'error',
          code: 'EMPTY_POLICY',
          message: '逗号之间存在空策略',
          hint: '请删除多余逗号或补全策略内容',
          loc: locate(raw, start),
          source: raw,
        });
      }
      return;
    }
    const result = parsePolicy(part.trim(), {
      baseOffset: start + (part.length - part.trimStart().length),
      mode: opts.mode || 'enforce',
      name: opts.namePrefix ? `${opts.namePrefix} #${policyIndex + 1}` : `策略 ${policyIndex + 1}`,
    });
    policies.push(result);
    allIssues.push(...result.issues);
    policyIndex += 1;
  });

  return { policies, issues: allIssues, raw };
}

function tokenize(segment) {
  const tokens = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(segment)) !== null) {
    tokens.push({ value: m[0], start: m.index, end: m.index + m[0].length });
  }
  return tokens;
}

function looksLikeUri(v) {
  try {
    // URI token 不允许出现引号、尖括号等分隔字符
    if (/['"<>\\]/.test(v)) return false;
    const u = new URL(v, 'https://local.invalid/');
    if (!u.pathname && !v.includes('/')) return false;
    // 相对 URI 应以 /、查询或片段开头；绝对 URI 必须带合法协议
    if (!v.includes('://') && !v.startsWith('/') && !v.startsWith('?') && !v.startsWith('#')) return false;
    return /\S/.test(v);
  } catch {
    return false;
  }
}

function makeIssue(severity, code, absOffset, source, message, hint = '') {
  return { severity, code, message, hint, loc: locate(source, absOffset), source };
}

function locate(source, offset) {
  let line = 1;
  let column = 1;
  const bound = Math.min(offset, source.length);
  for (let i = 0; i < bound; i++) {
    if (source[i] === '\n') {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  const lineStart = source.lastIndexOf('\n', bound - 1) + 1;
  let lineEnd = source.indexOf('\n', bound);
  if (lineEnd === -1) lineEnd = source.length;
  return {
    offset,
    line,
    column,
    lineText: source.slice(lineStart, lineEnd),
    snippetStart: bound - lineStart,
  };
}

function fillLineColumn(loc, raw /*, baseOffset */) {
  const l = locate(raw, loc.offset);
  loc.line = l.line;
  loc.column = l.column;
  loc.lineText = l.lineText;
}

function buildCanonical(directives) {
  // 规范化：按指令名字典序，值按稳定顺序排列；仅包含可解析的有效指令
  const valid = directives.filter((d) => d.known && !d.duplicate);
  const names = [...new Set(valid.map((d) => d.name))].sort();
  return names
    .map((name) => {
      const d = valid.find((x) => x.name === name);
      if (BOOLEAN_DIRECTIVES.includes(name)) return name;
      const special = SPECIAL_DIRECTIVES[name];
      if (special && d.sources.length === 0) {
        return d.valueTokens.length ? `${name} ${d.valueTokens.join(' ')}` : name;
      }
      const tokens = d.sources.map(canonicalSource);
      // 'none' 与其他值互斥的排序处理放在 linter；这里只做稳定化
      const uniq = [...new Set(tokens)].sort(compareTokens);
      return uniq.length ? `${name} ${uniq.join(' ')}` : name;
    })
    .join('; ');
}

// 规范化 token 的稳定排序：先按类别，再按字符串
function compareTokens(a, b) {
  const rank = (t) => {
    if (t.startsWith("'")) {
      if (t.startsWith("'nonce-")) return 3;
      if (t.startsWith("'sha")) return 4;
      return 1;
    }
    if (t.endsWith(':')) return 2;
    return 5;
  };
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  return a < b ? -1 : a > b ? 1 : 0;
}
