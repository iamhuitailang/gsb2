// 把 node_modules 里的 Vue 全局构建复制到 web/vendor，供离线页面使用。
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 脚本位于 <repo>/scripts/ 下，仓库根目录是它的上一级。
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(repoRoot, "node_modules", "vue", "dist", "vue.global.prod.js");
const targetDir = join(repoRoot, "web", "vendor");
const target = join(targetDir, "vue.global.prod.js");

if (!existsSync(source)) {
  console.error(`找不到 ${source}，请先执行 npm install vue@3.5.13`);
  process.exit(1);
}
mkdirSync(targetDir, { recursive: true });
copyFileSync(source, target);
console.log(`已复制 Vue 运行时到 ${target}`);
