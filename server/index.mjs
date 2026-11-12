/**
 * HTTP 服务（node:http，零 Web 框架）。
 * 路由：
 *  POST   /api/upload              multipart 上传，触发检查流水线
 *  GET    /api/tasks               任务列表
 *  GET    /api/tasks/:id           任务详情
 *  GET    /api/tasks/:id/audit     单任务审计记录
 *  GET    /api/audit               全局审计记录
 *  GET    /api/download/:id        仅 accepted 任务可取回；quarantined 一律 403
 *  DELETE /api/quarantine/:id      清理单个隔离文件（任务记录保留并标记 purged）
 *  POST   /api/quarantine/purge-all 清理全部隔离文件
 * 静态资源：构建后的 client/dist（开发期由 Vite 5173 端口提供，见 README）
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import busboy from 'busboy';
import { config, ensureDataDirs } from './config.mjs';
import { ensureInside, safeDisplayName } from './lib/paths.mjs';
import { inspectFile } from './inspection.mjs';
import {
  addAudit, deleteTask, getTask, listAudit, listByStatus, listTasks, openDb, updateTask,
} from './db.mjs';

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon'],
  ['.json', 'application/json; charset=utf-8'],
]);

export function createServer() {
  ensureDataDirs();
  openDb();

  return http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error('[server] 未捕获错误:', err);
      sendJson(res, 500, { error: '服务器内部错误' });
    });
  });
}

// 直接运行（npm start / dev:server）时启动监听；被测试 import 时不自动监听
const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href;
if (invokedDirectly) {
  const server = createServer();
  server.listen(config.port, () => {
    console.log(`文件接收与隔离工作台已启动: http://localhost:${config.port}`);
    console.log(`数据目录（不会暴露给页面）: ${config.dataDir}`);
  });
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  if (pathname === '/api/health' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, limits: redactLimits() });
  }
  if (pathname === '/api/upload' && req.method === 'POST') {
    return handleUpload(req, res);
  }
  if (pathname === '/api/tasks' && req.method === 'GET') {
    return sendJson(res, 200, { tasks: listTasks() });
  }

  const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)(\/audit)?$/);
  if (taskMatch && req.method === 'GET') {
    const task = getTask(taskMatch[1]);
    if (!task) return sendJson(res, 404, { error: '任务不存在' });
    if (taskMatch[2]) {
      return sendJson(res, 200, { records: listAudit(task.id) });
    }
    return sendJson(res, 200, { task });
  }

  if (pathname === '/api/audit' && req.method === 'GET') {
    return sendJson(res, 200, { records: listAudit() });
  }

  const downloadMatch = pathname.match(/^\/api\/download\/([^/]+)$/);
  if (downloadMatch && req.method === 'GET') {
    return handleDownload(req, res, downloadMatch[1]);
  }

  const qMatch = pathname.match(/^\/api\/quarantine\/([^/]+)$/);
  if (qMatch && req.method === 'DELETE') {
    return handleQuarantineDelete(res, qMatch[1]);
  }
  if (pathname === '/api/quarantine/purge-all' && req.method === 'POST') {
    return handlePurgeAll(res);
  }

  if (pathname.startsWith('/api/')) {
    return sendJson(res, 404, { error: '接口不存在' });
  }
  return serveStatic(res, pathname);
}

// ---------------- 上传 ----------------

function handleUpload(req, res) {
  const ct = req.headers['content-type'] || '';
  if (!ct.includes('multipart/form-data')) {
    return sendJson(res, 400, { error: '需要 multipart/form-data 上传' });
  }

  let bb;
  try {
    bb = busboy({
      headers: req.headers,
      limits: {
        fileSize: config.limits.maxUploadBytes,
        files: 1,
        fields: 5,
        fieldNameSize: 100,
        fieldSize: 1024,
      },
    });
  } catch (err) {
    return sendJson(res, 400, { error: `请求格式错误: ${err.message}` });
  }

  let settled = false;
  let tmpPath = null;
  let writeStream = null;
  let writeDone = null; // 在 file 事件中赋值为“写入完成”的 Promise
  let truncated = false;
  let meta = null;
  const { maxUploadBytes } = config.limits;

  bb.on('file', (fieldName, fileStream, info) => {
    if (fieldName !== 'file') {
      fileStream.resume();
      return;
    }
    meta = info;
    // 临时名也由服务端随机生成，客户端不参与任何路径决策
    tmpPath = path.join(config.dirs.tmp, `up_${randomUUID()}.part`);
    writeStream = fs.createWriteStream(tmpPath, { mode: 0o600 });
    writeDone = new Promise((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });
    fileStream.pipe(writeStream);

    fileStream.on('limit', () => {
      truncated = true;
    });
    writeStream.on('error', (err) => {
      if (!settled) {
        settled = true;
        cleanupTmp(tmpPath);
        sendJson(res, 500, { error: `临时文件写入失败: ${err.message}` });
        req.resume();
      }
    });
  });

  bb.on('error', (err) => {
    if (settled) return;
    settled = true;
    cleanupTmp(tmpPath);
    const tooLarge = /maximum|limit/i.test(err.message);
    sendJson(res, tooLarge ? 413 : 400, {
      error: tooLarge ? `文件超过大小上限 ${maxUploadBytes} 字节` : `上传解析失败: ${err.message}`,
    });
  });

  bb.on('close', async () => {
    if (settled) return;
    settled = true;
    try {
      // 关键：busboy 的 close 只代表表单解析结束，必须等管道写入 flush 完成
      if (writeDone) await writeDone;
    } catch {
      cleanupTmp(tmpPath);
      return sendJson(res, 500, { error: '临时文件写入失败' });
    }
    if (!meta || !tmpPath || !fs.existsSync(tmpPath)) {
      cleanupTmp(tmpPath);
      return sendJson(res, 400, { error: '未收到上传文件（表单字段名应为 file）' });
    }
    if (truncated) {
      // 超限文件直接隔离，同样走完整检查流程以便留下拒收记录
      const declared = fs.statSync(tmpPath).size;
      const task = await inspectFile({
        tmpPath,
        originalName: safeDisplayName(meta.filename),
        clientMime: meta.mimeType,
        declaredSize: declared,
      });
      // 显式补一条大小超限原因（截断发生时实际字节等于上限，原因可能尚未被流水线捕获）
      if (task.status === 'accepted') {
        updateTask(task.id, {
          status: 'quarantined',
          reasons: [...task.reasons, `上传在 ${maxUploadBytes} 字节处被服务端截断，判定超过大小上限`],
        });
        moveAcceptedToQuarantine(task);
        addAudit(task.id, 'inspect.rejected', `流式上传触发硬上限 ${maxUploadBytes} 字节`);
      }
      return sendJson(res, 413, { error: '文件超过大小上限', task: getTask(task.id) });
    }

    const task = await inspectFile({
      tmpPath,
      originalName: safeDisplayName(meta.filename),
      clientMime: meta.mimeType,
      declaredSize: fs.statSync(tmpPath).size,
    });
    return sendJson(res, 200, { task });
  });

  req.pipe(bb);
}

function moveAcceptedToQuarantine(task) {
  if (!task.storage_name) return;
  const oldPath = ensureInside(config.dirs.accepted, path.join(config.dirs.accepted, task.storage_name));
  const qName = `q_${randomUUID()}.bin`;
  const newPath = ensureInside(config.dirs.quarantine, path.join(config.dirs.quarantine, qName));
  if (fs.existsSync(oldPath)) {
    fs.renameSync(oldPath, newPath);
    fs.chmodSync(newPath, 0o400);
  }
  updateTask(task.id, { storage_name: qName });
  addAudit(task.id, 'quarantine.moved', `大小上限复核失败，转隔离，隔离名=${qName}`);
}

// ---------------- 下载 ----------------

function handleDownload(req, res, id) {
  const task = getTask(id);
  if (!task) return sendJson(res, 404, { error: '任务不存在' });

  // 核心隔离要求：隔离区文件不存在普通下载通道
  if (task.status !== 'accepted' || !task.storage_name) {
    addAudit(task.id, 'download.denied', `状态=${task.status}，下载请求被拒绝`);
    return sendJson(res, 403, {
      error: '该文件未通过检查，处于隔离区，无法通过下载接口取回',
      status: task.status,
      reasons: task.reasons,
    });
  }

  const filePath = ensureInside(config.dirs.accepted, path.join(config.dirs.accepted, task.storage_name));
  if (!fs.existsSync(filePath)) {
    addAudit(task.id, 'download.error', '存储文件缺失');
    return sendJson(res, 410, { error: '存储文件已不存在' });
  }

  const type = config.limits.allowed[task.detected_type];
  const dispositionName = encodeContentDisposition(task.original_name);
  res.writeHead(200, {
    // 对内固定用服务端认可的 MIME；不回传浏览器声明值
    'Content-Type': type ? type.mime : 'application/octet-stream',
    'Content-Length': task.stored_size ?? fs.statSync(filePath).size,
    'Content-Disposition': `attachment; filename="download${path.extname(filePath)}"; filename*=UTF-8''${dispositionName}`,
    'X-Content-Type-Options': 'nosniff',
  });
  addAudit(task.id, 'download.allowed', `存储名=${task.storage_name}`);
  fs.createReadStream(filePath).pipe(res);
}

// ---------------- 隔离清理 ----------------

function handleQuarantineDelete(res, id) {
  const task = getTask(id);
  if (!task) return sendJson(res, 404, { error: '任务不存在' });
  if (task.status !== 'quarantined') {
    return sendJson(res, 409, { error: `任务状态为 ${task.status}，不是隔离状态，拒绝执行隔离清理` });
  }

  // 只允许操作 quarantine 目录内、且数据库登记过的随机隔离名
  if (task.storage_name) {
    const qPath = ensureInside(
      config.dirs.quarantine,
      path.join(config.dirs.quarantine, task.storage_name),
    );
    if (fs.existsSync(qPath)) {
      fs.unlinkSync(qPath);
    }
  }
  updateTask(id, { status: 'purged', storage_name: null });
  addAudit(id, 'quarantine.purged', '隔离文件已清理，任务记录保留');
  return sendJson(res, 200, { task: getTask(id) });
}

function handlePurgeAll(res) {
  const quarantined = listByStatus('quarantined');
  let removed = 0;
  for (const task of quarantined) {
    if (task.storage_name) {
      const qPath = ensureInside(
        config.dirs.quarantine,
        path.join(config.dirs.quarantine, task.storage_name),
      );
      if (fs.existsSync(qPath)) {
        fs.unlinkSync(qPath);
        removed += 1;
      }
    }
    updateTask(task.id, { status: 'purged', storage_name: null });
    addAudit(task.id, 'quarantine.purged', '批量清理隔离文件');
  }
  addAudit(null, 'quarantine.purge-all', `批量清理 ${removed} 个隔离文件`);
  return sendJson(res, 200, { purged: removed, tasks: quarantined.length });
}

// ---------------- 静态资源 ----------------

function serveStatic(res, pathname) {
  const distDir = path.resolve(process.cwd(), 'client/dist');
  if (!fs.existsSync(distDir)) {
    return sendJson(res, 200, {
      message: '前端尚未构建。开发模式请运行 npm run dev:client（Vite 5173），或执行 npm run build。',
    }, 'text/plain; charset=utf-8');
  }
  let rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = ensureInside(distDir, path.join(distDir, rel));
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    // SPA 回退
    return pipeFile(res, path.join(distDir, 'index.html'));
  }
  return pipeFile(res, filePath);
}

function pipeFile(res, filePath) {
  if (!fs.existsSync(filePath)) return sendJson(res, 404, { error: 'Not Found' });
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME_TYPES.get(ext) || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

// ---------------- 工具 ----------------

function sendJson(res, status, payload, contentType = 'application/json; charset=utf-8') {
  const body = contentType.includes('json') ? JSON.stringify(payload, null, 2) : String(payload.message || '');
  res.writeHead(status, { 'Content-Type': contentType });
  res.end(body);
}

function cleanupTmp(p) {
  if (p) fs.rm(p, { force: true }, () => {});
}

function encodeContentDisposition(name) {
  return encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function redactLimits() {
  // 给页面展示限制用，不含任何路径信息
  const { maxUploadBytes, allowed, zip } = config.limits;
  return {
    maxUploadBytes,
    zip,
    allowed: Object.fromEntries(Object.entries(allowed).map(([k, v]) => [k, v.label])),
  };
}
