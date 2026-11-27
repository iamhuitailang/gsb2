import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { server } from '../src/server.js';

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function get(path) {
  const port = server.address().port;
  return fetch(`http://127.0.0.1:${port}${path}`);
}

test('首页可访问并带安全响应头', async () => {
  const res = await get('/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
});

test('静态资源与 ES 模块路径可访问', async () => {
  const paths = ['/styles.css', '/app.js', '/sanitizer/sanitizer.js', '/ui/labels.js'];
  for (const path of paths) {
    const res = await get(path);
    assert.equal(res.status, 200, path);
  }
});

test('样例清单 API 返回本地样例', async () => {
  const res = await get('/api/samples');
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data));
  assert.ok(data.length >= 5);
  assert.ok(data.every((s) => /\.html$/.test(s.file)));
});

test('样例文件 API 可读取内容', async () => {
  const list = await (await get('/api/samples')).json();
  const res = await get(`/api/samples/${list[0].file}`);
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(text.includes('<'));
});

test('路径穿越尝试被拒', async () => {
  const attempts = [
    '/api/samples/..%2f..%2fpackage.json',
    '/api/samples/%2e%2e%2fserver.js',
    '/..%2f..%2fetc%2fpasswd',
    '/sanitizer/../../package.json'
  ];
  for (const path of attempts) {
    const res = await get(path);
    assert.ok([400, 403, 404].includes(res.status), `${path} 应被拒,实际 ${res.status}`);
  }
});

test('不存在的资源返回 404', async () => {
  const res = await get('/no-such-file.txt');
  assert.equal(res.status, 404);
});

test('非 GET 方法返回 405', async () => {
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST' });
  assert.equal(res.status, 405);
});
