/**
 * 安全测试：魔数嗅探、路径穿越、ZIP 攻击、上传/隔离/下载全链路。
 * 运行：npm test
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';

// 每个测试套件使用独立的临时 data 目录
const testData = fs.mkdtempSync(path.join(os.tmpdir(), 'fiw-test-'));
process.env.FIW_DATA_DIR = testData;
process.env.FIW_PORT = '0';

const { sniffType, verifyImage } = await import('../server/lib/sniffer.mjs');
const { ensureInside } = await import('../server/lib/paths.mjs');
const { inspectAndExtract } = await import('../server/lib/zip-inspect.mjs');
const { config } = await import('../server/config.mjs');
const { openDb, getTask, listAudit } = await import('../server/db.mjs');
const { createServer } = await import('../server/index.mjs');

let server;
let baseUrl;

before(async () => {
  openDb();
  server = createServer();
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  fs.rmSync(testData, { recursive: true, force: true });
});

// ---------- 魔数嗅探 ----------

test('sniffType: 依据字节而非扩展名识别 PNG', () => {
  const pngSig = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(32),
  ]);
  assert.equal(sniffType(pngSig), 'png');
  // 文本文件伪装 .png
  assert.equal(sniffType(Buffer.from('not an image at all')), null);
  // 纯魔数但结构残缺的 PNG 应在深度校验中失败
  const fake = Buffer.concat([pngSig, Buffer.alloc(8)]);
  assert.equal(sniffType(fake), 'png');
  assert.equal(verifyImage('png', fake).ok, false);
});

test('sniffType: 识别 JPEG/GIF/BMP/WebP/ZIP', () => {
  assert.equal(sniffType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'jpeg');
  assert.equal(sniffType(Buffer.from('GIF89a....')), 'gif');
  assert.equal(sniffType(Buffer.from('BM.......')), 'bmp');
  const webp = Buffer.concat([
    Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(20),
  ]);
  assert.equal(sniffType(webp), 'webp');
  assert.equal(sniffType(Buffer.from([0x50, 0x4b, 0x03, 0x04])), 'zip');
});

test('真实样例图片通过结构校验', () => {
  const samplesDir = path.resolve('client/public/samples');
  const png = fs.readFileSync(path.join(samplesDir, 'sample.png'));
  assert.equal(sniffType(png), 'png');
  assert.deepEqual(
    { ok: verifyImage('png', png).ok, w: verifyImage('png', png).width, h: verifyImage('png', png).height },
    { ok: true, w: 96, h: 64 },
  );
  for (const [file, type] of [['sample.jpg', 'jpeg'], ['sample.gif', 'gif'], ['sample.bmp', 'bmp']]) {
    const buf = fs.readFileSync(path.join(samplesDir, file));
    assert.equal(sniffType(buf), type, file);
    assert.equal(verifyImage(type, buf).ok, true, file);
  }
});

// ---------- 路径安全 ----------

test('ensureInside: 拦截目录穿越', () => {
  const base = path.join(testData, 'base');
  fs.mkdirSync(base, { recursive: true });
  assert.throws(() => ensureInside(base, path.join(base, '..', 'escape.txt')), /PATH_TRAVERSAL|路径越界/);
  assert.throws(() => ensureInside(base, path.join(testData, 'sibling')), /PATH_TRAVERSAL|路径越界/);
  // 前缀相似目录不得蒙混
  assert.throws(() => ensureInside('/foo/bar', '/foo/bar-evil/x'), /PATH_TRAVERSAL|路径越界/);
  // 合法内部路径放行
  assert.equal(ensureInside(base, path.join(base, 'a', 'b.txt')), path.join(base, 'a', 'b.txt'));
});

// ---------- ZIP 安全 ----------

function makeZip(entries, { store = false } = {}) {
  // 使用系统 zip 不可控攻击条目，这里手工构造 ZIP（本地文件头 + 中央目录）
  const localParts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const data = e.data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    localParts.push(local, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, nameBuf]));
    offset += local.length + nameBuf.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, cdBuf, eocd]);
}

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

test('ZIP: 合法压缩包通过并保留条目清单', async () => {
  const zip = makeZip([
    { name: 'a.txt', data: Buffer.from('hello') },
    { name: 'dir/b.txt', data: Buffer.from('world') },
  ]);
  const zipPath = path.join(testData, `in_${randomUUID()}.zip`);
  const dest = path.join(testData, `ex_${randomUUID()}`);
  fs.writeFileSync(zipPath, zip);
  fs.mkdirSync(dest);
  const r = await inspectAndExtract(zipPath, dest);
  assert.equal(r.ok, true);
  assert.equal(r.entries, 2);
  assert.equal(r.totalBytes, 10);
  assert.ok(fs.existsSync(path.join(dest, 'a.txt')));
  assert.ok(fs.existsSync(path.join(dest, 'dir/b.txt')));
});

test('ZIP: 拒绝 ../ 目录穿越（zip-slip）', async () => {
  const zip = makeZip([{ name: '../evil.txt', data: Buffer.from('pwn') }]);
  const zipPath = path.join(testData, `slip_${randomUUID()}.zip`);
  const dest = path.join(testData, `slipdest_${randomUUID()}`);
  fs.writeFileSync(zipPath, zip);
  fs.mkdirSync(dest);
  const r = await inspectAndExtract(zipPath, dest);
  assert.equal(r.ok, false);
  assert.match(r.reason, /路径非法|目录穿越|invalid/);
  // 逃逸目标不得落盘
  assert.ok(!fs.existsSync(path.join(testData, 'evil.txt')));
});

test('ZIP: 拒绝绝对路径与盘符', async () => {
  const zip = makeZip([
    { name: '/tmp/abs.txt', data: Buffer.from('x') },
    { name: 'C:/windows/x.txt', data: Buffer.from('y') },
  ]);
  const zipPath = path.join(testData, `abs_${randomUUID()}.zip`);
  const dest = path.join(testData, `absdest_${randomUUID()}`);
  fs.writeFileSync(zipPath, zip);
  fs.mkdirSync(dest);
  const r = await inspectAndExtract(zipPath, dest);
  assert.equal(r.ok, false);
});

test('ZIP: 条目数量超限拒收', async () => {
  const entries = Array.from({ length: config.limits.zip.maxEntries + 5 }, (_, i) => ({
    name: `f${i}.txt`,
    data: Buffer.from('x'),
  }));
  const zip = makeZip(entries);
  const zipPath = path.join(testData, `many_${randomUUID()}.zip`);
  const dest = path.join(testData, `manydest_${randomUUID()}`);
  fs.writeFileSync(zipPath, zip);
  fs.mkdirSync(dest);
  const r = await inspectAndExtract(zipPath, dest);
  assert.equal(r.ok, false);
  assert.match(r.reason, /条目数量/);
});

test('ZIP: 解压总大小超限拒收（zip-bomb 防护）', async () => {
  const big = Buffer.alloc(config.limits.zip.maxTotalUncompressedBytes + 1, 0x61);
  const zip = makeZip([{ name: 'bomb.bin', data: big }]);
  const zipPath = path.join(testData, `bomb_${randomUUID()}.zip`);
  const dest = path.join(testData, `bombdest_${randomUUID()}`);
  fs.writeFileSync(zipPath, zip);
  fs.mkdirSync(dest);
  const r = await inspectAndExtract(zipPath, dest);
  assert.equal(r.ok, false);
  assert.match(r.reason, /总大小/);
});

test('ZIP: 损坏文件被拒收', async () => {
  const zipPath = path.join(testData, `broken_${randomUUID()}.zip`);
  const dest = path.join(testData, `brokendest_${randomUUID()}`);
  fs.writeFileSync(zipPath, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0]));
  fs.mkdirSync(dest);
  const r = await inspectAndExtract(zipPath, dest);
  assert.equal(r.ok, false);
});

// ---------- HTTP 全链路 ----------

async function uploadMultipart(fileName, fileBuf, contentType = 'application/octet-stream') {
  const boundary = `----fiwtest${randomUUID()}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
    `Content-Type: ${contentType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const res = await fetch(`${baseUrl}/api/upload`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body: Buffer.concat([head, fileBuf, tail]),
  });
  return { status: res.status, body: await res.json() };
}

test('HTTP: 合法 PNG 上传后 accepted，存储名为随机 UUID', async () => {
  const png = fs.readFileSync(path.resolve('client/public/samples/sample.png'));
  const { status, body } = await uploadMultipart('photo.png', png, 'image/png');
  assert.equal(status, 200);
  assert.equal(body.task.status, 'accepted');
  assert.match(body.task.storage_name, /^[0-9a-f-]{36}\.png$/);
  // 存储名不等于原始名
  assert.notEqual(body.task.storage_name, 'photo.png');
  // accepted 目录里确实存在该随机名文件
  assert.ok(fs.existsSync(path.join(config.dirs.accepted, body.task.storage_name)));
});

test('HTTP: 伪造扩展名与 MIME 不影响服务端按真实内容判定', async () => {
  const png = fs.readFileSync(path.resolve('client/public/samples/sample.png'));
  const { body } = await uploadMultipart('actually-png.exe', png, 'application/x-msdownload');
  assert.equal(body.task.status, 'accepted');
  assert.equal(body.task.detected_type, 'png');
  // 扩展名不符应留下提示记录
  assert.ok(body.task.reasons.some((r) => r.includes('扩展名')));
  // 落盘扩展名由服务端按真实类型决定
  assert.ok(body.task.storage_name.endsWith('.png'));
});

test('HTTP: 文本文件即使命名为 .png 也被隔离', async () => {
  const { status, body } = await uploadMultipart('evil.png', Buffer.from('hello not image'), 'image/png');
  assert.equal(status, 200);
  assert.equal(body.task.status, 'quarantined');
  assert.ok(body.task.reasons.length > 0);
  assert.match(body.task.storage_name, /^q_.*\.bin$/);
  assert.ok(fs.existsSync(path.join(config.dirs.quarantine, body.task.storage_name)));
});

test('HTTP: 隔离文件无法通过下载接口取回（403），通过的文件可以下载', async () => {
  const good = await uploadMultipart('ok.png', fs.readFileSync(path.resolve('client/public/samples/sample.png')));
  const bad = await uploadMultipart('bad.png', Buffer.from('nope'));

  const denied = await fetch(`${baseUrl}/api/download/${bad.body.task.id}`);
  assert.equal(denied.status, 403);
  const deniedBody = await denied.json();
  assert.match(deniedBody.error, /隔离/);

  const allowed = await fetch(`${baseUrl}/api/download/${good.body.task.id}`);
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('content-type'), 'image/png');
  assert.equal(allowed.headers.get('x-content-type-options'), 'nosniff');
});

test('HTTP: 清理隔离文件不影响已通过文件', async () => {
  const good = await uploadMultipart('keep.png', fs.readFileSync(path.resolve('client/public/samples/sample.png')));
  const bad = await uploadMultipart('drop.png', Buffer.from('nope'));
  const goodPath = path.join(config.dirs.accepted, good.body.task.storage_name);
  const badPath = path.join(config.dirs.quarantine, bad.body.task.storage_name);

  const del = await fetch(`${baseUrl}/api/quarantine/${bad.body.task.id}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.ok(!fs.existsSync(badPath), '隔离文件应已删除');
  assert.ok(fs.existsSync(goodPath), '已通过文件必须保留');

  const after = getTask(bad.body.task.id);
  assert.equal(after.status, 'purged');
  assert.equal(after.storage_name, null);
  // 审计里能看到清理动作
  const logs = listAudit(bad.body.task.id);
  assert.ok(logs.some((l) => l.action === 'quarantine.purged'));
});

test('HTTP: 不能对非隔离任务执行隔离清理', async () => {
  const good = await uploadMultipart('x.png', fs.readFileSync(path.resolve('client/public/samples/sample.png')));
  const res = await fetch(`${baseUrl}/api/quarantine/${good.body.task.id}`, { method: 'DELETE' });
  assert.equal(res.status, 409);
});

test('HTTP: 空文件被拒收', async () => {
  const { body } = await uploadMultipart('empty.png', Buffer.alloc(0));
  assert.equal(body.task.status, 'quarantined');
  assert.ok(body.task.reasons.some((r) => r.includes('空')));
});

test('HTTP: 合法样例 ZIP 上传通过并记录条目元数据', async () => {
  const zip = fs.readFileSync(path.resolve('client/public/samples/sample.zip'));
  const { body } = await uploadMultipart('bundle.zip', zip, 'application/zip');
  assert.equal(body.task.status, 'accepted');
  assert.equal(body.task.detected_type, 'zip');
  assert.ok(body.task.zip_meta.entries >= 2);
  assert.ok(body.task.zip_meta.totalUncompressedBytes > 0);
});

test('HTTP: 含穿越条目的 ZIP 上传后被隔离', async () => {
  const zip = makeZip([{ name: '../escape.txt', data: Buffer.from('x') }]);
  const { body } = await uploadMultipart('evil.zip', zip, 'application/zip');
  assert.equal(body.task.status, 'quarantined');
  assert.ok(body.task.reasons.join(' ').match(/穿越|路径/));
});

test('审计日志记录完整状态变化且不含绝对路径', async () => {
  const png = fs.readFileSync(path.resolve('client/public/samples/sample.png'));
  const { body } = await uploadMultipart('audit.png', png);
  const logs = listAudit(body.task.id);
  const actions = logs.map((l) => l.action);
  assert.ok(actions.includes('upload.received'));
  assert.ok(actions.includes('inspect.accepted'));
  // 任何 detail 都不应暴露 data 目录绝对路径
  for (const l of logs) {
    assert.ok(!l.detail.includes(testData), `审计细节泄露绝对路径: ${l.detail}`);
  }
});
