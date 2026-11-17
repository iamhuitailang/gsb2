/**
 * HTTP 应用装配：管理端 API、对外业务 API（带钥匙鉴权）与静态页面。
 * createApp 以依赖注入方式接收 Store / DemoClock，便于测试隔离。
 */
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { DemoClock } from './clock.js';
import { Store, ACTIONS } from './store.js';
import { ApiError, err } from './errors.js';
import {
  issueKey,
  rotateKey,
  revokeKey,
  sweepExpirations,
  serializeKey,
  serializeAccount,
  DEFAULT_OVERLAP_MS,
} from './credentials.js';
import { authorize } from './auth.js';
import {
  enqueueStocktake,
  tickQueue,
  serializeJob,
  DEFAULT_QUEUE_DELAY_MS,
} from './queue.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

export function createApp(options = {}) {
  const store = options.store || new Store(options.dbPath);
  const clock = options.clock || new DemoClock();
  const queueDelayMs = options.queueDelayMs ?? DEFAULT_QUEUE_DELAY_MS;

  async function readJson(req) {
    if (req.method === 'GET' || req.method === 'HEAD') return {};
    let body = '';
    for await (const chunk of req) body += chunk;
    if (!body) return {};
    try {
      return JSON.parse(body);
    } catch {
      throw err.badRequest('请求体不是合法 JSON');
    }
  }

  function send(res, status, payload) {
    const json = JSON.stringify(payload);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(json);
  }

  function adminState() {
    return {
      clock: clock.toJSON(),
      warehouses: store.warehouses,
      actions: Object.values(ACTIONS),
      serviceAccounts: store.serviceAccounts.map((a) =>
        serializeAccount(a, store, clock)
      ),
      keys: store.keys.map((k) =>
        serializeKey(k, clock, store.findAccount(k.serviceAccountId))
      ),
      jobs: store.stocktakeJobs
        .slice()
        .sort((a, b) => Date.parse(b.enqueuedAt) - Date.parse(a.enqueuedAt))
        .map(serializeJob),
      inventory: store.inventory,
      queueDelayMs,
    };
  }

  /** 管理端路由（本地演示工具，不挂鉴权） */
  async function handleAdmin(req, res, url) {
    const path = url.pathname;

    if (req.method === 'GET' && path === '/api/admin/state') {
      return send(res, 200, adminState());
    }

    const body = await readJson(req);

    if (req.method === 'POST' && path === '/api/admin/clock/advance') {
      const ms = Number(body.ms);
      if (!Number.isFinite(ms)) throw err.badRequest('ms 必须是数字');
      clock.advance(ms);
      sweepExpirations(store, clock);
      tickQueue(store, clock);
      return send(res, 200, adminState());
    }

    if (req.method === 'POST' && path === '/api/admin/clock/reset') {
      clock.reset();
      return send(res, 200, adminState());
    }

    if (req.method === 'POST' && path === '/api/admin/demo/reset') {
      store.reset();
      clock.reset();
      return send(res, 200, adminState());
    }

    if (req.method === 'POST' && path === '/api/admin/service-accounts/toggle') {
      const account = store.findAccount(body.id);
      if (!account) throw err.notFound('服务账号不存在');
      account.enabled = !account.enabled;
      store.persist();
      // 停用立即生效：无需改动钥匙记录，鉴权与队列都会在下一步拒绝它们
      return send(res, 200, adminState());
    }

    if (req.method === 'POST' && path === '/api/admin/keys') {
      const result = issueKey(store, clock, body);
      return send(res, 201, { ...adminState(), issued: result });
    }

    if (req.method === 'POST' && path === '/api/admin/keys/rotate') {
      const overlapMs = Number.isFinite(Number(body.overlapMs))
        ? Number(body.overlapMs)
        : DEFAULT_OVERLAP_MS;
      const result = rotateKey(store, clock, body.keyId, overlapMs);
      return send(res, 201, { ...adminState(), issued: result });
    }

    if (req.method === 'POST' && path === '/api/admin/keys/revoke') {
      revokeKey(store, clock, body.keyId);
      return send(res, 200, adminState());
    }

    if (req.method === 'POST' && path === '/api/admin/queue/tick') {
      // 演示/测试辅助：立刻处理到期任务
      const processed = tickQueue(store, clock);
      return send(res, 200, { ...adminState(), processed });
    }

    throw err.notFound('管理端接口不存在');
  }

  /** 对外业务 API：每一次调用都核对钥匙范围 */
  async function handleApi(req, res, url) {
    const path = url.pathname;

    if (req.method === 'GET' && path === '/api/inventory') {
      const warehouse = url.searchParams.get('warehouse');
      if (!warehouse) throw err.badRequest('查询参数 warehouse 必填');
      authorize(store, clock, req, ACTIONS.READ_INVENTORY, warehouse);
      const items = store.inventory.filter((i) => i.warehouse === warehouse);
      return send(res, 200, { warehouse, items });
    }

    if (req.method === 'POST' && path === '/api/stocktakes') {
      const body = await readJson(req);
      const job = enqueueStocktake(store, clock, req, body, queueDelayMs);
      return send(res, 202, { job });
    }

    throw err.notFound('接口不存在');
  }

  async function serveStatic(req, res, url) {
    let rel = url.pathname === '/' ? '/index.html' : url.pathname;
    rel = normalize(rel).replace(/^(\.\.[/\\])+/, '');
    const filePath = join(PUBLIC_DIR, rel);
    if (!filePath.startsWith(PUBLIC_DIR)) throw err.notFound('资源不存在');
    const content = await readFile(filePath);
    res.writeHead(200, { 'content-type': MIME[extname(filePath)] || 'application/octet-stream' });
    res.end(content);
  }

  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/admin/')) return await handleAdmin(req, res, url);
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      return await serveStatic(req, res, url);
    } catch (error) {
      if (error instanceof ApiError) {
        return send(res, error.status, { error: error.code, message: error.message });
      }
      console.error(error);
      return send(res, 500, { error: 'INTERNAL', message: '服务器内部错误' });
    }
  };

  // 定时驱动：到期状态翻转 + 排队任务执行，全部以演示时钟为准
  const timer = setInterval(() => {
    sweepExpirations(store, clock);
    tickQueue(store, clock);
  }, 500);
  timer.unref?.();

  return { handler, store, clock, timer };
}
