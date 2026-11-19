// audit 命令编排：解析参数 → 调用核心 analyze → 输出报告/决定退出码。
import { writeFile } from 'node:fs/promises';
import { analyze } from '../core/analyze.js';
import { materializeRules, severityRank } from '../core/config.js';
import { readJsonFile } from '../core/fs-util.js';
import { formatTable } from './format-text.js';

export async function runAudit(flags, positionals) {
  const lockfilePath = positionals[0];
  if (!lockfilePath) {
    throw new AppErrorCli('缺少 lockfile 位置参数；用法：lock-audit audit <lockfile> [选项]');
  }

  // 规则先加载，以便拿到 maxFileSize；--max-size 可覆盖
  let rules;
  if (flags.rules) {
    const loaded = await readJsonFile(flags.rules, 1024 * 1024 * 1024);
    rules = materializeRules(loaded.data);
  } else {
    rules = materializeRules();
  }
  if (flags['max-size'] !== undefined) {
    const n = Number(flags['max-size']);
    if (!Number.isInteger(n) || n <= 0) {
      throw new AppErrorCli('--max-size 必须是正整数（字节）');
    }
    rules.maxFileSizeBytes = n;
  }

  const input = {
    lockfile: { filePath: lockfilePath },
    rules: { content: JSON.stringify(rules) },
  };
  if (flags.baseline) input.baseline = { filePath: flags.baseline };

  const report = await analyze(input);

  if (flags.out) {
    await writeFile(flags.out, JSON.stringify(report, null, 2), 'utf8');
    process.stderr.write(`JSON 报告已写入 ${flags.out}\n`);
  }

  const format = flags.format ?? 'table';
  if (format === 'json') {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else if (format !== 'none' && !flags.out) {
    process.stdout.write(`${formatTable(report)}\n`);
  } else if (!flags.out) {
    process.stdout.write(`${formatTable(report)}\n`);
  }

  if (flags['fail-on']) {
    const threshold = severityRank(flags['fail-on']);
    if (!threshold) throw new AppErrorCli(`未知的 --fail-on 级别：${flags['fail-on']}`);
    const hit = report.findings.some((f) => severityRank(f.severity) >= threshold);
    return hit ? 1 : 0;
  }
  return 0;
}

// CLI 本地的参数错误（退出码 2），与核心 AppError 区分
export class AppErrorCli extends Error {
  constructor(message) {
    super(message);
    this.name = 'AppErrorCli';
  }
}
