'use strict';

/**
 * 端到端自动验证（零依赖，Node 内置 fetch）
 * 自动在测试端口启动两个站点，覆盖：
 *  - 只读 GET 不改状态、未登录可查看 10:00
 *  - 跨来源改预约被来源/会话/校验值逐层拒绝，安全事件不泄露校验值原文
 *  - 同源登录后的确认流程成功改到 11:00，旧 10:00 保留
 *  - 切换账号 / 登出后旧会话与旧校验值立即失效
 *  - 审计页可区分安全事件与业务事件
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const BACKEND_PORT = 5101;
const NOTIFY_PORT = 5102;
const BACKEND = `http://localhost:${BACKEND_PORT}`;
const NOTIFY = `http://localhost:${NOTIFY_PORT}`;
const CHANGE = `${BACKEND}/bookings/BK-1001/change`;
const DETAIL = `${BACKEND}/bookings/BK-1001`;

let failures = 0;
let passes = 0;

function check(name, cond, extra) {
  if (cond) {
    passes++;
    console.log(`  ✅ ${name}`);
  } else {
    failures++;
    console.log(`  ❌ ${name}${extra ? ` —— ${extra}` : ''}`);
  }
}

async function waitReady(url, label) {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* 重试 */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${label} 启动超时: ${url}`);
}

function start(label, file, env) {
  const child = spawn(process.execPath, [path.join(__dirname, file)], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (b) => process.stdout.write(`[${label}] ${b}`));
  return child;
}

function extractSid(res) {
  const cookie = res.headers.getSetCookie?.().find((c) => c.startsWith('sid='));
  return cookie ? cookie.split(';')[0].slice(4) : null;
}

function extractCsrf(html) {
  const m = html.match(/name="_csrf"\s+value="([0-9a-f]+)"/);
  return m ? m[1] : null;
}

async function login(username, password) {
  const res = await fetch(`${BACKEND}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: BACKEND },
    body: new URLSearchParams({ username, password }),
  });
  const sid = extractSid(res);
  const detail = await (await fetch(DETAIL, { headers: { Cookie: `sid=${sid}` } })).text();
  return { sid, csrf: extractCsrf(detail), status: res.status };
}

async function postChange({ sid, csrf, origin = BACKEND, extra = {}, referer }) {
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Origin: origin,
    Cookie: sid ? `sid=${sid}` : undefined,
  };
  if (referer) {
    delete headers.Origin;
    headers.Referer = referer;
  }
  const res = await fetch(CHANGE, {
    method: 'POST',
    redirect: 'manual',
    headers,
    body: new URLSearchParams({ newTime: '11:00', confirm: 'yes', _csrf: csrf || '', ...extra }),
  });
  return { status: res.status, location: res.headers.get('location') || '' };
}

async function audit() {
  return (await (await fetch(`${BACKEND}/audit.json`)).json()).events;
}

async function main() {
  const backend = start('backend', 'backend/server.js', { BACKEND_PORT: String(BACKEND_PORT) });
  const notify = start('notify', 'notification/server.js', {
    NOTIFY_PORT: String(NOTIFY_PORT),
    BACKEND_URL: BACKEND,
  });
  try {
    await waitReady(`${BACKEND}/healthz`, 'backend');
    await waitReady(`${NOTIFY}/healthz`, 'notify');
    console.log('\n=== 1. 站点就绪，来源不同 ===');
    const h1 = await (await fetch(`${BACKEND}/healthz`)).json();
    const h2 = await (await fetch(`${NOTIFY}/healthz`)).json();
    check('后台来源为 5101', h1.origin === BACKEND, h1.origin);
    check('通知页来源为 5102 且指向前台', h2.origin === NOTIFY && h2.backend === BACKEND);

    console.log('\n=== 2. 通知链接是只读 GET，未登录即可查看，时间 10:00 ===');
    const before = (await audit()).length;
    const detailAnon = await (await fetch(DETAIL)).text();
    const after = (await audit()).length;
    check('详情页显示 10:00', detailAnon.includes('10:00'));
    check('未登录看不到修改表单（无 _csrf）', !detailAnon.includes('name="_csrf"'));
    check('GET 查看不产生任何审计事件（不改状态）', before === after, `${before} -> ${after}`);
    const notifyPage = await (await fetch(`${NOTIFY}/`)).text();
    check('通知页包含指向后台详情的只读链接', notifyPage.includes(DETAIL));
    check('通知页包含演示变更按钮', notifyPage.includes('发送演示变更'));

    console.log('\n=== 3. 跨来源提交演示变更：未登录，先被来源核对拒绝 ===');
    const r3 = await postChange({ origin: NOTIFY, csrf: 'FORGED-FROM-OTHER-ORIGIN' });
    check('返回 302 拒绝跳转', r3.status === 302 && r3.location.includes('flash=denied'));
    let events = await audit();
    const e3 = events.find((e) => e.type === 'security' && e.detail?.requestId);
    check('记录安全事件且原因为来源不匹配', !!e3 && /来源不匹配/.test(e3.reason), e3?.reason);
    const detailNow1 = await (await fetch(DETAIL)).text();
    check('预约时间仍为 10:00（未被修改）', detailNow1.includes('>10:00<'));

    console.log('\n=== 4. 同源但无会话 / 无校验值：逐层拒绝 ===');
    const r4 = await postChange({ csrf: 'whatever' });
    events = await audit();
    const e4 = events.filter((e) => e.type === 'security').at(-1);
    check('无会话被拒绝并跳转', r4.status === 302 && r4.location.includes('flash=denied'));
    check('拒绝原因为缺少有效会话', /会话/.test(e4.reason), e4.reason);

    console.log('\n=== 5. Origin 缺失时 Referer 回退核对 ===');
    const r5 = await postChange({ referer: `${BACKEND}/bookings/BK-1001` });
    events = await audit();
    const e5 = events.filter((e) => e.type === 'security').at(-1);
    check('Referer 匹配则通过来源层，继续在会话层拒绝', /会话/.test(e5.reason), e5.reason);
    const r5b = await postChange({ referer: `${NOTIFY}/evil` });
    events = await audit();
    const e5b = events.filter((e) => e.type === 'security').at(-1);
    check('Referer 不匹配仍按来源拒绝', /来源不匹配/.test(e5b.reason), e5b.reason);

    console.log('\n=== 6. 登录后台（alice），签发会话与校验值 ===');
    const bad = await login('alice', 'wrong-password');
    check('错误密码登录失败且不发 Cookie', bad.status === 302 && bad.sid === null);
    const alice = await login('alice', 'alice123');
    check('登录成功拿到会话 sid 与本会话 CSRF 校验值', !!alice.sid && /^[0-9a-f]{64}$/.test(alice.csrf));
    const detailOwner = await (await fetch(DETAIL, { headers: { Cookie: `sid=${alice.sid}` } })).text();
    check('登录后详情页出现带确认复选框的修改表单', detailOwner.includes('name="confirm"') && detailOwner.includes(alice.csrf));

    console.log('\n=== 7. 已登录但跨来源提交：来源核对优先拒绝（即使带对 Cookie）===');
    const r7 = await postChange({ sid: alice.sid, csrf: alice.csrf, origin: NOTIFY });
    events = await audit();
    const e7 = events.filter((e) => e.type === 'security').at(-1);
    check('跨来源请求被拒绝', r7.location.includes('flash=denied'));
    check('拒绝原因是来源不匹配（会话与校验值尚未参与）', /来源不匹配/.test(e7.reason), e7.reason);

    console.log('\n=== 8. 同源但校验值错误：请求层校验值比对拒绝 ===');
    const FORGED = 'a'.repeat(64);
    const r8 = await postChange({ sid: alice.sid, csrf: FORGED });
    events = await audit();
    const e8 = events.filter((e) => e.type === 'security').at(-1);
    check('伪造校验值被拒绝', r8.location.includes('flash=denied'));
    check('原因指明 CSRF 校验值无效', /CSRF/.test(e8.reason), e8.reason);
    check('只记录校验值哈希前缀 tokenHash', typeof e8.detail.tokenHash === 'string' && e8.detail.tokenHash.length === 8);

    console.log('\n=== 9. 同源、会话与校验值都对，但未走确认流程 ===');
    const r9 = await postChange({ sid: alice.sid, csrf: alice.csrf, extra: { confirm: '' } });
    events = await audit();
    const e9 = events.filter((e) => e.action === 'change_booking').at(-1);
    check('未确认被拒绝', r9.location.includes('flash=confirm_required'));
    check('记为业务事件而非安全事件', e9.type === 'business' && e9.result === 'denied');
    check('时间仍为 10:00', (await (await fetch(DETAIL)).text()).includes('>10:00<'));

    console.log('\n=== 10. 同源确认流程完整：改到 11:00 成功，旧 10:00 保留 ===');
    const r10 = await postChange({ sid: alice.sid, csrf: alice.csrf, extra: { newTime: '11:00' } });
    check('变更成功跳转', r10.status === 302 && r10.location.includes('flash=changed'));
    const detailAfter = await (await fetch(DETAIL)).text();
    check('当前时间变为 11:00', detailAfter.includes('>11:00<'));
    check('历史中保留旧预约 10:00', /10:00/.test(detailAfter) && detailAfter.includes('变更前时间'));
    events = await audit();
    const e10 = events.find((e) => e.action === 'change_booking' && e.result === 'success');
    check('成功事件记录 oldTime=10:00 -> newTime=11:00', e10?.detail.oldTime === '10:00' && e10.detail.newTime === '11:00');

    console.log('\n=== 11. 切换账号：bob 不能改 alice 的预约 ===');
    const bob = await login('bob', 'bob123');
    const detailBob = await (await fetch(DETAIL, { headers: { Cookie: `sid=${bob.sid}` } })).text();
    check('bob 的详情页不渲染修改表单', !detailBob.includes('name="confirm"'));
    const r11 = await postChange({ sid: bob.sid, csrf: bob.csrf, extra: { newTime: '12:00' } });
    events = await audit();
    const e11 = events.filter((e) => e.type === 'security').at(-1);
    check('bob 越权修改被拒绝', r11.location.includes('flash=denied') && /越权/.test(e11.reason), e11.reason);

    console.log('\n=== 12. 登出 / 重新登录后，旧会话与旧页面里的旧校验值失效 ===');
    // 12a 登出 alice 的旧会话
    const lo = await fetch(`${BACKEND}/logout`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: BACKEND, Cookie: `sid=${alice.sid}` },
      body: new URLSearchParams({ _csrf: alice.csrf }),
    });
    check('登出成功并清除 Cookie', lo.status === 302 && lo.headers.getSetCookie().some((c) => /Max-Age=0/.test(c)));
    const r12a = await postChange({ sid: alice.sid, csrf: alice.csrf });
    events = await audit();
    const e12a = events.filter((e) => e.type === 'security').at(-1);
    check('旧 sid 再用被拒（会话已销毁）', /会话/.test(e12a.reason), e12a.reason);
    // 12b 跨站登出也被来源核对拦截
    const loX = await fetch(`${BACKEND}/logout`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: NOTIFY, Cookie: `sid=${bob.sid}` },
      body: new URLSearchParams({ _csrf: bob.csrf }),
    });
    events = await audit();
    const e12b = events.filter((e) => e.action === 'logout' && e.result === 'denied').at(-1);
    check('跨站强制登出被来源核对拒绝', loX.status === 302 && /来源不匹配/.test(e12b.reason));
    // 12c alice 重新登录拿到新校验值，旧校验值 T1 不能再用
    const alice2 = await login('alice', 'alice123');
    check('重新登录后校验值已轮换（与旧值不同）', alice2.csrf !== alice.csrf);
    const r12c = await postChange({ sid: alice2.sid, csrf: alice.csrf });
    events = await audit();
    const e12c = events.filter((e) => e.type === 'security').at(-1);
    check('旧页面里拿到的旧校验值继续用被拒', /CSRF/.test(e12c.reason), e12c.reason);
    const r12d = await postChange({ sid: alice2.sid, csrf: alice2.csrf, extra: { confirm: '' } });
    check('新会话新校验值可正常通过校验（停在确认步骤）', r12d.location.includes('flash=confirm_required'));

    console.log('\n=== 13. 审计可区分两次操作，且全程不泄露校验值原文 ===');
    events = await audit();
    const sec = events.filter((e) => e.type === 'security');
    const biz = events.filter((e) => e.type === 'business');
    check('存在多条安全事件（跨站/越权/校验失败）', sec.length >= 6, `实际 ${sec.length} 条`);
    check('存在成功的业务变更事件', biz.some((e) => e.action === 'change_booking' && e.result === 'success'));
    const raw = JSON.stringify(events);
    check('审计 JSON 不包含伪造校验值原文', !raw.includes(FORGED) && !raw.includes('FORGED-FROM-OTHER-ORIGIN'));
    check('审计 JSON 不包含任何真实 CSRF 原文', !raw.includes(alice.csrf) && !raw.includes(alice2.csrf) && !raw.includes(bob.csrf));
    const deniedEvt = sec.find((e) => /CSRF/.test(e.reason || ''));
    const successEvt = biz.find((e) => e.action === 'change_booking' && e.result === 'success');
    check('两次操作可区分：拒绝=security/denied，成功=business/success',
      deniedEvt.result === 'denied' && successEvt.result === 'success' && deniedEvt.id !== successEvt.id);

    console.log(`\n────────────────────────────────────────`);
    console.log(`  通过 ${passes}，失败 ${failures}`);
    console.log(`────────────────────────────────────────\n`);
  } finally {
    backend.kill('SIGTERM');
    notify.kill('SIGTERM');
  }
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error('验证脚本异常:', err);
  process.exit(1);
});
