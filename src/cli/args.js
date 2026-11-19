// 手写命令行参数解析，零依赖。支持 --flag=value、--flag value、布尔 flag 与位置参数。
export function parseArgs(argv) {
  const positionals = [];
  const flags = Object.create(null);
  const booleanFlags = new Set(['help', 'version']);

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    if (booleanFlags.has(body)) {
      flags[body] = true;
      continue;
    }
    // 其余 flag 取后一个 token 作为值
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[body] = true;
    } else {
      flags[body] = next;
      i += 1;
    }
  }
  return { positionals, flags };
}

export const USAGE = `lock-audit — 离线 package-lock.json 来源与完整性审计

用法：
  lock-audit audit <lockfile> [选项]     审计锁文件
  lock-audit serve [选项]               启动本地 Web 界面
  lock-audit rules                       输出物化后的默认规则 JSON
  lock-audit version                     显示版本

audit 选项：
  --rules <path>        规则配置 JSON（不指定则用内置默认规则）
  --baseline <path>     基线锁文件，用于差异对比
  --out <path>          写入 JSON 报告文件（不指定则打印表格摘要）
  --format <fmt>        table（默认）或 json
  --fail-on <severity>  存在该级别及以上发现时退出码为 1（critical/high/medium/low/info）
  --max-size <bytes>    覆盖规则中的文件大小上限

serve 选项：
  --host <addr>         默认 127.0.0.1
  --port <port>         默认 8080

通用：
  --help                 显示本帮助
`;
