// 终端文本输出：摘要 + finding 表格。只做展示，不改变报告数据。
import { severityRank } from '../core/config.js';

const SEVERITY_TAG = Object.freeze({
  critical: '严重',
  high: '高',
  medium: '中',
  low: '低',
  info: '提示',
});

function pad(s, width) {
  const str = String(s ?? '');
  return str.length >= width ? str : str + ' '.repeat(width - str.length);
}

function truncate(s, width) {
  const str = String(s ?? '');
  return str.length <= width ? str : `${str.slice(0, width - 1)}…`;
}

export function formatTable(report) {
  const lines = [];
  lines.push('==== 锁文件来源与完整性审计（离线）====');
  lines.push(`清单：${report.lockfile.fileName}（lockfileVersion ${report.lockfile.lockfileVersion}，${report.lockfile.packageCount} 个包）`);
  lines.push(`sha256：${report.lockfile.sha256}`);
  lines.push(`时间：${report.generatedAtLocal}（${report.timeZone}）`);
  lines.push(
    `包关系：直接 ${report.lockfile.directCount} / 传递 ${report.lockfile.transitiveCount} / 不可达 ${report.lockfile.unreachableCount}`,
  );
  lines.push('');

  const s = report.summary;
  lines.push(
    `发现汇总：共 ${s.totalFindings} 项（严重 ${s.bySeverity.critical} / 高 ${s.bySeverity.high} / 中 ${s.bySeverity.medium} / 低 ${s.bySeverity.low} / 提示 ${s.bySeverity.info}），待核实 ${s.inconclusiveCount} 项`,
  );
  lines.push('');

  if (report.findings.length === 0) {
    lines.push('没有触发任何规则。注意：这不等于压缩包内容已校验，本工具不下载制品。');
  } else {
    lines.push(pad('级别', 6) + pad('规则', 34) + pad('位置', 48) + '说明');
    lines.push('-'.repeat(120));
    const sorted = [...report.findings].sort(
      (a, b) => severityRank(b.severity) - severityRank(a.severity),
    );
    for (const f of sorted) {
      lines.push(
        pad(SEVERITY_TAG[f.severity] ?? f.severity ?? '?', 6) +
          pad(truncate(f.ruleId, 32), 34) +
          pad(truncate(f.packageKey, 46), 48) +
          truncate(f.message, 80),
      );
    }
  }

  if (report.inconclusive.length > 0) {
    lines.push('');
    lines.push('待核实（无法依据锁文件判定，不计为通过）：');
    for (const item of report.inconclusive) {
      lines.push(`  - ${item.packageKey}：${item.reason}`);
    }
  }

  if (report.diff) {
    lines.push('');
    const d = report.diff.summary;
    lines.push(
      `基线差异：新增 ${d.added} / 移除 ${d.removed} / 变化 ${d.changed} / 未变 ${d.unchanged}（按唯一安装位置计数，共 ${d.unionLocations} 个位置）`,
    );
    for (const w of report.diff.warnings) lines.push(`  警告：${w}`);
  }

  lines.push('');
  lines.push(`边界：${report.boundaries.offline}`);
  lines.push(`      ${report.boundaries.integrity}`);
  lines.push(`      ${report.boundaries.wording}`);
  return lines.join('\n');
}
