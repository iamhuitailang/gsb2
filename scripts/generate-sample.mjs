/**
 * 生成 samples/ 下的示例工程与预览图：
 *   samples/mossling.pixanim.json   可直接在工具里"打开工程"
 *   samples/mossling-sheet.png      4 列精灵表预览
 *   samples/mossling-preview.gif    按每帧时长循环的 GIF
 *
 * 用法：npm run generate:samples
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMosslingProject } from '../src/samples/mossling.js';
import {
  compositeFrame,
  serializeProject,
  totalLoopDuration,
} from '../src/core/project.js';
import { encodeGif } from '../src/core/gif.js';
import { buildSpriteSheet, scaleSheet } from '../src/core/spritesheet.js';
import { encodePng } from './lib/png.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, '..', 'samples');
fs.mkdirSync(outDir, { recursive: true });

const project = createMosslingProject();
// 固定英文基础名，README 里的图片与示例链接都依赖它。
const base = 'mossling';

const composites = project.frames.map((frame) => ({
  data: compositeFrame(project, frame),
  duration: frame.duration,
}));

const projectPath = path.join(outDir, `${base}.pixanim.json`);
fs.writeFileSync(projectPath, serializeProject(project), 'utf8');

const sheet = buildSpriteSheet({
  width: project.width,
  height: project.height,
  frames: composites,
  columns: 4,
  cellGap: 1,
});
const scaled = scaleSheet(sheet, 4);
const sheetPath = path.join(outDir, `${base}-sheet.png`);
fs.writeFileSync(sheetPath, encodePng(scaled));

const gif = encodeGif({
  width: project.width,
  height: project.height,
  frames: composites,
  loop: true,
});
const gifPath = path.join(outDir, `${base}-preview.gif`);
fs.writeFileSync(gifPath, gif);

const durations = project.frames.map((f) => f.duration);
console.log(`工程：${path.relative(process.cwd(), projectPath)}`);
console.log(`精灵表：${path.relative(process.cwd(), sheetPath)}（${sheet.columns}×${sheet.rows}，4 倍放大）`);
console.log(`GIF：${path.relative(process.cwd(), gifPath)}（${gif.length} 字节）`);
console.log(`帧数：${project.frames.length}，帧时长：${durations.join(' / ')} ms`);
console.log(`循环时长：${totalLoopDuration(project)} ms`);
