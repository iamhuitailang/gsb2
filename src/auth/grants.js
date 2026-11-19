// 授权数据模型：授权（grant）、授权码、访问令牌、刷新令牌。
//
// 关键不变量：
//  1. 令牌只记录“签发时的范围快照”，能力上限 = 快照 ∩ 当前 grant 范围。
//     因此升级授权后，旧令牌仍只按原范围生效（只读令牌不会自动变大）。
//  2. 令牌、授权码、刷新令牌都挂在同一个 grantId 上。撤销某个应用 = 删除该 grant
//     及其名下全部令牌/授权码 —— 已发出的凭据与续期能力在同一事务里一起失效。
//  3. 不同应用有各自的 grantId，撤销互不影响。
import {
  ACCESS_TOKEN_TTL,
  CODE_TTL,
  REFRESH_TOKEN_TTL,
} from '../config.js';
import {
  hashSecret,
  isValidPkceChallenge,
  isValidPkceVerifier,
  nowSeconds,
  pkceChallenge,
  randomId,
  randomToken,
  safeEqual,
  sha256,
  unique,
} from '../util.js';

export class OAuthError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message || code);
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function findClient(state, clientId) {
  return state.clients.find((c) => c.clientId === clientId && c.active !== false) || null;
}

export function authenticateClient(state, clientId, clientSecret) {
  if (!clientId || !clientSecret) {
    throw new OAuthError('invalid_client', '缺少应用凭据', 401);
  }
  const client = findClient(state, clientId);
  if (!client) throw new OAuthError('invalid_client', '应用未注册', 401);
  if (!safeEqual(hashSecret(clientSecret, client.secretSalt), client.secretHash)) {
    throw new OAuthError('invalid_client', '应用凭据不正确', 401);
  }
  return client;
}

export function validateRedirectUri(client, redirectUri) {
  if (!redirectUri) throw new OAuthError('invalid_request', '缺少 redirect_uri');
  if (!client.redirectUris.includes(redirectUri)) {
    throw new OAuthError('invalid_request', 'redirect_uri 与注册值不一致');
  }
  return redirectUri;
}

// 只允许应用申请它注册时被允许的范围。
export function validateRequestedScopes(client, scopes) {
  const requested = unique(scopes).sort();
  const disallowed = requested.filter((s) => !client.allowedScopes.includes(s));
  if (disallowed.length) {
    throw new OAuthError('invalid_scope', `该应用无权申请范围：${disallowed.join(', ')}`);
  }
  if (requested.length === 0) {
    throw new OAuthError('invalid_scope', '至少申请一个范围');
  }
  return requested;
}

export function findGrant(state, userId, clientId) {
  return state.grants.find((g) => g.userId === userId && g.clientId === clientId) || null;
}

export function grantById(state, grantId) {
  return state.grants.find((g) => g.grantId === grantId) || null;
}

// 首次授权或范围升级：沿用同一 grantId，把新范围并入。
// 返回值里附带 wasUpgrade，便于审计区分“新授权/升级”。
export function applyGrant(state, { userId, clientId, scopes }) {
  const now = nowSeconds();
  const scopesToAdd = unique(scopes).sort();
  let grant = findGrant(state, userId, clientId);
  if (!grant) {
    grant = {
      grantId: randomId('gr_'),
      userId,
      clientId,
      scopes: scopesToAdd,
      createdAt: now,
      updatedAt: now,
    };
    state.grants.push(grant);
    return { grant, upgraded: false, added: scopesToAdd };
  }
  const added = scopesToAdd.filter((s) => !grant.scopes.includes(s));
  if (added.length) {
    grant.scopes = unique([...grant.scopes, ...added]).sort();
    grant.updatedAt = now;
  }
  return { grant, upgraded: added.length > 0, added };
}

export function revokeGrant(state, grantId) {
  const idx = state.grants.findIndex((g) => g.grantId === grantId);
  if (idx === -1) return { removed: false, tokens: 0, refreshTokens: 0, codes: 0 };
  state.grants.splice(idx, 1);
  const beforeAccess = state.accessTokens.length;
  const beforeRefresh = state.refreshTokens.length;
  const beforeCodes = state.codes.length;
  // 同一事务内清除该 grant 名下的全部凭据，含尚未兑换的授权码。
  state.accessTokens = state.accessTokens.filter((t) => t.grantId !== grantId);
  state.refreshTokens = state.refreshTokens.filter((t) => t.grantId !== grantId);
  state.codes = state.codes.filter((c) => c.grantId !== grantId);
  state.pending = state.pending.filter((p) => p.grantId !== grantId);
  return {
    removed: true,
    tokens: beforeAccess - state.accessTokens.length,
    refreshTokens: beforeRefresh - state.refreshTokens.length,
    codes: beforeCodes - state.codes.length,
  };
}

export function listGrants(state, userId) {
  return state.grants
    .filter((g) => g.userId === userId)
    .map((g) => {
      const client = state.clients.find((c) => c.clientId === g.clientId) || {};
      return {
        grantId: g.grantId,
        clientId: g.clientId,
        clientName: client.name || g.clientId,
        scopes: [...g.scopes].sort(),
        createdAt: g.createdAt,
        updatedAt: g.updatedAt,
      };
    })
    .sort((a, b) => a.clientName.localeCompare(b.clientName, 'zh-CN'));
}

export function issueCode(state, {
  clientId,
  redirectUri,
  userId,
  grantId,
  scopes,
  codeChallenge,
  codeChallengeMethod,
}) {
  if (!isValidPkceChallenge(codeChallenge)) {
    throw new OAuthError('invalid_request', 'PKCE code_challenge 缺失或格式不正确');
  }
  if (codeChallengeMethod && codeChallengeMethod !== 'S256') {
    throw new OAuthError('invalid_request', '仅支持 PKCE S256');
  }
  const now = nowSeconds();
  const code = randomToken();
  state.codes.push({
    codeHash: sha256(code),
    clientId,
    redirectUri,
    userId,
    grantId,
    scopes: unique(scopes).sort(),
    codeChallenge,
    codeChallengeMethod: 'S256',
    createdAt: now,
    expiresAt: now + CODE_TTL,
    used: false,
  });
  return code;
}

export function consumeCode(state, { code, clientId, redirectUri, codeVerifier }) {
  const now = nowSeconds();
  const hash = sha256(code || '');
  const record = state.codes.find((c) => c.codeHash === hash);
  if (!record) throw new OAuthError('invalid_grant', '授权码无效');
  if (record.used) {
    // 授权码被重复使用：视为泄露，连带吊销其 grant 下所有凭据。
    revokeGrant(state, record.grantId);
    throw new OAuthError('invalid_grant', '授权码已被使用，相关凭据已全部失效');
  }
  if (record.expiresAt < now) throw new OAuthError('invalid_grant', '授权码已过期');
  if (record.clientId !== clientId) throw new OAuthError('invalid_grant', '授权码不属于该应用');
  if (redirectUri !== undefined && record.redirectUri !== redirectUri) {
    throw new OAuthError('invalid_grant', 'redirect_uri 不匹配');
  }
  if (!isValidPkceVerifier(codeVerifier)) {
    throw new OAuthError('invalid_grant', 'code_verifier 缺失或格式不正确');
  }
  if (pkceChallenge(codeVerifier) !== record.codeChallenge) {
    throw new OAuthError('invalid_grant', 'PKCE 校验失败');
  }
  record.used = true;
  const grant = grantById(state, record.grantId);
  if (!grant) throw new OAuthError('invalid_grant', '授权已被撤销');
  return { record, grant };
}

export function issueTokens(state, { grant, clientId, userId, scopes }) {
  const now = nowSeconds();
  // 令牌范围不得超过 grant 现存范围，避免用旧请求越权。
  const effective = unique(scopes).filter((s) => grant.scopes.includes(s)).sort();
  if (effective.length === 0) throw new OAuthError('invalid_scope', '没有可用的授权范围');

  const accessToken = randomToken();
  const refreshToken = randomToken();
  state.accessTokens.push({
    id: randomId('at_'),
    tokenHash: sha256(accessToken),
    clientId,
    userId,
    grantId: grant.grantId,
    scopes: effective,
    createdAt: now,
    expiresAt: now + ACCESS_TOKEN_TTL,
  });
  state.refreshTokens.push({
    id: randomId('rt_'),
    tokenHash: sha256(refreshToken),
    clientId,
    userId,
    grantId: grant.grantId,
    scopes: effective,
    createdAt: now,
    expiresAt: now + REFRESH_TOKEN_TTL,
  });
  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL,
    refresh_token: refreshToken,
    scope: effective.join(' '),
  };
}

export function findRefreshToken(state, rawToken) {
  const hash = sha256(rawToken || '');
  return state.refreshTokens.find((t) => t.tokenHash === hash) || null;
}

// 刷新：校验 grant 仍在、范围仍被允许，然后轮换刷新令牌（旧的立即作废）。
export function refreshTokens(state, { rawRefreshToken, clientId }) {
  const now = nowSeconds();
  const record = findRefreshToken(state, rawRefreshToken);
  if (!record) throw new OAuthError('invalid_grant', '刷新令牌无效或已被撤销');
  if (record.expiresAt < now) throw new OAuthError('invalid_grant', '刷新令牌已过期');
  if (record.clientId !== clientId) throw new OAuthError('invalid_grant', '刷新令牌不属于该应用');
  const grant = grantById(state, record.grantId);
  if (!grant) {
    // 授权已撤销：清掉残留刷新令牌，续期能力必须一起失效。
    state.refreshTokens = state.refreshTokens.filter((t) => t.grantId !== record.grantId);
    throw new OAuthError('invalid_grant', '授权已被撤销');
  }
  // 轮换：移除旧刷新令牌，签发新的一对。
  state.refreshTokens = state.refreshTokens.filter((t) => t.id !== record.id);
  return issueTokens(state, {
    grant,
    clientId,
    userId: record.userId,
    scopes: record.scopes,
  });
}

// 校验 Bearer 令牌是否仍然可用。返回令牌、grant、用户，以及“本次实际生效的范围”。
export function authenticateAccessToken(state, rawToken) {
  if (!rawToken) throw new OAuthError('invalid_token', '缺少访问令牌', 401);
  const now = nowSeconds();
  const hash = sha256(rawToken);
  const token = state.accessTokens.find((t) => t.tokenHash === hash);
  if (!token) throw new OAuthError('invalid_token', '访问令牌无效', 401);
  if (token.expiresAt < now) throw new OAuthError('invalid_token', '访问令牌已过期', 401);
  const grant = grantById(state, token.grantId);
  if (!grant) throw new OAuthError('invalid_token', '授权已被撤销', 401);
  const client = findClient(state, token.clientId);
  if (!client) throw new OAuthError('invalid_token', '应用已被停用', 401);
  const user = state.users.find((u) => u.username === token.userId && u.active !== false);
  if (!user) throw new OAuthError('invalid_token', '用户已不可用', 401);
  // 实时求交：grant 若缩小或令牌过期范围，都以交集为准。
  const scopes = token.scopes.filter((s) => grant.scopes.includes(s));
  if (scopes.length === 0) throw new OAuthError('invalid_token', '授权范围已失效', 401);
  return { token, grant, user, scopes };
}

export function hasScope(scopes, required) {
  return scopes.includes(required);
}
