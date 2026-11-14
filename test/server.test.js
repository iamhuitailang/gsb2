import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

function startServer() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsb2-e2e-'));
  const port = 4300 + Math.floor(Math.random() * 500);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), GSB2_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('服务启动超时')), 8000);
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('已启动')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    child.on('exit', (code) => reject(new Error(`服务提前退出：${code}`)));
  });
  return { child, port, ready, dataDir };
}

async function upload(port, sampleName) {
  const buffer = fs.readFileSync(path.join(root, 'samples', sampleName));
  const form = new FormData();
  form.append('file', new Blob([buffer]), sampleName);
  const response = await fetch(`http://127.0.0.1:${port}/api/imports`, {
    method: 'POST',
    body: form,
  });
  return { status: response.status, body: await response.json() };
}

test('服务端：上传 → 识别 → 确认 → 批次快照', async (t) => {
  const server = startServer();
  t.after(() => server.child.kill());
  await server.ready;

  const { port } = server;

  // 旧版
  const oldUpload = await upload(port, '旧版清单.csv');
  assert.equal(oldUpload.status, 201);
  assert.equal(oldUpload.body.rule.version, 'old');
  assert.equal(oldUpload.body.lines.find((l) => l.code === '1001').pieces, 120);

  const oldConfirm = await fetch(
    `http://127.0.0.1:${port}/api/imports/${oldUpload.body.file.id}/confirm`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
  );
  assert.equal(oldConfirm.status, 201);
  const oldBatch = (await oldConfirm.json()).batch;
  assert.equal(oldBatch.rule.version, 'old');
  assert.ok(oldBatch.schema.mapping['整箱数量']);
  assert.ok(oldBatch.packagingSnapshot.items.length > 0);

  // 新版
  const newUpload = await upload(port, '新版清单.csv');
  assert.equal(newUpload.body.rule.version, 'new');
  const boxLine = newUpload.body.lines.find((l) => l.code === '1001' && l.unitKind === 'box');
  const pieceLine = newUpload.body.lines.find((l) => l.code === '1001' && l.unitKind === 'piece');
  assert.equal(boxLine.pieces, 120);
  assert.equal(pieceLine.pieces, 36);

  const newConfirm = await fetch(
    `http://127.0.0.1:${port}/api/imports/${newUpload.body.file.id}/confirm`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
  );
  assert.equal(newConfirm.status, 201);
  const newBatch = (await newConfirm.json()).batch;
  assert.equal(newBatch.schema.mapping['计量单位'], 'unit');

  // 未知表头：未配置映射时拒绝确认
  const unknownUpload = await upload(port, '新版清单-未知表头.csv');
  assert.equal(unknownUpload.body.schema.status, 'needs_mapping');
  assert.ok(unknownUpload.body.schema.unknownColumns.length > 0);
  const blocked = await fetch(
    `http://127.0.0.1:${port}/api/imports/${unknownUpload.body.file.id}/confirm`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
  );
  assert.equal(blocked.status, 400);

  // 通过配置映射后重新预览并确认
  const mappingResponse = await fetch(
    `http://127.0.0.1:${port}/api/imports/${unknownUpload.body.file.id}/preview`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mapping: {
          0: 'ignore',
          1: 'productCode',
          2: 'productName',
          3: 'qty',
          4: 'unit',
          5: 'ignore',
        },
      }),
    },
  );
  const mapped = await mappingResponse.json();
  assert.equal(mapped.schema.status, 'ready');
  assert.equal(mapped.rule.version, 'new');
  assert.equal(mapped.status, 'ok');

  const mappedConfirm = await fetch(
    `http://127.0.0.1:${port}/api/imports/${unknownUpload.body.file.id}/confirm`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
  );
  assert.equal(mappedConfirm.status, 201);

  // 批次列表与快照
  const batchList = await (await fetch(`http://127.0.0.1:${port}/api/batches`)).json();
  assert.equal(batchList.batches.length, 3);
  const detail = await (
    await fetch(`http://127.0.0.1:${port}/api/batches/${newBatch.id}`)
  ).json();
  assert.equal(detail.batch.totals.pieces, newBatch.totals.pieces);
});
