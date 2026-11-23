#!/usr/bin/env node
// 生成内建演示素材：带帧号条码、同位置色块、中央帧号，以及每段不同走向的扫频音。
// 条码可逐帧精确解码出源帧号；色块在叠化时同位置混色，可量出叠化的 alpha。
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SAMPLE_SPECS, SAMPLE_AUDIO, SAMPLE_VERSION } from '../src/samples.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(ROOT, 'public', 'samples');
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const VERSION_FILE = path.join(OUT, '.version.json');

const FONT_CANDIDATES = [
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
  '/System/Library/Fonts/Helvetica.ttc',
  '/Library/Fonts/Arial.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
];

const BAR = { bits: 16, cell: 22, x: 18, y: 312, h: 30 };

function run(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg ${c}\n${err.slice(-3000)}`))));
  });
}

async function pickFont() {
  for (const f of FONT_CANDIDATES) {
    try { await fs.access(f); return f; } catch { /* next */ }
  }
  return null;
}

function fdir(dir) {
  return path.join(OUT, dir);
}

function barcodeFilters() {
  const back = `drawbox=x=${BAR.x - 4}:y=${BAR.y - 4}:w=${BAR.bits * BAR.cell + 4}:h=${BAR.h + 8}:color=black@0.55:t=fill`;
  const parts = [back];
  for (let k = 0; k < BAR.bits; k++) {
    const x = BAR.x + k * BAR.cell;
    parts.push(
      `drawbox=x=${x}:y=${BAR.y}:w=${BAR.cell - 2}:h=${BAR.h}:color=white@0.92:t=fill:` +
      `enable='eq(mod(floor(n/${2 ** k}),2),1)'`,
    );
  }
  return parts.join(',');
}

function videoFilters(spec, font) {
  const [r, g, b] = spec.base;
  const [ar, ag, ab] = spec.accent;
  const [pr, pg, pb] = spec.patch.color;
  const filters = [
    // 背景细纹理，避免大块纯色编码损失
    `drawbox=x=0:y=0:w=iw:h=ih:color=0x${hex(r)}${hex(g)}${hex(b)}:t=fill`,
    `drawgrid=w=40:h=40:t=1:c=0x${hex(clamp8(r + 10))}${hex(clamp8(g + 10))}${hex(clamp8(b + 10))}@0.6`,
    // 顶部色带
    `drawbox=x=0:y=0:w=iw:h=6:color=0x${hex(ar)}${hex(ag)}${hex(ab)}:t=fill`,
    // 右上角标记色块（叠化混色采样点）
    `drawbox=x=${spec.patch.x}:y=${spec.patch.y}:w=${spec.patch.w}:h=${spec.patch.h}:color=0x${hex(pr)}${hex(pg)}${hex(pb)}:t=fill`,
    `drawbox=x=${spec.patch.x - 2}:y=${spec.patch.y - 2}:w=${spec.patch.w + 4}:h=${spec.patch.h + 4}:color=white@0.8:t=3`,
    barcodeFilters(),
  ];
  if (font) {
    filters.push(
      `drawtext=fontfile='${font}':text='%{frame_num}':fontcolor=white:fontsize=112:` +
      `x=(w-text_w)/2:y=(h-text_h)/2-10:box=1:boxcolor=black@0.35:boxborderw=18`,
      `drawtext=fontfile='${font}':text='${spec.label}':fontcolor=0x${hex(ar)}${hex(ag)}${hex(ab)}:` +
      `fontsize=48:x=26:y=24:box=1:boxcolor=black@0.45:boxborderw=10`,
      `drawtext=fontfile='${font}':text='${spec.fps} fps':fontcolor=white@0.85:fontsize=22:x=26:y=86`,
    );
  }
  return filters.join(',');
}

function audioFilter(spec) {
  const T = spec.duration;
  const { f0, f1 } = spec.tone;
  const amp = SAMPLE_AUDIO.amplitude;
  // 相位积分后的线性扫频：f(t) = f0 + (f1-f0) t/T
  const expr = `${amp}*sin(2*PI*(${f0}*t + (${(f1 - f0) / (2 * T)} )*t*t))`;
  return `aevalsrc=${expr}:s=${SAMPLE_AUDIO.sampleRate}:c=stereo:d=${T}`;
}

function hex(n) { return Math.round(n).toString(16).padStart(2, '0'); }
function clamp8(n) { return Math.max(0, Math.min(255, n)); }

async function buildSample(spec, font) {
  const out = path.join(OUT, spec.fileName);
  await fs.mkdir(OUT, { recursive: true });
  const tmp = path.join(OUT, `.${spec.fileName}.tmp.mp4`);
  await fs.rm(tmp, { force: true });
  const args = [];
  args.push(
    '-f', 'lavfi', '-i',
    `color=c=black:s=${spec.width}x${spec.height}:r=${spec.fps}:d=${spec.duration}`,
  );
  if (spec.hasAudio) {
    args.push('-f', 'lavfi', '-i', audioFilter(spec));
  }
  args.push(
    '-vf', videoFilters(spec, font),
    '-t', String(spec.duration),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-g', '1', '-keyint_min', '1', '-sc_threshold', '0',
    '-r', String(spec.fps),
  );
  if (spec.hasAudio) {
    args.push('-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', String(SAMPLE_AUDIO.sampleRate));
  } else {
    args.push('-an');
  }
  args.push('-movflags', '+faststart', '-y', tmp);
  await run(args);
  await fs.rm(out, { force: true });
  await fs.rename(tmp, out);
  return out;
}

async function main() {
  const font = await pickFont();
  console.log(`[samples] font: ${font || '(none, 跳过文字)'}`);
  for (const spec of SAMPLE_SPECS) {
    process.stdout.write(`[samples] ${spec.fileName} ... `);
    await buildSample(spec, font);
    console.log('ok');
  }
  await fs.writeFile(VERSION_FILE, JSON.stringify({ version: SAMPLE_VERSION, generatedAt: new Date().toISOString(), specs: SAMPLE_SPECS.map((s) => s.id) }, null, 2));
  console.log('[samples] done');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

export { buildSample, barcodeFilters, videoFilters, BAR };
