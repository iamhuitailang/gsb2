/**
 * 生成一套试听用钟声采样到 public/samples/：
 * - 8 个根音 × 轻敲/重敲两层，共 16 条
 * - 部分音色带循环持续段（按住可续、松开进尾音）
 * - 故意制造 1 个损坏文件 + 1 个缺失条目，用于验证坏样本隔离与回退提示
 *
 * 运行：npm run generate:samples
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { synthBell, synthCorruptWav } from './synth.ts';
import { encodeWavPcm16 } from '../src/audio/wav.ts';
import type { SampleManifest, SampleManifestEntry, VelocityLayer } from '../src/types.ts';

const SAMPLE_RATE = 44100;
const ROOTS = [48, 52, 55, 60, 64, 67, 72, 76]; // C3 E3 G3 C4 E4 G4 C5 E5
const LOOPED_ROOTS = new Set([55, 60, 67]); // G3 C4 G4 带持续段
const CORRUPT_ZONE: [number, VelocityLayer] = [52, 'hard']; // E3 重敲：文件损坏
const MISSING_ZONE: [number, VelocityLayer] = [67, 'soft']; // G4 轻敲：文件缺失（不写盘）

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'public', 'samples');
mkdirSync(outDir, { recursive: true });

const entries: SampleManifestEntry[] = [];

for (const root of ROOTS) {
  for (const layer of ['soft', 'hard'] as VelocityLayer[]) {
    const file = `${root}-${layer}.wav`;
    const looped = LOOPED_ROOTS.has(root);
    const isCorrupt = root === CORRUPT_ZONE[0] && layer === CORRUPT_ZONE[1];
    const isMissing = root === MISSING_ZONE[0] && layer === MISSING_ZONE[1];

    if (isCorrupt) {
      writeFileSync(join(outDir, file), synthCorruptWav(root + 99));
      entries.push({ root, layer, file, fault: 'corrupt' });
      console.log(`  写入损坏样本 ${file}（用于测试坏样本提示）`);
      continue;
    }
    if (isMissing) {
      entries.push({ root, layer, file, fault: 'missing' });
      console.log(`  登记缺失样本 ${file}（不写盘，用于测试 404 回退）`);
      continue;
    }

    const { samples, loopStart, loopEnd } = synthBell(root, layer, looped, SAMPLE_RATE);
    writeFileSync(join(outDir, file), encodeWavPcm16(samples, SAMPLE_RATE));
    const entry: SampleManifestEntry = { root, layer, file };
    if (looped && loopStart !== undefined && loopEnd !== undefined) {
      entry.loopStart = loopStart;
      entry.loopEnd = loopEnd;
    }
    entries.push(entry);
    console.log(`  写入 ${file}${looped ? '（带循环持续段）' : ''}`);
  }
}

const manifest: SampleManifest = {
  sampleRate: SAMPLE_RATE,
  channels: 1,
  velocityThreshold: 80,
  samples: entries,
};
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`\n完成：${entries.length} 条样本声明，输出到 public/samples/`);
console.log('故障键区：E3·重敲（损坏）、G4·轻敲（缺失）');
