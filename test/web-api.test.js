import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/web/server.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function listen(server) {
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res(server.address().port)));
}

async function withServer(fn) {
  const server = createApp();
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  try {
    await fn(base);
  } finally {
    server.close();
  }
}

const examples = (name) => readFileSync(resolve('examples', name), 'utf8');

test('GET /health 返回 ok', async () => {
  await withServer(async (base) => {
    const resp = await fetch(`${base}/health`);
    assert.equal(resp.status, 200);
    assert.equal((await resp.json()).ok, true);
  });
});

test('GET /api/samples 列出示例且文件名受白名单约束', async () => {
  await withServer(async (base) => {
    const resp = await fetch(`${base}/api/samples`);
    const data = await resp.json();
    assert.equal(data.ok, true);
    assert.ok(data.samples.some((s) => s.name === 'lockfile-v2.json'));
  });
});

test('GET /api/samples/:name 返回示例内容', async () => {
  await withServer(async (base) => {
    const resp = await fetch(`${base}/api/samples/lockfile-v2.json`);
    const data = await resp.json();
    assert.equal(data.ok, true);
    assert.match(data.content, /lockfileVersion/);
  });
});

test('示例名含非法字符被拒', async () => {
  await withServer(async (base) => {
    const resp = await fetch(`${base}/api/samples/..%2f..%2fpackage.json`);
    assert.equal(resp.status, 422);
    assert.equal((await resp.json()).ok, false);
  });
});

test('POST /api/analyze 成功返回报告', async () => {
  await withServer(async (base) => {
    const resp = await fetch(`${base}/api/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        lockfile: { fileName: 'lockfile-v2.json', content: examples('lockfile-v2.json') },
        rules: { content: examples('rules.example.json') },
        baseline: { fileName: 'baseline-v2.json', content: examples('baseline-v2.json') },
      }),
    });
    const data = await resp.json();
    assert.equal(resp.status, 200);
    assert.equal(data.ok, true);
    assert.ok(data.report.diff);
    assert.ok(data.report.findings.length > 0);
  });
});

test('POST /api/analyze 坏 JSON 返回 400 带行列', async () => {
  await withServer(async (base) => {
    const resp = await fetch(`${base}/api/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lockfile: { fileName: 'x.json', content: '{ broken' } }),
    });
    const data = await resp.json();
    assert.equal(resp.status, 400);
    assert.equal(data.ok, false);
    assert.equal(data.error.code, 'JSON_PARSE_ERROR');
    assert.ok(data.error.line >= 1);
  });
});

test('POST /api/analyze 不支持结构返回 422', async () => {
  await withServer(async (base) => {
    const resp = await fetch(`${base}/api/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lockfile: { fileName: 'x.json', content: '{"foo":1}' } }),
    });
    const data = await resp.json();
    assert.equal(resp.status, 422);
    assert.equal(data.error.code, 'UNSUPPORTED_STRUCTURE');
  });
});

test('POST /api/analyze 超大请求体被拒绝（413 或连接重置）', async () => {
  await withServer(async (base) => {
    const huge = 'x'.repeat(11 * 1024 * 1024);
    let resp;
    try {
      resp = await fetch(`${base}/api/analyze`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lockfile: { fileName: 'big.json', content: huge } }),
      });
    } catch (err) {
      // 服务器在读取超限后立即销毁连接，客户端可能表现为连接重置/EPIPE——这本身就是拒绝
      assert.ok(['EPIPE', 'ECONNRESET', 'ECONNABORTED'].includes(err.cause?.code));
      return;
    }
    const data = await resp.json();
    assert.equal(resp.status, 413);
    assert.equal(data.error.code, 'REQUEST_TOO_LARGE');
  });
});

test('静态资源路径穿越返回 404/403 而非文件内容', async () => {
  await withServer(async (base) => {
    const resp = await fetch(`${base}/../package.json`);
    assert.ok([403, 404].includes(resp.status));
  });
});

test('未知 API 路由返回 404 JSON', async () => {
  await withServer(async (base) => {
    const resp = await fetch(`${base}/api/nope`);
    assert.equal(resp.status, 404);
    assert.equal((await resp.json()).ok, false);
  });
});
