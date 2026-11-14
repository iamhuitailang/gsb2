import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseCsv } from './lib/csv.js';
import { parsePackagingTable } from './lib/packaging.js';
import {
  FIELD_DEFS,
  FIELD_KEYS,
  RULES,
  buildAliasIndex,
  findHeaderRow,
} from './lib/schema.js';
import { buildPreview } from './lib/convert.js';
import { readXlsx } from './lib/xlsx.js';
import { BatchStore, PendingStore, ensureDir, newId, readJson, writeJsonAtomic } from './lib/store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.GSB2_DATA_DIR
  ? path.resolve(process.env.GSB2_DATA_DIR)
  : path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SAMPLES_DIR = path.join(__dirname, 'samples');
const PACKAGING_SOURCE = path.join(__dirname, 'data', '包装表.csv');
const PACKAGING_FILE = path.join(DATA_DIR, '包装表.csv');
const ALIAS_FILE = path.join(DATA_DIR, '表头别名.json');

ensureDir(DATA_DIR);
// 独立数据目录（测试用）时，复制一份包装表过去。
if (PACKAGING_FILE !== PACKAGING_SOURCE && !fs.existsSync(PACKAGING_FILE)) {
  fs.copyFileSync(PACKAGING_SOURCE, PACKAGING_FILE);
}
const pendingStore = new PendingStore(path.join(DATA_DIR, 'pending'));
const batchStore = new BatchStore(path.join(DATA_DIR, 'batches'));

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const SAMPLE_BY_KEY = {
  old: { file: path.join(SAMPLES_DIR, '旧版清单.csv'), name: '旧版清单.csv' },
  new: { file: path.join(SAMPLES_DIR, '新版清单.csv'), name: '新版清单.csv' },
  unknown: { file: path.join(SAMPLES_DIR, '新版清单-未知表头.csv'), name: '新版清单-未知表头.csv' },
  packaging: { file: PACKAGING_SOURCE, name: '包装表.csv' },
};

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function text(res, status, body) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function fail(res, status, message) {
  json(res, status, { error: message });
}

function loadPackaging() {
  return parsePackagingTable(fs.readFileSync(PACKAGING_FILE, 'utf8'));
}

function loadAliases() {
  return readJson(ALIAS_FILE, {});
}

function saveAliases(aliases) {
  writeJsonAtomic(ALIAS_FILE, aliases);
}

function rowsToCsv(rows) {
  const escape = (value) => {
    const cell = String(value ?? '');
    return /[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
  };
  return rows.map((row) => row.map(escape).join(',')).join('\n');
}

function parseMultipart(req, buffer) {
  const contentType = req.headers['content-type'] ?? '';
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
  if (!boundaryMatch) throw new Error('上传格式不正确');
  const boundary = `--${boundaryMatch[1] ?? boundaryMatch[2]}`;
  const parts = [];

  let start = buffer.indexOf(boundary);
  if (start < 0) throw new Error('上传内容为空');
  start += boundary.length;

  while (start < buffer.length) {
    if (buffer[start] === 0x2d && buffer[start + 1] === 0x2d) break;
    const headerEnd = buffer.indexOf('\r\n\r\n', start);
    if (headerEnd < 0) break;
    const headerText = buffer.subarray(start, headerEnd).toString('utf8');
    const bodyStart = headerEnd + 4;
    const nextBoundary = buffer.indexOf(`\r\n${boundary}`, bodyStart);
    const bodyEnd = nextBoundary >= 0 ? nextBoundary : buffer.length;

    const name = /\bname="([^"]*)"/.exec(headerText)?.[1];
    const filenameQuoted = /\bfilename="([^"]*)"/.exec(headerText)?.[1];
    const filenameExtended = /\bfilename\*=UTF-8''([^\r\n;]+)/i.exec(headerText)?.[1];
    const filename =
      filenameQuoted ?? (filenameExtended ? decodeURIComponent(filenameExtended) : undefined);
    const mime = /content-type:\s*([^\r\n]+)/i.exec(headerText)?.[1]?.trim();
    parts.push({ name, filename, mime, content: buffer.subarray(bodyStart, bodyEnd) });
    start = bodyEnd + 2 + boundary.length;
  }
  return parts;
}

async function readBody(req, limit = MAX_UPLOAD_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('文件过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sanitizeMapping(mapping) {
  if (!mapping || typeof mapping !== 'object') return {};
  const result = {};
  for (const [key, value] of Object.entries(mapping)) {
    const index = String(Number(key));
    if (!/^\d+$/.test(index)) continue;
    if (value === 'ignore' || value === 'unmapped') result[index] = value;
    else if (value && FIELD_DEFS[value]) result[index] = value;
  }
  return result;
}

function previewResponse({ record, mapping, headerRowIndex, defaultUnit }) {
  const aliases = loadAliases();
  const { items: packaging, conflicts: packagingConflicts } = loadPackaging();
  const csvText = pendingStore.readCsv(record.id);
  const rows = parseCsv(csvText).rows;
  const effectiveHeaderRow =
    headerRowIndex ?? record.headerRowIndex ?? findHeaderRow(rows, buildAliasIndex(aliases));
  const resolvedMapping = mapping ?? record.mapping ?? {};
  // 显式传 null 表示“清除默认单位”；只有 undefined 才回落到已保存值。
  const resolvedDefaultUnit =
    defaultUnit !== undefined ? defaultUnit : (record.defaultUnit ?? null);

  const preview = buildPreview({
    text: csvText,
    packaging,
    headerRowIndex: effectiveHeaderRow,
    options: {
      customAliases: aliases,
      mapping: resolvedMapping,
      defaultUnit: resolvedDefaultUnit,
      headerRowIndex: effectiveHeaderRow,
    },
  });

  return {
    file: {
      id: record.id,
      filename: record.filename,
      createdAt: record.createdAt,
      status: record.status,
    },
    headerRowIndex: effectiveHeaderRow,
    mapping: resolvedMapping,
    defaultUnit: resolvedDefaultUnit,
    rawPreviewRows: rows.slice(0, 6).map((row, index) => ({
      lineNumber: index + 1,
      cells: row,
      header: index === effectiveHeaderRow,
    })),
    schema: {
      status: preview.schema.status,
      version: preview.schema.version,
      versionProblem: preview.schema.versionProblem,
      columns: preview.schema.columns,
      unknownColumns: preview.schema.unknownColumns,
      conflicts: preview.schema.conflicts,
      missingFields: preview.schema.missingFields,
    },
    rule: preview.rule,
    headers: preview.headers,
    lines: preview.lines,
    totals: preview.totals,
    errors: preview.errors,
    status: preview.status,
    packagingConflicts,
  };
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean);
  const method = req.method;

  if (parts[1] === 'meta' && method === 'GET') {
    const packaging = loadPackaging();
    return json(res, 200, {
      fields: FIELD_KEYS.filter((key) => key !== 'ignore').map((key) => ({
        key,
        label: FIELD_DEFS[key].label,
        required: FIELD_DEFS[key].required,
      })),
      rules: Object.values(RULES),
      packaging: {
        path: 'data/包装表.csv',
        count: packaging.items.size,
        conflicts: packaging.conflicts,
        items: [...packaging.items.values()],
      },
      aliases: loadAliases(),
    });
  }

  if (parts[1] === 'imports') {
    if (parts.length === 2 && method === 'GET') {
      return json(res, 200, { imports: pendingStore.list() });
    }

    if (parts.length === 2 && method === 'POST') {
      const body = await readBody(req);
      const formParts = parseMultipart(req, body);
      const filePart = formParts.find((part) => part.filename);
      if (!filePart) return fail(res, 400, '请选择要导入的清单文件');

      const filename = filePart.filename;
      const lower = filename.toLowerCase();
      let rows;
      let csvText;
      if (lower.endsWith('.xlsx')) {
        try {
          rows = readXlsx(filePart.content);
        } catch (error) {
          return fail(res, 400, `无法读取 XLSX：${error.message}`);
        }
        csvText = rowsToCsv(rows);
      } else if (lower.endsWith('.xls')) {
        return fail(res, 400, '暂不支持旧版 .xls，请另存为 .xlsx 或 .csv');
      } else if (lower.endsWith('.csv') || lower.endsWith('.txt')) {
        // CSV 原样保存，保证预览里的行号与源文件一致。
        csvText = filePart.content.toString('utf8');
        rows = parseCsv(csvText).rows;
      } else {
        return fail(res, 400, '仅支持 .csv / .txt / .xlsx');
      }
      if (!rows.length) return fail(res, 400, '文件内容为空');

      const id = newId('imp-');
      const aliases = loadAliases();
      const headerRowIndex = findHeaderRow(rows, buildAliasIndex(aliases));
      pendingStore.save({
        id,
        filename,
        uploadBuffer: filePart.content,
        csvText,
        headers: (rows[headerRowIndex] ?? []).map((cell) => String(cell ?? '').trim()),
      });
      pendingStore.update(id, { headerRowIndex });

      const preview = previewResponse({ record: pendingStore.get(id) });
      pendingStore.update(id, {
        lastPreviewStatus: preview.status,
        detectedVersion: preview.schema.version,
      });
      return json(res, 201, preview);
    }

    const id = parts[2];
    if (parts.length === 3 && method === 'GET') {
      const record = pendingStore.get(id);
      if (!record) return fail(res, 404, '待处理文件不存在');
      return json(res, 200, previewResponse({ record }));
    }

    if (parts.length === 3 && method === 'DELETE') {
      if (!pendingStore.get(id)) return fail(res, 404, '待处理文件不存在');
      pendingStore.remove(id);
      return json(res, 200, { ok: true });
    }

    if (parts.length === 4 && parts[3] === 'preview' && method === 'POST') {
      const record = pendingStore.get(id);
      if (!record) return fail(res, 404, '待处理文件不存在');
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const mapping = sanitizeMapping(body.mapping);
      const headerRowIndex = Number.isInteger(body.headerRowIndex) ? body.headerRowIndex : undefined;
      // 前端传 null 或空串表示清除默认单位。
      const defaultUnit =
        body.defaultUnit === null || body.defaultUnit === ''
          ? null
          : typeof body.defaultUnit === 'string'
            ? body.defaultUnit
            : undefined;
      pendingStore.update(id, { mapping, ...(headerRowIndex !== undefined ? { headerRowIndex } : {}), ...(defaultUnit !== undefined ? { defaultUnit } : {}) });
      const preview = previewResponse({
        record: pendingStore.get(id),
        mapping,
        headerRowIndex,
        defaultUnit,
      });
      pendingStore.update(id, {
        lastPreviewStatus: preview.status,
        detectedVersion: preview.schema.version,
      });
      return json(res, 200, preview);
    }

    if (parts.length === 4 && parts[3] === 'confirm' && method === 'POST') {
      const record = pendingStore.get(id);
      if (!record) return fail(res, 404, '待处理文件不存在');
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');

      // 以服务端保存的文件 + 已保存的映射重算，不信任前端回传的换算结果。
      const preview = previewResponse({ record });
      if (!preview.rule) return fail(res, 400, '尚未识别清单版本，不能导入');
      if (preview.schema.status !== 'ready') {
        return fail(res, 400, '仍有未识别或未映射的表头，请先配置字段对应关系');
      }
      if (preview.status !== 'ok') return fail(res, 400, '预览中仍有错误行，请修正后再导入');

      // 把本次手动配置的表头记为新别名，下次遇到同名列可自动识别。
      const aliases = loadAliases();
      const aliasIndex = buildAliasIndex(aliases);
      const nextAliases = { ...aliases };
      for (const column of preview.schema.columns ?? []) {
        if (!column.overridden || !column.field || column.field === 'ignore') continue;
        if (!column.header.trim()) continue;
        if (aliasIndex.has(column.header.replace(/\s+/g, '').toLowerCase())) continue;
        nextAliases[column.header] = column.field;
      }
      if (Object.keys(nextAliases).length !== Object.keys(aliases).length) saveAliases(nextAliases);

      const packaging = loadPackaging();
      const batch = {
        id: newId('batch-'),
        sourceFile: {
          id: record.id,
          filename: record.filename,
          createdAt: record.createdAt,
        },
        confirmedAt: new Date().toISOString(),
        confirmedBy: String(body.confirmedBy ?? '').slice(0, 40) || null,
        rule: preview.rule,
        schema: {
          version: preview.schema.version,
          headerRowIndex: preview.headerRowIndex,
          columns: preview.schema.columns,
          mapping: Object.fromEntries(
            (preview.schema.columns ?? [])
              .filter((column) => column.field && column.field !== 'ignore')
              .map((column) => [column.header, column.field]),
          ),
        },
        packagingSnapshot: {
          source: 'data/包装表.csv',
          items: [...packaging.items.values()],
        },
        totals: preview.totals,
        lines: preview.lines,
        errors: preview.errors,
      };
      const saved = batchStore.save(batch);
      pendingStore.remove(record.id);
      return json(res, 201, { batch: saved });
    }
  }

  if (parts[1] === 'batches') {
    if (parts.length === 2 && method === 'GET') {
      return json(res, 200, {
        batches: batchStore.list().map((batch) => ({
          id: batch.id,
          confirmedAt: batch.confirmedAt,
          filename: batch.sourceFile?.filename,
          rule: batch.rule,
          totals: batch.totals,
          lineCount: batch.lines?.length ?? 0,
        })),
      });
    }
    if (parts.length === 3 && method === 'GET') {
      const batch = batchStore.get(parts[2]);
      if (!batch) return fail(res, 404, '批次不存在');
      return json(res, 200, { batch });
    }
  }

  if (parts[1] === 'samples' && method === 'GET') {
    const sample = SAMPLE_BY_KEY[parts[2]];
    if (!sample || !fs.existsSync(sample.file)) return fail(res, 404, '样例不存在');
    res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(sample.name)}`,
      'cache-control': 'no-store',
    });
    return res.end(fs.readFileSync(sample.file));
  }

  return fail(res, 404, '接口不存在');
}

function serveStatic(req, res, url) {
  const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  if (relative.includes('..')) return text(res, 400, 'Bad path');
  const filePath = path.join(PUBLIC_DIR, relative);
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return text(res, 404, 'Not found');
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(filePath)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  res.end(fs.readFileSync(filePath));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (error) {
    console.error(error);
    return fail(res, 500, error.message || '服务器错误');
  }
});

const PORT = Number(process.env.PORT ?? 4173);
server.listen(PORT, () => {
  console.log(`供货清单导入服务已启动：http://localhost:${PORT}`);
});
