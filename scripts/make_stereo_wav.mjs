// scripts/make_stereo_wav.mjs — 生成立体声测试 WAV 供浏览器冒烟使用。
// 左声道渐弱、右声道近静音,两声道内容不同以便确认声道不串。
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSignal, encodeWav } from '../dsp.js';

const sr = 22050;
const left = generateSignal('fade', sr).channels[0];
const right = generateSignal('quiet', sr).channels[0];
const buf = encodeWav([left, right], sr, 16);
const out = new URL('./stereo-sample.wav', import.meta.url);
mkdirSync(dirname(fileURLToPath(out)), { recursive: true });
writeFileSync(fileURLToPath(out), Buffer.from(buf));
console.log(`wrote ${fileURLToPath(out)} (${buf.byteLength} bytes, 2 ch, ${sr} Hz)`);
