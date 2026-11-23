import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * 项目持久化：素材索引 + 标签 + 循环点全部保存在本地 JSON 文件里。
 * 默认位置: <repo>/data/project.json （可用环境变量 SFX_PROJECT_FILE 覆盖）
 */
const DATA_DIR = path.resolve(process.env.SFX_DATA_DIR || path.join(process.cwd(), 'data'));
const PROJECT_FILE = process.env.SFX_PROJECT_FILE
  ? path.resolve(process.env.SFX_PROJECT_FILE)
  : path.join(DATA_DIR, 'project.json');

const EMPTY_PROJECT = {
  version: 1,
  root: null,          // 当前扫描根目录（素材路径均相对它存储）
  assets: [],          // [{ path, name, format, duration, channels, sampleRate, sizeBytes, error, tags: [], loopStart, loopEnd }]
  tagGroups: [],       // [{ id, name }]
  tags: [],            // [{ name, groupId }]
};

export function projectFilePath() {
  return PROJECT_FILE;
}

export async function loadProject() {
  try {
    const raw = await fs.readFile(PROJECT_FILE, 'utf8');
    return { ...EMPTY_PROJECT, ...JSON.parse(raw) };
  } catch {
    return { ...EMPTY_PROJECT };
  }
}

export async function saveProject(project) {
  await fs.mkdir(path.dirname(PROJECT_FILE), { recursive: true });
  const tmp = PROJECT_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(project, null, 2), 'utf8');
  await fs.rename(tmp, PROJECT_FILE);
  return PROJECT_FILE;
}
