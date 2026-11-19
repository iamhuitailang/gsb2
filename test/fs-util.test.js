import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJsonFile, parseJsonText, locateJsonError, sha256Buffer } from '../src/core/fs-util.js';
import { AppError } from '../src/core/errors.js';

async function withTempFile(content) {
  const dir = await mkdtemp(join(tmpdir(), 'lockaudit-'));
  const file = join(dir, 'input.json');
  await writeFile(file, content, 'utf8');
  return file;
}

test('readJsonFile 正常解析并给出大小与 sha256', async () => {
  const file = await withTempFile('{"a":1}');
  const result = await readJsonFile(file, 1024);
  assert.equal(result.data.a, 1);
  assert.equal(result.sizeBytes, 7);
  assert.match(result.sha256, /^[0-9a-f]{64}$/);
});

test('readJsonFile 超过 stat 预检上限报 FILE_TOO_LARGE', async () => {
  const file = await withTempFile('{"a":1}');
  await assert.rejects(
    () => readJsonFile(file, 3),
    (err) => err instanceof AppError && err.code === 'FILE_TOO_LARGE' && err.limitBytes === 3,
  );
});

test('parseJsonText 超限报 REQUEST_TOO_LARGE', () => {
  assert.throws(
    () => parseJsonText('{"a":12345}', 4, '测试'),
    (err) => err instanceof AppError && err.code === 'REQUEST_TOO_LARGE',
  );
});

test('JSON 语法错误带行列定位', async () => {
  // 第二行放一个明确的非法 token，保证各 V8 版本都报语法错误
  const file = await withTempFile('{\n  "a": 1,\n  "b": xxx\n}\n');
  await assert.rejects(
    () => readJsonFile(file, 1024),
    (err) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, 'JSON_PARSE_ERROR');
      assert.ok(Number.isInteger(err.line) && err.line >= 1, `line=${err.line}`);
      assert.ok(Number.isInteger(err.column) && err.column >= 1, `column=${err.column}`);
      assert.match(err.message, /JSON 解析失败/);
      return true;
    },
  );
});

test('locateJsonError 对不含位置信息的消息兜底返回可用行列', () => {
  const text = '{\n  bad\n}';
  const loc = locateJsonError(text, new SyntaxError('Unexpected token'));
  assert.equal(loc.line, 1);
  assert.equal(loc.column, 1);
  assert.ok(loc.message.includes('Unexpected token'));
});

test('locateJsonError 能解析 V8 的 position 格式', () => {
  const text = '{"a":1,"b":x}';
  const loc = locateJsonError(text, new SyntaxError('Unexpected token x in JSON at position 10'));
  assert.equal(loc.position, 10);
  assert.ok(loc.line >= 1 && loc.column >= 1);
});

test('BOM 不影响解析', async () => {
  const file = await withTempFile('﻿{"x":true}');
  const result = await readJsonFile(file, 1024);
  assert.equal(result.data.x, true);
});

test('文件不存在报 FILE_NOT_FOUND', async () => {
  await assert.rejects(
    () => readJsonFile(join(tmpdir(), `nope-${Date.now()}.json`), 1024),
    (err) => err.code === 'FILE_NOT_FOUND',
  );
});

test('sha256Buffer 与已知向量一致', () => {
  // echo -n abc | shasum -a 256
  assert.equal(
    sha256Buffer(Buffer.from('abc')),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
});
