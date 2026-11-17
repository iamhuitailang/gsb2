// 手动冒烟测试：直接调用 createApp 的 handler，不依赖 node --test 子进程。
import http from 'node:http';
import { createApp } from '../src/app.js';

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition), detail });
  console.log(`${condition ? '✓' : '✗'} ${name}${condition ? '' : ` — ${detail}`}`);
}

const { handler } = createApp();
const server = http.createServer(handler);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

function client() {
  let cookie = '';
  return async (method, path, body) => {
    const res = await fetch(baseUrl + path, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: res.status, data, headers: res.headers };
  };
}

// --- 鉴权 ---
const anon = client();
check('未登录读取返回 401', (await anon('GET', '/api/orgs/jia/customers/C01')).status === 401);
check('未登录写入返回 401', (await anon('PUT', '/api/orgs/jia/customers/C01/note', { note: 'x' })).status === 401);

const outsider = client();
await outsider('POST', '/api/session', { userId: 'u-outsider' });
check('无权限账号读取 403', (await outsider('GET', '/api/orgs/jia/customers/C01')).status === 403);
check('无权限账号写入 403', (await outsider('PUT', '/api/orgs/jia/customers/C01/note', { note: 'x' })).status === 403);

const agent = client();
await agent('POST', '/api/session', { userId: 'u-agent' });
check('不存在的组织返回 404', (await agent('GET', '/api/orgs/nope/customers/C01')).data?.error?.code === 'ORGANIZATION_NOT_FOUND');
check('裸编号路径不可用', (await agent('GET', '/api/customers/C01')).status === 404);

// --- 撞号客户 ---
const jia = await agent('GET', '/api/orgs/jia/customers/C01');
const yi = await agent('GET', '/api/orgs/yi/customers/C01');
check('甲 C01 属于甲', jia.data?.customer?.organizationId === 'org-jia');
check('乙 C01 属于乙', yi.data?.customer?.organizationId === 'org-yi');
check('甲乙 C01 是不同的人', jia.data?.customer?.name !== yi.data?.customer?.name);

// --- 验收流程：乙先改，甲再改 ---
const jiaTab = client();
const yiTab = client();
await jiaTab('POST', '/api/session', { userId: 'u-agent' });
await yiTab('POST', '/api/session', { userId: 'u-agent' });

check('乙保存成功', (await yiTab('PUT', '/api/orgs/yi/customers/C01/note', { note: '乙侧备注：发票已开' })).status === 200);
check('甲保存成功', (await jiaTab('PUT', '/api/orgs/jia/customers/C01/note', { note: '甲侧备注：续费已确认' })).status === 200);

const jiaAfter = await jiaTab('GET', '/api/orgs/jia/customers/C01');
const yiAfter = await yiTab('GET', '/api/orgs/yi/customers/C01');
check('甲保留甲的内容', jiaAfter.data.customer.note === '甲侧备注：续费已确认', jiaAfter.data.customer.note);
check('乙保留乙的内容', yiAfter.data.customer.note === '乙侧备注：发票已开', yiAfter.data.customer.note);

// --- 刷新甲旧地址 ---
const jiaReloaded = await jiaTab('GET', '/api/orgs/jia/customers/C01');
check('刷新甲旧地址看不到乙的备注', !jiaReloaded.data.customer.note.includes('乙侧'));
check('刷新甲旧地址仍是甲的人', jiaReloaded.data.customer.organizationId === 'org-jia');

// --- 写接口不能跨组织 ---
const mismatch = await agent('PUT', '/api/orgs/yi/customers/C01/note', {
  note: '越权',
  organizationId: 'org-jia',
});
check('请求体组织与地址不一致被拒', mismatch.status === 400 && mismatch.data?.error?.code === 'ORGANIZATION_MISMATCH');
check('越权写入没有生效', (await agent('GET', '/api/orgs/yi/customers/C01')).data.customer.note === '乙侧备注：发票已开');

// --- 列表隔离 ---
const jiaList = await agent('GET', '/api/orgs/jia/customers');
const yiList = await agent('GET', '/api/orgs/yi/customers');
check('甲列表只含甲客户', jiaList.data.customers.every((c) => c.organizationId === 'org-jia'));
check('乙列表只含乙客户', yiList.data.customers.every((c) => c.organizationId === 'org-yi'));

// --- 失去权限 ---
const lost = client();
await lost('POST', '/api/session', { userId: 'u-agent' });
check('失去权限前可读', (await lost('GET', '/api/orgs/jia/customers/C01')).status === 200);
await lost('POST', '/api/session', { userId: 'u-outsider' });
check('失去权限后读被拒', (await lost('GET', '/api/orgs/jia/customers/C01')).status === 403);
check('失去权限后写被拒', (await lost('PUT', '/api/orgs/jia/customers/C01/note', { note: 'x' })).status === 403);

// --- 静态页面 ---
const shell = await fetch(`${baseUrl}/o/jia/customers/C01`);
const shellHtml = await shell.text();
check('旧地址返回客户页外壳', shell.status === 200 && shellHtml.includes('/app.js'));
const traversal = await fetch(`${baseUrl}/o/..%2f..%2fpackage.json`);
check('目录穿越读不到 package.json', !(await traversal.text()).includes('gsb2-org-bound-desk'));

await new Promise((resolve) => {
  server.closeAllConnections?.();
  server.close(resolve);
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} 通过 / ${results.length} 总计`);
if (failed.length) {
  console.error('失败项：', failed.map((f) => f.name).join('；'));
  process.exitCode = 1;
}
