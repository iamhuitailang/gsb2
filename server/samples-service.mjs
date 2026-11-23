// 内建演示素材：缺失或版本过旧时自动生成。
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { SAMPLE_DIR, ROOT, FFMPEG } from './util.mjs';
import { SAMPLE_SPECS, SAMPLE_VERSION } from '../src/samples.js';

const VERSION_FILE = path.join(SAMPLE_DIR, '.version.json');

function runNode(script, args = []) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [script, ...args], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (c) => (c === 0 ? resolve(out) : reject(new Error(`${err || out}`.slice(-3000)))));
  });
}

export async function samplesReady() {
  try {
    const version = JSON.parse(await fs.readFile(VERSION_FILE, 'utf8'));
    if (version.version !== SAMPLE_VERSION) return false;
    for (const spec of SAMPLE_SPECS) {
      const st = await fs.stat(path.join(SAMPLE_DIR, spec.fileName));
      if (!st.size) return false;
    }
    return true;
  } catch {
    return false;
  }
}

let generating = null;

export async function ensureSamples({ force = false } = {}) {
  if (!force && (await samplesReady())) {
    return { generated: false, ready: true };
  }
  if (generating) return generating;
  generating = (async () => {
    const script = path.join(ROOT, 'scripts', 'generate-samples.mjs');
    const log = await runNode(script);
    generating = null;
    return { generated: true, ready: await samplesReady(), log: log.slice(-2000) };
  })().catch((err) => {
    generating = null;
    throw err;
  });
  return generating;
}

export { FFMPEG };
