#!/usr/bin/env node
/**
 * 从 demo/sample-logs.jsonl 生成浏览器端演示数据 src/web/demo-data.js。
 * 纯本地文件读写，不涉及任何网络访问。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'demo', 'sample-logs.jsonl');
const dest = path.join(root, 'src', 'web', 'demo-data.js');

const text = fs.readFileSync(src, 'utf8');
const out =
  '/* 由 demo/sample-logs.jsonl 同步生成（npm run gen:demo），请勿手工编辑 */\n' +
  `window.SANLOG_DEMO_TEXT = ${JSON.stringify(text)};\n`;

fs.writeFileSync(dest, out);
console.log(`已生成 ${path.relative(root, dest)}（${Buffer.byteLength(out)} 字节）`);
