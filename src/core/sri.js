// SRI（Subresource Integrity）声明的语法解析与算法策略判定。
// 只检查锁文件中的"声明"，不下载也不校验任何压缩包内容。
// 参考 SRI 语法：token = alg "-" base64 digest，多个 token 以空白分隔。

const ALG_RE = /^[A-Za-z0-9][A-Za-z0-9+.-]*$/;
const DIGEST_CHARS_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function validateBase64(digest) {
  const errors = [];
  if (!DIGEST_CHARS_RE.test(digest)) {
    errors.push('digest 含非法 base64 字符');
  }
  if (digest.length % 4 !== 0) {
    errors.push('base64 长度不是 4 的倍数（padding 不正确）');
  }
  const eqIndex = digest.indexOf('=');
  if (eqIndex >= 0 && digest.slice(eqIndex).replace(/=/g, '') !== '') {
    errors.push('padding 字符 = 后仍有其它字符');
  }
  if ((digest.match(/=/g) || []).length > 2) {
    errors.push('padding 字符 = 超过 2 个');
  }
  return errors;
}

// 解析单条 integrity 字符串（可能含多个空格分隔的 token）。
export function parseIntegrity(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    return { present: false, tokens: [], overallValid: false };
  }
  const text = String(raw).trim();
  const parts = text.split(/\s+/);
  const tokens = parts.map((part) => {
    const dash = part.indexOf('-');
    const token = { raw: part, alg: null, digest: null, syntacticValid: true, errors: [] };

    if (dash <= 0 || dash === part.length - 1) {
      token.syntacticValid = false;
      token.errors.push('token 不符合 alg-digest 形态');
      return token;
    }
    const alg = part.slice(0, dash);
    const digest = part.slice(dash + 1);
    token.alg = alg;
    token.digest = digest;

    if (!ALG_RE.test(alg)) {
      token.syntacticValid = false;
      token.errors.push('算法名含非法字符');
    }
    if (digest === '') {
      token.syntacticValid = false;
      token.errors.push('digest 为空');
    } else {
      const b64Errors = validateBase64(digest);
      if (b64Errors.length > 0) {
        token.syntacticValid = false;
        token.errors.push(...b64Errors);
      }
    }
    return token;
  });

  return {
    present: true,
    tokens,
    overallValid: tokens.every((t) => t.syntacticValid),
  };
}

// 按规则评估每个 token 的算法策略，返回每个 token 的策略标签与触发的 ruleId。
// policy: allowed | weak | not-allowed（语法非法的 token 不评策略）
export function evaluateAlgorithms(parsed, rules) {
  const allowed = new Set(rules.allowedAlgorithms);
  const weak = new Set(rules.weakAlgorithms);
  return parsed.tokens.map((token) => {
    if (!token.syntacticValid) {
      return { ...token, policy: 'malformed', ruleId: 'INTEGRITY_SRI_MALFORMED' };
    }
    if (weak.has(token.alg)) {
      return { ...token, policy: 'weak', ruleId: 'INTEGRITY_ALG_WEAK' };
    }
    if (allowed.has(token.alg)) {
      return { ...token, policy: 'allowed', ruleId: null };
    }
    return { ...token, policy: 'not-allowed', ruleId: 'INTEGRITY_ALG_NOT_ALLOWED' };
  });
}

// 把 integrity 字符串拆成 alg -> digest 集合，供基线比较（顺序无关）。
export function integrityMap(raw) {
  const map = new Map();
  if (!raw) return map;
  const parsed = parseIntegrity(raw);
  for (const token of parsed.tokens) {
    if (token.alg && token.digest) {
      if (!map.has(token.alg)) map.set(token.alg, new Set());
      map.get(token.alg).add(token.digest);
    }
  }
  return map;
}
