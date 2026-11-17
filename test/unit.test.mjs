import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { createConfig } from '../src/config.js';
import { ReportStore } from '../src/store.js';
import { buildSampleReport } from '../src/samples.js';

test('配置：三个源彼此独立（默认用不同回环地址，同一端口）', () => {
  const config = createConfig({ basePort: 5000, dataDir: '/tmp/x' });
  const origins = Object.values(config.origins);
  assert.equal(new Set(origins).size, 3);
  assert.equal(config.origins.business, 'http://127.0.0.1:5000');
  assert.equal(config.origins.report, 'http://127.0.0.2:5000');
  assert.equal(config.origins.tracker, 'http://127.0.0.3:5000');
});

test('样例报告：表格、本地图片、第二站点图片、报告内脚本都在', async () => {
  const config = createConfig({ basePort: 5000, dataDir: '/tmp/x' });
  const sample = buildSampleReport(config);
  assert.match(sample.html, /<table>/);
  assert.match(sample.html, /src="images\/chart\.png"/);
  assert.ok(sample.html.includes(`src="${config.origins.tracker}/pixel.png`));
  assert.match(sample.html, /<script>/);

  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gsb2-sample-'));
  try {
    const store = new ReportStore(dataDir);
    await store.init();
    const meta = await store.importReport(sample);
    assert.equal(meta.summary.loaded, 2, '本地图片 + 本地样式表');
    assert.equal(meta.summary.external, 1, '指向第二站点的图片');

    const check = await store.getCheck(meta.id);
    assert.equal(check.externalResources.length, 1);
    assert.equal(check.externalResources[0].loaded, false);
    assert.ok(check.externalResources[0].url.startsWith(config.origins.tracker));

    const body = await store.readBody(meta.id);
    assert.doesNotMatch(body, /<script/i);
    assert.doesNotMatch(body, /tracker|127\.0\.0\.3/);
    assert.match(body, /第二个本地站点/);
    assert.match(body, /B-2026-1101/);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('三个站点可以一起启动与关闭', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gsb2-app-'));
  const app = createApp({ dataDir, basePort: 5300 });
  try {
    const { config } = await app.start();
    const health = await (await fetch(`${config.origins.business}/api/health`, {
      headers: { 'Sec-Fetch-Site': 'same-origin' },
    })).json();
    assert.equal(health.ok, true);
    assert.equal((await fetch(`${config.origins.report}/health`)).status, 200);
    assert.equal((await (await fetch(`${config.origins.tracker}/count`)).json()).count, 0);
  } finally {
    await app.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
