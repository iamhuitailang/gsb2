import fs from 'node:fs/promises';
import path from 'node:path';
import { parseFile } from 'music-metadata';

export const AUDIO_EXTENSIONS = new Set([
  '.wav', '.mp3', '.ogg', '.oga', '.flac', '.m4a', '.aac', '.aiff', '.aif', '.opus', '.wma',
]);

/**
 * 递归扫描目录，返回所有音频文件的元数据。
 * 单个文件读取失败只在该条目上记录 error，不影响整批索引。
 */
export async function scanDirectory(rootDir) {
  const root = path.resolve(rootDir);
  const stat = await fs.stat(root).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw new Error(`目录不存在或不可读: ${root}`);
  }

  const files = [];
  await walk(root, files);

  const assets = [];
  for (const absPath of files) {
    assets.push(await probeOne(root, absPath));
  }
  return { root, assets };
}

async function walk(dir, out) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return; // 无权限的子目录直接跳过
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      await walk(full, out);
    } else if (entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      out.push(full);
    }
  }
}

async function probeOne(root, absPath) {
  const rel = path.relative(root, absPath).split(path.sep).join('/');
  const base = {
    path: rel, // 相对扫描根目录的路径，清单导出与项目文件都用它
    name: path.basename(absPath),
    format: null,
    duration: null,
    channels: null,
    sampleRate: null,
    sizeBytes: null,
    error: null,
  };
  try {
    const stat = await fs.stat(absPath);
    base.sizeBytes = stat.size;
    const meta = await parseFile(absPath, { duration: true });
    base.format = meta.format.container || path.extname(absPath).slice(1).toLowerCase();
    base.duration = meta.format.duration ?? null;
    base.channels = meta.format.numberOfChannels ?? null;
    base.sampleRate = meta.format.sampleRate ?? null;
  } catch (err) {
    base.error = `无法解析: ${err.message}`;
  }
  return base;
}
