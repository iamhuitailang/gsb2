// 端到端验收脚本：零依赖，用两个独立 cookie jar 模拟甲、乙两个浏览器
// 运行：node scripts/e2e-test.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import assert from 'node:assert/strict';

const ROOT = join(import.meta.dirname, '..');
const DATA_DIR = mkdtempSync(join(tmpdir(), 'duty-e2e-'));
const PORT = 4317 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;
const USERNAME = 'admin';
const PASSWORD = 'duty-2026';

const server = spawn(process.execPath, ['src/server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), DATA_DIR },
  stdio: ['ignore', 'pipe', 'inherit'],
});

let passed = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`  ✔ ${name}`);
    });
}

// 独立 cookie jar：每个实例代表一个浏览器
class CookieJar {
  constructor(label) {
    this.label = label;
    this.cookies = new Map();
  }

  absorb(res) {
    const pattern = /^([^=;]+)=([^;]*)/;
    for (const raw of res.headers.getSetCookie()) {
      const m = raw.match(pattern);
      if (!m) continue;
      const name = m[1].trim();
      const value = m[2].trim();
      if (value === '' || /max-age=0/i.test(raw)) this.cookies.delete(name);
      else this.cookies.set(name, decodeURIComponent(value));
    }
  }

  header() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
  }

  get(name) {
    return this.cookies.get(name);
  }

  has(name) {
    return this.cookies.has(name);
  }
}

async function request(jar, method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    redirect: 'manual',
    headers: {
      Cookie: jar.header(),
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: body ? new URLSearchParams(body).toString() : undefined,
  });
  jar.absorb(res);
  const text = await res.text();
  return { status: res.status, location: res.headers.get('location'), text };
}

async function follow(jar, path) {
  // 跟随重定向（最多 5 跳），返回最终响应
  let current = path;
  for (let i = 0; i < 5; i += 1) {
    const r = await request(jar, 'GET', current);
    if (r.status === 302) current = r.location;
    else return r;
  }
  throw new Error('too many redirects');
}

async function login(jar, { remember = false, deviceName = '', password = PASSWORD } = {}) {
  const form = { username: USERNAME, password };
  if (remember) form.remember = '1';
  if (deviceName) form.deviceName = deviceName;
  return request(jar, 'POST', '/login', form);
}

function latestConfirmToken() {
  // 收件箱是全局模拟邮箱，取最新一封确认邮件里的链接
  return new Promise((resolve, reject) => {
    const inboxJar = new CookieJar('inbox-reader');
    const timer = setInterval(async () => {
      const r = await request(inboxJar, 'GET', '/inbox');
      const m = r.text.match(/\/confirm\?token=([A-Za-z0-9_-]+)/);
      if (m) {
        clearInterval(timer);
        resolve(m[1]);
      }
    }, 100);
    setTimeout(() => {
      clearInterval(timer);
      reject(new Error('收件箱中未出现确认链接'));
    }, 5000);
  });
}

function extractDeviceId(html, deviceName) {
  const idx = html.indexOf(deviceName);
  assert.ok(idx > -1, `安全页应显示设备名称「${deviceName}」`);
  const m = html.slice(idx).match(/\/devices\/([A-Za-z0-9_-]+)\/revoke/);
  assert.ok(m, '安全页应包含该设备的取消信任入口');
  return m[1];
}

async function waitReady() {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE + '/login');
      if (res.ok) return;
    } catch (_) {
      /* 服务尚未启动 */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('服务启动超时');
}

async function main() {
  await waitReady();
  const A = new CookieJar('甲浏览器');
  const B = new CookieJar('乙浏览器');

  console.log('\n① 未登录基线');
  await check('匿名访问值班数据接口返回 403', async () => {
    const r = await request(A, 'GET', '/api/roster');
    assert.equal(r.status, 403);
  });
  await check('匿名访问值班表页面被重定向到登录页', async () => {
    const r = await request(A, 'GET', '/');
    assert.equal(r.status, 302);
    assert.equal(r.location, '/login');
  });

  console.log('\n② 密码错误不能登录');
  await check('错误密码返回 401 且不发放任何 cookie', async () => {
    const r = await login(A, { password: 'wrong-pass' });
    assert.equal(r.status, 401);
    assert.ok(!A.has('dl_pending') && !A.has('dl_session'));
  });

  console.log('\n③ 甲浏览器：正确密码 + 记住设备，进入等待并完成确认');
  await check('甲登录后只拿到 pending cookie，停在等待页', async () => {
    const r = await login(A, { remember: true, deviceName: '甲的笔记本' });
    assert.equal(r.status, 302);
    assert.equal(r.location, '/waiting');
    assert.ok(A.has('dl_pending'));
    assert.ok(!A.has('dl_session'));
  });
  const tokenA = await latestConfirmToken();
  await check('等待中的甲访问值班数据被 403 拦截（沙箱生效）', async () => {
    const r = await request(A, 'GET', '/api/roster');
    assert.equal(r.status, 403);
    const page = await request(A, 'GET', '/security');
    assert.equal(page.status, 403);
  });
  await check('等待页与状态轮询可访问，状态为 pending', async () => {
    const page = await request(A, 'GET', '/waiting');
    assert.equal(page.status, 200);
    const status = await request(A, 'GET', '/wait/status');
    assert.equal(status.status, 200);
    assert.equal(JSON.parse(status.text).status, 'pending');
  });
  await check('甲在自己的浏览器打开确认链接 → 正式会话 + 设备 cookie', async () => {
    const r = await request(A, 'GET', `/confirm?token=${tokenA}`);
    assert.equal(r.status, 302);
    assert.equal(r.location, '/');
    assert.ok(A.has('dl_session'));
    assert.ok(A.has('dl_device'));
    assert.ok(!A.has('dl_pending'), '确认后 pending cookie 应被清除');
  });
  await check('甲可查询值班数据', async () => {
    const r = await request(A, 'GET', '/api/roster');
    assert.equal(r.status, 200);
    const data = JSON.parse(r.text);
    assert.equal(data.user, USERNAME);
    assert.ok(Array.isArray(data.roster) && data.roster.length > 0);
  });
  await check('确认链接一次性：再次使用返回 403', async () => {
    const r = await request(A, 'GET', `/confirm?token=${tokenA}`);
    assert.equal(r.status, 403);
  });

  console.log('\n④ 乙浏览器：正确密码但只停在等待页');
  await check('乙登录后进入等待，无正式会话', async () => {
    const r = await login(B, { remember: true, deviceName: '乙的工位机' });
    assert.equal(r.status, 302);
    assert.equal(r.location, '/waiting');
    assert.ok(B.has('dl_pending') && !B.has('dl_session'));
  });
  const tokenB = await latestConfirmToken();
  await check('乙同样无法访问值班数据', async () => {
    const r = await request(B, 'GET', '/api/roster');
    assert.equal(r.status, 403);
  });

  console.log('\n⑤ 把乙的确认链接复制到甲打开，不应让乙通过');
  await check('甲（无乙的 pending cookie）打开乙的链接 → 403 且无新会话变化', async () => {
    const before = A.get('dl_session');
    const r = await request(A, 'GET', `/confirm?token=${tokenB}`);
    assert.equal(r.status, 403);
    assert.match(r.text, /不属于当前浏览器/);
    assert.equal(A.get('dl_session'), before, '甲的会话不应被替换');
  });
  await check('乙仍处于等待状态，链接未被消耗', async () => {
    const status = await request(B, 'GET', '/wait/status');
    assert.equal(JSON.parse(status.text).status, 'pending');
  });
  await check('乙回到自己浏览器正常确认 → 成功', async () => {
    const r = await request(B, 'GET', `/confirm?token=${tokenB}`);
    assert.equal(r.status, 302);
    assert.equal(r.location, '/');
    assert.ok(B.has('dl_session') && B.has('dl_device'));
    const roster = await request(B, 'GET', '/api/roster');
    assert.equal(roster.status, 200);
  });

  console.log('\n⑥ 安全页：只显示自定义名称与活动时间，不泄露设备令牌');
  let deviceB;
  await check('安全页列出甲、乙两台设备，且不出现设备 cookie 原值', async () => {
    const r = await follow(A, '/security');
    assert.equal(r.status, 200);
    assert.ok(r.text.includes('甲的笔记本'));
    assert.ok(r.text.includes('乙的工位机'));
    assert.ok(r.text.includes('最近活动时间'));
    assert.ok(!r.text.includes(A.get('dl_device')), '页面不得包含设备令牌明文');
    assert.ok(!r.text.includes(B.get('dl_device')));
    deviceB = extractDeviceId(r.text, '乙的工位机');
  });

  console.log('\n⑦ 取消信任乙：只影响乙，甲不受影响');
  await check('取消乙的信任后甲仍是可信设备（记录仍在）', async () => {
    const r = await request(A, 'POST', `/devices/${deviceB}/revoke`);
    assert.equal(r.status, 302);
    const page = await follow(A, '/security');
    assert.ok(!page.text.includes('乙的工位机'));
    assert.ok(page.text.includes('甲的笔记本'));
  });
  await check('乙当前正式会话仍可访问数据（撤销不踢下线）', async () => {
    const r = await request(B, 'GET', '/api/roster');
    assert.equal(r.status, 200);
  });
  await check('乙退出登录', async () => {
    const r = await request(B, 'POST', '/logout');
    assert.equal(r.status, 302);
    assert.ok(!B.has('dl_session'));
  });
  await check('乙再次登录需重新走设备确认（设备 cookie 已不被信任）', async () => {
    const r = await login(B, { remember: true, deviceName: '乙的工位机' });
    assert.equal(r.status, 302);
    assert.equal(r.location, '/waiting');
    assert.ok(B.has('dl_pending') && !B.has('dl_session'));
  });

  console.log('\n⑧ 已记住设备走普通流程（免确认）');
  await check('甲退出后重新登录直接进入值班表，无需确认', async () => {
    await request(A, 'POST', '/logout');
    const r = await login(A, { remember: true, deviceName: '甲的笔记本' });
    assert.equal(r.status, 302);
    assert.equal(r.location, '/');
    assert.ok(A.has('dl_session'));
    assert.ok(!A.has('dl_pending'), '可信设备不应产生等待态');
    const home = await follow(A, '/');
    assert.equal(home.status, 200);
    assert.ok(home.text.includes('本周值班表'));
  });

  console.log('\n⑨ 篡改/陌生确认链接被拒');
  await check('伪造 token 返回 403', async () => {
    const r = await request(B, 'GET', '/confirm?token=not-a-real-token');
    assert.equal(r.status, 403);
  });

  console.log(`\n全部通过：${passed} 项检查 ✅`);
}

main()
  .catch((err) => {
    console.error('\n❌ 验收失败：', err.message);
    process.exitCode = 1;
  })
  .finally(() => {
    server.kill();
    rmSync(DATA_DIR, { recursive: true, force: true });
  });
