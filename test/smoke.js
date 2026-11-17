'use strict';

// 端到端冒烟测试：独立测试库 + 临时端口启动真实 HTTP 服务，
// 既验接口响应，也直接查 SQLite 验证落库/不落库与审计掩码。
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const PORT = 3199;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gsb2-test-'));
const DB_FILE = path.join(TMP_DIR, 'test.db');

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function client() {
  const cookies = new Map();
  return {
    async request(method, reqPath, body) {
      const headers = {};
      if (cookies.size) headers.Cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const res = await fetch(BASE + reqPath, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const setCookie = res.headers.getSetCookie
        ? res.headers.getSetCookie()
        : [res.headers.get('set-cookie')].filter(Boolean);
      for (const cookie of setCookie) {
        const [pair] = cookie.split(';');
        const idx = pair.indexOf('=');
        if (idx > 0) cookies.set(pair.slice(0, idx), pair.slice(idx + 1));
      }
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    },
  };
}

async function waitForServer(proc) {
  for (let i = 0; i < 50; i += 1) {
    try {
      await fetch(BASE + '/login.html');
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  proc.kill();
  throw new Error('测试服务启动超时');
}

async function main() {
  const proc = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), APP_DB_PATH: DB_FILE },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await waitForServer(proc);

  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(DB_FILE);
    const snapshot = (id) => db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
    const auditRows = () => db.prepare('SELECT * FROM audit_logs ORDER BY id').all();

    const guest = client();
    const custJia = client();
    const custYi = client();
    const mgrJia = client();
    const mgrYi = client();

    console.log('\n[1] 登录鉴权');
    const bad = await guest.request('POST', '/api/auth/login', { username: 'cust_jia', password: 'wrong' });
    check('错误密码被拒', bad.status === 401);
    const noAuth = await guest.request('GET', '/api/customer/me');
    check('未登录访问被拒', noAuth.status === 401);

    const loginJia = await custJia.request('POST', '/api/auth/login', { username: 'cust_jia', password: 'demo1234' });
    check('甲店客户登录成功', loginJia.status === 200 && loginJia.body.user.role === 'customer');
    await custYi.request('POST', '/api/auth/login', { username: 'cust_yi', password: 'demo1234' });
    await mgrJia.request('POST', '/api/auth/login', { username: 'mgr_jia', password: 'demo1234' });
    await mgrYi.request('POST', '/api/auth/login', { username: 'mgr_yi', password: 'demo1234' });

    const me = await custJia.request('GET', '/api/customer/me');
    check('客户读到本人详情', me.status === 200 && me.body.customer.id === 1);

    const adminByCustomer = await custJia.request('GET', '/api/admin/customers');
    check('客户不能进主管接口', adminByCustomer.status === 403);

    console.log('\n[2] 普通用户：正常修改签收备注成功');
    const before = snapshot(1);
    const ok = await custJia.request('PUT', '/api/customer/me', {
      deliveryNote: '请工作日下午派送',
    });
    const after = snapshot(1);
    check('接口返回成功', ok.status === 200 && ok.body.changed === true);
    check('签收备注已落库', after.delivery_note === '请工作日下午派送');
    check('其他字段未被动过', after.display_name === before.display_name && after.address === before.address);

    console.log('\n[3] 普通用户：夹带受保护字段，整次拒绝，两项均不落库');
    const before2 = snapshot(1);
    const denied = await custJia.request('PUT', '/api/customer/me', {
      deliveryNote: '尝试夹带的备注',
      creditLevel: 'A',
    });
    const after2 = snapshot(1);
    check('返回 403 且点名字段', denied.status === 403 &&
      Array.isArray(denied.body.error.rejectedFields) &&
      denied.body.error.rejectedFields.includes('creditLevel'));
    check('签收备注未落库', after2.delivery_note === before2.delivery_note &&
      after2.delivery_note !== '尝试夹带的备注');
    check('信用等级未落库', after2.credit_level === before2.credit_level && after2.credit_level !== 'A');

    console.log('\n[4] 普通用户：受保护字段单独提交同样拒绝');
    const before3 = snapshot(1);
    const protectOnly = await custJia.request('PUT', '/api/customer/me', { disabled: true });
    check('停用字段被拒', protectOnly.status === 403 &&
      protectOnly.body.error.rejectedFields.includes('disabled'));
    check('停用状态保持不变', snapshot(1).disabled === before3.disabled);

    const unknown = await custJia.request('PUT', '/api/customer/me', {
      deliveryNote: 'x',
      passwordHash: 'hacked',
    });
    check('非白名单字段整包拒绝', unknown.status === 403 &&
      unknown.body.error.rejectedFields.includes('passwordHash'));
    check('同包合法字段也未落库', snapshot(1).delivery_note === '请工作日下午派送');

    console.log('\n[5] 主管：门店归属校验，两角色同源详情');
    const mgrViewJia = await mgrJia.request('GET', '/api/admin/customers/1');
    const custView = await custJia.request('GET', '/api/customer/me');
    check('主管与客户看到同一份详情记录',
      mgrViewJia.body.customer.address === custView.body.customer.address &&
      mgrViewJia.body.customer.creditLevel === custView.body.customer.creditLevel);

    const mgrOk = await mgrJia.request('PUT', '/api/admin/customers/1', { creditLevel: 'A' });
    check('甲店主管调整甲店客户信用等级成功', mgrOk.status === 200 && snapshot(1).credit_level === 'A');

    const crossBefore = snapshot(2);
    const cross = await mgrJia.request('PUT', '/api/admin/customers/2', { creditLevel: 'C' });
    check('甲店主管改乙店客户被拒', cross.status === 403 && cross.body.error.code === 'STORE_MISMATCH');
    check('乙店客户资料保持不变', snapshot(2).credit_level === crossBefore.credit_level);

    const crossView = await mgrJia.request('GET', '/api/admin/customers/2');
    check('跨店详情仍可打开（只读）', crossView.status === 200 && crossView.body.customer.id === 2);

    const yiMgrOk = await mgrYi.request('PUT', '/api/admin/customers/2', { disabled: true });
    check('乙店主管可停用乙店客户', yiMgrOk.status === 200 && snapshot(2).disabled === 1);

    const customerTouchOther = await custJia.request('PUT', '/api/admin/customers/2', { creditLevel: 'B' });
    check('客户身份调主管接口被拒', customerTouchOther.status === 403);

    console.log('\n[6] 校验失败不产生部分写入');
    const before4 = snapshot(1);
    const invalid = await mgrJia.request('PUT', '/api/admin/customers/1', {
      displayName: '新名称',
      creditLevel: 'Z',
    });
    check('非法枚举被拒', invalid.status === 400 && invalid.body.error.field === 'creditLevel');
    check('同包显示名未落库', snapshot(1).display_name === before4.display_name);

    console.log('\n[7] 审计：记录字段改动，不记录地址原文');
    const addrBefore = snapshot(1).address;
    const addrUpdate = await custJia.request('PUT', '/api/customer/me', {
      address: '新地址：机密小区 8 栋 808',
    });
    check('地址更新本身成功', addrUpdate.status === 200 && snapshot(1).address.includes('机密小区'));
    const logs = auditRows();
    const addrLogs = logs.filter((l) => l.field === 'address');
    check('地址改动有审计行', addrLogs.length > 0);
    const leaked = addrLogs.some((l) =>
      (l.old_value && l.old_value.includes('机密小区')) ||
      (l.new_value && l.new_value.includes('机密小区')) ||
      (l.old_value === addrBefore));
    check('审计表不含任何地址原文', !leaked);
    check('地址审计值已掩码', addrLogs.every((l) =>
      l.old_value === '[地址已隐藏]' && l.new_value === '[地址已隐藏]'));

    const deniedLogs = logs.filter((l) => l.result === 'denied');
    check('拒绝尝试也留审计', deniedLogs.some((l) => l.detail && l.detail.includes('creditLevel')));
    check('跨店拒绝留审计', deniedLogs.some((l) => l.detail && l.detail.includes('门店归属不匹配')));
    check('拒绝行不记录提交值', deniedLogs.every((l) => l.old_value === null && l.new_value === null));

    const noteLogs = logs.filter((l) => l.field === 'deliveryNote' && l.result === 'success');
    check('普通字段改动记录新旧值', noteLogs.some((l) => l.new_value === '请工作日下午派送'));

    console.log('\n[8] 静态页可访问');
    const page = await fetch(BASE + '/login.html');
    check('登录页返回 200', page.status === 200);
    const traversal = await fetch(BASE + '/..%2f..%2f..%2fetc%2fpasswd');
    check('目录穿越被拦截', traversal.status === 403 || traversal.status === 404);

    db.close();
  } finally {
    proc.kill();
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  }

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
