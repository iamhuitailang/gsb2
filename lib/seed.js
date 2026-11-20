// 演示数据播种：生成多套模拟身份提供方、密钥生命周期状态与令牌样例。
// 全部密钥在本机临时生成，私钥只写入本地 data 文件，不进仓库、不对外返回。
import * as store from './store.js';
import { generateKeyPair, signJwt } from './jose.js';

const now = () => Math.floor(Date.now() / 1000);

function baseClaims(issuer, overrides = {}) {
  return {
    iss: issuer,
    sub: 'demo-user',
    aud: 'local-demo-app',
    iat: now(),
    exp: now() + 3600,
    ...overrides,
  };
}

export async function seedDemoData() {
  store.resetAll();

  // ---------- 提供方 1：模拟银行身份服务（RS256，完整密钥生命周期） ----------
  const bank = store.createProvider({
    name: '模拟银行身份服务',
    expected: {
      issuer: 'https://bank.demo.local',
      authorizationEndpoint: 'https://bank.demo.local/oauth/authorize',
      jwksUri: 'https://bank.demo.local/.well-known/jwks.json',
    },
    allowedAlgs: ['RS256'],
    discoveryTtlSec: 30,
    jwksTtlSec: 30,
  });

  const oldKey = await store.addKey(bank.id, 'RS256');   // 轮换窗口中的旧密钥，仍 active
  const newKey = await store.addKey(bank.id, 'RS256');   // 当前主密钥
  const retiredKey = await store.addKey(bank.id, 'RS256');
  const revokedKey = await store.addKey(bank.id, 'RS256');

  const tNormal = await store.mintToken(bank.id, { kid: newKey.kid, alg: 'RS256' });
  const tRotation = await store.mintToken(bank.id, { kid: oldKey.kid, alg: 'RS256' });
  const tRetired = await store.mintToken(bank.id, { kid: retiredKey.kid, alg: 'RS256' });
  const tRevoked = await store.mintToken(bank.id, { kid: revokedKey.kid, alg: 'RS256' });
  store.setKeyStatus(bank.id, retiredKey.kid, 'retired');
  store.setKeyStatus(bank.id, revokedKey.kid, 'revoked');

  // 未知 kid：使用一把从未加入该提供方 JWKS 的独立密钥签发
  const foreign = await generateKeyPair('RS256');
  const tUnknown = await signJwt({
    alg: 'RS256',
    key: foreign.privateKey,
    kid: 'kid-unknown-demo',
    payload: baseClaims(bank.expected.issuer),
  });

  // 算法不匹配：RS256 密钥签名，但头部声明 ES256
  const tAlgMismatch = await store.mintToken(bank.id, {
    kid: newKey.kid,
    alg: 'RS256',
    algHeaderOverride: 'ES256',
  });

  // alg=none 无签名令牌
  const tNone = await store.mintToken(bank.id, { kid: newKey.kid, alg: 'RS256', algHeaderOverride: 'none' });

  // 过期令牌
  const tExpired = await store.mintToken(bank.id, {
    kid: newKey.kid,
    alg: 'RS256',
    payloadOverrides: { exp: now() - 3600 },
  });

  // 签名被篡改：改动 payload 段但保留原签名，验签必然失败
  const tTampered = (() => {
    const parts = tNormal.split('.');
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    claims.sub = 'attacker-user';
    parts[1] = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return parts.join('.');
  })();

  const bankSamples = [
    ['正常登录令牌', '当前主密钥签发，发现信息与预期一致，应核验通过', tNormal],
    ['轮换窗口-旧密钥令牌', '新旧密钥并存期间由旧密钥签发，旧密钥仍 active，应核验通过', tRotation],
    ['旧密钥退役令牌', '轮换结束后旧密钥已 retired，必须拒绝', tRetired],
    ['紧急撤销令牌', '密钥被紧急 revoke，即使签名正确也必须拒绝', tRevoked],
    ['未知密钥标识令牌', 'kid 从未出现在受信 JWKS 中，必须拒绝', tUnknown],
    ['算法不匹配令牌', '头部声明 ES256 但提供方只允许 RS256，必须拒绝', tAlgMismatch],
    ['alg=none 无签名令牌', '试图跳过签名验证，必须拒绝且不得回退默认处理', tNone],
    ['过期令牌', 'exp 已过去一小时，必须拒绝', tExpired],
    ['签名被篡改令牌', '内容签名段被改动，密码学验签失败，必须拒绝', tTampered],
  ];
  for (const [label, description, token] of bankSamples) {
    store.addSample({ providerId: bank.id, label, description, token });
  }

  // ---------- 提供方 2：模拟政务身份服务（ES256，独立缓存与密钥域） ----------
  const gov = store.createProvider({
    name: '模拟政务身份服务',
    expected: {
      issuer: 'https://govid.demo.local',
      authorizationEndpoint: 'https://govid.demo.local/connect/authorize',
      jwksUri: 'https://govid.demo.local/connect/jwks',
    },
    allowedAlgs: ['ES256'],
    discoveryTtlSec: 20,
    jwksTtlSec: 20,
  });
  const govOld = await store.addKey(gov.id, 'ES256');
  const govNew = await store.addKey(gov.id, 'ES256');
  const tGovNormal = await store.mintToken(gov.id, { kid: govNew.kid, alg: 'ES256' });
  const tGovRotation = await store.mintToken(gov.id, { kid: govOld.kid, alg: 'ES256' });
  store.addSample({
    providerId: gov.id,
    label: '政务正常登录令牌',
    description: 'ES256 签发，独立提供方的独立密钥集合，应核验通过',
    token: tGovNormal,
  });
  store.addSample({
    providerId: gov.id,
    label: '政务轮换窗口令牌',
    description: 'ES256 旧密钥仍在并存窗口内，应核验通过',
    token: tGovRotation,
  });
  // 跨提供方串用：政务密钥签的令牌拿到银行提供方核验 -> 银行 JWKS 无此 kid
  store.addSample({
    providerId: bank.id,
    label: '跨提供方令牌（政务签发给银行）',
    description: '模拟缓存/配置串用：该 kid 只存在于政务提供方，银行侧必须按未知密钥拒绝',
    token: tGovNormal,
  });

  // ---------- 提供方 3：疑似被仿冒的身份服务（发现文档签发方已被替换） ----------
  const shadow = store.createProvider({
    name: '疑似被仿冒的身份服务',
    expected: {
      issuer: 'https://partner.demo.local',
      authorizationEndpoint: 'https://partner.demo.local/authorize',
      jwksUri: 'https://partner.demo.local/jwks.json',
    },
    allowedAlgs: ['RS256'],
  });
  const shadowKey = await store.addKey(shadow.id, 'RS256');
  const tShadow = await store.mintToken(shadow.id, { kid: shadowKey.kid, alg: 'RS256' });
  // 模拟远端发现文档被替换：签发方变成攻击者站点
  store.mutateRemoteDiscovery(shadow.id, {
    issuer: 'https://partner.evil-example.net',
  });
  store.addSample({
    providerId: shadow.id,
    label: '签发方被替换场景令牌',
    description: '令牌本身由合法密钥签发，但远端发现文档的签发方已被替换，必须拒绝沿用旧信任',
    token: tShadow,
  });

  // ---------- 提供方 4：异常密钥集合（重复 kid） ----------
  const chaos = store.createProvider({
    name: '异常密钥集合演示服务',
    expected: {
      issuer: 'https://chaos.demo.local',
      authorizationEndpoint: 'https://chaos.demo.local/authorize',
      jwksUri: 'https://chaos.demo.local/jwks',
    },
    allowedAlgs: ['RS256'],
  });
  const chaosKey = await store.addKey(chaos.id, 'RS256');
  const tChaos = await store.mintToken(chaos.id, { kid: chaosKey.kid, alg: 'RS256' });
  store.setDuplicateKid(chaos.id, true);
  store.addSample({
    providerId: chaos.id,
    label: '重复 kid 场景令牌',
    description: '远端 JWKS 中同一 kid 对应两把不同公钥，无法确定唯一受信密钥，必须拒绝',
    token: tChaos,
  });

  // ---------- 播种后执行首轮核验，让仪表盘立刻有“最近一次核验结果” ----------
  const { verifyToken } = await import('./verifier.js');
  for (const sample of store.listSamples()) {
    const full = store.getSample(sample.id);
    await verifyToken(sample.providerId, full.token, { source: 'seed' });
  }

  return { providers: store.listProviders().length, samples: store.listSamples().length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  store.load();
  seedDemoData().then((r) => {
    console.log('演示数据已生成：', r);
  });
}
