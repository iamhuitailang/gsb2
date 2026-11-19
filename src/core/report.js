// 组装可复核的 JSON 报告：清单标识、规则快照、时间、汇总、证据、差异与未决项。
// 所有键控统计对象使用 null 原型，避免锁文件中的特殊键污染原型链。
import { RELATIONSHIPS } from './model.js';
import { severityRank } from './config.js';
import { allPathsTo } from './graph.js';

export const SCHEMA_VERSION = '1.0';

const BOUNDARY_STATEMENTS = Object.freeze({
  offline: '本工具全程离线运行：不访问注册表或任何网络地址，不执行安装脚本，不安装依赖',
  integrity:
    'integrity 仅为锁文件中的摘要声明；工具未下载任何压缩包，未验证实际制品内容，所有条目的 verified 均为 false',
  wording: '来源类发现仅表示与配置规则不符或无法判定，不等于确认该依赖为恶意',
  inconclusive: '无法依据锁文件本身判定的条目列入 inconclusive，不计为通过',
});

function nullProtoObject() {
  return Object.create(null);
}

function localTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const offset = `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  const local = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${offset}`;
  return local;
}

function summarize(findings, inconclusive, records, rootKey) {
  const bySeverity = nullProtoObject();
  for (const sev of ['critical', 'high', 'medium', 'low', 'info']) bySeverity[sev] = 0;
  const byRuleId = nullProtoObject();
  const hosts = nullProtoObject();

  for (const f of findings) {
    bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
    byRuleId[f.ruleId] = (byRuleId[f.ruleId] ?? 0) + 1;
  }
  for (const rec of records.values()) {
    if (rec.key === rootKey) continue;
    const hostKey = rec.host ?? '(无法判定)';
    hosts[hostKey] = (hosts[hostKey] ?? 0) + 1;
  }

  return {
    totalFindings: findings.length,
    bySeverity,
    byRuleId,
    inconclusiveCount: inconclusive.length,
    hosts,
  };
}

// 为每条记录挂依赖路径（最短 + 受限枚举的 alternatives）。
function buildDependencyPaths(parsed, graph) {
  const out = nullProtoObject();
  for (const rec of parsed.records.values()) {
    if (rec.key === graph.rootKey) continue;
    const shortest = graph.shortestPaths.get(rec.key) ?? [];
    const { paths, truncated } = allPathsTo(rec.key, graph);
    out[rec.recordId] = {
      reachable: shortest.length > 0,
      shortest,
      alternatives: paths.filter((p) => p.join('>') !== shortest.join('>')),
      truncated,
    };
  }
  return out;
}

export function buildReport({
  parsed,
  graph,
  rules,
  findings,
  inconclusive,
  lockfileMeta,
  baselineMeta,
  diff,
  diffFindingsList,
  errors = [],
}) {
  const allFindings = [...findings, ...diffFindingsList].sort(
    (a, b) => severityRank(b.severity) - severityRank(a.severity),
  );

  const records = [...parsed.records.values()].filter((r) => r.key !== graph.rootKey);
  let directCount = 0;
  let transitiveCount = 0;
  let unreachableCount = 0;
  for (const r of records) {
    if (r.relationship === RELATIONSHIPS.DIRECT) directCount += 1;
    else if (r.relationship === RELATIONSHIPS.TRANSITIVE) transitiveCount += 1;
    else unreachableCount += 1;
  }

  const now = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown';

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAtUtc: now.toISOString(),
    generatedAtLocal: localTimestamp(now),
    timeZone: tz,
    boundaries: BOUNDARY_STATEMENTS,
    lockfile: {
      fileName: lockfileMeta.fileName,
      filePath: lockfileMeta.filePath ?? null,
      sizeBytes: lockfileMeta.sizeBytes,
      sha256: lockfileMeta.sha256,
      lockfileVersion: parsed.lockfileVersion,
      packageEntryCount: parsed.records.size - (parsed.records.has(graph.rootKey) ? 1 : 0),
      packageCount: records.length,
      directCount,
      transitiveCount,
      unreachableCount,
    },
    rules,
    summary: summarize(allFindings, inconclusive, parsed.records, graph.rootKey),
    findings: allFindings,
    inconclusive,
    records,
    dependencyPaths: buildDependencyPaths(parsed, graph),
    graph: {
      danglingEdges: graph.dangling,
    },
    diff: diff
      ? {
          baseline: baselineMeta,
          summary: diff.summary,
          warnings: diff.warnings,
          entries: diff.entries,
        }
      : null,
    errors,
  };
}
