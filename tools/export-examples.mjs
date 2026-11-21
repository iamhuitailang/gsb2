/*
 * 把程序化示例数据导出为游戏可读的 manifest JSON。
 * 运行：node tools/export-examples.mjs
 * 每个数据集导出两份：镜像补齐开 / 关，便于对照 unresolved 与 substitutions 的差异。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const Exporter = require(path.join(here, '..', 'js', 'exporter.js'));
const { datasets } = require(path.join(here, '..', 'js', 'example-data.js'));

const outDir = path.join(here, '..', 'examples');
mkdirSync(outDir, { recursive: true });

for (const ds of datasets) {
  for (const mirror of [true, false]) {
    const suffix = mirror ? 'mirror-on' : 'mirror-off';
    const file = path.join(outDir, `${ds.id}.${suffix}.json`);
    writeFileSync(file, Exporter.toJSON(ds, mirror, true) + '\n');
    const cfg = Exporter.buildConfig(ds, mirror);
    console.log(`写出 ${path.relative(process.cwd(), file)}  ` +
      `替代 ${cfg.substitutions.length} 处，未解决缺口 ${cfg.unresolved.length} 处`);
  }
}
console.log('完成。');
