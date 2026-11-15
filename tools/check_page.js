#!/usr/bin/env node
// 校验 static/index.html 内联脚本的 JS 语法：node tools/check_page.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const file = path.join(__dirname, "..", "app", "static", "index.html");
const html = fs.readFileSync(file, "utf8");
const m = html.match(/<script>([\s\S]*?)<\/script>/g);
if (!m) {
  console.error("未找到内联 <script>");
  process.exit(1);
}
let ok = 0;
m.forEach((block, i) => {
  const src = block.replace(/^<script>/, "").replace(/<\/script>$/, "");
  try {
    new vm.Script(src, { filename: `index.html#script${i + 1}` });
    ok++;
  } catch (e) {
    console.error(`脚本 #${i + 1} 语法错误：${e.message}`);
    process.exit(1);
  }
});
console.log(`OK: ${ok} 个内联脚本语法正确`);
