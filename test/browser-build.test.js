'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');

test('浏览器演示数据与 demo/sample-logs.jsonl 严格同步', () => {
  const demoText = fs.readFileSync(path.join(root, 'demo', 'sample-logs.jsonl'), 'utf8');
  const generated = fs.readFileSync(path.join(root, 'src', 'web', 'demo-data.js'), 'utf8');
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(generated, sandbox);
  assert.equal(sandbox.window.SANLOG_DEMO_TEXT, demoText);
});

test('核心模块在浏览器式全局环境（无 module 对象）下可加载并协作', () => {
  const sandbox = { self: {}, console };
  vm.createContext(sandbox);
  const files = ['rules.js', 'importer.js', 'scanner.js', 'redactor.js', 'audit.js', 'pipeline.js'];
  for (const f of files) {
    vm.runInContext(fs.readFileSync(path.join(root, 'src', 'core', f), 'utf8'), sandbox);
  }
  const R = sandbox.self.SanLog;
  assert.ok(R && typeof R.runPipeline === 'function');
  const out = R.runPipeline('{"phone":"13812345678","order_id":"ORD-1"}\n{bad}\n', {
    createdAt: '2026-11-20T00:00:00.000Z',
  });
  assert.equal(out.importResult.records.length, 1);
  assert.equal(out.importResult.failures.length, 1);
  assert.ok(out.maskedJsonl.includes('[REDACTED:PHONE:'));
  assert.ok(!out.maskedJsonl.includes('13812345678'));
  assert.ok(!out.reportJson.includes('13812345678'));
  // 失败行不静默丢弃
  assert.ok(out.maskedJsonl.includes('__sanlog_unprocessable__'));
});

test('核心与页面代码中不存在任何网络调用 API', () => {
  const coreDir = path.join(root, 'src', 'core');
  const files = [
    ...fs.readdirSync(coreDir).map((f) => path.join(coreDir, f)),
    path.join(root, 'src', 'web', 'app.js'),
  ];
  for (const file of files) {
    const code = fs.readFileSync(file, 'utf8');
    for (const banned of ['fetch(', 'XMLHttpRequest', 'WebSocket', 'http://', 'https://']) {
      assert.ok(!code.includes(banned), `${path.basename(file)} 含禁用网络 API: ${banned}`);
    }
  }
});
