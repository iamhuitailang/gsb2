#!/usr/bin/env node
// CLI 入口：仅做命令分发，业务逻辑在 src/cli 与 src/core。
import { parseArgs, USAGE } from '../src/cli/args.js';
import { runAudit, AppErrorCli } from '../src/cli/audit.js';
import { runServe } from '../src/cli/serve.js';
import { isAppError } from '../src/core/errors.js';
import { materializeRules } from '../src/core/config.js';

const COMMANDS = new Set(['audit', 'serve', 'rules', 'version']);

async function main() {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  const command = positionals[0];

  if (flags.help || !command) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (!COMMANDS.has(command)) {
    process.stderr.write(`未知命令：${command}\n\n${USAGE}`);
    return 2;
  }

  if (command === 'version') {
    process.stdout.write('lock-audit 1.0.0\n');
    return 0;
  }
  if (command === 'rules') {
    process.stdout.write(`${JSON.stringify(materializeRules(), null, 2)}\n`);
    return 0;
  }
  if (command === 'audit') {
    return runAudit(flags, positionals.slice(1));
  }
  if (command === 'serve') {
    await runServe(flags);
    return 0;
  }
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code ?? 0;
  })
  .catch((err) => {
    if (err instanceof AppErrorCli || isAppError(err)) {
      process.stderr.write(`错误[${err.code ?? 'CLI'}]：${err.message}\n`);
      if (err.line !== undefined) process.stderr.write(`位置：第 ${err.line} 行第 ${err.column} 列\n`);
      process.exit(2);
    }
    process.stderr.write(`错误：${err?.stack ?? err}\n`);
    process.exit(2);
  });
