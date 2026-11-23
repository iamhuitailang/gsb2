import express from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { scanDirectory } from './scanner.js';
import { loadProject, saveProject, projectFilePath } from './store.js';

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(process.cwd(), 'public')));

// 允许访问音频的目录白名单：只有扫描过的根目录下的文件才能被读取/试听
const allowedRoots = new Set();

function isAllowed(absPath) {
  const resolved = path.resolve(absPath);
  for (const root of allowedRoots) {
    if (resolved === root || resolved.startsWith(root + path.sep)) return true;
  }
  return false;
}

// ---- 扫描 ----
app.post('/api/scan', async (req, res) => {
  try {
    let dir = String(req.body?.dir || '');
    if (!dir) return res.status(400).json({ error: '缺少 dir 参数' });
    if (dir === '@samples') dir = path.join(process.cwd(), 'public', 'samples'); // 内置示例素材
    const { root, assets } = await scanDirectory(dir);
    allowedRoots.add(root);
    res.json({ root, assets });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---- 音频流（支持 Range，供试听与解码） ----
app.get('/api/audio', async (req, res) => {
  try {
    const root = String(req.query.root || '');
    const rel = String(req.query.path || '');
    const abs = path.resolve(root, rel);
    if (!allowedRoots.has(path.resolve(root)) || !isAllowed(abs)) {
      return res.status(403).json({ error: '该目录未被扫描，禁止访问' });
    }
    const stat = await fsp.stat(abs);
    const range = req.headers.range;
    const mime = mimeOf(abs);
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      const start = m && m[1] ? parseInt(m[1], 10) : 0;
      const end = m && m[2] ? Math.min(parseInt(m[2], 10), stat.size - 1) : stat.size - 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': mime,
      });
      fs.createReadStream(abs, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': mime, 'Accept-Ranges': 'bytes' });
      fs.createReadStream(abs).pipe(res);
    }
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

function mimeOf(file) {
  const ext = path.extname(file).toLowerCase();
  return {
    '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.oga': 'audio/ogg',
    '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.opus': 'audio/ogg',
    '.aiff': 'audio/aiff', '.aif': 'audio/aiff', '.wma': 'audio/x-ms-wma',
  }[ext] || 'application/octet-stream';
}

// ---- 项目存取 ----
app.get('/api/project', async (_req, res) => {
  const project = await loadProject();
  if (project.root) allowedRoots.add(path.resolve(project.root));
  res.json({ project, projectFile: projectFilePath() });
});

app.post('/api/project', async (req, res) => {
  try {
    const project = req.body?.project;
    if (!project || !Array.isArray(project.assets)) {
      return res.status(400).json({ error: '项目数据格式不正确' });
    }
    if (project.root) allowedRoots.add(path.resolve(project.root));
    const file = await saveProject(project);
    res.json({ ok: true, projectFile: file });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- 导出清单（相对路径 + 循环信息 + 标签） ----
app.post('/api/export', async (req, res) => {
  const project = req.body?.project;
  if (!project || !Array.isArray(project.assets)) {
    return res.status(400).json({ error: '项目数据格式不正确' });
  }
  const format = req.query.format === 'csv' ? 'csv' : 'json';
  const rows = project.assets.map((a) => ({
    path: a.path, // 相对扫描根目录
    name: a.name,
    format: a.format,
    duration: a.duration,
    channels: a.channels,
    sampleRate: a.sampleRate,
    tags: a.tags || [],
    loop: a.loopStart != null && a.loopEnd != null
      ? { start: a.loopStart, end: a.loopEnd }
      : null,
  }));
  if (format === 'csv') {
    const esc = (v) => `"${String(v ?? '').replaceAll('"', '""')}"`;
    const header = 'path,name,format,duration,channels,sampleRate,tags,loopStart,loopEnd';
    const body = rows.map((r) => [
      r.path, r.name, r.format, r.duration, r.channels, r.sampleRate,
      r.tags.join('|'), r.loop?.start ?? '', r.loop?.end ?? '',
    ].map(esc).join(',')).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="sfx-manifest.csv"');
    res.send('﻿' + header + '\n' + body);
  } else {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="sfx-manifest.json"');
    res.send(JSON.stringify({ root: project.root, exportedAt: new Date().toISOString(), assets: rows }, null, 2));
  }
});

const PORT = process.env.PORT || 3920;
app.listen(PORT, () => {
  console.log(`SFX Browser 已启动: http://localhost:${PORT}`);
  console.log(`项目索引文件: ${projectFilePath()}`);
});
