#!/usr/bin/env node
/**
 * 生成示例素材（可重复运行）。
 */
import { ensureSampleSet, SAMPLE_DIR } from './samples.js';

const force = process.argv.includes('--force');
const info = await ensureSampleSet({ force });
console.log(`示例目录：${info.dir}`);
console.log(`生成文件：${info.generated.length ? info.generated.join('\n  ') : '无（已存在，使用 --force 重建）'}`);
void SAMPLE_DIR;
