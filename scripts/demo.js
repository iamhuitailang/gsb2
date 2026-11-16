#!/usr/bin/env node
/**
 * 端到端演示 / 自检脚本。
 *
 * 按需求跑完整条链路：
 *   1. 管理员登录、为「甲」合同签发仅查看链接
 *   2. 两个浏览器打开确认页（含预览、刷新），确认不消耗领取机会
 *   3. 两个浏览器同时点击领取 —— 只能有一个成功
 *   4. 领取者只能看甲、不能下载、不能借会话打开乙
 *   5. 管理员撤销链接后，已领取页面刷新即失效
 *   6. 合同下架同样让已领取会话失效
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN_TOKEN = 'demo-admin-token';
const PORT = 4600 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
function check(name, ok, detail = '') {
  const mark = ok ? 'PASS' : 'FAIL';
  if (!ok) failures += 1;
  console.log(`  [${mark}] ${name}${detail ? ` — ${detail}` : ''}`);
}

/* ------------------------------ cookie jar ------------------------------ */

function newBrowser(label) {
  return { label, cookies: new Map() };
}

function cookieHeader(browser) {
  return [...browser.cookies]
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

function absorb(browser, res) {
  const list =
    typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : (res.headers.get('set-cookie') ?? '')
          .split(/,\s*(?=[A-Za-z0-9_-]+=)/)
          .filter(Boolean);
  for (const raw of list) {
    const [pair, ...attrs] = raw.split(';');
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    const name = pair.slice(0, idx).trim();
    const value = decodeURIComponent(pair.slice(idx + 1).trim());
    const expired = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a));
    if (expired) browser.cookies.delete(name);
    else browser.cookies.set(name, value);
  }
}

async function request(browser, method, url, form) {
  const headers = {};
  const cookie = cookieHeader(browser);
  if (cookie) headers.cookie = cookie;
  let body;
  if (form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(form).toString();
  }
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers,
    body,
    redirect: 'manual',
  });
  absorb(browser, res);
  const text = await res.text();
  return { status: res.status, text, location: res.headers.get('location'), res };
}

/* ------------------------------ 启动服务 ------------------------------ */

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'contract-demo-'));
const child = spawn(process.execPath, [path.join(ROOT, 'src/server.js')], {
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    DATA_DIR: dataDir,
    ADMIN_TOKEN,
    SESSION_TTL_MS: String(15 * 60 * 1000),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stderr.on('data', (d) => process.stderr.write(d));

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) return;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('服务启动超时');
}

const findLinkId = (html, contractId) => {
  const re = new RegExp(
    `<tr data-link-id="([A-Za-z0-9_-]+)" data-contract-id="${contractId}"`,
  );
  return html.match(re)?.[1] ?? null;
};

try {
  await waitForServer();
  console.log('本地合同库端到端演示\n');

  /* ---------------- 管理员：登录并签发仅查看甲的链接 ---------------- */
  console.log('1) 管理员签发「仅查看甲」链接');
  const admin = newBrowser('admin');
  const login = await request(admin, 'POST', '/admin/login', {
    token: ADMIN_TOKEN,
  });
  check('管理员登录成功', login.status === 303);

  const first = await request(admin, 'GET', '/admin');
  check('管理台可见两份样例合同', first.text.includes('HT-A-2026-001') && first.text.includes('HT-B-2026-002'));

  const issued = await request(admin, 'POST', '/admin/links', {
    contractId: 'contract-a',
    ttlMinutes: '30',
    // 不勾选下载 → 仅查看
  });
  check('链接签发成功并跳回管理台', issued.status === 303);
  const adminPage = await request(admin, 'GET', '/admin');
  const linkId = findLinkId(adminPage.text, 'contract-a');
  check('管理台出现该链接', Boolean(linkId));
  if (!linkId) throw new Error('未能从管理台解析出甲合同链接');
  const shareUrl = `/l/${linkId}`;

  /* ---------------- 两个浏览器打开确认页 ---------------- */
  console.log('\n2) 两个浏览器打开确认页（预览 + 刷新，不应消耗机会）');
  const browser1 = newBrowser('browser-1');
  const browser2 = newBrowser('browser-2');

  for (const b of [browser1, browser2]) {
    const preview = await request(b, 'GET', shareUrl);
    const refreshed = await request(b, 'GET', shareUrl);
    check(
      `${b.label} 确认页显示甲合同`,
      preview.status === 200 && preview.text.includes('劳动合同（甲）'),
    );
    check(
      `${b.label} 刷新确认页仍可领取`,
      refreshed.status === 200 &&
        refreshed.text.includes('领取并查看合同') &&
        !refreshed.text.includes('已被领取'),
    );
    check(`${b.label} 尚未获得访问会话`, !b.cookies.has('contract_session'));
  }

  const afterPreview = await request(admin, 'GET', '/admin');
  check('预览/刷新后链接仍是待领取状态', afterPreview.text.includes('待领取'));

  /* ---------------- 并发领取 ---------------- */
  console.log('\n3) 两个浏览器同时点击领取');
  const [claim1, claim2] = await Promise.all([
    request(browser1, 'POST', `${shareUrl}/claim`),
    request(browser2, 'POST', `${shareUrl}/claim`),
  ]);
  const results = [
    { browser: browser1, res: claim1 },
    { browser: browser2, res: claim2 },
  ];
  const winners = results.filter(
    (r) => r.res.status === 303 && r.res.location === '/view',
  );
  const losers = results.filter((r) => !winners.includes(r));
  check('恰好一个领取成功', winners.length === 1, `成功 ${winners.length} 个`);
  check('另一个领取被拒绝', losers.length === 1 && losers[0].res.status === 410);
  check(
    '失败的浏览器没有拿到会话 cookie',
    losers.length === 1 && !losers[0].browser.cookies.has('contract_session'),
  );
  check(
    '成功的浏览器拿到了会话 cookie',
    winners.length === 1 && winners[0].browser.cookies.has('contract_session'),
  );
  if (winners.length !== 1 || losers.length !== 1) {
    throw new Error('并发领取结果不符合预期，后续步骤无法继续');
  }
  const winner = winners[0].browser;
  const loser = losers[0].browser;

  /* ---------------- 领取后只可看甲 ---------------- */
  console.log('\n4) 领取者只能查看甲、不能下载、不能打开乙');
  const view = await request(winner, 'GET', '/view');
  check('领取者可打开甲合同', view.status === 200 && view.text.includes('CONTRACT_A_MARKER_2026'));
  check('页面未出现乙合同内容', !view.text.includes('CONTRACT_B_MARKER_2026'));
  check('页面提示仅查看不可下载', view.text.includes('仅查看'));

  const dlA = await request(winner, 'GET', '/view/contract-a/download');
  check('未授权下载 → 甲文件下载被拒绝', dlA.status === 403);

  const dlB = await request(winner, 'GET', '/view/contract-b/download');
  check(
    '借该会话打开乙 → 被拒绝',
    dlB.status === 403 && !dlB.text.includes('CONTRACT_B_MARKER_2026'),
  );

  const loserView = await request(loser, 'GET', '/view');
  check('未领取的浏览器访问 /view 被拒绝', loserView.status === 401);

  const loserDlB = await request(loser, 'GET', '/view/contract-b/download');
  check(
    '未领取的浏览器也无法下载乙',
    loserDlB.status === 401 && !loserDlB.text.includes('CONTRACT_B_MARKER_2026'),
  );

  /* ---------------- 撤销链接 ---------------- */
  console.log('\n5) 管理员撤销链接，已领取页面刷新失效');
  const revoke = await request(
    admin,
    'POST',
    `/admin/links/${linkId}/revoke`,
  );
  check('撤销请求成功', revoke.status === 303);

  const viewAfterRevoke = await request(winner, 'GET', '/view');
  check(
    '撤销后已领取页面刷新不可继续查看',
    viewAfterRevoke.status === 410 &&
      viewAfterRevoke.text.includes('已撤销') &&
      !viewAfterRevoke.text.includes('CONTRACT_A_MARKER_2026'),
  );
  const dlAfterRevoke = await request(winner, 'GET', '/view/contract-a/download');
  check('撤销后下载同样失效', dlAfterRevoke.status === 410);

  const claimAgain = await request(browser2, 'GET', shareUrl);
  check(
    '已撤销链接的领取入口不可用',
    claimAgain.status === 410 && claimAgain.text.includes('已撤销'),
  );

  /* ---------------- 合同下架 ---------------- */
  console.log('\n6) 合同下架让已领取的访问失效');
  const issuedB = await request(admin, 'POST', '/admin/links', {
    contractId: 'contract-b',
    ttlMinutes: '30',
    allowDownload: 'on',
  });
  check('为乙合同签发可下载链接', issuedB.status === 303);
  const bPage = await request(admin, 'GET', '/admin');
  const linkB = findLinkId(bPage.text, 'contract-b');
  check('管理台出现乙合同链接', Boolean(linkB));
  if (!linkB) throw new Error('未能从管理台解析出乙合同链接');

  const browser3 = newBrowser('browser-3');
  const previewB = await request(browser3, 'GET', `/l/${linkB}`);
  check('可下载链接的确认页标明可下载', previewB.status === 200 && previewB.text.includes('允许下载'));
  const claimB = await request(browser3, 'POST', `/l/${linkB}/claim`);
  check('领取乙链接成功', claimB.status === 303 && browser3.cookies.has('contract_session'));
  const dlBok = await request(browser3, 'GET', '/view/contract-b/download');
  check(
    '授权下载时乙文件可下载',
    dlBok.status === 200 &&
      dlBok.text.includes('CONTRACT_B_MARKER_2026') &&
      /attachment/.test(dlBok.res.headers.get('content-disposition') ?? ''),
  );

  const unpublish = await request(admin, 'POST', '/admin/contracts/contract-b/publish', {
    published: '0',
  });
  check('乙合同下架成功', unpublish.status === 303);
  const viewAfterUnpublish = await request(browser3, 'GET', '/view');
  check(
    '下架后已领取页面刷新失效',
    viewAfterUnpublish.status === 410 &&
      viewAfterUnpublish.text.includes('已下架') &&
      !viewAfterUnpublish.text.includes('CONTRACT_B_MARKER_2026'),
  );
  const dlAfterUnpublish = await request(browser3, 'GET', '/view/contract-b/download');
  check(
    '下架后下载失效',
    dlAfterUnpublish.status === 410 &&
      !dlAfterUnpublish.text.includes('CONTRACT_B_MARKER_2026'),
  );

  /* ---------------- 持久化 ---------------- */
  console.log('\n7) 状态持久化');
  const stateRaw = await fs.readFile(path.join(dataDir, 'state.json'), 'utf8');
  const state = JSON.parse(stateRaw);
  check('状态文件已落盘', Object.keys(state.links).length >= 2);
  check(
    '会话令牌只以摘要形式保存',
    Object.values(state.sessions).every((s) => /^[A-Za-z0-9_-]{43}$/.test(s.id)),
  );
} catch (err) {
  failures += 1;
  console.error('\n演示过程中出错:', err);
} finally {
  child.kill();
  await fs.rm(dataDir, { recursive: true, force: true });
}

console.log(
  failures === 0
    ? '\n全部检查通过 ✅'
    : `\n有 ${failures} 项检查失败 ❌`,
);
process.exit(failures === 0 ? 0 : 1);
