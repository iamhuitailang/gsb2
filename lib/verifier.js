// 令牌核验流水线。任何一步不确定都直接拒绝，不存在静默放行或跨提供方兜底。
// 顺序：结构解析 -> 发现核验（签发方/端点/缓存完整性/TTL）-> 密钥集合核验
//       -> 算法策略 -> 密钥状态 -> 签名 -> 时间声明
import { parseB64uJson, importPublicJwk, verifySignature, hashText } from './jose.js';
import { REASONS, reasonMeta } from './reasons.js';
import * as store from './store.js';

function step(name, ok, detail) {
  return { step: name, ok, detail };
}

export async function verifyToken(providerId, token, { forceRefresh = false, source = 'manual' } = {}) {
  const provider = store.getProvider(providerId);
  const trace = [];
  const startedAt = new Date().toISOString();

  const finalize = (reasonCode, extra = {}) => {
    const meta = reasonMeta(reasonCode);
    const result = {
      providerId,
      providerName: provider?.name || providerId,
      configVersion: provider?.configVersion ?? null,
      cacheGeneration: store.getCacheGeneration(providerId),
      decision: meta.decision,
      reasonCode,
      reason: meta.label,
      trace,
      source,
      startedAt,
      finishedAt: new Date().toISOString(),
      tokenFingerprint: store.tokenFingerprint(token || ''),
      matchedKid: extra.matchedKid || null,
      ...extra,
    };
    store.appendAudit({
      providerId,
      providerName: result.providerName,
      configVersion: result.configVersion,
      cacheGeneration: result.cacheGeneration,
      decision: result.decision,
      reasonCode,
      reason: result.reason,
      matchedKid: result.matchedKid,
      tokenFingerprint: result.tokenFingerprint,
      source,
      trace: trace.map(({ step: s, ok, detail }) => ({ step: s, ok, detail })),
    });
    return result;
  };

  if (!provider) {
    return finalize('DISCOVERY_FETCH_FAILED', { detail: '提供方不存在' });
  }

  // ---- 1. 结构解析（不依赖任何远端数据） ----
  const parts = (token || '').split('.');
  if (parts.length !== 3 || parts.some((p) => p === undefined)) {
    trace.push(step('parse', false, '令牌不是 header.payload.signature 三段结构'));
    return finalize('TOKEN_MALFORMED');
  }
  let header;
  let payload;
  try {
    header = parseB64uJson(parts[0]);
    payload = parseB64uJson(parts[1]);
    trace.push(step('parse', true, { alg: header.alg, kid: header.kid || null, claims: Object.keys(payload) }));
  } catch {
    trace.push(step('parse', false, 'header/payload 无法解码为 JSON'));
    return finalize('TOKEN_MALFORMED');
  }

  // alg=none：显式拒绝，绝不回退为“跳过签名”
  if (header.alg === 'none') {
    trace.push(step('alg-policy', false, '令牌声明 alg=none'));
    return finalize('TOKEN_ALG_NONE');
  }

  if (!header.kid) {
    trace.push(step('kid-lookup', false, 'JWT header 缺少 kid'));
    return finalize('TOKEN_KID_MISSING');
  }

  // ---- 2. 发现文档：拿不到、过期、被污染、与预期不一致都拒绝 ----
  let discovery;
  try {
    const r = await store.fetchDiscovery(providerId, { force: forceRefresh });
    discovery = r.payload;
    trace.push(step('discovery-fetch', true, { fromCache: r.fromCache, issuer: discovery.issuer }));
  } catch {
    trace.push(step('discovery-fetch', false, '模拟身份服务离线，发现文档获取失败'));
    return finalize('DISCOVERY_FETCH_FAILED');
  }

  const cache1 = store.cacheStatus(providerId).discovery;
  if (cache1 && cache1.payloadHash !== hashText(JSON.stringify(discovery))) {
    trace.push(step('discovery-integrity', false, '缓存内容与核验哈希不符，缓存可能被污染'));
    return finalize('DISCOVERY_CACHE_TAMPERED');
  }
  trace.push(step('discovery-integrity', true, '发现缓存哈希一致'));

  if (discovery.issuer !== provider.expected.issuer) {
    trace.push(step('issuer-match', false, {
      expected: provider.expected.issuer,
      discovered: discovery.issuer,
    }));
    return finalize('ISSUER_MISMATCH');
  }
  trace.push(step('issuer-match', true, discovery.issuer));

  if (
    discovery.authorization_endpoint !== provider.expected.authorizationEndpoint ||
    discovery.jwks_uri !== provider.expected.jwksUri
  ) {
    trace.push(step('endpoint-match', false, {
      expected: {
        authorizationEndpoint: provider.expected.authorizationEndpoint,
        jwksUri: provider.expected.jwksUri,
      },
      discovered: {
        authorizationEndpoint: discovery.authorization_endpoint,
        jwksUri: discovery.jwks_uri,
      },
    }));
    return finalize('DISCOVERY_ENDPOINT_CHANGED');
  }
  trace.push(step('endpoint-match', true, '登录端点与密钥地址均与本地预期一致'));

  // ---- 3. 密钥集合：获取失败/过期/重复 kid 都拒绝 ----
  let jwks;
  try {
    const r = await store.fetchJwks(providerId, { force: forceRefresh });
    jwks = r;
    trace.push(step('jwks-fetch', true, { fromCache: r.fromCache, keyCount: r.keys.length }));
  } catch {
    trace.push(step('jwks-fetch', false, '模拟身份服务离线，密钥集合获取失败'));
    return finalize('JWKS_FETCH_FAILED');
  }

  const cache2 = store.cacheStatus(providerId).jwks;
  if (cache2 && cache2.payloadHash !== hashText(JSON.stringify({ keys: jwks.keys }))) {
    trace.push(step('jwks-integrity', false, '密钥缓存与核验哈希不符，缓存可能被污染'));
    return finalize('DISCOVERY_CACHE_TAMPERED');
  }
  trace.push(step('jwks-integrity', true, '密钥缓存哈希一致'));

  if (jwks.duplicateKid) {
    trace.push(step('kid-uniqueness', false, `密钥集合中 kid=${jwks.duplicateKid} 出现多次`));
    return finalize('JWKS_DUPLICATE_KID', { matchedKid: jwks.duplicateKid });
  }
  trace.push(step('kid-uniqueness', true, '密钥集合中 kid 唯一'));

  const matches = jwks.keys.filter((k) => k.kid === header.kid);
  if (matches.length === 0) {
    trace.push(step('kid-lookup', false, `kid=${header.kid} 不在受信密钥集合中`));
    return finalize('KEY_UNKNOWN', { matchedKid: header.kid });
  }
  const key = matches[0];
  trace.push(step('kid-lookup', true, `kid=${header.kid} 命中受信密钥（${key.kty}/${key.alg}）`));

  // ---- 4. 算法策略：必须同时在管理员允许列表与密钥声明算法中 ----
  if (!provider.allowedAlgs.includes(header.alg)) {
    trace.push(step('alg-policy', false, {
      tokenAlg: header.alg,
      allowedAlgs: provider.allowedAlgs,
    }));
    return finalize('TOKEN_ALG_NOT_ALLOWED', { matchedKid: header.kid });
  }
  if (header.alg !== key.alg) {
    trace.push(step('alg-policy', false, {
      tokenAlg: header.alg,
      keyAlg: key.alg,
      note: '令牌签名算法与密钥声明算法不一致',
    }));
    return finalize('TOKEN_ALG_NOT_ALLOWED', { matchedKid: header.kid });
  }
  trace.push(step('alg-policy', true, `${header.alg} 在允许列表且与密钥匹配`));

  // ---- 5. 密钥状态：撤销 / 退役显式拒绝 ----
  if (key.status === 'revoked') {
    trace.push(step('key-status', false, `kid=${header.kid} 已被紧急撤销`));
    return finalize('KEY_REVOKED', { matchedKid: header.kid });
  }
  if (key.status === 'retired') {
    trace.push(step('key-status', false, `kid=${header.kid} 已随轮换结束退役`));
    return finalize('KEY_RETIRED', { matchedKid: header.kid });
  }
  trace.push(step('key-status', true, `kid=${header.kid} 状态=${key.status}`));

  // ---- 6. 密码学签名核验（最后才用公钥验签） ----
  const publicKey = await importPublicJwk({ ...key, use: undefined });
  const signingInput = `${parts[0]}.${parts[1]}`;
  const valid = await verifySignature({
    alg: header.alg,
    publicKey,
    signingInput,
    signature: parts[2],
  });
  if (!valid) {
    trace.push(step('signature', false, '签名验证失败'));
    return finalize('TOKEN_SIGNATURE_INVALID', { matchedKid: header.kid });
  }
  trace.push(step('signature', true, '签名验证通过'));

  // ---- 7. 时间声明 ----
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === 'number' && payload.exp < now) {
    trace.push(step('time-claims', false, { exp: payload.exp, now }));
    return finalize('TOKEN_EXPIRED', { matchedKid: header.kid });
  }
  trace.push(step('time-claims', true, 'exp 等时间声明有效'));

  return finalize('OK', {
    matchedKid: header.kid,
    claims: { iss: payload.iss, sub: payload.sub, aud: payload.aud },
  });
}
