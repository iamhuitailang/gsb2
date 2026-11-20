/*
 * OIDC 配置检查核心逻辑（纯函数，无 DOM / 无网络依赖）。
 * 同一份输入永远产生同一份输出，保证多次检查结果一致。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.OidcChecks = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = '1.0.0';

  // 严重级别：通过 < 需要关注 < 无法确认 < 拒绝
  const SEVERITY_ORDER = { pass: 0, attention: 1, unknown: 2, reject: 3 };

  const SEVERITY_LABEL = {
    pass: '通过',
    attention: '需要关注',
    unknown: '无法确认',
    reject: '拒绝',
  };

  const REQUIRED_DISCOVERY_FIELDS = [
    'issuer',
    'authorization_endpoint',
    'token_endpoint',
    'jwks_uri',
  ];

  const RECOMMENDED_DISCOVERY_FIELDS = [
    'userinfo_endpoint',
    'response_types_supported',
    'subject_types_supported',
    'id_token_signing_alg_values_supported',
  ];

  const ENDPOINT_FIELDS = ['authorization_endpoint', 'token_endpoint', 'jwks_uri'];

  const SUPPORTED_KTY = ['RSA', 'EC'];

  const ALG_BY_KTY = {
    RSA: ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512'],
    EC: ['ES256', 'ES384', 'ES512'],
  };

  const SIG_KEY_OPS = ['sign', 'verify'];
  const ENC_KEY_OPS = ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey', 'deriveKey', 'deriveBits'];
  const SYMMETRIC_ALGS = ['HS256', 'HS384', 'HS512'];

  function finding(severity, code, message, evidence) {
    return { severity, code, message, evidence: evidence === undefined ? null : evidence };
  }

  function parseUrl(value) {
    try {
      return new URL(value);
    } catch (e) {
      return null;
    }
  }

  function worstSeverity(findings) {
    let worst = 'pass';
    for (const f of findings) {
      if (SEVERITY_ORDER[f.severity] > SEVERITY_ORDER[worst]) worst = f.severity;
    }
    return worst;
  }

  /* ---------------- 发现文档检查 ---------------- */

  function checkDiscovery(discovery, expectedIssuer) {
    const findings = [];

    if (typeof discovery.issuer !== 'string' || discovery.issuer.length === 0) {
      findings.push(finding('reject', 'DISCOVERY_ISSUER_MISSING',
        '发现文档缺少 issuer 字段，无法确认签发者。'));
    } else if (discovery.issuer !== expectedIssuer) {
      findings.push(finding('reject', 'ISSUER_MISMATCH',
        `签发者与预期不完全一致：文档中为 "${discovery.issuer}"，预期为 "${expectedIssuer}"。`,
        { documented: discovery.issuer, expected: expectedIssuer }));
    } else {
      findings.push(finding('pass', 'ISSUER_MATCH',
        `签发者与预期完全一致：${discovery.issuer}`));
    }

    for (const field of REQUIRED_DISCOVERY_FIELDS) {
      if (typeof discovery[field] !== 'string' || discovery[field].length === 0) {
        findings.push(finding('reject', 'DISCOVERY_FIELD_MISSING',
          `发现文档缺少必需字段 ${field}。`, { field }));
      }
    }
    for (const field of RECOMMENDED_DISCOVERY_FIELDS) {
      if (discovery[field] === undefined) {
        findings.push(finding('attention', 'DISCOVERY_FIELD_RECOMMENDED_MISSING',
          `发现文档缺少建议字段 ${field}。`, { field }));
      }
    }

    const algs = discovery.id_token_signing_alg_values_supported;
    if (Array.isArray(algs) && algs.indexOf('none') !== -1) {
      findings.push(finding('reject', 'ALG_NONE_ALLOWED',
        'id_token_signing_alg_values_supported 包含 "none"，即允许未签名的令牌。',
        { algs }));
    }

    const issuerUrl = typeof discovery.issuer === 'string' ? parseUrl(discovery.issuer) : null;
    if (issuerUrl && issuerUrl.protocol !== 'https:') {
      findings.push(finding('reject', 'ISSUER_NOT_HTTPS',
        `签发者地址未使用 HTTPS：${discovery.issuer}`));
    }

    for (const field of ENDPOINT_FIELDS) {
      const value = discovery[field];
      if (typeof value !== 'string' || value.length === 0) continue; // 缺失已单独报告
      const url = parseUrl(value);
      if (!url) {
        findings.push(finding('reject', 'ENDPOINT_URL_INVALID',
          `${field} 不是合法 URL：${value}`, { field, value }));
        continue;
      }
      if (url.protocol !== 'https:') {
        findings.push(finding('reject', 'ENDPOINT_NOT_HTTPS',
          `${field} 未使用 HTTPS：${value}`, { field, value }));
      }
      if (issuerUrl && url.origin !== issuerUrl.origin) {
        findings.push(finding('attention', 'ENDPOINT_ORIGIN_MISMATCH',
          `${field} 的源（${url.origin}）与签发者的源（${issuerUrl.origin}）不一致，请人工确认是否为预期部署。`,
          { field, value, issuerOrigin: issuerUrl.origin }));
      }
    }

    return findings;
  }

  /* ---------------- JWKS 检查 ---------------- */

  function canonicalJwk(key) {
    const out = {};
    for (const k of Object.keys(key).sort()) out[k] = key[k];
    return JSON.stringify(out);
  }

  function checkSingleKey(key, index, snapshotLabel) {
    const findings = [];
    const where = `快照 "${snapshotLabel}" 第 ${index + 1} 个密钥`;

    if (typeof key !== 'object' || key === null || Array.isArray(key)) {
      findings.push(finding('unknown', 'KEY_NOT_OBJECT',
        `${where}不是合法的 JWK 对象，无法确认。`, { index }));
      return findings;
    }

    const kid = typeof key.kid === 'string' && key.kid.length > 0 ? key.kid : null;
    const name = kid ? `密钥 "${kid}"` : where;

    if (!kid) {
      findings.push(finding('unknown', 'KEY_KID_MISSING',
        `${where}缺少 kid，无法与令牌头部对应，无法确认。`, { index }));
    }

    if (SUPPORTED_KTY.indexOf(key.kty) === -1) {
      findings.push(finding('unknown', 'KEY_KTY_UNSUPPORTED',
        `${name}的 kty 为 "${key.kty === undefined ? '(未声明)' : key.kty}"，不在支持列表（${SUPPORTED_KTY.join(', ')}）内，无法确认，不按可信密钥处理。`,
        { kid, kty: key.kty === undefined ? null : key.kty }));
      return findings; // 类型不支持时其余判断没有意义
    }

    if (key.use !== undefined && key.use !== 'sig') {
      findings.push(finding('attention', 'KEY_USE_NOT_SIG',
        `${name}的 use 为 "${key.use}"，不是签名用途（sig）。`, { kid, use: key.use }));
    }

    if (Array.isArray(key.key_ops)) {
      const hasSig = key.key_ops.some(function (op) { return SIG_KEY_OPS.indexOf(op) !== -1; });
      const hasEnc = key.key_ops.some(function (op) { return ENC_KEY_OPS.indexOf(op) !== -1; });
      if (hasSig && hasEnc) {
        findings.push(finding('reject', 'KEY_OPS_CONTRADICTION',
          `${name}的 key_ops 同时包含签名与加密操作（${key.key_ops.join(', ')}），用途声明互相矛盾。`,
          { kid, key_ops: key.key_ops }));
      } else if (hasEnc && !hasSig) {
        findings.push(finding('attention', 'KEY_OPS_NOT_SIG',
          `${name}的 key_ops 仅包含加密类操作（${key.key_ops.join(', ')}），不应用于验签。`,
          { kid, key_ops: key.key_ops }));
      }
      if (key.use === 'sig' && hasEnc && !hasSig) {
        findings.push(finding('reject', 'KEY_USE_OPS_CONTRADICTION',
          `${name}声明 use=sig 但 key_ops 不含任何签名操作，声明互相矛盾。`, { kid }));
      }
    }

    if (key.alg === undefined) {
      findings.push(finding('unknown', 'KEY_ALG_MISSING',
        `${name}未声明 alg，无法确认其签名算法。`, { kid }));
    } else if (key.alg === 'none') {
      findings.push(finding('reject', 'KEY_ALG_NONE',
        `${name}的 alg 为 "none"。`, { kid }));
    } else if (SYMMETRIC_ALGS.indexOf(key.alg) !== -1) {
      findings.push(finding('attention', 'KEY_ALG_SYMMETRIC',
        `${name}的 alg 为对称算法 ${key.alg}，出现在公开 JWKS 中需人工确认。`,
        { kid, alg: key.alg }));
    } else if ((ALG_BY_KTY[key.kty] || []).indexOf(key.alg) === -1) {
      findings.push(finding('attention', 'KEY_ALG_KTY_MISMATCH',
        `${name}的 alg（${key.alg}）与 kty（${key.kty}）不匹配，声明互相矛盾。`,
        { kid, alg: key.alg, kty: key.kty }));
    }

    if (key.kty === 'RSA' && (typeof key.n !== 'string' || typeof key.e !== 'string')) {
      findings.push(finding('unknown', 'KEY_MATERIAL_INCOMPLETE',
        `${name}为 RSA 密钥但缺少 n 或 e 参数，无法确认。`, { kid }));
    }
    if (key.kty === 'EC' && (typeof key.crv !== 'string' || typeof key.x !== 'string')) {
      findings.push(finding('unknown', 'KEY_MATERIAL_INCOMPLETE',
        `${name}为 EC 密钥但缺少 crv 或 x 参数，无法确认。`, { kid }));
    }
    if (key.d !== undefined) {
      findings.push(finding('reject', 'KEY_PRIVATE_MATERIAL',
        `${name}包含私钥字段 d，私钥不应出现在公开的 JWKS 中。`, { kid }));
    }

    if (findings.length === 0) {
      findings.push(finding('pass', 'KEY_OK',
        `${name}检查通过（kty=${key.kty}${key.alg ? ', alg=' + key.alg : ''}）。`, { kid }));
    }
    return findings;
  }

  function checkJwks(jwks, snapshotLabel) {
    const findings = [];

    if (typeof jwks !== 'object' || jwks === null || !Array.isArray(jwks.keys)) {
      findings.push(finding('reject', 'JWKS_STRUCTURE_INVALID',
        `快照 "${snapshotLabel}" 不是合法的 JWKS（缺少 keys 数组）。`));
      return findings;
    }
    if (jwks.keys.length === 0) {
      findings.push(finding('reject', 'JWKS_EMPTY',
        `快照 "${snapshotLabel}" 不包含任何密钥，令牌将无法验证。`));
      return findings;
    }

    const firstSeen = {};
    jwks.keys.forEach(function (key, i) {
      const kid = key && typeof key.kid === 'string' && key.kid.length > 0 ? key.kid : null;
      if (!kid) return;
      if (firstSeen[kid] !== undefined) {
        findings.push(finding('reject', 'KEY_KID_DUPLICATED',
          `快照 "${snapshotLabel}" 中 kid "${kid}" 出现多次（第 ${firstSeen[kid] + 1} 个与第 ${i + 1} 个密钥），密钥标识被复用。`,
          { kid, firstIndex: firstSeen[kid], againIndex: i }));
      } else {
        firstSeen[kid] = i;
      }
    });

    jwks.keys.forEach(function (key, i) {
      const keyFindings = checkSingleKey(key, i, snapshotLabel);
      for (const f of keyFindings) findings.push(f);
    });

    return findings;
  }

  /* ---------------- 快照对比 ---------------- */

  function kidMap(jwks) {
    const map = new Map();
    if (jwks && Array.isArray(jwks.keys)) {
      for (const key of jwks.keys) {
        if (key && typeof key.kid === 'string' && key.kid.length > 0 && !map.has(key.kid)) {
          map.set(key.kid, canonicalJwk(key));
        }
      }
    }
    return map;
  }

  function compareSnapshots(prevJwks, prevLabel, nextJwks, nextLabel) {
    const prev = kidMap(prevJwks);
    const next = kidMap(nextJwks);
    const added = [];
    const retained = [];
    const removed = [];
    const replaced = [];

    for (const entry of next) {
      const kid = entry[0];
      const content = entry[1];
      if (!prev.has(kid)) added.push(kid);
      else if (prev.get(kid) === content) retained.push(kid);
      else replaced.push(kid);
    }
    for (const entry of prev) {
      if (!next.has(entry[0])) removed.push(entry[0]);
    }
    added.sort(); retained.sort(); removed.sort(); replaced.sort();

    const findings = [];
    for (const kid of replaced) {
      findings.push(finding('reject', 'KEY_REPLACED_SAME_KID',
        `密钥 "${kid}" 在 "${nextLabel}" 中标识不变但内容已被替换（相对于 "${prevLabel}"）：验证方无法区分新旧密钥，正在验证的令牌可能立即失效或被混用。`,
        { kid }));
    }
    for (const kid of removed) {
      findings.push(finding('attention', 'KEY_REMOVED',
        `密钥 "${kid}" 在 "${nextLabel}" 中已移除（相对于 "${prevLabel}"）；若仍有未过期令牌用其签名，验证将失败，请确认已过令牌有效期再移除。`,
        { kid }));
    }
    if (prev.size > 0 && next.size > 0 && retained.length === 0 && replaced.length === 0) {
      findings.push(finding('reject', 'KEY_SET_NO_OVERLAP',
        `"${prevLabel}" 与 "${nextLabel}" 之间没有任何共同密钥，存在验签断档：切换瞬间所有在途令牌都无法验证。`));
    }
    for (const kid of added) {
      findings.push(finding('pass', 'KEY_ADDED',
        `密钥 "${kid}" 为 "${nextLabel}" 新增。`, { kid }));
    }
    if (replaced.length === 0 && removed.length === 0) {
      findings.push(finding('pass', 'KEY_SET_STABLE',
        `"${prevLabel}" 中的密钥在 "${nextLabel}" 中全部保留，无断档。`));
    }

    return {
      from: prevLabel,
      to: nextLabel,
      added,
      retained,
      removed,
      replaced,
      verdict: worstSeverity(findings),
      findings,
    };
  }

  /* ---------------- 环境整体评估 ---------------- */

  function evaluateEnvironment(env) {
    const discoveryFindings = checkDiscovery(env.discovery, env.expectedIssuer);

    const snapshots = env.snapshots.map(function (snap) {
      const findings = checkJwks(snap.jwks, snap.label);
      return { label: snap.label, verdict: worstSeverity(findings), findings };
    });

    const comparisons = [];
    for (let i = 1; i < env.snapshots.length; i++) {
      comparisons.push(compareSnapshots(
        env.snapshots[i - 1].jwks, env.snapshots[i - 1].label,
        env.snapshots[i].jwks, env.snapshots[i].label));
    }

    const all = [];
    for (const f of discoveryFindings) all.push(f);
    for (const s of snapshots) for (const f of s.findings) all.push(f);
    for (const c of comparisons) for (const f of c.findings) all.push(f);

    return {
      name: env.name,
      expectedIssuer: env.expectedIssuer,
      verdict: worstSeverity(all),
      discoveryFindings,
      snapshots,
      comparisons,
    };
  }

  function buildReport(environments) {
    return {
      tool: 'oidc-config-inspector',
      version: VERSION,
      environments: environments.map(evaluateEnvironment),
    };
  }

  return {
    VERSION,
    SEVERITY_ORDER,
    SEVERITY_LABEL,
    checkDiscovery,
    checkJwks,
    compareSnapshots,
    evaluateEnvironment,
    buildReport,
    worstSeverity,
  };
});
