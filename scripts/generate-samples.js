#!/usr/bin/env node
/*
 * generate-samples.js —— 把内置合成样例导出为 public/samples/*.wav
 *
 * 运行：npm run generate:samples
 * 页面默认直接在浏览器内合成样例（离线可用），这些 WAV 是给需要
 * 直接拿文件做导入测试/外部播放器核对时用的，产物已在 .gitignore 忽略。
 */
const fs = require('node:fs');
const path = require('node:path');
const WavCodec = require('../public/js/wav-codec.js');
const Samples = require('../public/js/samples.js');

const outDir = path.join(__dirname, '..', 'public', 'samples');
fs.mkdirSync(outDir, { recursive: true });

const manifest = [];
for (const s of Samples.buildAll()) {
  const { buffer } = WavCodec.encodeWav(s.channels, s.sampleRate);
  const file = s.id + '.wav';
  fs.writeFileSync(path.join(outDir, file), Buffer.from(buffer));
  manifest.push({
    id: s.id,
    file,
    name: s.name,
    sampleRate: s.sampleRate,
    channels: s.channels.length,
    frames: s.channels[0].length,
    durationSec: s.channels[0].length / s.sampleRate,
    markers: s.markers,
  });
  console.log('生成 ' + file + ' (' + s.name + ')');
}

fs.writeFileSync(
  path.join(outDir, 'manifest.json'),
  JSON.stringify(manifest, null, 2) + '\n'
);
console.log('共 ' + manifest.length + ' 个样例 -> ' + path.relative(process.cwd(), outDir));
