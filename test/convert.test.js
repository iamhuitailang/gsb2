import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseCsv } from '../lib/csv.js';
import { parsePackagingTable } from '../lib/packaging.js';
import { findHeaderRow, buildAliasIndex } from '../lib/schema.js';
import { buildPreview } from '../lib/convert.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const packaging = parsePackagingTable(
  fs.readFileSync(path.join(root, 'data', '包装表.csv'), 'utf8'),
).items;

function previewOf(file, options = {}) {
  const text = fs.readFileSync(path.join(root, 'samples', file), 'utf8');
  const { rows } = parseCsv(text);
  const headerRowIndex = findHeaderRow(rows, buildAliasIndex(options.customAliases));
  return buildPreview({
    text,
    packaging,
    options: { ...options, headerRowIndex },
  });
}

test('旧版清单：整箱数量按包装表换算为件', () => {
  const preview = previewOf('旧版清单.csv');
  assert.equal(preview.rule.version, 'old');
  assert.equal(preview.rule.id, 'old-box-v1');

  const line = preview.lines.find((item) => item.code === '1001');
  assert.equal(line.rawQuantity, 5);
  assert.equal(line.unitKind, 'box');
  assert.equal(line.unitsPerBox, 24);
  assert.equal(line.factor, 24);
  assert.equal(line.pieces, 120);

  assert.equal(preview.totals.boxRows, 4);
  assert.equal(preview.totals.errorRows, 0);
  assert.equal(preview.totals.pieces, 120 + 120 + 72 + 40);
});

test('包装表缺商品时不允许按箱换算，并标为错误行', () => {
  const text = ['商品编码,整箱数量', '9999,2'].join('\n');
  const { rows } = parseCsv(text);
  const headerRowIndex = findHeaderRow(rows, buildAliasIndex());
  const preview = buildPreview({ text, packaging, options: { headerRowIndex } });
  assert.equal(preview.lines[0].status, 'error');
  assert.match(preview.lines[0].errors.join(), /包装表中找不到商品/);
  assert.equal(preview.status, 'has_errors');
});

test('新版清单：同一商品按箱与按件得到不同换算，单位可混用', () => {
  const preview = previewOf('新版清单.csv');
  assert.equal(preview.rule.version, 'new');
  assert.equal(preview.rule.id, 'new-unit-v1');

  const byBox = preview.lines.find((item) => item.code === '1001' && item.unitKind === 'box');
  const byPiece = preview.lines.find((item) => item.code === '1001' && item.unitKind === 'piece');

  assert.equal(byBox.rawQuantity, 5);
  assert.equal(byBox.factor, 24);
  assert.equal(byBox.pieces, 120);
  assert.equal(byPiece.rawQuantity, 36);
  assert.equal(byPiece.factor, 1);
  assert.equal(byPiece.pieces, 36);

  // 48 件按件 = 48 件（不是 48×12）
  const piece = preview.lines.find((item) => item.code === '1002');
  assert.equal(piece.unitKind, 'piece');
  assert.equal(piece.pieces, 48);

  // 按箱：2 × 8
  const boxed = preview.lines.find((item) => item.code === '1004');
  assert.equal(boxed.pieces, 16);

  assert.equal(preview.status, 'ok'); // 1007 按件计量，无需包装表也能计件
  assert.equal(preview.totals.pieces, 120 + 36 + 48 + 16 + 7 + 300);
});

test('同一商品在不同版本中来源不同、统一件数可比', () => {
  const oldPreview = previewOf('旧版清单.csv');
  const newPreview = previewOf('新版清单.csv');
  const oldLine = oldPreview.lines.find((item) => item.code === '1001');
  const newLine = newPreview.lines.find((item) => item.code === '1001' && item.unitKind === 'box');
  assert.equal(oldLine.pieces, newLine.pieces);
  assert.equal(oldLine.formula, newLine.formula);
  assert.equal(oldLine.unitsPerBox, newLine.unitsPerBox);
});

test('列顺序变化不影响识别', () => {
  const text = [
    '计量单位,整箱数量,商品编码',
    '箱,5,1001',
  ].join('\n');
  const { rows } = parseCsv(text);
  const headerRowIndex = findHeaderRow(rows, buildAliasIndex());
  const preview = buildPreview({ text, packaging, options: { headerRowIndex } });
  assert.equal(preview.rule.version, 'old');
  assert.equal(preview.lines[0].code, '1001');
  assert.equal(preview.lines[0].rawQuantity, 5);
  assert.equal(preview.lines[0].pieces, 120);
});

test('未知表头：保留为未识别列，并可配置映射后重新预览', () => {
  const text = fs.readFileSync(path.join(root, 'samples', '新版清单-未知表头.csv'), 'utf8');
  const { rows } = parseCsv(text);
  const headerRowIndex = findHeaderRow(rows, buildAliasIndex());
  const first = buildPreview({ text, packaging, options: { headerRowIndex } });
  assert.equal(first.schema.status, 'needs_mapping');
  assert.ok(first.schema.unknownColumns.length >= 3);

  const mapping = {
    0: 'ignore', // 供货批次
    1: 'productCode', // 商品编号
    2: 'productName', // 品名规格
    3: 'qty', // 申报数量
    4: 'unit', // 计价单位
    5: 'ignore', // 供货单价
  };
  const second = buildPreview({
    text,
    packaging,
    options: { headerRowIndex, mapping },
  });
  assert.equal(second.schema.status, 'ready');
  assert.equal(second.rule.version, 'new');
  assert.equal(second.lines[0].pieces, 120);
  assert.equal(second.lines[1].pieces, 120);
});

test('新版缺单位列时按默认单位换算', () => {
  const text = ['商品编号,数量', '1001,5'].join('\n');
  const { rows } = parseCsv(text);
  const headerRowIndex = findHeaderRow(rows, buildAliasIndex());
  const preview = buildPreview({
    text,
    packaging,
    options: { headerRowIndex, defaultUnit: '箱' },
  });
  assert.equal(preview.schema.status, 'ready');
  assert.equal(preview.lines[0].pieces, 120);
});

test('计量单位不可识别时报错而不是猜', () => {
  const text = ['商品编号,数量,计量单位', '1001,5,袋'].join('\n');
  const { rows } = parseCsv(text);
  const headerRowIndex = findHeaderRow(rows, buildAliasIndex());
  const preview = buildPreview({ text, packaging, options: { headerRowIndex } });
  assert.equal(preview.lines[0].status, 'error');
  assert.match(preview.lines[0].errors.join(), /计量单位/);
});
