// /api/* 请求处理。所有分析都调用 core/analyze，出错由统一错误映射返回，
// 服务端不缓存任何"上一次分析结果"。
import { readFile, readdir } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { analyze } from '../core/analyze.js';
import { materializeRules, DEFAULT_RULES } from '../core/config.js';
import { parseJsonText } from '../core/fs-util.js';
import { AppError, ERROR_CODES } from '../core/errors.js';
import { sendJson, sendError, readJsonBody } from './http-util.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLES_DIR = resolve(HERE, '..', '..', 'examples');
const SAMPLE_NAME_RE = /^[a-zA-Z0-9._-]+$/;
// Web 请求体硬上限：规则上限再加少量 JSON 包装余量
const BODY_LIMIT = DEFAULT_RULES.maxFileSizeBytes + 64 * 1024;

// 示例文件的场景标签，供前端"载入示例"下拉展示
const SAMPLE_TAGS = Object.freeze({
  'lockfile-v1.json': 'v1 锁文件：覆盖各类来源与完整性异常',
  'lockfile-v2.json': 'v2 锁文件：packages 映射 + 身份错配/别名/嵌套',
  'lockfile-v3.json': 'v3 锁文件：字段省略（待核实）场景',
  'rules.example.json': '示例规则配置（可信域名/算法/级别覆盖）',
  'baseline-v2.json': 'v2 基线锁文件：用于差异对比',
});

export async function handleSamplesList(res) {
  const names = (await readdir(EXAMPLES_DIR)).filter((n) => SAMPLE_NAME_RE.test(n)).sort();
  sendJson(res, 200, {
    ok: true,
    samples: names.map((name) => ({ name, description: SAMPLE_TAGS[name] ?? name })),
  });
}

export async function handleSampleContent(res, name) {
  if (!SAMPLE_NAME_RE.test(name)) {
    throw new AppError(ERROR_CODES.UNSUPPORTED_STRUCTURE, '示例文件名含非法字符');
  }
  const target = resolve(EXAMPLES_DIR, name);
  if (!target.startsWith(EXAMPLES_DIR)) {
    throw new AppError(ERROR_CODES.UNSUPPORTED_STRUCTURE, '非法的示例路径');
  }
  const content = await readFile(target, 'utf8');
  sendJson(res, 200, { ok: true, name: basename(target), content });
}

export async function handleAnalyze(req, res) {
  const body = await readJsonBody(req, BODY_LIMIT);
  if (!body || typeof body !== 'object' || !body.lockfile) {
    throw new AppError(ERROR_CODES.UNSUPPORTED_STRUCTURE, '请求缺少 lockfile 字段');
  }
  const { lockfile, rules: rulesInput, baseline } = body;
  if (typeof lockfile.content !== 'string' || typeof lockfile.fileName !== 'string') {
    throw new AppError(ERROR_CODES.UNSUPPORTED_STRUCTURE, 'lockfile 需包含 fileName 与 content');
  }

  // 规则：优先请求内文本；缺省用内置默认。先物化以拿到大小上限。
  let rules;
  if (rulesInput && typeof rulesInput.content === 'string') {
    const parsed = parseJsonText(rulesInput.content, BODY_LIMIT, '规则配置');
    rules = materializeRules(parsed.data);
  } else {
    rules = materializeRules();
  }

  const input = {
    lockfile: { fileName: lockfile.fileName, content: lockfile.content },
    rules: { content: JSON.stringify(rules) },
  };
  if (baseline && typeof baseline.content === 'string') {
    input.baseline = { fileName: baseline.fileName ?? 'baseline.json', content: baseline.content };
  }

  const report = await analyze(input);
  sendJson(res, 200, { ok: true, report });
}

// 路由分发：返回 true 表示已处理。
export async function handleApi(req, res, pathname) {
  try {
    if (req.method === 'GET' && pathname === '/api/samples') {
      await handleSamplesList(res);
      return true;
    }
    const sampleMatch = pathname.match(/^\/api\/samples\/([^/]+)$/);
    if (req.method === 'GET' && sampleMatch) {
      await handleSampleContent(res, decodeURIComponent(sampleMatch[1]));
      return true;
    }
    if (req.method === 'POST' && pathname === '/api/analyze') {
      await handleAnalyze(req, res);
      return true;
    }
    return false;
  } catch (err) {
    sendError(res, err);
    return true;
  }
}
