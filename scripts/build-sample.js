/**
 * 生成示例剧情：samples/misty-lighthouse.story.json
 * 源数据在 src/sample.js，这里只负责写盘，保证示例与「新建项目 → 载入示例」完全一致。
 * 运行：node scripts/build-sample.js
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { serializeProject } from '../src/story.js';
import { mistyLighthouseStory } from '../src/sample.js';

const dir = resolve(fileURLToPath(new URL('../samples', import.meta.url)));
await mkdir(dir, { recursive: true });

const story = mistyLighthouseStory();
const output = resolve(dir, 'misty-lighthouse.story.json');
await writeFile(output, serializeProject(story), 'utf8');

const choices = story.nodes.reduce((total, node) => total + node.choices.length, 0);
console.log(`已生成示例剧情 → ${output}`);
console.log(`节点 ${story.nodes.length}，选项 ${choices}，语言 ${story.locales.length}`);
