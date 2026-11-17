// 端到端流程测试：黑盒方式启动真实 HTTP 服务，用两套独立 cookie 模拟两个浏览器。
// 运行：node test/flow.test.mjs（或 npm test）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const SERVER_PATH = path.join(REPO_ROOT, 'src', 'server.js');

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 启动一个服务实例，返回 baseUrl 和清理函数 */
async function startServer({ port, dataDir, logDir, resetTtlMs }) {
  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      LOG_DIR: logDir,
      RESET_TTL_MS: String(resetTtlMs),
    },
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => process.stderr.write(d));

  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${base}/api/mails`);
      if (res.ok) break;
    } catch {
      /* 服务尚未就绪 */
    }
    await sleep(100);
  }
  return {
    base,
    stop: () => child.kill('SIGTERM'),
  };
}

/** 每个“浏览器”一套独立 cookie 罐 */
function makeBrowser(base) {
  const jar = new Map();
  async function req(method, p, body) {
    const cookieHeader = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(`${base}${p}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.getSetCookie
      ? res.headers.getSetCookie()
      : [res.headers.get('set-cookie')].filter(Boolean);
    for (const raw of setCookie) {
      const [pair] = raw.split(';');
      const idx = pair.indexOf('=');
      const key = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (value === '') jar.delete(key);
      else jar.set(key, value);
    }
    return { status: res.status, data: await res.json().catch(() => ({})) };
  }
  return {
    req,
    cookie: (k) => jar.get(k) || null,
  };
}

async function latestResetToken(base) {
  const res = await fetch(`${base}/api/mails`);
  const { mails } = await res.json();
  if (!mails.length) throw new Error('收件箱中没有邮件');
  const url = new URL(mails[0].resetUrl);
  return url.searchParams.get('token');
}

// ---------------------------------------------------------------------------
// 主场景
// ---------------------------------------------------------------------------
console.log('\n[场景] 两个浏览器登录同一账号，两次申请重置链接');

const dataDir = tempDir('gsb2-data-');
const logDir = tempDir('gsb2-logs-');
const port = 4311 + Math.floor(Math.random() * 200);
const { base, stop } = await startServer({
  port,
  dataDir,
  logDir,
  resetTtlMs: 30 * 60 * 1000,
});

const browserA = makeBrowser(base);
const browserB = makeBrowser(base);
const EMAIL = 'demo@example.com';
const OLD_PASSWORD = 'password123';
const NEW_PASSWORD = 'new-secret-42';

try {
  // 1. 两个浏览器分别登录同一账号
  const loginA = await browserA.req('POST', '/api/login', {
    email: EMAIL,
    password: OLD_PASSWORD,
  });
  const loginB = await browserB.req('POST', '/api/login', {
    email: EMAIL,
    password: OLD_PASSWORD,
  });
  assert(loginA.status === 200 && !!loginA.data.user, '浏览器 A 登录成功');
  assert(loginB.status === 200 && !!loginB.data.user, '浏览器 B 登录成功');
  assert(
    browserA.cookie('sid') !== browserB.cookie('sid'),
    '两个浏览器拿到不同的会话 cookie'
  );

  // 2. 资料页访问由服务端判断会话
  const meA = await browserA.req('GET', '/api/me');
  const meB = await browserB.req('GET', '/api/me');
  assert(meA.status === 200, '浏览器 A 可访问资料接口');
  assert(meB.status === 200, '浏览器 B 可访问资料接口');
  const anon = await makeBrowser(base).req('GET', '/api/me');
  assert(anon.status === 401, '未登录请求访问资料接口被服务端拒绝');

  // 3. 拿到两条重置链接
  await browserA.req('POST', '/api/password/forgot', { email: EMAIL });
  await sleep(20);
  const token1 = await latestResetToken(base);
  await browserA.req('POST', '/api/password/forgot', { email: EMAIL });
  const token2 = await latestResetToken(base);
  assert(!!token1 && !!token2 && token1 !== token2, '收到两条不同的重置链接');

  // 4. 忘记密码页统一回复，无法据此判断邮箱是否注册
  const known = await browserA.req('POST', '/api/password/forgot', { email: EMAIL });
  const unknown = await browserA.req('POST', '/api/password/forgot', {
    email: 'nobody-' + Date.now() + '@example.com',
  });
  assert(known.status === 200 && unknown.status === 200, '注册/未注册邮箱返回相同状态码 200');
  assert(
    JSON.stringify(known.data) === JSON.stringify(unknown.data),
    '注册/未注册邮箱返回完全相同的响应内容'
  );
  const malformed = await browserA.req('POST', '/api/password/forgot', { email: 'not-an-email' });
  assert(malformed.status === 400, '非法邮箱格式仍会被输入校验拦截（不泄露账号信息）');

  // 5. 重置链接绑定用途：随机/伪造令牌无效
  const checkRandom = await browserA.req('GET', '/api/password/reset?token=deadbeef');
  assert(checkRandom.data.valid === false, '伪造的重置链接被判定无效');

  // 6. 第一条链接设置新密码
  const reset1 = await browserA.req('POST', '/api/password/reset', {
    token: token1,
    password: NEW_PASSWORD,
  });
  assert(reset1.status === 200, '第一条重置链接成功设置新密码');

  // 7. 另一个浏览器的旧会话立即失效，保存资料被拒绝
  const meBAfter = await browserB.req('GET', '/api/me');
  const saveB = await browserB.req('POST', '/api/profile', {
    name: '浏览器 B 想改资料',
    bio: 'should be rejected',
  });
  assert(meBAfter.status === 401, '改密后浏览器 B 的旧会话已失效');
  assert(saveB.status === 401, '浏览器 B 保存资料被服务端拒绝');

  // 8. 一次重置只成功一次：第一条不能再用
  const reuse1 = await browserA.req('POST', '/api/password/reset', {
    token: token1,
    password: 'another-password-9',
  });
  assert(reuse1.status === 400, '第一条链接不能再次用于重置');

  // 9. 第二条链接（未使用但已被连带失效）不能重置
  const reuse2 = await browserA.req('POST', '/api/password/reset', {
    token: token2,
    password: 'another-password-9',
  });
  assert(reuse2.status === 400, '第二条未使用的链接在改密后一并失效');
  const check2 = await browserA.req('GET', `/api/password/reset?token=${encodeURIComponent(token2)}`);
  assert(check2.data.valid === false, '第二条链接的状态查询返回无效');

  // 10. 旧密码不能登录，新密码可以
  const oldLogin = await makeBrowser(base).req('POST', '/api/login', {
    email: EMAIL,
    password: OLD_PASSWORD,
  });
  const newLogin = await makeBrowser(base).req('POST', '/api/login', {
    email: EMAIL,
    password: NEW_PASSWORD,
  });
  assert(oldLogin.status === 401, '旧密码无法登录');
  assert(newLogin.status === 200 && !!newLogin.data.user, '新密码可以登录');

  // 11. 新会话可以正常保存资料
  const fresh = makeBrowser(base);
  await fresh.req('POST', '/api/login', { email: EMAIL, password: NEW_PASSWORD });
  const saveOk = await fresh.req('POST', '/api/profile', { name: '新昵称', bio: '新简介' });
  assert(saveOk.status === 200 && saveOk.data.user.name === '新昵称', '新会话保存资料成功');

  // 12. 存储检查：令牌只存哈希、密码只存哈希
  const dbRaw = fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8');
  assert(!dbRaw.includes(token1) && !dbRaw.includes(token2), '数据库中不保存重置令牌明文');
  assert(!dbRaw.includes(OLD_PASSWORD) && !dbRaw.includes(NEW_PASSWORD), '数据库中不保存密码明文');

  // 13. 日志检查：只有时刻 + 事件 + 结果，没有邮箱/令牌
  const logRaw = fs.readFileSync(path.join(logDir, 'app.log'), 'utf8');
  const lines = logRaw.trim().split('\n').filter(Boolean).map(JSON.parse);
  assert(
    lines.every((l) => Object.keys(l).sort().join(',') === 'event,result,time'),
    '每条日志只包含 time / event / result 三个字段'
  );
  assert(
    lines.filter((l) => l.event === 'password_reset_request').every((l) => l.result === 'accepted'),
    '忘记密码申请日志结果统一为 accepted'
  );
  assert(
    lines.some((l) => l.event === 'password_reset_complete' && l.result === 'success'),
    '成功重置记录为 success'
  );
  assert(
    lines.some((l) => l.event === 'password_reset_complete' && l.result === 'invalid'),
    '失效链接尝试记录为 invalid'
  );
  assert(
    !logRaw.includes(EMAIL) && !logRaw.includes(token1) && !logRaw.includes(token2),
    '日志中不出现邮箱地址或重置令牌'
  );
} finally {
  stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(logDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 过期场景：独立实例，极短有效期
// ---------------------------------------------------------------------------
console.log('\n[场景] 重置链接过期后不能再设置密码');

const expData = tempDir('gsb2-exp-data-');
const expLogs = tempDir('gsb2-exp-logs-');
const expPort = 4511 + Math.floor(Math.random() * 200);
const expServer = await startServer({
  port: expPort,
  dataDir: expData,
  logDir: expLogs,
  resetTtlMs: 120,
});

try {
  await expServer.base;
  const browser = makeBrowser(expServer.base);
  await browser.req('POST', '/api/password/forgot', { email: EMAIL });
  const token = await latestResetToken(expServer.base);
  const before = await browser.req('GET', `/api/password/reset?token=${encodeURIComponent(token)}`);
  assert(before.data.valid === true, '链接刚发出时有效');
  await sleep(200);
  const expired = await browser.req('POST', '/api/password/reset', {
    token,
    password: NEW_PASSWORD,
  });
  assert(expired.status === 400, '过期链接无法设置密码');
  const after = await browser.req('GET', `/api/password/reset?token=${encodeURIComponent(token)}`);
  assert(after.data.valid === false, '过期链接状态查询返回无效');
} finally {
  expServer.stop();
  fs.rmSync(expData, { recursive: true, force: true });
  fs.rmSync(expLogs, { recursive: true, force: true });
}

console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
process.exit(failed ? 1 : 0);
