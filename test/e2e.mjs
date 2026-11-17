// 端到端测试：两个 cookie jar 模拟甲、乙两个浏览器，覆盖题目全部验收场景。
// 运行：node test/e2e.mjs
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const dir = await mkdtemp(join(tmpdir(), 'duty-console-'));
const dataFile = join(dir, 'data.json');
const srv = spawn(process.execPath, ['server.js'], {
  cwd: new URL('..', import.meta.url).pathname,
  env: { ...process.env, PORT: '0', DATA_FILE: dataFile },
  stdio: ['ignore', 'pipe', 'inherit'],
});

let base;
await new Promise((resolvePromise, reject) => {
  const timer = setTimeout(() => reject(new Error('服务器启动超时')), 5000);
  srv.stdout.on('data', (chunk) => {
    const m = /http:\/\/localhost:(\d+)/.exec(String(chunk));
    if (m) {
      clearTimeout(timer);
      base = `http://localhost:${m[1]}`;
      resolvePromise();
    }
  });
  srv.on('exit', (code) => reject(new Error(`服务器提前退出，code=${code}`)));
});

class CookieJar {
  constructor(name) {
    this.name = name;
    this.cookies = new Map();
  }
  applySetCookie(headers) {
    // getSetCookie 保留同名多条 Set-Cookie（Node 内置 fetch 基于 undici）
    for (const line of headers.getSetCookie()) {
      const pair = line.split(';')[0];
      const i = pair.indexOf('=');
      const key = pair.slice(0, i).trim();
      const val = pair.slice(i + 1).trim();
      if (val === '') this.cookies.delete(key);
      else this.cookies.set(key, decodeURIComponent(val));
    }
  }
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
  }
  async req(method, path, { form, headers = {}, redirect = 'manual' } = {}) {
    const opts = { method, headers: { ...headers, Cookie: this.header() }, redirect };
    if (form) {
      opts.body = new URLSearchParams(form).toString();
      opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    const r = await fetch(base + path, opts);
    this.applySetCookie(r.headers);
    return r;
  }
  get(path, opts) { return this.req('GET', path, opts); }
  post(path, form, opts = {}) { return this.req('POST', path, { ...opts, form }); }
  has(key) { return this.cookies.has(key); }
}

const A = new CookieJar('甲');
const B = new CookieJar('乙');
let passed = 0;
function step(n, title) { console.log(`  ${n}. ${title}`); }
function ok() { passed += 1; }

async function inboxLink(jar) {
  const r = await jar.get('/api/inbox');
  const data = await r.json();
  assert.ok(data.messages.length > 0, '收件箱里应有确认邮件');
  return data.messages[0].link; // 最新一封
}
async function loginStatus(jar) {
  const r = await jar.get('/api/login-status');
  return r.json();
}

try {
  console.log('— 前置：错误密码不能进入流程');
  step(0, '错误密码返回 401，且不发放任何会话 cookie');
  let r = await A.post('/login', { username: 'admin', password: 'wrong' });
  assert.equal(r.status, 401);
  assert.ok(!A.has('psid') && !A.has('sid'));
  ok();

  console.log('— 场景一：甲（浏览器A）先登录、确认、记住设备');
  step(1, '甲输入正确密码并勾选记住设备 → 302 到等待页，只拿到 psid 没有 sid');
  r = await A.post('/login', { username: 'admin', password: 'duty123', remember: '1', deviceName: '甲浏览器' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/login/waiting');
  assert.ok(A.has('psid') && !A.has('sid'));
  ok();

  step(2, '等待中的甲访问值班数据接口 → 403（页面路由也被挡回等待页）');
  r = await A.get('/api/duty');
  assert.equal(r.status, 403);
  r = await A.get('/duty');
  assert.equal(r.status, 403);
  r = await A.get('/security');
  assert.equal(r.status, 403);
  ok();

  const linkA = await inboxLink(A);

  step(3, '甲在自己的浏览器打开确认链接 → 确认后生成正式 sid，跳首页');
  r = await A.get(linkA);
  assert.equal(r.status, 200);
  r = await A.post(linkA);
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/');
  assert.ok(A.has('sid') && !A.has('psid'));
  r = await A.get('/api/duty');
  assert.equal(r.status, 200);
  ok();

  step(4, '安全页只显示自定义名称与活动时间，不泄露内部设备标识');
  r = await A.get('/security');
  const secHtml = await r.text();
  assert.match(secHtml, /甲浏览器/);
  // 去掉表单隐藏域后，可见区域（含内联脚本/文案）不应出现设备内部 id
  const visible = secHtml.replace(/<input[^>]*type="hidden"[^>]*>/g, '');
  assert.ok(!/[umpl]{1,2}_\d+/.test(visible), '页面可见区域不应出现内部记录 id');
  ok();

  console.log('— 场景二：乙（浏览器B）正确密码后停在等待页');
  step(5, '乙登录（不勾选记住）→ 302 等待页，无 sid，查询值班数据 403');
  r = await B.post('/login', { username: 'admin', password: 'duty123', deviceName: '乙浏览器' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/login/waiting');
  assert.ok(B.has('psid') && !B.has('sid'));
  r = await B.get('/api/duty');
  assert.equal(r.status, 403);
  assert.equal((await loginStatus(B)).mode, 'pending');
  ok();

  const linkB = await inboxLink(B);

  console.log('— 场景三：乙的确认链接复制到甲打开，不能让乙通过');
  step(6, '甲（已是正式会话）打开乙的链接 → 400，链接不被消费');
  r = await A.get(linkB);
  assert.equal(r.status, 400);
  assert.match(await r.text(), /另一次登录或另一台浏览器/);
  ok();

  step(7, '甲直接 POST 乙的链接同样被拒；乙仍然停在 pending');
  r = await A.post(linkB);
  assert.equal(r.status, 400);
  assert.equal((await loginStatus(B)).mode, 'pending');
  assert.ok(!B.has('sid'));
  ok();

  step(8, '乙回到自己浏览器正常确认 → 通过并生成正式会话');
  r = await B.get(linkB);
  assert.equal(r.status, 200);
  r = await B.post(linkB);
  assert.equal(r.status, 303);
  assert.ok(B.has('sid'));
  assert.equal((await loginStatus(B)).mode, 'session');
  r = await B.get('/api/duty');
  assert.equal(r.status, 200);
  ok();

  step(9, '乙的链接是一次性的：再次使用 → 失效错误');
  r = await B.get(linkB);
  assert.equal(r.status, 400);
  assert.match(await r.text(), /已失效|已被使用/);
  ok();

  console.log('— 场景四：未记住的设备，退出再登录要重新确认');
  step(10, '乙未勾选记住 → 安全页状态为“未记住”；退出后再登录仍走等待流程');
  r = await B.get('/security');
  assert.match(await r.text(), /未记住/);
  r = await B.post('/logout');
  assert.equal(r.status, 302);
  assert.ok(!B.has('sid') && !B.has('psid'));
  r = await B.post('/login', { username: 'admin', password: 'duty123' });
  assert.equal(r.headers.get('location'), '/login/waiting');
  assert.ok(B.has('psid') && !B.has('sid'));
  ok();

  console.log('— 场景五：取消信任只影响目标设备，甲不受影响');
  const linkB2 = await inboxLink(B);
  r = await B.post(linkB2);
  assert.equal(r.status, 303); // 先确认进来

  // 乙勾选记住再确认一次，使乙成为已信任设备，然后由甲在安全页取消对乙的信任
  await B.post('/logout');
  r = await B.post('/login', { username: 'admin', password: 'duty123', remember: '1' });
  const linkB3 = await inboxLink(B);
  await B.post(linkB3);
  r = await B.get('/security');
  assert.match(await r.text(), /已记住/);

  step(11, '从安全页取消对乙设备的信任 → 乙当前会话仍在，但下次登录需重新确认');
  r = await A.get('/security');
  const secPage = await r.text();
  // 从隐藏域取设备 id（页面可见区域只展示名称/时间，不展示 id）
  const allDeviceIds = [...secPage.matchAll(/name="deviceId" value="([^"]+)"/g)].map((m) => m[1]);
  const deviceId = allDeviceIds.find((id) => id !== A.cookies.get('did'));
  assert.ok(deviceId, '应能定位到乙的设备 id');
  r = await A.post('/security/revoke', { deviceId });
  assert.equal(r.status, 302);
  ok();

  step(12, '甲依然是被信任设备：退出再登录直接进入，不再需要确认');
  await A.post('/logout');
  r = await A.post('/login', { username: 'admin', password: 'duty123' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/');
  assert.ok(A.has('sid') && !A.has('psid'));
  ok();

  step(13, '乙退出再登录 → 回到等待页，必须重新确认（取消信任不影响其他浏览器已验证）');
  await B.post('/logout');
  r = await B.post('/login', { username: 'admin', password: 'duty123' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/login/waiting');
  assert.ok(B.has('psid') && !B.has('sid'));
  r = await B.get('/api/duty');
  assert.equal(r.status, 403);
  ok();

  console.log('— 场景六：同一浏览器重复登录，旧确认链接被新登录取代而失效');
  const staleLink = await inboxLink(B);
  await B.post('/logout');
  r = await B.post('/login', { username: 'admin', password: 'duty123' });
  assert.equal(r.status, 302);
  step(14, '旧链接对新的等待登录无效（链接只对应发起它的那次登录）');
  r = await B.get(staleLink);
  assert.equal(r.status, 400);
  assert.match(await r.text(), /另一次登录|已失效/);
  const freshLink = await inboxLink(B);
  r = await B.post(freshLink);
  assert.equal(r.status, 303);
  ok();

  console.log(`\n全部 ${passed} 项断言通过 ✅`);
} catch (err) {
  console.error('\n测试失败 ❌', err);
  process.exitCode = 1;
} finally {
  srv.kill('SIGTERM');
  await new Promise((res) => setTimeout(res, 300));
  await rm(dir, { recursive: true, force: true });
}
