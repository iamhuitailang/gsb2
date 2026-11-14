import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseCsv, serializeCsv } from '../lib/csv.js';

test('parseCsv: BOM、CRLF、引号转义、字段内逗号与换行', () => {
  const text = '﻿a,b\r\n1,"x,y"\r\n"q""q","line1\nline2"\r\n';
  const { headers, rows, lines } = parseCsv(text);
  assert.deepEqual(headers, ['a', 'b']);
  assert.deepEqual(rows, [
    { a: '1', b: 'x,y' },
    { a: 'q"q', b: 'line1\nline2' },
  ]);
  assert.deepEqual(lines, [2, 3]);
});

test('parseCsv: 仅表头 -> 零行；空行跳过；末尾无换行', () => {
  const r1 = parseCsv('a,b\n');
  assert.deepEqual(r1.rows, []);
  const r2 = parseCsv('a,b\n1,2\n\n3,4');
  assert.equal(r2.rows.length, 2);
  assert.deepEqual(r2.lines, [2, 4]);
});

test('parseCsv: 引号未闭合抛错', () => {
  assert.throws(() => parseCsv('a\n"unterminated'), /引号未闭合/);
});

test('parseCsv: 列数不一致抛错并带行号', () => {
  assert.throws(() => parseCsv('a,b,c\n1,2\n'), /第 2 行/);
});

test('parseCsv: 重复表头抛错', () => {
  assert.throws(() => parseCsv('a,a\n1,2\n'), /重复列/);
});

test('serializeCsv: 引号/逗号转义与公式注入防护、BOM', () => {
  const csv = serializeCsv(['x'], [['=CMD()'], ['a,b'], ['he"llo']]);
  assert.ok(csv.startsWith('﻿'));
  assert.ok(csv.includes("'=CMD()"));
  assert.ok(csv.includes('"a,b"'));
  assert.ok(csv.includes('"he""llo"'));
});
