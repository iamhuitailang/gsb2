import { send, sendJson, readJsonBody } from './util.js';
import { businessHeaders, crossSiteReason } from './security.js';
import { businessPage } from './businessPage.js';
import { APP_CSS } from './app.css.js';
import { buildSampleReport } from './samples.js';

/**
 * 业务站点：采购系统的账号信息、报告列表、导入入口与预览容器。
 * 报告预览永远放在跨源 iframe 里，业务页从不把报告 HTML 插入自己的 DOM。
 */
export function createBusinessServer({ config, store, sessions, events }) {
  const handler = async (req, res) => {
    if (req.headers.host !== `${config.hosts.business}:${config.ports.business}`) {
      return send(res, 421, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' }, 'Host 不被接受');
    }

    const url = new URL(req.url, config.origins.business);

    // 静态资源与会话无关，先处理，避免无谓地建会话。
    if (url.pathname === '/app.css') {
      return send(res, 200, {
        'Content-Type': 'text/css; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      }, APP_CSS);
    }

    if (url.pathname === '/app.js') {
      return send(res, 200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      }, businessScript(config));
    }

    // 业务 API 一律拒绝跨站来源；报告站点在另一个源，因此既拿不到也用不了这里的会话。
    // 这一步放在建立会话之前：跨站调用不会得到任何会话标识。
    if (url.pathname.startsWith('/api/')) {
      const reason = crossSiteReason(req, config);
      if (reason) {
        sessions.recordCrossSite({
          at: new Date().toISOString(),
          path: url.pathname,
          method: req.method,
          reason,
          origin: req.headers.origin ?? '',
          host: req.headers.host ?? '',
        });
        return sendJson(res, 403, { error: 'cross-site request rejected', reason });
      }
    }

    // 安全自检接口：列出三个源的地址。
    if (url.pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, origins: config.origins });
    }

    const { session, created } = sessions.ensure(req);
    const cookieHeaders = created ? { 'Set-Cookie': sessions.cookieHeader(session.token) } : {};
    const respondJson = (status, value) => sendJson(res, status, value, cookieHeaders);

    try {
      if (url.pathname === '/api/me' && req.method === 'GET') {
        return respondJson(200, sessions.publicView(session));
      }

      if (url.pathname === '/api/session/ping' && req.method === 'POST') {
        session.actions.push({ at: new Date().toISOString(), kind: 'ping' });
        if (session.actions.length > 20) session.actions.shift();
        return respondJson(200, sessions.publicView(session));
      }

      if (url.pathname === '/api/reports' && req.method === 'GET') {
        return respondJson(200, { reports: await store.list() });
      }

      if (url.pathname === '/api/reports' && req.method === 'POST') {
        const body = await readJsonBody(req, 8 * 1024 * 1024);
        const meta = await store.importReport({
          title: body.title,
          fileName: body.fileName,
          html: body.html,
          assets: Array.isArray(body.assets) ? body.assets : [],
          declaredExternalUrls: Array.isArray(body.declaredExternalUrls) ? body.declaredExternalUrls : [],
        });
        session.actions.push({ at: new Date().toISOString(), kind: 'import', reportId: meta.id });
        return respondJson(201, { report: meta });
      }

      if (url.pathname === '/api/samples/import' && req.method === 'POST') {
        const sample = buildSampleReport(config);
        const meta = await store.importReport(sample);
        session.actions.push({ at: new Date().toISOString(), kind: 'import-sample', reportId: meta.id });
        return respondJson(201, { report: meta });
      }

      const reportMatch = /^\/api\/reports\/(rpt_[a-f0-9]{16})$/.exec(url.pathname);
      if (reportMatch) {
        const id = reportMatch[1];
        if (req.method === 'GET') {
          try {
            const [meta, check] = await Promise.all([store.getMeta(id), store.getCheck(id)]);
            return respondJson(200, { report: meta, check });
          } catch {
            return respondJson(404, { error: '报告不存在' });
          }
        }
        if (req.method === 'DELETE') {
          await store.remove(id);
          session.actions.push({ at: new Date().toISOString(), kind: 'delete', reportId: id });
          return respondJson(200, { ok: true });
        }
      }

      // 安全自检：两次会话的统计、跨站尝试记录、报告站点拦截记录。
      if (url.pathname === '/api/security' && req.method === 'GET') {
        return respondJson(200, {
          sessionId: session.publicId,
          crossSiteAttempts: sessions.crossSiteAttempts,
          reportSiteBlocked: events.blockedRequests.slice(-20),
        });
      }

      if (url.pathname === '/') {
        return send(res, 200, {
          ...businessHeaders(config),
          ...cookieHeaders,
          'Content-Type': 'text/html; charset=utf-8',
        }, businessPage(config));
      }

      return send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }, '未找到');
    } catch (error) {
      const status = error.statusCode ?? 400;
      return respondJson(status, { error: error.message ?? '请求失败' });
    }
  };

  return { handler };
}

function businessScript(config) {
  return BUSINESS_SCRIPT.replaceAll('__PREVIEW_ORIGIN__', JSON.stringify(config.origins.report));
}

const BUSINESS_SCRIPT = String.raw`
(() => {
  const PREVIEW_ORIGIN = __PREVIEW_ORIGIN__;
  const state = { me: null, reports: [], selected: null, frame: null };

  const el = (id) => document.getElementById(id);
  const text = (tag, value, className) => {
    const node = document.createElement(tag);
    node.textContent = value == null ? '' : String(value);
    if (className) node.className = className;
    return node;
  };

  async function api(path, options = {}) {
    const response = await fetch(path, {
      credentials: 'same-origin',
      method: options.method || 'GET',
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || ('HTTP ' + response.status));
    return data;
  }

  function formatTime(iso) {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false });
  }

  function renderSession() {
    const me = state.me;
    if (!me) return;
    el('sess-name').textContent = me.account.displayName;
    el('sess-role').textContent = me.account.role + ' · ' + me.account.department;
    el('sess-id').textContent = me.id;
    el('sess-requests').textContent = String(me.requests);
    el('sess-actions').textContent = String(me.actionCount);
    el('sess-seen').textContent = new Date(me.lastSeenAt).toLocaleTimeString('zh-CN', { hour12: false });
  }

  async function refreshMe() {
    state.me = await api('/api/me');
    renderSession();
  }

  function renderList() {
    const list = el('report-list');
    list.replaceChildren();
    if (!state.reports.length) {
      list.append(text('p', '还没有报告。点击右上角“导入报告”或“生成样例报告”。', 'muted empty'));
      return;
    }
    for (const report of state.reports) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'report-item' + (state.selected === report.id ? ' active' : '');
      item.dataset.reportId = report.id;

      const badges = document.createElement('span');
      badges.className = 'badges';
      const loaded = text('span', '本地资源 ' + report.summary.loaded, 'badge ok');
      badges.append(loaded);
      if (report.summary.external > 0) {
        badges.append(text('span', '外部 ' + report.summary.external + ' 未载入', 'badge warn'));
      }
      if (report.summary.missing > 0) {
        badges.append(text('span', '缺失 ' + report.summary.missing, 'badge bad'));
      }

      item.append(
        text('span', report.title, 'report-title'),
        text('span', report.fileName + ' · ' + formatTime(report.importedAt), 'report-meta'),
        badges,
      );
      item.addEventListener('click', () => openPreview(report.id));
      list.append(item);
    }
  }

  function urlsFor(report) {
    const base = report.id + '/' + report.token;
    return {
      // 列表预览：业务页直接内嵌报告站点的正文。正文与独立预览外壳里嵌的是
      // 同一个地址、同一份响应头，因此两处的隔离规则完全一致。
      embedded: PREVIEW_ORIGIN + '/r/' + base + '/content',
      standalone: PREVIEW_ORIGIN + '/r/' + base,
    };
  }

  function openPreview(reportId) {
    const report = state.reports.find((r) => r.id === reportId);
    if (!report) return;
    closePreview(false);
    state.selected = report.id;
    renderList();

    const urls = urlsFor(report);
    const frame = document.createElement('iframe');
    frame.className = 'preview-frame';
    frame.title = '报告隔离预览';
    frame.referrerPolicy = 'no-referrer';
    // 沙箱属性是浏览器侧的第二道防线；真正的隔离规则来自报告站点的响应头，
    // 列表预览与独立预览加载的是同一个正文地址，因此规则一致。
    frame.sandbox = '';
    frame.src = urls.embedded;

    el('preview-host').replaceChildren(frame);
    el('preview-empty').hidden = true;
    el('preview-panel').hidden = false;
    el('preview-title').textContent = report.title;
    el('preview-file').textContent = report.fileName;
    const standalone = el('preview-standalone');
    standalone.href = urls.standalone;
    standalone.dataset.reportId = report.id;
    state.frame = frame;

    loadCheck(report.id);
  }

  function closePreview(reselect = true) {
    if (state.frame) state.frame.remove();
    state.frame = null;
    state.selected = null;
    el('preview-panel').hidden = true;
    el('preview-empty').hidden = false;
    if (reselect) renderList();
  }

  async function loadCheck(reportId) {
    const target = el('check-body');
    target.replaceChildren(text('p', '正在读取检查结果…', 'muted'));
    try {
      const data = await api('/api/reports/' + reportId);
      renderCheck(data.check);
    } catch (error) {
      target.replaceChildren(text('p', '检查结果读取失败：' + error.message, 'bad'));
    }
  }

  function block(titleText, items, describe, emptyText) {
    const box = document.createElement('section');
    box.append(text('h4', titleText));
    if (!items.length) {
      box.append(text('p', emptyText, 'muted'));
      return box;
    }
    const ul = document.createElement('ul');
    for (const item of items) {
      const info = describe(item);
      const li = document.createElement('li');
      li.append(text('code', info.label));
      if (info.status) li.append(text('span', ' ' + info.status, info.className));
      ul.append(li);
    }
    box.append(ul);
    return box;
  }

  function renderCheck(check) {
    const target = el('check-body');
    target.replaceChildren();
    target.append(text('p', '预览不会自动联网：外部资源只列出、不加载。', 'muted'));

    const external = check.externalResources || [];
    const local = check.resources.filter((r) => r.status === 'local');
    const embedded = check.resources.filter((r) => r.status === 'embedded');
    const missing = check.resources.filter((r) => r.status === 'missing');
    const blocked = check.resources.filter((r) => r.status === 'blocked');

    target.append(block('外部资源（未载入）', external, (item) => ({
      label: item.url + (item.kinds.length ? '（' + item.kinds.join('、') + '）' : ''),
      status: '未载入',
      className: 'bad',
    }), '无。'));
    target.append(block('随报告提供的本地资源', local, (item) => ({
      label: item.url, status: '已载入', className: 'ok',
    }), '无。'));
    target.append(block('内嵌图片（data:）', embedded, (item) => ({
      label: item.url.length > 48 ? item.url.slice(0, 48) + '…' : item.url,
      status: '已载入',
      className: 'ok',
    }), '无。'));
    target.append(block('缺失的本地资源', missing, (item) => ({
      label: item.url, status: '缺失', className: 'bad',
    }), '无。'));
    target.append(block('被阻止的构造', blocked, (item) => ({
      label: item.kind + '：' + item.url, status: '已阻止', className: 'bad',
    }), '无。'));

    const removed = check.removed || {};
    const removedBits = Object.entries({
      scripts: '脚本', inlineHandlers: '内联事件', jsUrls: 'javascript: 地址',
      forms: '表单', metaRefreshes: '自动跳转', frames: '嵌套框架',
      stylesheets: '外部样式表', baseTags: 'base 标签',
    }).filter(([key]) => removed[key] > 0).map(([key, label]) => label + ' ' + removed[key]);
    const removedBox = document.createElement('section');
    removedBox.append(text('h4', '已移除的危险构造'));
    removedBox.append(text('p', removedBits.length ? removedBits.join('，') : '无。', removedBits.length ? '' : 'muted'));
    target.append(removedBox);
  }

  async function refreshReports() {
    state.reports = (await api('/api/reports')).reports;
    renderList();
  }

  async function openStandalone() {
    const link = el('preview-standalone');
    window.open(link.href, '_blank', 'noopener');
  }

  async function importFromDialog(event) {
    event.preventDefault();
    const dialogStatus = el('dialog-status');
    const sidebarStatus = el('import-status');
    const file = el('import-file').files[0];
    if (!file) {
      dialogStatus.textContent = '请选择报告 HTML 文件。';
      return;
    }
    dialogStatus.textContent = '正在导入…';
    try {
      const html = await file.text();
      const assets = [];
      for (const assetFile of el('import-assets').files) {
        const dataBase64 = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
          reader.readAsDataURL(assetFile);
        });
        assets.push({
          // 浏览器只给文件名；若报告里同名资源唯一，按文件名也能匹配上。
          path: assetFile.name,
          contentType: assetFile.type || 'application/octet-stream',
          dataBase64,
        });
      }
      const data = await api('/api/reports', {
        method: 'POST',
        body: JSON.stringify({
          title: el('import-title').value.trim() || file.name,
          fileName: file.name,
          html,
          assets,
        }),
      });
      sidebarStatus.textContent = '已导入：' + data.report.title;
      dialogStatus.textContent = '';
      el('import-dialog').close();
      el('import-form').reset();
      await refreshReports();
      await refreshMe();
      openPreview(data.report.id);
    } catch (error) {
      dialogStatus.textContent = '导入失败：' + error.message;
    }
  }

  async function importSample() {
    const status = el('import-status');
    status.textContent = '正在生成样例报告…';
    try {
      const data = await api('/api/samples/import', { method: 'POST' });
      status.textContent = '样例报告已导入：' + data.report.title;
      await refreshReports();
      await refreshMe();
      openPreview(data.report.id);
    } catch (error) {
      status.textContent = '样例导入失败：' + error.message;
    }
  }

  async function pingSession() {
    try {
      state.me = await api('/api/session/ping', { method: 'POST' });
      renderSession();
      el('session-note').textContent = '业务会话正常，最后一次操作 ' +
        new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '。';
    } catch (error) {
      el('session-note').textContent = '业务会话异常：' + error.message;
    }
  }

  function bind() {
    el('open-import').addEventListener('click', () => {
      el('dialog-status').textContent = '';
      el('import-dialog').showModal();
    });
    el('import-cancel').addEventListener('click', () => el('import-dialog').close());
    el('import-form').addEventListener('submit', importFromDialog);
    el('import-sample').addEventListener('click', importSample);
    el('session-ping').addEventListener('click', pingSession);
    el('close-preview').addEventListener('click', () => closePreview());
    el('preview-standalone').addEventListener('click', (event) => {
      event.preventDefault();
      openStandalone();
    });

    // 只接受来自当前预览框架的关闭消息。
    // 预览框架带 sandbox（不透明源），消息的 origin 会是字符串 "null"，
    // 因此这里以 event.source 身份校验为准，而不是 origin。
    window.addEventListener('message', (event) => {
      if (!state.frame) return;
      if (event.source !== state.frame.contentWindow) return;
      if (event.origin !== PREVIEW_ORIGIN && event.origin !== 'null') return;
      if (event.data && event.data.type === 'gsb2:close-preview') closePreview();
    });
  }

  async function boot() {
    bind();
    try {
      await refreshMe();
      await refreshReports();
      el('boot-error').hidden = true;
    } catch (error) {
      el('boot-error').hidden = false;
      el('boot-error').textContent = '加载失败：' + error.message;
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
`;
