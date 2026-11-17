import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

const USERS = {
  li: { id: 'li', name: '李岩', role: 'inspector', title: '现场检查员' },
  wang: { id: 'wang', name: '王敏', role: 'supervisor', title: '检验主管' },
};

const CHECKPOINTS = [
  {
    id: 'cp-jia',
    code: '甲',
    name: '甲 · 冷库月台',
    location: '一号库东侧',
    task: '冷链月台温控与码放检查',
    materials: [
      { id: 'mat-1', label: '近 7 日温控曲线', hint: '冷链系统导出' },
      { id: 'mat-2', label: '库位码放平面图', hint: '现场存档版' },
      { id: 'mat-3', label: '当班人员排班表', hint: '含防寒装备领用记录' },
    ],
    items: [
      { id: 'temp', label: '库温与记录一致（-18℃ 以下）' },
      { id: 'stack', label: '码放间距符合消防与通道要求' },
      { id: 'gear', label: '作业人员防寒装备齐全且在有效期内' },
    ],
  },
  {
    id: 'cp-yi',
    code: '乙',
    name: '乙 · 危化品柜',
    location: '二号库西侧',
    task: '危化品存放与双人双锁检查',
    materials: [
      { id: 'mat-1', label: '危化品出入库台账', hint: '当日更新' },
      { id: 'mat-2', label: '安全技术说明书（SDS）清单', hint: '与柜内实物核对' },
      { id: 'mat-3', label: '双人双锁签认记录', hint: '本月' },
    ],
    items: [
      { id: 'label', label: '柜内物品标签与台账一致' },
      { id: 'vent', label: '通风与消防设施可用' },
      { id: 'lock', label: '双人双锁签认完整' },
    ],
  },
];

const ANSWER_RESULTS = new Set(['pass', 'fail', 'na']);
const AUDIT_LIMIT = 200;

const nowIso = () => new Date().toISOString();

function createState() {
  const state = {
    records: new Map(),
    recordSeq: 0,
    audit: [],
    auditSeq: 0,
    authorizations: new Map(),
  };
  for (const cp of CHECKPOINTS) {
    state.authorizations.set(`li|${cp.id}`, {
      granted: true,
      updatedAt: nowIso(),
      updatedBy: '系统初始化',
    });
  }
  return state;
}

function getAuthorization(state, inspectorId, checkpointId) {
  return (
    state.authorizations.get(`${inspectorId}|${checkpointId}`) ?? {
      granted: false,
      updatedAt: null,
      updatedBy: null,
    }
  );
}

function checkpointById(id) {
  return CHECKPOINTS.find((cp) => cp.id === id) ?? null;
}

function addAudit(state, entry) {
  state.auditSeq += 1;
  state.audit.unshift({ id: state.auditSeq, at: nowIso(), ...entry });
  if (state.audit.length > AUDIT_LIMIT) state.audit.length = AUDIT_LIMIT;
}

function recordView(record) {
  return {
    draftId: record.draftId,
    seq: record.seq,
    checkpointId: record.checkpointId,
    checkpointName: record.checkpointName,
    inspectorId: record.inspectorId,
    inspectorName: record.inspectorName,
    receivedAt: record.receivedAt,
    payload: record.payload,
  };
}

function publicCheckpoint(cp, authorized) {
  if (!authorized) {
    return {
      id: cp.id,
      code: cp.code,
      name: cp.name,
      location: cp.location,
      authorized: false,
      task: null,
      materials: [],
      items: [],
    };
  }
  return { ...cp, authorized: true };
}

function buildState(state, actor) {
  const checkpoints = CHECKPOINTS.map((cp) => {
    const authForInspector = getAuthorization(state, 'li', cp.id);
    if (actor.role === 'supervisor') {
      return { ...cp, authorized: authForInspector.granted, inspectorAuthorization: authForInspector };
    }
    return publicCheckpoint(cp, authForInspector.granted);
  });

  const records = [...state.records.values()]
    .filter((record) => actor.role === 'supervisor' || record.inspectorId === actor.id)
    .sort((a, b) => b.seq - a.seq)
    .map(recordView);

  return {
    actor: { id: actor.id, name: actor.name, role: actor.role, title: actor.title },
    inspectorId: 'li',
    inspectorName: USERS.li.name,
    checkpoints,
    records,
    // 操作记录只对主管可见，检查员看不到管理侧动作。
    audit: actor.role === 'supervisor' ? state.audit.slice(0, 50) : [],
  };
}

function validateDraftPayload(cp, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return '检查单内容缺失';
  }
  const { answers } = payload;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
    return '检查项作答格式不正确';
  }
  const itemIds = new Set(cp.items.map((item) => item.id));
  for (const [itemId, answer] of Object.entries(answers)) {
    if (!itemIds.has(itemId)) return `未知检查项：${itemId}`;
    if (!answer || typeof answer !== 'object' || Array.isArray(answer)) {
      return `检查项「${itemId}」作答格式不正确`;
    }
    if (!ANSWER_RESULTS.has(answer.result)) {
      return `检查项「${itemId}」结论无效`;
    }
    if (answer.note !== undefined && (typeof answer.note !== 'string' || answer.note.length > 2000)) {
      return `检查项「${itemId}」备注过长`;
    }
  }
  for (const item of cp.items) {
    if (!answers[item.id]) return `检查项「${item.label}」尚未作答`;
  }
  if (payload.note !== undefined && (typeof payload.note !== 'string' || payload.note.length > 4000)) {
    return '整体备注过长';
  }
  if (payload.filledAt !== undefined && typeof payload.filledAt !== 'string') {
    return '填写时间格式不正确';
  }
  return null;
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(data),
  });
  res.end(data);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(Object.assign(new Error('请求体过大'), { statusCode: 413 }));
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
        reject(Object.assign(new Error('请求体不是合法 JSON'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

async function handleApi(req, res, url, state) {
  const actorId = String(req.headers['x-actor'] ?? 'li');
  const actor = USERS[actorId];
  if (!actor) {
    sendJson(res, 401, { error: 'UNKNOWN_ACTOR', message: '未知的操作人' });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/state') {
    sendJson(res, 200, buildState(state, actor));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/health') {
    sendJson(res, 200, { ok: true, serverTime: nowIso() });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/authorization') {
    if (actor.role !== 'supervisor') {
      sendJson(res, 403, { error: 'SUPERVISOR_ONLY', message: '只有主管可以调整授权' });
      return;
    }
    const body = await readJsonBody(req);
    const inspectorId = body.inspectorId ?? 'li';
    if (!USERS[inspectorId] || USERS[inspectorId].role !== 'inspector') {
      sendJson(res, 400, { error: 'UNKNOWN_INSPECTOR', message: '未知的检查员' });
      return;
    }
    const cp = checkpointById(body.checkpointId);
    if (!cp) {
      sendJson(res, 400, { error: 'UNKNOWN_CHECKPOINT', message: '未知的检查点' });
      return;
    }
    if (typeof body.granted !== 'boolean') {
      sendJson(res, 400, { error: 'INVALID_GRANT', message: '授权状态必须是布尔值' });
      return;
    }
    const key = `${inspectorId}|${cp.id}`;
    const authorization = {
      granted: body.granted,
      updatedAt: nowIso(),
      updatedBy: `${actor.name}（${actor.title}）`,
    };
    state.authorizations.set(key, authorization);
    addAudit(state, {
      type: 'authorization',
      actor: actor.name,
      checkpointId: cp.id,
      checkpointName: cp.name,
      detail: body.granted ? '恢复授权' : '撤销授权',
    });
    sendJson(res, 200, { ok: true, inspectorId, checkpointId: cp.id, authorization });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/drafts') {
    if (actor.role !== 'inspector') {
      sendJson(res, 403, { error: 'INSPECTOR_ONLY', message: '只有检查员可以提交检查单' });
      return;
    }
    const body = await readJsonBody(req);
    const draftId = typeof body.draftId === 'string' ? body.draftId.trim() : '';
    if (draftId.length < 6 || draftId.length > 100) {
      sendJson(res, 400, { error: 'INVALID_DRAFT_ID', message: '草稿编号无效' });
      return;
    }
    const cp = checkpointById(body.checkpointId);
    if (!cp) {
      sendJson(res, 400, { error: 'UNKNOWN_CHECKPOINT', message: '未知的检查点' });
      return;
    }

    const existing = state.records.get(draftId);
    if (existing) {
      if (existing.checkpointId !== cp.id || existing.inspectorId !== actor.id) {
        sendJson(res, 409, {
          error: 'DRAFT_ID_CONFLICT',
          message: '同一草稿编号对应了不同检查点或不同检查员，请复制草稿后重新创建',
        });
        return;
      }
      addAudit(state, {
        type: 'duplicate',
        actor: actor.name,
        checkpointId: cp.id,
        checkpointName: cp.name,
        draftId,
        detail: `重复提交已忽略，正式记录 #${existing.seq} 保持不变`,
      });
      sendJson(res, 200, { ok: true, duplicate: true, record: recordView(existing) });
      return;
    }

    const authorization = getAuthorization(state, actor.id, cp.id);
    if (!authorization.granted) {
      addAudit(state, {
        type: 'rejected',
        actor: actor.name,
        checkpointId: cp.id,
        checkpointName: cp.name,
        draftId,
        detail: '授权已撤销，未写入正式检查单',
      });
      sendJson(res, 403, {
        error: 'CHECKPOINT_NOT_AUTHORIZED',
        message: `「${cp.name}」的授权已撤销，该草稿只能保留在本机`,
        checkpointId: cp.id,
        draftId,
      });
      return;
    }

    const validationError = validateDraftPayload(cp, body.payload);
    if (validationError) {
      sendJson(res, 422, { error: 'INVALID_DRAFT', message: validationError });
      return;
    }

    state.recordSeq += 1;
    const record = {
      draftId,
      seq: state.recordSeq,
      checkpointId: cp.id,
      checkpointName: cp.name,
      inspectorId: actor.id,
      inspectorName: actor.name,
      receivedAt: nowIso(),
      payload: body.payload,
    };
    state.records.set(draftId, record);
    addAudit(state, {
      type: 'accepted',
      actor: actor.name,
      checkpointId: cp.id,
      checkpointName: cp.name,
      draftId,
      detail: `正式记录 #${record.seq} 入库`,
    });
    sendJson(res, 200, { ok: true, duplicate: false, record: recordView(record) });
    return;
  }

  sendJson(res, 404, { error: 'NOT_FOUND', message: '接口不存在' });
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

async function serveStatic(req, res, url) {
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Bad request');
    return;
  }
  if (pathname === '/') pathname = '/index.html';
  if (pathname === '/supervisor') pathname = '/supervisor.html';
  const filePath = path.resolve(PUBLIC_DIR, `.${pathname}`);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[path.extname(filePath)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
      'content-length': data.length,
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

export function createDemoServer() {
  const state = createState();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    try {
      if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url, state);
      } else if (req.method === 'GET' || req.method === 'HEAD') {
        await serveStatic(req, res, url);
      } else {
        res.writeHead(405);
        res.end('Method not allowed');
      }
    } catch (error) {
      const status = error.statusCode ?? 500;
      if (status === 500) console.error(error);
      if (!res.headersSent) {
        sendJson(res, status, {
          error: 'REQUEST_FAILED',
          message: error.statusCode ? error.message : '服务端处理失败',
        });
      } else {
        res.end();
      }
    }
  });
  return { server, state };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 4173);
  const { server } = createDemoServer();
  server.listen(port, () => {
    console.log(`现场检查离线演示已启动：http://localhost:${port}/`);
    console.log(`主管授权页：http://localhost:${port}/supervisor`);
  });
}
