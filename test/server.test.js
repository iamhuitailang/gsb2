import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 5189;
const BASE = `http://127.0.0.1:${PORT}`;
let server;

before(async () => {
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server.mjs')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await once(server.stdout, 'data'); // 等待启动日志
});

after(() => server.kill('SIGTERM'));

async function post(api, payload) {
  const res = await fetch(`${BASE}${api}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: res.status, json: await res.json() };
}

test('静态页面与核心模块可访问且 MIME 正确', async () => {
  const page = await fetch(`${BASE}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
  const mod = await fetch(`${BASE}/src/core/index.js`);
  assert.equal(mod.status, 200);
  assert.match(mod.headers.get('content-type'), /javascript/);
});

test('路径穿越被拒绝', async () => {
  const res = await fetch(`${BASE}/../server.mjs`);
  assert.ok([403, 404].includes(res.status));
});

test('/api/parse 返回解析问题与规范化结果', async () => {
  const { status, json } = await post('/api/parse', {
    text: "script-src self 'unsafe-inline'",
  });
  assert.equal(status, 200);
  assert.ok(json.issues.some((i) => i.code === 'INVALID_SOURCE'));
  assert.ok(json.issues.some((i) => i.code === 'UNSAFE_INLINE'));
});

test('/api/evaluate 拦截未授权来源', async () => {
  const { json } = await post('/api/evaluate', {
    policyText: "script-src 'self'",
    sample: { resourceType: 'script', url: 'https://evil.test/x.js' },
  });
  assert.equal(json.decision, 'blocked');
});

test('/api/evaluate 对无法解析的地址默认拒绝', async () => {
  const { json } = await post('/api/evaluate', {
    policyText: 'script-src *',
    sample: { resourceType: 'script', url: 'http://' },
  });
  assert.equal(json.decision, 'blocked');
});

test('/api/compare 稳定报告放宽与收紧', async () => {
  const { json } = await post('/api/compare', {
    policyA: { text: "img-src 'self'" },
    policyB: { text: "img-src 'self' https://img.test" },
  });
  assert.equal(json.summary.loosened, 1);
  assert.equal(json.summary.tightened, 0);
});

test('未知接口返回 404', async () => {
  const res = await fetch(`${BASE}/api/nope`);
  assert.equal(res.status, 404);
});
