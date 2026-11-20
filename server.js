// 本地演示服务：零依赖 Node 内置 http。离线可用，不发起任何真实网络请求。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from './lib/store.js';
import { verifyToken } from './lib/verifier.js';
import { REASONS } from './lib/reasons.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 5173);

store.load();

function sendJson(res, status, body) {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1_000_000) reject(new Error('请求体过大'));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('not found');
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

// 组装提供方详情：发现/密钥缓存状态 + 最近一次核验结果（按审计记录回溯）
function providerDetail(provider) {
  const keys = store.listKeys(provider.id);
  const cache = store.cacheStatus(provider.id);
  const auditRows = store.listAudit({ providerId: provider.id, limit: 500 });
  const latest = auditRows[0] || null;
  const remote = store.getRemoteState ? store.getRemoteState(provider.id) : undefined;
  return {
    ...provider,
    keys,
    cache,
    remote,
    latestVerification: latest
      ? {
          decision: latest.decision,
          reasonCode: latest.reasonCode,
          reason: latest.reason,
          configVersion: latest.configVersion,
          cacheGeneration: latest.cacheGeneration,
          source: latest.source,
          ts: latest.ts,
          stale: latest.configVersion !== provider.configVersion,
        }
      : null,
  };
}

const routes = [];
function route(method, pattern, handler) {
  routes.push({ method, pattern: new RegExp(`^${pattern}$`), handler });
}

route('GET', '/api/health', async (req, res) => {
  sendJson(res, 200, { ok: true, offline: true, ts: new Date().toISOString() });
});

route('GET', '/api/providers', async (req, res) => {
  sendJson(res, 200, store.listProviders().map(providerDetail));
});

route('POST', '/api/providers', async (req, res, body) => {
  const provider = await store.createProvider(body);
  sendJson(res, 201, providerDetail(provider));
});

route('PATCH', '/api/providers/(?<id>[^/]+)', async (req, res, body) => {
  const id = req.urlMatch.groups.id;
  sendJson(res, 200, providerDetail(store.updateProvider(id, body)));
});

route('DELETE', '/api/providers/(?<id>[^/]+)', async (req, res) => {
  store.deleteProvider(req.urlMatch.groups.id);
  sendJson(res, 200, { ok: true });
});

route('POST', '/api/providers/(?<id>[^/]+)/keys', async (req, res, body) => {
  const key = await store.addKey(req.urlMatch.groups.id, body.alg || 'RS256');
  sendJson(res, 201, key);
});

route('POST', '/api/providers/(?<id>[^/]+)/keys/(?<kid>[^/]+)/status', async (req, res, body) => {
  const key = store.setKeyStatus(req.urlMatch.groups.id, req.urlMatch.groups.kid, body.status);
  sendJson(res, 200, key);
});

route('POST', '/api/providers/(?<id>[^/]+)/remote/offline', async (req, res, body) => {
  store.setOffline(req.urlMatch.groups.id, Boolean(body.offline));
  sendJson(res, 200, { ok: true });
});

route('POST', '/api/providers/(?<id>[^/]+)/remote/discovery', async (req, res, body) => {
  store.mutateRemoteDiscovery(req.urlMatch.groups.id, body.patch || {});
  sendJson(res, 200, { ok: true });
});

route('POST', '/api/providers/(?<id>[^/]+)/remote/duplicate-kid', async (req, res, body) => {
  store.setDuplicateKid(req.urlMatch.groups.id, Boolean(body.enabled));
  sendJson(res, 200, { ok: true });
});

route('POST', '/api/providers/(?<id>[^/]+)/remote/inject-key', async (req, res, body) => {
  const kid = await store.injectForeignKey(req.urlMatch.groups.id, body.alg || 'RS256');
  sendJson(res, 201, { kid });
});

route('POST', '/api/providers/(?<id>[^/]+)/cache/expire', async (req, res) => {
  store.expireCachesNow(req.urlMatch.groups.id);
  sendJson(res, 200, { ok: true });
});

route('POST', '/api/providers/(?<id>[^/]+)/cache/tamper', async (req, res) => {
  store.tamperCaches(req.urlMatch.groups.id);
  sendJson(res, 200, { ok: true });
});

route('POST', '/api/providers/(?<id>[^/]+)/cache/invalidate', async (req, res) => {
  store.invalidateCaches(req.urlMatch.groups.id);
  sendJson(res, 200, { ok: true });
});

route('POST', '/api/providers/(?<id>[^/]+)/verify', async (req, res, body) => {
  const result = await verifyToken(req.urlMatch.groups.id, body.token || '', {
    forceRefresh: Boolean(body.forceRefresh),
    source: body.source || 'manual',
  });
  sendJson(res, 200, result);
});

// 管理员“重新检查”：对该提供方下全部样例重新核验，返回每组新旧结果对比
route('POST', '/api/providers/(?<id>[^/]+)/recheck', async (req, res, body) => {
  const id = req.urlMatch.groups.id;
  const samples = store.listSamples().filter((s) => s.providerId === id);
  const results = [];
  for (const s of samples) {
    const before = store.listAudit({ providerId: id, limit: 500 }).find((a) => a.tokenFingerprint === s.tokenFingerprint);
    const full = store.getSample(s.id);
    const after = await verifyToken(id, full.token, { forceRefresh: Boolean(body.forceRefresh), source: 'recheck' });
    results.push({
      sampleId: s.id,
      label: s.label,
      before: before ? { decision: before.decision, reasonCode: before.reasonCode, configVersion: before.configVersion, ts: before.ts } : null,
      after: { decision: after.decision, reasonCode: after.reasonCode, reason: after.reason, configVersion: after.configVersion, trace: after.trace },
    });
  }
  sendJson(res, 200, { results });
});

route('POST', '/api/providers/(?<id>[^/]+)/mint', async (req, res, body) => {
  const token = await store.mintToken(req.urlMatch.groups.id, body);
  sendJson(res, 201, { token });
});

route('GET', '/api/samples', async (req, res) => {
  sendJson(res, 200, store.listSamples());
});

route('GET', '/api/samples/(?<id>[^/]+)', async (req, res) => {
  const sample = store.getSample(req.urlMatch.groups.id);
  if (!sample) return sendJson(res, 404, { error: '样例不存在' });
  sendJson(res, 200, sample);
});

route('POST', '/api/samples', async (req, res, body) => {
  const sample = store.addSample(body);
  sendJson(res, 201, sample);
});

route('DELETE', '/api/samples/(?<id>[^/]+)', async (req, res) => {
  store.deleteSample(req.urlMatch.groups.id);
  sendJson(res, 200, { ok: true });
});

route('GET', '/api/audit', async (req, res, body, url) => {
  sendJson(res, 200, store.listAudit({ providerId: url.searchParams.get('providerId') || undefined }));
});

route('GET', '/api/reasons', async (req, res) => {
  sendJson(res, 200, REASONS);
});

route('POST', '/api/reset', async (req, res) => {
  const { seedDemoData } = await import('./lib/seed.js');
  await seedDemoData();
  sendJson(res, 200, { ok: true });
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith('/api/')) {
    try {
      const match = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
      if (!match) return sendJson(res, 404, { error: '接口不存在' });
      req.urlMatch = url.pathname.match(match.pattern);
      const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readBody(req) : {};
      await match.handler(req, res, body, url);
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
    return;
  }
  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`\n  本地身份核验演示工具（离线）: http://localhost:${PORT}\n`);
});
