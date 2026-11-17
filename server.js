/**
 * 离线检查单演示 —— 服务端
 *
 * 零依赖：仅使用 Node 内置模块。
 * 数据保存在内存里，重启进程即恢复初始演示数据。
 *
 * 关键规则：
 *  - 授权按“员工 × 检查点”维度管理（grants）。
 *  - 提交检查单时逐条按当前权限核对，无权限返回 403，服务端不落任何数据。
 *  - 同一份草稿（draftId）的重复提交只入库一份：已存在则直接返回原记录（幂等）。
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import crypto from 'node:crypto';

const PORT = process.env.PORT ? Number(process.env.PORT) : 4319;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');

const VALID_RESULTS = new Set(['pass', 'fail', 'n/a']);

// ---------------------------------------------------------------------------
// 内存数据（演示用）
// ---------------------------------------------------------------------------
function seed() {
  return {
    checkpoints: [
      {
        id: 'CP-A',
        name: '甲点 · 一号车间电气柜',
        tasks: [
          { id: 't1', label: '柜门接地是否完好' },
          { id: 't2', label: '柜内有无积尘、异味' },
        ],
        materials: '资料：电气柜点检基准 v3（额定电压、扭矩参数见附件）',
      },
      {
        id: 'CP-B',
        name: '乙点 · 原料仓库消防通道',
        tasks: [
          { id: 't1', label: '通道是否被货物占用' },
          { id: 't2', label: '灭火器压力指针是否在绿区' },
        ],
        materials: '资料：仓库消防周检表（通道宽度 ≥ 1.2m）',
      },
    ],
    employees: [{ id: 'e1', name: '王检（现场检查员）' }],
    // grantKey: `${employeeId}:${checkpointId}` -> boolean
    grants: new Set(['e1:CP-A', 'e1:CP-B']),
    records: [], // 正式检查单
  };
}

let db = seed();

const grantKey = (employeeId, checkpointId) => `${employeeId}:${checkpointId}`;
const hasGrant = (employeeId, checkpointId) =>
  db.grants.has(grantKey(employeeId, checkpointId));

// ---------------------------------------------------------------------------
// HTTP 工具
// ---------------------------------------------------------------------------
function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function readJsonBody(req, limitBytes = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(Object.assign(new Error('请求体过大'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('JSON 解析失败'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function publicEmployee(employeeId) {
  const employee = db.employees.find((e) => e.id === employeeId);
  if (!employee) return null;
  return {
    id: employee.id,
    name: employee.name,
    permissions: db.checkpoints.map((cp) => ({
      checkpointId: cp.id,
      checkpointName: cp.name,
      granted: hasGrant(employee.id, cp.id),
    })),
  };
}

// ---------------------------------------------------------------------------
// 业务接口
// ---------------------------------------------------------------------------
const routes = {
  // 检查任务与资料（只返回检查点本身；当前权限走 /api/me 单独核对）
  'GET /api/checkpoints': (req, res) => {
    sendJson(res, 200, { checkpoints: db.checkpoints });
  },

  // 员工当前权限快照 —— 同步前按“当前权限”核对的依据
  'GET /api/me': (req, res, url) => {
    const employeeId = url.searchParams.get('employeeId');
    const employee = publicEmployee(employeeId);
    if (!employee) return sendJson(res, 404, { error: '员工不存在' });
    sendJson(res, 200, employee);
  },

  /**
   * 提交一条检查单（离线草稿恢复后逐条调用）。
   * 幂等键 = draftId（同一份草稿在客户端只有一个 id）。
   */
  'POST /api/records': async (req, res) => {
    const body = await readJsonBody(req);
    const { employeeId, checkpointId, draftId, result, note } = body;

    // 1. 参数校验
    if (!employeeId || !checkpointId || !draftId) {
      return sendJson(res, 400, { error: '缺少 employeeId / checkpointId / draftId' });
    }
    if (!VALID_RESULTS.has(result)) {
      return sendJson(res, 400, { error: 'result 必须是 pass / fail / n/a' });
    }
    if (!db.employees.some((e) => e.id === employeeId)) {
      return sendJson(res, 404, { error: '员工不存在' });
    }
    const checkpoint = db.checkpoints.find((c) => c.id === checkpointId);
    if (!checkpoint) return sendJson(res, 404, { error: '检查点不存在' });
    if (typeof note !== 'string' || note.length > 1000) {
      return sendJson(res, 400, { error: 'note 非法或过长' });
    }

    // 2. 幂等：同一份草稿的重试，服务端只保存一份
    const existing = db.records.find((r) => r.draftId === draftId);
    if (existing) {
      if (
        existing.checkpointId !== checkpointId ||
        existing.employeeId !== employeeId ||
        existing.result !== result ||
        existing.note !== note
      ) {
        return sendJson(res, 409, {
          error: 'draftId 已被另一份内容占用，拒绝覆盖',
        });
      }
      return sendJson(res, 200, {
        duplicated: true,
        record: existing,
        message: '该草稿已入库，本次为重试，未重复保存',
      });
    }

    // 3. 按当前权限核对：无权限的草稿绝不进入正式检查单
    if (!hasGrant(employeeId, checkpointId)) {
      return sendJson(res, 403, {
        error: '当前没有该检查点的授权，草稿保留在本机，未提交',
        checkpointId,
      });
    }

    const record = {
      id: crypto.randomUUID(),
      draftId,
      employeeId,
      checkpointId,
      checkpointName: checkpoint.name,
      result,
      note,
      submittedAt: new Date().toISOString(),
    };
    db.records.push(record);
    sendJson(res, 201, { duplicated: false, record });
  },

  // ---------------- 主管端 ----------------
  'GET /api/admin/state': (req, res) => {
    sendJson(res, 200, {
      employees: db.employees.map((e) => publicEmployee(e.id)),
      checkpoints: db.checkpoints.map((c) => ({ id: c.id, name: c.name })),
      records: db.records,
    });
  },

  'POST /api/admin/grants': async (req, res) => {
    const { employeeId, checkpointId, granted } = await readJsonBody(req);
    if (!employeeId || !checkpointId || typeof granted !== 'boolean') {
      return sendJson(res, 400, { error: '参数非法' });
    }
    if (!db.employees.some((e) => e.id === employeeId)) {
      return sendJson(res, 404, { error: '员工不存在' });
    }
    if (!db.checkpoints.some((c) => c.id === checkpointId)) {
      return sendJson(res, 404, { error: '检查点不存在' });
    }
    const key = grantKey(employeeId, checkpointId);
    if (granted) db.grants.add(key);
    else db.grants.delete(key);
    sendJson(res, 200, {
      employeeId,
      checkpointId,
      granted,
      permissions: publicEmployee(employeeId).permissions,
    });
  },

  'POST /api/admin/reset': (req, res) => {
    db = seed();
    sendJson(res, 200, { message: '服务端数据已重置为初始状态' });
  },
};

// ---------------------------------------------------------------------------
// 静态文件
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

async function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/inspector.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const routeKey = `${req.method} ${url.pathname}`;
  try {
    if (routes[routeKey]) return await routes[routeKey](req, res, url);
    if (req.method === 'GET') return await serveStatic(req, res, url);
    sendJson(res, 404, { error: '接口不存在' });
  } catch (err) {
    sendJson(res, err.status ?? 500, { error: err.message ?? '服务器内部错误' });
  }
});

server.listen(PORT, () => {
  console.log(`离线检查单演示已启动：`);
  console.log(`  检查员页面  http://localhost:${PORT}/inspector.html`);
  console.log(`  主管页面    http://localhost:${PORT}/supervisor.html`);
});
