// 分析编排层：被 CLI 与 Web API 共用。支持从文件路径或文本内容进入，
// 任何失败都直接抛 AppError，由调用方负责展示——本层不保留任何"上一次结果"。
import { readJsonFile, parseJsonText, sha256Buffer } from './fs-util.js';
import { materializeRules, DEFAULT_RULES } from './config.js';
import { parseLockfile } from './parse-lockfile.js';
import { buildGraph } from './graph.js';
import { evaluate } from './rules.js';
import { diffLockfiles, diffFindings } from './diff.js';
import { buildReport } from './report.js';
import { resetSequences } from './model.js';

async function loadLockfileFromFile(filePath, maxBytes) {
  const loaded = await readJsonFile(filePath, maxBytes);
  return {
    data: loaded.data,
    meta: {
      fileName: filePath.split('/').pop(),
      filePath,
      sizeBytes: loaded.sizeBytes,
      sha256: loaded.sha256,
    },
  };
}

function loadLockfileFromText(content, fileName, maxBytes) {
  const { data, sizeBytes } = parseJsonText(content, maxBytes, fileName);
  return {
    data,
    meta: {
      fileName,
      filePath: null,
      sizeBytes,
      sha256: sha256Buffer(Buffer.from(content, 'utf8')),
    },
  };
}

function loadRulesFromText(content, maxBytes) {
  const { data } = parseJsonText(content, maxBytes, '规则配置');
  return materializeRules(data);
}

// 统一入口。input 形态：
// { lockfile:{filePath} | {fileName, content}, rules?: {filePath}|{content}|null,
//   baseline?: 同 lockfile | null }
export async function analyze(input) {
  // 每次分析重置自增 id，保证同一输入产出稳定报告
  resetSequences();

  const preliminaryRules = input.rules
    ? input.rules.filePath
      ? materializeRules((await readJsonFile(input.rules.filePath, DEFAULT_RULES.maxFileSizeBytes)).data)
      : loadRulesFromText(input.rules.content, DEFAULT_RULES.maxFileSizeBytes)
    : materializeRules();
  const maxBytes = preliminaryRules.maxFileSizeBytes;

  const current = input.lockfile.filePath
    ? await loadLockfileFromFile(input.lockfile.filePath, maxBytes)
    : await loadLockfileFromText(input.lockfile.content, input.lockfile.fileName, maxBytes);
  const parsed = parseLockfile(current.data, { fileName: current.meta.fileName });
  const graph = buildGraph(parsed);
  const { findings, inconclusive } = evaluate(parsed, graph, preliminaryRules);

  let diff = null;
  let diffFindingsList = [];
  let baselineMeta = null;
  if (input.baseline) {
    const baseline = input.baseline.filePath
      ? await loadLockfileFromFile(input.baseline.filePath, maxBytes)
      : await loadLockfileFromText(
          input.baseline.content,
          input.baseline.fileName,
          maxBytes,
        );
    const baselineParsed = parseLockfile(baseline.data, { fileName: baseline.meta.fileName });
    diff = diffLockfiles(parsed, baselineParsed);
    diffFindingsList = diffFindings(diff, preliminaryRules);
    baselineMeta = {
      fileName: baseline.meta.fileName,
      sha256: baseline.meta.sha256,
      lockfileVersion: baselineParsed.lockfileVersion,
    };
  }

  return buildReport({
    parsed,
    graph,
    rules: preliminaryRules,
    findings,
    inconclusive,
    lockfileMeta: current.meta,
    baselineMeta,
    diff,
    diffFindingsList,
  });
}
