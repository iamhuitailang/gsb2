// 核验结论与原因码的统一字典。前端与审计记录都引用这里，保证文案一致。
// 原则：任何不确定的情况一律 fail-closed（拒绝信任），不存在“静默放行”。
export const DECISION = {
  TRUSTED: 'TRUSTED',
  REJECTED: 'REJECTED',
};

export const REASONS = {
  OK: { decision: 'TRUSTED', label: '核验通过：发现信息匹配、密钥受信且在有效期内' },

  TOKEN_MALFORMED: { decision: 'REJECTED', label: '令牌格式错误，无法解析为 JWT' },
  TOKEN_EXPIRED: { decision: 'REJECTED', label: '令牌已过期（exp 校验失败）' },
  TOKEN_ALG_NONE: { decision: 'REJECTED', label: '令牌声明 alg=none，拒绝无签名令牌，不回退到不安全默认' },
  TOKEN_ALG_NOT_ALLOWED: { decision: 'REJECTED', label: '签名算法不在该提供方允许列表中' },
  TOKEN_KID_MISSING: { decision: 'REJECTED', label: '令牌头部缺少 kid，无法定位受信密钥' },
  TOKEN_SIGNATURE_INVALID: { decision: 'REJECTED', label: '签名与受信公钥不匹配（令牌内容可能被篡改）' },

  ISSUER_MISMATCH: { decision: 'REJECTED', label: '发现文档的签发方与本地预期签发方不一致，拒绝沿用旧信任' },
  DISCOVERY_FETCH_FAILED: { decision: 'REJECTED', label: '发现文档获取失败：模拟身份服务不可用，拒绝继续信任' },
  DISCOVERY_STALE: { decision: 'REJECTED', label: '发现缓存已过期且无法刷新，拒绝使用过期信任结果' },
  DISCOVERY_ENDPOINT_CHANGED: { decision: 'REJECTED', label: '发现文档中的登录端点/密钥地址与本地预期不一致，拒绝沿用旧信任' },
  DISCOVERY_CACHE_TAMPERED: { decision: 'REJECTED', label: '发现缓存被污染（与已核验版本不符），拒绝使用' },

  JWKS_FETCH_FAILED: { decision: 'REJECTED', label: '密钥集合获取失败：模拟身份服务不可用，拒绝继续信任' },
  JWKS_STALE: { decision: 'REJECTED', label: '密钥缓存已过期且无法刷新，拒绝使用过期密钥' },
  JWKS_DUPLICATE_KID: { decision: 'REJECTED', label: '密钥集合存在重复 kid，无法确定唯一受信密钥，拒绝信任' },
  KEY_UNKNOWN: { decision: 'REJECTED', label: '令牌 kid 不在受信密钥集合中（未知密钥）' },
  KEY_REVOKED: { decision: 'REJECTED', label: '对应密钥已被紧急撤销' },
  KEY_RETIRED: { decision: 'REJECTED', label: '对应密钥已退役（轮换结束，旧密钥不再受信）' },
};

export function reasonMeta(code) {
  return REASONS[code] || { decision: 'REJECTED', label: `未知原因码: ${code}` };
}
