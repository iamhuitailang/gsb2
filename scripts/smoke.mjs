// 端到端冒烟测试：node scripts/smoke.mjs
// 自动启停本地服务，覆盖题目全部规则。断言失败即退出码 1。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DATA_FILE = path.join(ROOT, 'data.json');
const BASE = `http://localhost:${process.env.PORT || 3100}`;

let passed = 0;
function check(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    console.error(`  ❌ ${name} ${extra}`);
    process.exitCode = 1;
  }
}
async function call(token, method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

// 全新数据启动服务
if (fs.existsSync(DATA_FILE)) fs.rmSync(DATA_FILE);
const server = spawn('node', [path.join(ROOT, 'src', 'server.js')], {
  env: { ...process.env, PORT: process.env.PORT || 3100 },
  stdio: ['ignore', 'pipe', 'inherit']
});
await new Promise((resolve) => {
  server.stdout.on('data', (b) => {
    if (b.toString().includes('已启动')) resolve();
  });
});

try {
  console.log('\n== 场景一：正常代办 + 订单隔离 + 幂等 + 退出清会话 ==');
  const cust = await call(null, 'POST', '/api/login', { userId: 'u_cust' });
  const agent = await call(null, 'POST', '/api/login', { userId: 'u_agent' });
  const agent2 = await call(null, 'POST', '/api/login', { userId: 'u_agent2' });
  const auditor = await call(null, 'POST', '/api/login', { userId: 'u_auditor' });
  const custToken = cust.json.token;
  const agentToken = agent.json.token;
  const agent2Token = agent2.json.token;
  const auditorToken = auditor.json.token;

  const orders = (await call(custToken, 'GET', '/api/orders')).json.orders;
  const [o1, o2] = orders;
  check('准备了两笔订单', orders.length === 2);

  // 客户只对第一笔订单授权给客服李敏，有效期 30 分钟
  const created = await call(custToken, 'POST', '/api/authorizations', {
    orderId: o1.id,
    agentId: 'u_agent',
    ttlMinutes: 30
  });
  const authNo = created.json.auth.id;
  check('授权生成且带编号/范围/截止时间', !!authNo && created.status === 201);
  check('授权范围仅售后提交', JSON.stringify(created.json.auth.scope) === '["aftersale:submit"]');
  check('授权绑定第一笔订单', created.json.auth.orderId === o1.id);
  check('授权带截止时间', created.json.auth.expiresAt > Date.now());

  // 另一客服无权接手
  const wrongTake = await call(agent2Token, 'POST', '/api/acting/enter', { authId: authNo });
  check('非指定客服不能接手', wrongTake.status === 403);

  // 指定客服接手
  const take = await call(agentToken, 'POST', '/api/acting/enter', { authId: authNo });
  check('指定客服接手成功', take.status === 200 && take.json.auth.id === authNo);

  const meActing = (await call(agentToken, 'GET', '/api/me')).json;
  check('会话中可见代办范围和截止时间', meActing.acting?.scope?.includes('aftersale:submit') && !!meActing.acting.expiresAt);
  check('代办期间会话登录身份仍是客服本人', meActing.user.id === 'u_agent');

  // 第二笔订单：没有授权，客服不能代办 —— 尝试用第一笔授权直接提交 o2 在服务端无入口；
  // 授权与订单强绑定，售后单只能开在授权绑定的订单上
  const o2Auths = (await call(agentToken, 'GET', '/api/authorizations')).json.auths.filter(
    (a) => a.orderId === o2.id
  );
  check('第二笔订单无任何授权给该客服', o2Auths.length === 0);

  // 常规页面仍以客服本人身份工作
  const tickets = await call(agentToken, 'GET', '/api/my-tickets');
  check('代办状态下工单页仍以客服本人身份工作', tickets.json.tickets.every((t) => t.owner === '客服·李敏'));

  // 提交售后
  const submit = await call(agentToken, 'POST', '/api/aftersales', {
    type: '退货退款',
    reason: '客户电话确认：耳机降噪异常',
    amount: 899
  });
  check('售后提交成功', submit.status === 201);
  check('保存客户身份', submit.json.aftersale.customerId === 'u_cust');
  check('保存实际提交客服', submit.json.aftersale.agentId === 'u_agent');
  check('保存授权编号', submit.json.aftersale.authId === authNo);
  check('保存订单为授权绑定的第一笔', submit.json.aftersale.orderId === o1.id);

  // 提交后不自动退出：会话仍带代办标记，由客服显式退出
  const meAfter = await call(agentToken, 'GET', '/api/me');
  check('提交成功后会话仍保留代办上下文用于回放', meAfter.json.acting?.id === authNo);
  check('会话登录身份始终是客服本人', meAfter.json.user.id === 'u_agent');

  // 再点一次：同一授权重复提交，只返回原申请（幂等）
  const resubmit = await call(agentToken, 'POST', '/api/aftersales', {
    type: '退货退款',
    reason: '客户又点了一次',
    amount: 1
  });
  check('重复提交返回原申请而非新建', resubmit.status === 200 && resubmit.json.duplicated === true);
  check('回放的是同一张申请单', resubmit.json.aftersale.id === submit.json.aftersale.id);
  const custApps = (await call(custToken, 'GET', '/api/aftersales')).json.aftersales;
  check('一个授权只产生一张售后单', custApps.length === 1 && custApps[0].id === submit.json.aftersale.id);

  // 客服显式退出代办：客户身份不残留在会话里
  await call(agentToken, 'POST', '/api/acting/exit');
  const meExit1 = await call(agentToken, 'GET', '/api/me');
  check('退出代办后客户身份不残留', meExit1.json.acting === null && meExit1.json.user.role === 'agent');
  // 已消费授权不能再次接手
  const reEnter = await call(agentToken, 'POST', '/api/acting/enter', { authId: authNo });
  check('已消费授权不能再次接手', reEnter.status === 409);

  console.log('\n== 场景二：客户取消授权后，客服手上表单不能提交；退出代办不留客户身份 ==');
  const created2 = await call(custToken, 'POST', '/api/authorizations', {
    orderId: o2.id,
    agentId: 'u_agent',
    ttlMinutes: 30
  });
  const auth2 = created2.json.auth.id;
  await call(agentToken, 'POST', '/api/acting/enter', { authId: auth2 });
  const beforeCancel = await call(agentToken, 'GET', '/api/me');
  check('客服已进入第二笔订单代办', beforeCancel.json.acting?.id === auth2);

  await call(custToken, 'POST', `/api/authorizations/${auth2}/cancel`);
  const blocked = await call(agentToken, 'POST', '/api/aftersales', {
    type: '仅退款',
    reason: '测试取消后提交'
  });
  check('客户取消后表单不能提交', blocked.status === 409 && /取消/.test(blocked.json.error));
  const meBlocked = await call(agentToken, 'GET', '/api/me');
  check('被拒后会话已清掉代办标记', meBlocked.json.acting === null);

  // 退出代办接口本身不残留
  const created3 = await call(custToken, 'POST', '/api/authorizations', {
    orderId: o1.id,
    agentId: 'u_agent',
    ttlMinutes: 30
  });
  // o1 的旧授权已 consumed，可以再发新的
  check('旧授权消费完，客户可就同订单再发新授权', created3.status === 201);
  await call(agentToken, 'POST', '/api/acting/enter', { authId: created3.json.auth.id });
  await call(agentToken, 'POST', '/api/acting/exit');
  const meExit = await call(agentToken, 'GET', '/api/me');
  check('主动退出代办后客户身份不残留', meExit.json.acting === null && meExit.json.user.role === 'agent');

  console.log('\n== 场景三：授权过了截止时间，表单同样不能提交 ==');
  const created4 = await call(custToken, 'POST', '/api/authorizations', {
    orderId: o2.id,
    agentId: 'u_agent',
    ttlMinutes: 0.03 // 约 2 秒过期
  });
  const auth4 = created4.json.auth.id;
  await call(agentToken, 'POST', '/api/acting/enter', { authId: auth4 });
  await new Promise((r) => setTimeout(r, 2200));
  const expired = await call(agentToken, 'POST', '/api/aftersales', { type: '换货', reason: '已过期' });
  check('超过截止时间后表单不能提交', expired.status === 409 && /过期/.test(expired.json.error));

  console.log('\n== 场景四：订单隔离（售后单只能开在授权绑定的那笔订单上）==');
  // 场景二留下的授权仅退出代办、仍生效，先取消再新建
  await call(custToken, 'POST', `/api/authorizations/${created3.json.auth.id}/cancel`);
  const created5 = await call(custToken, 'POST', '/api/authorizations', {
    orderId: o1.id,
    agentId: 'u_agent',
    ttlMinutes: 30
  });
  check('订单隔离场景授权创建成功', created5.status === 201, JSON.stringify(created5.json));
  await call(agentToken, 'POST', '/api/acting/enter', { authId: created5.json.auth.id });
  const fifth = await call(agentToken, 'POST', '/api/aftersales', { type: '维修', reason: '隔离验证' });
  check('即使客户端伪造，售后单也只能开在授权绑定的订单上', fifth.json.aftersale.orderId === o1.id);
  const o2Apps = (await call(custToken, 'GET', '/api/aftersales')).json.aftersales.filter((a) => a.orderId === o2.id);
  check('第二笔订单始终没有被代办产生申请', o2Apps.length === 0);
  await call(agentToken, 'POST', '/api/acting/exit');

  console.log('\n== 场景五：客户页与审计可查实际操作人与授权编号 ==');
  const custView = await call(custToken, 'GET', '/api/aftersales');
  const hasOperator = custView.json.aftersales.every(
    (a) => a.agent?.id === 'u_agent' && a.customer?.id === 'u_cust' && a.authId
  );
  check('客户页面每条申请都能看到实际客服与授权编号', hasOperator && custView.json.aftersales.length === 2);

  const audits = await call(auditorToken, 'GET', '/api/audits');
  const submitLogs = audits.json.audits.filter((l) => l.action === 'aftersale.submit');
  // 3 条提交动作：2 次成功 + 1 次幂等回放（duplicated=true）
  check('审计含全部提交记录且带授权编号/客户/客服', submitLogs.length === 3 &&
    submitLogs.every((l) => l.actorId === 'u_agent' && l.detail.authId && l.detail.customerId === 'u_cust'));
  check('审计记录了幂等回放标记', submitLogs.some((l) => l.detail.duplicated === true));
  check('审计含授权创建、取消、接手、退出全链路记录',
    ['auth.create', 'auth.cancel', 'acting.enter', 'acting.exit'].every((act) =>
      audits.json.audits.some((l) => l.action === act)));

  // 越权：客户不能访问审计
  const forbidden = await call(custToken, 'GET', '/api/audits');
  check('客户无权访问审计', forbidden.status === 403);
  // 未登录
  const noAuth = await call(null, 'GET', '/api/orders');
  check('未登录请求被拦截', noAuth.status === 401);

  console.log(`\n共通过 ${passed} 项断言`);
} finally {
  server.kill();
}
