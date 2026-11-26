// 工程文件保存 / 打开。素材本身不入库、不上传，工程文件只记录素材的
// 文件名、大小等指纹与偏移/切点决定；重新打开时按文件名+大小匹配本地素材。

import { createProject } from './model.js';

export const PROJECT_FORMAT = 'multicam-project';
export const PROJECT_VERSION = 1;

export function serializeProject(project, name = 'multicam-project') {
  return JSON.stringify(
    {
      format: PROJECT_FORMAT,
      formatVersion: PROJECT_VERSION,
      name,
      savedAt: new Date().toISOString(),
      sources: project.sources.map((s) => ({
        id: s.id,
        name: s.name,
        path: s.path || null, // 仅作溯源，浏览器重新打开时不会直接访问该路径
        size: s.size ?? null,
        kind: s.kind,
        duration: s.duration,
        fps: s.fps,
        offset: s.offset,
        hasAudio: !!s.hasAudio,
      })),
      cuts: project.cuts.map((c) => ({ id: c.id, time: c.time, sourceId: c.sourceId })),
    },
    null,
    2,
  );
}

/**
 * 解析工程文件。handles 为重新选择的本地文件数组（File），
 * 按 name+size 优先、name 兜底匹配。
 * 返回 { project, missing }：missing 为找不到本地素材的源，
 * 其引用的段在时间线上仍保留并标注「素材缺失」，不会被静默丢弃。
 */
export function deserializeProject(json, handles = []) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  if (data.format !== PROJECT_FORMAT) {
    throw new Error('不是本工具导出的工程文件（format 字段不匹配）');
  }
  const project = createProject();
  const missing = [];
  for (const saved of data.sources) {
    const handle =
      handles.find((f) => f.name === saved.name && (saved.size == null || f.size === saved.size)) ||
      handles.find((f) => f.name === saved.name) ||
      null;
    project.sources.push({ ...saved, handle });
    if (!handle) missing.push({ sourceId: saved.id, name: saved.name });
  }
  const ids = new Set(project.sources.map((s) => s.id));
  project.cuts = (data.cuts || [])
    .filter((c) => ids.has(c.sourceId))
    .map((c) => ({ id: String(c.id), time: Number(c.time), sourceId: c.sourceId }));
  project.cuts.sort((a, b) => a.time - b.time);
  return { project, missing, name: data.name || '未命名工程' };
}
