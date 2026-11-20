// 端到端 API 测试：在子进程中启动真实 HTTP 服务，通过 fetch 走完所有演示接口后自动关闭。
// 用法：node scripts/e2e.js（脚本会自行起停服务，无需先 npm start）
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = `http://localhost:${process.env.PORT || 5199}`;
let passed = 0;
const failures = [];

function check(name, cond, extra = '') {
  if (cond) { passed += 1; console.log(`✅ ${name}`); }
  else { failures.push(name); console.log(`❌ ${name} ${extra}`); }
}

async function call(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, PORT: process.env.PORT || 5199 },
  stdio: ['ignore', 'pipe', 'inherit'],
});

try {
  // 等待端口就绪
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('服务启动超时')), 8000);
    const tick = async () => {
      try {
        const r = await fetch(BASE + '/api/health');
        if (r.ok) { clearTimeout(timer); resolve(); } else setTimeout(tick, 150);
      } catch { setTimeout(tick, 150); }
    };
    tick();
  });

  // 1. 重置为内置演示数据
  let r = await call('POST', '/api/reset', {});
  check('重置演示数据', r.status === 200);

  // 2. 提供方列表与详情
  r = await call('GET', '/api/providers');
  check('返回 4 套提供方', r.data.length === 4, `实际 ${r.data.length}`);
  const bank = r.data.find((p) => p.name.includes('银行'));
  const gov = r.data.find((p) => p.name.includes('政务'));
  check('提供方含发现/密钥/缓存/最近核验',
    bank.keys.length >= 4 && bank.cache && bank.latestVerification && bank.remote,
    JSON.stringify(Object.keys(bank)));
  check('缓存按提供方独立（各自有条目）',
    r.data.every((p) => typeof p.cache.generation === 'number'));
  check('对外数据不含私钥字段 d', JSON.stringify(r.data).includes('"d":') === false);

  // 3. 样例与核验
  const samples = (await call('GET', '/api/samples')).data;
  check('返回 14 条样例且列表不含令牌原文',
    samples.length === 14 && samples.every((s) => s.token === undefined && s.tokenFingerprint));

  const verifySample = async (keyword) => {
    const meta = samples.find((s) => s.label.includes(keyword));
    const full = (await call('GET', `/api/samples/${meta.id}`)).data;
    return (await call('POST', `/api/providers/${meta.providerId}/verify`, { token: full.token })).data;
  };

  check('正常登录信任', (await verifySample('正常登录令牌')).reasonCode === 'OK');
  check('撤销密钥拒绝', (await verifySample('紧急撤销令牌')).reasonCode === 'KEY_REVOKED');
  check('重复 kid 拒绝', (await verifySample('重复 kid')).reasonCode === 'JWKS_DUPLICATE_KID');
  check('签发方替换拒绝', (await verifySample('签发方被替换')).reasonCode === 'ISSUER_MISMATCH');
  const cross = await verifySample('跨提供方');
  check('跨提供方串用按未知密钥拒绝', cross.reasonCode === 'KEY_UNKNOWN');

  // 4. 配置变更 -> 版本递增 + 缓存清空 + 旧结果 stale
  const before = bank.configVersion;
  r = await call('PATCH', `/api/providers/${bank.id}`, { name: '银行（改名演示）' });
  check('配置版本递增', r.data.configVersion === before + 1);
  check('配置变更后缓存被清空', r.data.cache.discovery === null && r.data.cache.jwks === null);
  check('旧核验结果标记 stale', r.data.latestVerification.stale === true);

  // 5. 离线 + 缓存过期：拒绝且不回退
  await call('POST', `/api/providers/${bank.id}/verify`, { token: (await call('GET', `/api/samples/${samples.find((s) => s.label === '正常登录令牌').id}`)).data.token });
  await call('POST', `/api/providers/${bank.id}/cache/expire`, {});
  await call('POST', `/api/providers/${bank.id}/remote/offline`, { offline: true });
  const normalMeta = samples.find((s) => s.label === '正常登录令牌');
  const normalFull = (await call('GET', `/api/samples/${normalMeta.id}`)).data;
  r = await call('POST', `/api/providers/${bank.id}/verify`, { token: normalFull.token });
  check('缓存过期+离线拒绝信任', r.data.decision === 'REJECTED' && r.data.reasonCode === 'DISCOVERY_FETCH_FAILED');
  await call('POST', `/api/providers/${bank.id}/remote/offline`, { offline: false });

  // 6. 重新检查：返回每组新旧对比
  r = await call('POST', `/api/providers/${bank.id}/recheck`, { forceRefresh: true });
  check('重新检查覆盖该提供方全部样例', Array.isArray(r.data.results) && r.data.results.length >= 9);
  check('重新检查结果含 before/after', r.data.results.every((x) => 'after' in x && 'before' in x));

  // 7. 密钥生命周期：新增 -> 撤销即时生效
  r = await call('POST', `/api/providers/${bank.id}/keys`, { alg: 'RS256' });
  check('可新增密钥', r.status === 201 && r.data.kid);
  const newKid = r.data.kid;
  const mint = await call('POST', `/api/providers/${bank.id}/mint`, { kid: newKid, alg: 'RS256' });
  check('可用新密钥签发样例令牌', mint.status === 201 && mint.data.token.split('.').length === 3);
  let v = (await call('POST', `/api/providers/${bank.id}/verify`, { token: mint.data.token, forceRefresh: true })).data;
  check('新密钥令牌先信任', v.reasonCode === 'OK');
  await call('POST', `/api/providers/${bank.id}/keys/${newKid}/status`, { status: 'revoked' });
  v = (await call('POST', `/api/providers/${bank.id}/verify`, { token: mint.data.token, forceRefresh: true })).data;
  check('撤销后同一令牌被拒绝', v.reasonCode === 'KEY_REVOKED');

  // 8. 审计安全：无令牌、无私钥，关联三要素齐全
  const audit = (await call('GET', '/api/audit')).data;
  check('审计记录非空', audit.length > 0);
  check('审计不含令牌原文', audit.every((a) => !JSON.stringify(a).includes(mint.data.token)));
  check('审计关联提供方/配置版本/kid或原因码',
    audit.every((a) => a.providerId && a.configVersion && a.reasonCode && a.tokenFingerprint));

  // 9. 静态页面
  const html = await fetch(BASE + '/');
  check('首页可访问', html.status === 200 && (await html.text()).includes('本地身份信任核验演示台'));
  const js = await fetch(BASE + '/app.js');
  check('前端脚本可访问', js.status === 200);

  // 10. 政务提供方不受银行侧操作影响（隔离性）
  const govState = (await call('GET', '/api/providers')).data.find((p) => p.id === gov.id);
  check('政务提供方缓存与银行隔离', govState.id !== bank.id);

} finally {
  child.kill('SIGTERM');
}

console.log(`\n${passed} 项通过，${failures.length} 项失败`);
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
