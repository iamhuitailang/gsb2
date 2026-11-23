import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const DATA_DIR = path.join(ROOT, 'data');
export const MEDIA_DIR = path.join(DATA_DIR, 'media');
export const EXPORT_DIR = path.join(DATA_DIR, 'exports');
export const AUDIO_CACHE_DIR = path.join(DATA_DIR, 'audio-cache');
export const SAMPLE_DIR = path.join(PUBLIC_DIR, 'samples');

export async function ensureDirs() {
  await Promise.all([
    fs.mkdir(MEDIA_DIR, { recursive: true }),
    fs.mkdir(EXPORT_DIR, { recursive: true }),
    fs.mkdir(AUDIO_CACHE_DIR, { recursive: true }),
    fs.mkdir(SAMPLE_DIR, { recursive: true }),
  ]);
}

export function run(cmd, args, { input, cwd, maxBuffer = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', reject);
    child.on('close', (code) => {
      const stdout = Buffer.concat(out);
      const stderr = Buffer.concat(err).toString();
      if (code === 0) resolve({ stdout, stderr });
      else reject(Object.assign(new Error(`${cmd} exited ${code}\n${stderr.slice(-4000)}`), { code, stderr, stdout }));
    });
    if (input) {
      child.stdin.end(input);
    }
  });
}

export const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
export const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
