// 离线自检：不启动 HTTP 服务，直接驱动核验流水线，断言每个场景的结论与原因码。
// 用法：node scripts/selftest.js；全部通过退出码 0。
import * as store from '../lib/store.js';
import { verifyToken } from '../lib/verifier.js';
import { seedDemoData } from '../lib/seed.js';
import { generateKeyPair, signJwt } from '../lib/jose.js';

const now = () => Math.floor(Date.now() / 1000);
let passed = 0;
const failures = [];

function check(name, actual, expected) {
  const ok = actual === expected;
  if (ok) passed += 1;
  else failures.push(`${name}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  console.log(`${ok ? '✅' : '❌'} ${name} -> ${JSON.stringify(actual)}`);
}

function expectReason(name, result, reasonCode) {
  check(name, result.reasonCode, reasonCode);
}

await seedDemoData();

const providers = store.listProviders();
const bank = providers.find((p) => p.name === '模拟银行身份服务');
const gov = providers.find((p) => p.name === '模拟政务身份服务');
const shadow = providers.find((p) => p.name === '疑似被仿冒的身份服务');
const chaos = providers.find((p) => p.name === '异常密钥集合演示服务');

const sampleToken = (labelPart) => {
  const meta = store.listSamples().find((s) => s.label.includes(labelPart));
  if (!meta) throw new Error(`找不到样例: ${labelPart}`);
  return store.getSample(meta.id).token;
};

// ---- 1. 正常与各类拒绝路径 ----
expectReason('正常登录', await verifyToken(bank.id, sampleToken('正常登录令牌')), 'OK');
expectReason('轮换窗口旧密钥', await verifyToken(bank.id, sampleToken('轮换窗口-旧密钥令牌')), 'OK');
expectReason('政务独立提供方正常', await verifyToken(gov.id, sampleToken('政务正常登录令牌')), 'OK');
expectReason('退役密钥', await verifyToken(bank.id, sampleToken('旧密钥退役令牌')), 'KEY_RETIRED');
expectReason('撤销密钥', await verifyToken(bank.id, sampleToken('紧急撤销令牌')), 'KEY_REVOKED');
expectReason('未知密钥', await verifyToken(bank.id, sampleToken('未知密钥标识令牌')), 'KEY_UNKNOWN');
expectReason('算法不匹配', await verifyToken(bank.id, sampleToken('算法不匹配令牌')), 'TOKEN_ALG_NOT_ALLOWED');
expectReason('alg=none', await verifyToken(bank.id, sampleToken('alg=none')), 'TOKEN_ALG_NONE');
expectReason('过期令牌', await verifyToken(bank.id, sampleToken('过期令牌')), 'TOKEN_EXPIRED');
expectReason('签名篡改', await verifyToken(bank.id, sampleToken('签名被篡改令牌')), 'TOKEN_SIGNATURE_INVALID');
expectReason('跨提供方串用', await verifyToken(bank.id, sampleToken('跨提供方令牌')), 'KEY_UNKNOWN');
expectReason('签发方被替换', await verifyToken(shadow.id, sampleToken('签发方被替换场景令牌')), 'ISSUER_MISMATCH');
expectReason('重复 kid', await verifyToken(chaos.id, sampleToken('重复 kid 场景令牌')), 'JWKS_DUPLICATE_KID');

const rejectCodes = ['KEY_RETIRED', 'KEY_REVOKED', 'KEY_UNKNOWN', 'TOKEN_ALG_NOT_ALLOWED', 'TOKEN_ALG_NONE',
  'TOKEN_EXPIRED', 'TOKEN_SIGNATURE_INVALID', 'ISSUER_MISMATCH', 'JWKS_DUPLICATE_KID'];
check('全部拒绝场景结论为 REJECTED',
  rejectCodes.every((code) => store.listAudit().find((a) => a.reasonCode === code)?.decision === 'REJECTED'),
  true);

// ---- 2. 结构错误 ----
expectReason('非 JWT 字符串', await verifyToken(bank.id, 'not-a-jwt'), 'TOKEN_MALFORMED');
expectReason('空令牌', await verifyToken(bank.id, ''), 'TOKEN_MALFORMED');

// 缺少 kid 的令牌
const bankKey = store.listKeys(bank.id).find((k) => k.status === 'active');
const noKidToken = await store.mintToken(bank.id, { kid: bankKey.kid, alg: 'RS256', includeKid: false });
expectReason('缺少 kid', await verifyToken(bank.id, noKidToken), 'TOKEN_KID_MISSING');

// ---- 3. 发现端点变化不能静默沿用 ----
const normal = sampleToken('正常登录令牌');
check('端点变更前通过', (await verifyToken(bank.id, normal)).reasonCode, 'OK');
store.mutateRemoteDiscovery(bank.id, { jwks_uri: 'https://bank.demo.local/evil-jwks' });
expectReason('密钥地址变更后拒绝', await verifyToken(bank.id, normal, { forceRefresh: true }), 'DISCOVERY_ENDPOINT_CHANGED');
store.mutateRemoteDiscovery(bank.id, { jwks_uri: bank.expected.jwksUri });
store.invalidateDiscoveryCache(bank.id);
check('恢复后重新通过', (await verifyToken(bank.id, normal, { forceRefresh: true })).reasonCode, 'OK');

// ---- 4. 离线 + 缓存 TTL：新鲜缓存可用，过期后拒绝且不回退 ----
check('在线时建立缓存', (await verifyToken(bank.id, normal)).reasonCode, 'OK');
store.setOffline(bank.id, true);
check('离线但缓存新鲜仍可核验', (await verifyToken(bank.id, normal)).reasonCode, 'OK');
store.expireCachesNow(bank.id);
expectReason('缓存过期后离线拒绝发现', await verifyToken(bank.id, normal), 'DISCOVERY_FETCH_FAILED');
store.setOffline(bank.id, false);
check('恢复在线刷新后通过', (await verifyToken(bank.id, normal, { forceRefresh: true })).reasonCode, 'OK');

// JWKS 获取失败路径：先在线建立发现缓存，再只让 JWKS 过期并离线
await store.fetchDiscovery(bank.id, { force: true });
store.setOffline(bank.id, true);
store.expireJwksOnly(bank.id);
expectReason('JWKS 过期且离线拒绝', await verifyToken(bank.id, normal), 'JWKS_FETCH_FAILED');
store.setOffline(bank.id, false);
check('JWKS 恢复后通过', (await verifyToken(bank.id, normal, { forceRefresh: true })).reasonCode, 'OK');

// ---- 5. 配置版本变化使旧结果标记为 stale，且缓存被清空 ----
const beforeVersion = bank.configVersion;
const beforeAudit = store.listAudit({ providerId: bank.id, limit: 1 })[0];
store.updateProvider(bank.id, { name: '模拟银行身份服务（改名）' });
check('配置版本自增', store.getProvider(bank.id).configVersion, beforeVersion + 1);
check('旧审计记录版本落后', beforeAudit.configVersion < store.getProvider(bank.id).configVersion, true);
check('配置变更清空缓存', store.cacheStatus(bank.id).discovery, null);

// ---- 6. 缓存按提供方隔离：政务缓存不影响银行 ----
await verifyToken(gov.id, sampleToken('政务正常登录令牌'), { forceRefresh: true });
const govCache = store.cacheStatus(gov.id);
const bankCacheAfterReset = store.cacheStatus(bank.id);
check('两提供方缓存条目独立', govCache.discovery !== null && bankCacheAfterReset.discovery === null, true);
store.setOffline(gov.id, true);
store.expireCachesNow(gov.id);
expectReason('政务过期离线拒绝', await verifyToken(gov.id, sampleToken('政务正常登录令牌')), 'DISCOVERY_FETCH_FAILED');
check('银行提供方不受政务离线影响', (await verifyToken(bank.id, normal)).reasonCode, 'OK');
store.setOffline(gov.id, false);

// ---- 7. 缓存污染检测 ----
await verifyToken(bank.id, normal, { forceRefresh: true });
store.tamperCaches(bank.id);
expectReason('发现缓存被污染', await verifyToken(bank.id, normal), 'DISCOVERY_CACHE_TAMPERED');
store.invalidateCaches(bank.id);

// ---- 8. 紧急撤销即时生效（强制刷新密钥集合后） ----
const victim = store.listKeys(bank.id).find((k) => k.status === 'active' && k.kid !== bankKey.kid) || bankKey;
const victimToken = await store.mintToken(bank.id, { kid: victim.kid, alg: 'RS256' });
check('撤销前通过', (await verifyToken(bank.id, victimToken, { forceRefresh: true })).reasonCode, 'OK');
store.setKeyStatus(bank.id, victim.kid, 'revoked');
expectReason('撤销后拒绝', await verifyToken(bank.id, victimToken, { forceRefresh: true }), 'KEY_REVOKED');

// ---- 9. 审计不含敏感内容 ----
const auditJson = JSON.stringify(store.listAudit());
check('审计不含令牌原文', auditJson.includes(normal), false);
const providerJson = JSON.stringify(store.listProviders());
check('提供方数据不含私钥参数', providerJson.includes('"d"'), false);
const auditRow = store.listAudit({ providerId: bank.id, limit: 1 })[0];
check('审计关联提供方/配置版本',
  Boolean(auditRow.providerId && auditRow.configVersion && auditRow.reasonCode && auditRow.tokenFingerprint),
  true);

// ---- 10. 外部独立密钥（从未注册）签发的令牌 ----
const ephemeral = await generateKeyPair('RS256');
const foreignToken = await signJwt({
  alg: 'RS256',
  key: ephemeral.privateKey,
  kid: 'kid-never-registered',
  payload: { iss: bank.expected.issuer, sub: 'x', aud: 'local-demo-app', exp: now() + 60 },
});
expectReason('未注册外部密钥', await verifyToken(bank.id, foreignToken), 'KEY_UNKNOWN');

console.log(`\n${passed} 项通过，${failures.length} 项失败`);
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
