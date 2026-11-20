// 离线审计：确认源码中不存在白名单之外的外部 URL。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const allow = ['w3.org', 'example.com', 'example.org', 'demo.local', '.test', '.invalid', 'local.invalid'];
// 提示文案中的占位示例与代码中的回环地址模板，均非真实外联
const placeholders = ['https://host:', 'http://${host}', 'http://${HOST}'];
function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const files = [...walk('src'), ...walk('web'), 'server.mjs'].filter((f) => /\.(js|mjs|html|css)$/.test(f));
const re = /https?:\/\/[^\s"'`)\\]+/g;
const bad = [];
for (const f of files) {
  const text = readFileSync(f, 'utf8');
  for (const m of text.match(re) || []) {
    if (placeholders.some((p) => m.startsWith(p))) continue;
    if (!allow.some((a) => m.includes(a))) bad.push(`${f} -> ${m}`);
  }
}
if (bad.length) {
  console.error('发现白名单外 URL：\n' + bad.join('\n'));
  process.exit(1);
}
console.log('OK: 源码中不存在白名单外的外部 URL（仅规范文档链接与演示域）');
