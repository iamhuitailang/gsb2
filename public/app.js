// 前端：零依赖原生 JS。所有数据来自本地 API，不访问任何外部地址。
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let providers = [];
let selectedId = null;
let lastResults = {}; // sampleId -> 最新核验结果

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: { 'content-type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 ${res.status}`);
  return data;
}

function toast(msg, bad = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast${bad ? ' bad' : ''}`;
  setTimeout(() => el.classList.add('hidden'), 3200);
}

function decisionBadge(decision, reasonCode) {
  const cls = decision === 'TRUSTED' ? 'ok' : 'bad';
  const text = decision === 'TRUSTED' ? '信任' : '拒绝';
  return `<span class="badge ${cls}">${text}</span> <span class="mono">${esc(reasonCode)}</span>`;
}

function keyStatusBadge(status) {
  const map = { active: ['ok', 'active 受信'], retired: ['muted', 'retired 已退役'], revoked: ['bad', 'revoked 已撤销'] };
  const [cls, label] = map[status] || ['muted', status];
  return `<span class="badge ${cls}">${label}</span>`;
}

async function loadProviders() {
  providers = await api('/api/providers');
  $('#provider-count').textContent = providers.length;
  $('#provider-list').innerHTML = providers.map((p) => `
    <div class="provider-card ${p.id === selectedId ? 'active' : ''}" data-id="${p.id}">
      <div class="name">
        <span>${esc(p.name)}</span>
        ${p.latestVerification
          ? `<span class="badge ${p.latestVerification.decision === 'TRUSTED' ? 'ok' : 'bad'}">v${p.configVersion}</span>`
          : '<span class="badge muted">未核验</span>'}
      </div>
      <div class="meta mono">${esc(p.expected.issuer)}</div>
      <div class="meta">密钥 ${p.keys.length} 把 · 算法 ${esc(p.allowedAlgs.join('/'))}</div>
    </div>`).join('');
  document.querySelectorAll('.provider-card').forEach((card) => {
    card.onclick = () => { selectedId = card.dataset.id; renderDetail(); loadProviders(); };
  });
  if (selectedId) renderDetail();
}

function cacheCell(title, c) {
  if (!c) return `<div class="cache-cell empty"><b>${title}</b><br/>无缓存（未获取或已失效）</div>`;
  return `<div class="cache-cell ${c.expired ? '' : ''}">
    <b>${title}</b> ${c.expired ? '<span class="badge warn">已过期</span>' : '<span class="badge ok">新鲜</span>'}<br/>
    获取于 ${esc(c.fetchedAt.slice(11, 19))}<br/>
    配置版本 v${c.configVersion}<br/>
    哈希 <span class="mono">${esc(c.payloadHash)}</span>
  </div>`;
}

function renderDetail() {
  const p = providers.find((x) => x.id === selectedId);
  const host = $('#provider-detail');
  if (!p) { host.innerHTML = '<p class="empty-hint">从左侧选择一个提供方查看详情。</p>'; return; }

  host.innerHTML = `
    <div class="card">
      <div class="flex-between">
        <h2>${esc(p.name)} <span class="badge muted">配置版本 v${p.configVersion}</span></h2>
        <div>
          <button class="btn small" id="btn-edit">编辑配置</button>
          <button class="btn small danger" id="btn-delete">删除</button>
        </div>
      </div>
      <dl class="kv" style="margin-top:10px">
        <dt>预期签发方</dt><dd class="mono">${esc(p.expected.issuer)}</dd>
        <dt>预期登录端点</dt><dd class="mono">${esc(p.expected.authorizationEndpoint)}</dd>
        <dt>预期密钥地址</dt><dd class="mono">${esc(p.expected.jwksUri)}</dd>
        <dt>允许算法</dt><dd>${p.allowedAlgs.map((a) => `<span class="badge">${esc(a)}</span>`).join(' ')}</dd>
        <dt>缓存 TTL</dt><dd>发现 ${p.discoveryTtlSec}s · JWKS ${p.jwksTtlSec}s · 当前缓存代数 #${p.cache.generation}</dd>
      </dl>
      <div style="margin-top:10px">
        <b>最近一次核验：</b>
        ${p.latestVerification
          ? `${decisionBadge(p.latestVerification.decision, p.latestVerification.reasonCode)}
             <span class="mono">${esc(p.latestVerification.ts)}</span>
             ${p.latestVerification.stale ? '<span class="stale-tag">结果基于旧配置版本，已 stale</span>' : '<span class="badge ok">与当前配置同版本</span>'}`
          : '<span class="badge muted">暂无</span>'}
      </div>
    </div>

    <div class="card">
      <h3>模拟身份服务当前状态</h3>
      <dl class="kv">
        <dt>服务开关</dt><dd>${p.remote.offline ? '<span class="badge bad">离线</span>' : '<span class="badge ok">在线</span>'}</dd>
        <dt>远端发现签发方</dt><dd class="mono">${esc(p.remote.discovery.issuer)}</dd>
        <dt>远端登录端点</dt><dd class="mono">${esc(p.remote.discovery.authorization_endpoint)}</dd>
        <dt>远端密钥地址</dt><dd class="mono">${esc(p.remote.discovery.jwks_uri)}</dd>
        <dt>重复 kid 注入</dt><dd>${p.remote.duplicateKid ? '<span class="badge bad">开启</span>' : '<span class="badge muted">关闭</span>'}</dd>
      </dl>
      <div class="actions-row">
        <button class="btn small" data-act="toggle-offline">${p.remote.offline ? '恢复在线' : '模拟服务离线'}</button>
        <button class="btn small" data-act="mutate-issuer">替换远端签发方</button>
        <button class="btn small" data-act="mutate-endpoint">替换远端密钥地址</button>
        <button class="btn small" data-act="restore-discovery">还原远端发现文档</button>
        <button class="btn small" data-act="toggle-dup">${p.remote.duplicateKid ? '关闭重复 kid' : '注入重复 kid'}</button>
      </div>
    </div>

    <div class="card">
      <h3>发现与密钥缓存（相互独立，仅存内存）</h3>
      <div class="cache-box">
        ${cacheCell('发现缓存', p.cache.discovery)}
        ${cacheCell('JWKS 缓存', p.cache.jwks)}
      </div>
      <div class="actions-row">
        <button class="btn small" data-act="expire">令缓存立即过期</button>
        <button class="btn small" data-act="invalidate">清空缓存</button>
        <button class="btn small" data-act="tamper">模拟缓存被污染</button>
        <button class="btn small" data-act="recheck" >全部样例重新检查</button>
        <button class="btn small primary" data-act="recheck-force">强制刷新并重新检查</button>
      </div>
    </div>

    <div class="card">
      <div class="flex-between">
        <h3>密钥集合（${p.keys.length}）</h3>
        <div>
          <button class="btn small" data-act="add-rs">+ RS256 密钥</button>
          <button class="btn small" data-act="add-es">+ ES256 密钥</button>
        </div>
      </div>
      <table>
        <thead><tr><th>kid</th><th>算法</th><th>类型</th><th>状态</th><th>生命周期操作</th></tr></thead>
        <tbody>
          ${p.keys.map((k) => `
            <tr>
              <td class="mono">${esc(k.kid)}</td>
              <td>${esc(k.alg)}</td>
              <td>${esc(k.kty)}</td>
              <td>${keyStatusBadge(k.status)}</td>
              <td>
                <button class="btn small" data-key="${esc(k.kid)}" data-status="active">设为并存</button>
                <button class="btn small" data-key="${esc(k.kid)}" data-status="retired">退役</button>
                <button class="btn small danger" data-key="${esc(k.kid)}" data-status="revoked">紧急撤销</button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
      <p class="note">轮换演示：新密钥“设为并存(active)”→ 用新旧两把分别核验 → 旧密钥“退役”→ 旧令牌即被拒绝；撤销立即生效。</p>
    </div>

    <div class="card">
      <h3>令牌核验</h3>
      <textarea id="token-input" class="token-input" placeholder="粘贴 JWT，或从下方样例点击“核验”自动填入"></textarea>
      <div class="actions-row">
        <button class="btn primary" data-act="verify">核验该令牌</button>
        <button class="btn" data-act="verify-force">强制刷新后核验</button>
      </div>
      <div id="verify-result"></div>
    </div>

    <div class="card">
      <h3>本提供方的本地令牌样例</h3>
      <div id="sample-list"></div>
    </div>`;

  bindDetailActions(p);
  loadSamples(p);
  $('#btn-edit').onclick = () => openProviderDialog(p);
  $('#btn-delete').onclick = async () => {
    if (!confirm(`确认删除提供方 ${p.name}？其缓存、密钥与样例将一并移除。`)) return;
    await api(`/api/providers/${p.id}`, { method: 'DELETE' });
    selectedId = null;
    loadProviders();
    toast('提供方已删除');
  };
}

function traceHtml(trace) {
  if (!trace) return '';
  return `<ul class="trace-list">${trace.map((t) => `
    <li class="${t.ok ? 'ok' : 'fail'}">
      <span class="mark">${t.ok ? '✓ 通过' : '✗ 阻断'}</span>
      <div><b>${esc(t.step)}</b><br/><code>${esc(typeof t.detail === 'string' ? t.detail : JSON.stringify(t.detail))}</code></div>
    </li>`).join('')}</ul>`;
}

async function loadSamples(p) {
  const all = await api('/api/samples');
  const mine = all.filter((s) => s.providerId === p.id);
  $('#sample-list').innerHTML = mine.length ? mine.map((s) => {
    const r = lastResults[s.id];
    return `<div class="sample-row">
      <div class="flex-between">
        <span class="label">${esc(s.label)}</span>
        <span class="badge mono">指纹 ${esc(s.tokenFingerprint)}</span>
      </div>
      <div class="desc">${esc(s.description)}</div>
      <div class="actions-row">
        <button class="btn small primary" data-sample="${esc(s.id)}">核验</button>
        <button class="btn small" data-sample-force="${esc(s.id)}">强制刷新核验</button>
      </div>
      <div class="sample-result" id="sr-${esc(s.id)}">
        ${r ? `${decisionBadge(r.decision, r.reasonCode)}<div class="note">${esc(r.reason)}</div>${traceHtml(r.trace)}` : '<span class="note">尚未在本次页面会话核验</span>'}
      </div>
    </div>`;
  }).join('') : '<p class="note">该提供方暂无样例。</p>';

  document.querySelectorAll('[data-sample]').forEach((b) => {
    b.onclick = () => runSample(p.id, b.dataset.sample, false);
  });
  document.querySelectorAll('[data-sample-force]').forEach((b) => {
    b.onclick = () => runSample(p.id, b.dataset.sampleForce, true);
  });
}

async function runSample(providerId, sampleId, force) {
  const full = await api(`/api/samples/${sampleId}`);
  $('#token-input').value = full.token;
  const result = await api(`/api/providers/${providerId}/verify`, {
    method: 'POST', body: { token: full.token, forceRefresh: force, source: force ? 'manual-force' : 'manual' },
  });
  lastResults[sampleId] = result;
  renderVerifyResult(result);
  const p = providers.find((x) => x.id === providerId);
  loadSamples(p);
  await loadProviders();
  loadAudit();
}

function renderVerifyResult(r) {
  $('#verify-result').innerHTML = `
    <div style="margin-top:10px">
      ${decisionBadge(r.decision, r.reasonCode)}
      <span class="note">配置 v${r.configVersion} · 缓存代数 #${r.cacheGeneration} · kid=${esc(r.matchedKid || '无')}</span>
      <div class="note">${esc(r.reason)}</div>
      ${traceHtml(r.trace)}
    </div>`;
}

function bindDetailActions(p) {
  const act = (sel, fn) => { const el = $(sel); if (el) el.onclick = fn; };
  act('[data-act="toggle-offline"]', async () => {
    await api(`/api/providers/${p.id}/remote/offline`, { method: 'POST', body: { offline: !p.remote.offline } });
    await refresh(); toast(p.remote.offline ? '已恢复在线' : '模拟服务已离线：过期缓存将无法刷新');
  });
  act('[data-act="mutate-issuer"]', async () => {
    await api(`/api/providers/${p.id}/remote/discovery`, {
      method: 'POST', body: { patch: { issuer: p.remote.discovery.issuer + '-evil' } },
    });
    await refresh(); toast('远端签发方已被替换，下次核验应拒绝（ISSUER_MISMATCH）');
  });
  act('[data-act="mutate-endpoint"]', async () => {
    await api(`/api/providers/${p.id}/remote/discovery`, {
      method: 'POST', body: { patch: { jwks_uri: p.remote.discovery.jwks_uri + '-evil' } },
    });
    await refresh(); toast('远端密钥地址已被替换，下次核验应拒绝（ENDPOINT_CHANGED）');
  });
  act('[data-act="restore-discovery"]', async () => {
    await api(`/api/providers/${p.id}/remote/discovery`, {
      method: 'POST',
      body: { patch: { issuer: p.expected.issuer, authorization_endpoint: p.expected.authorizationEndpoint, jwks_uri: p.expected.jwksUri } },
    });
    await refresh(); toast('远端发现文档已还原为本地预期值');
  });
  act('[data-act="toggle-dup"]', async () => {
    await api(`/api/providers/${p.id}/remote/duplicate-kid`, { method: 'POST', body: { enabled: !p.remote.duplicateKid } });
    await refresh();
  });
  act('[data-act="expire"]', async () => {
    await api(`/api/providers/${p.id}/cache/expire`, { method: 'POST' });
    await refresh(); toast('缓存已标记过期：TTL 内不再命中，需重新获取');
  });
  act('[data-act="invalidate"]', async () => {
    await api(`/api/providers/${p.id}/cache/invalidate`, { method: 'POST' });
    await refresh(); toast('缓存已清空');
  });
  act('[data-act="tamper"]', async () => {
    await api(`/api/providers/${p.id}/cache/tamper`, { method: 'POST' });
    await refresh(); toast('已污染内存缓存，下次核验应在完整性检查处拒绝');
  });
  act('[data-act="add-rs"]', () => addKey(p, 'RS256'));
  act('[data-act="add-es"]', () => addKey(p, 'ES256'));
  act('[data-act="verify"]', () => verifyTyped(p, false));
  act('[data-act="verify-force"]', () => verifyTyped(p, true));
  act('[data-act="recheck"]', () => recheck(p, false));
  act('[data-act="recheck-force"]', () => recheck(p, true));

  document.querySelectorAll('[data-key][data-status]').forEach((b) => {
    b.onclick = async () => {
      await api(`/api/providers/${p.id}/keys/${b.dataset.key}/status`, { method: 'POST', body: { status: b.dataset.status } });
      await refresh(); toast(`密钥 ${b.dataset.key} 已置为 ${b.dataset.status}`);
    };
  });
}

async function addKey(p, alg) {
  await api(`/api/providers/${p.id}/keys`, { method: 'POST', body: { alg } });
  await refresh(); toast(`已生成新的 ${alg} 密钥（演示私钥仅存本地 data，不对外返回）`);
}

async function verifyTyped(p, force) {
  const token = $('#token-input').value.trim();
  if (!token) return toast('请先粘贴令牌或选择样例', true);
  const result = await api(`/api/providers/${p.id}/verify`, {
    method: 'POST', body: { token, forceRefresh: force, source: force ? 'manual-force' : 'manual' },
  });
  renderVerifyResult(result);
  await loadProviders();
  loadAudit();
  toast(`${result.decision === 'TRUSTED' ? '信任' : '拒绝'}：${result.reasonCode}`, result.decision !== 'TRUSTED');
}

async function recheck(p, force) {
  const { results } = await api(`/api/providers/${p.id}/recheck`, { method: 'POST', body: { forceRefresh: force } });
  const changed = results.filter((r) => r.before && r.before.reasonCode !== r.after.reasonCode);
  await refresh();
  toast(`重新检查 ${results.length} 条样例，${changed.length} 条结论发生变化（配置版本/密钥状态差异可在审计中追溯）`);
}

async function refresh() {
  await loadProviders();
  await loadAudit();
}

// ---------- 审计 ----------
async function loadAudit() {
  const filter = $('#audit-filter').value;
  const rows = await api(filter ? `/api/audit?providerId=${encodeURIComponent(filter)}` : '/api/audit');
  $('#audit-list').innerHTML = rows.slice(0, 80).map((r) => `
    <div class="audit-row">
      <div class="top">
        <span>${decisionBadge(r.decision, r.reasonCode)}</span>
        <span class="mono">${esc(r.ts.slice(11, 19))}</span>
      </div>
      <div class="reason">${esc(r.reason)}</div>
      <div class="trace">
        ${esc(r.providerName)} · 配置 v${r.configVersion} · 缓存 #${r.cacheGeneration}
        · kid=${esc(r.matchedKid || '无')} · 来源=${esc(r.source)} · 令牌指纹=${esc(r.tokenFingerprint)}
      </div>
      <details><summary>核验流水线（${r.trace.length} 步）</summary>${traceHtml(r.trace)}</details>
    </div>`).join('') || '<p class="note">暂无审计记录。</p>';
}

$('#audit-filter').onchange = loadAudit;

// ---------- 新建/编辑提供方 ----------
function openProviderDialog(p) {
  const dlg = $('#dlg-provider');
  const f = $('#form-provider');
  $('#dlg-title').textContent = p ? '编辑身份提供方（保存即升版本并清空缓存）' : '新建身份提供方';
  f.name.value = p?.name || '';
  f.issuer.value = p?.expected.issuer || 'https://example.demo.local';
  f.authorizationEndpoint.value = p?.expected.authorizationEndpoint || 'https://example.demo.local/authorize';
  f.jwksUri.value = p?.expected.jwksUri || 'https://example.demo.local/jwks.json';
  Array.from(f.algs.options).forEach((o) => { o.selected = p ? p.allowedAlgs.includes(o.value) : o.value === 'RS256'; });
  dlg.showModal();
  $('#dlg-save').onclick = async (e) => {
    e.preventDefault();
    const algs = Array.from(f.algs.selectedOptions).map((o) => o.value);
    try {
      if (p) {
        await api(`/api/providers/${p.id}`, {
          method: 'PATCH',
          body: { name: f.name.value, expected: { issuer: f.issuer.value, authorizationEndpoint: f.authorizationEndpoint.value, jwksUri: f.jwksUri.value }, allowedAlgs: algs },
        });
      } else {
        const created = await api('/api/providers', {
          method: 'POST',
          body: { name: f.name.value, expected: { issuer: f.issuer.value, authorizationEndpoint: f.authorizationEndpoint.value, jwksUri: f.jwksUri.value }, allowedAlgs: algs },
        });
        selectedId = created.id;
      }
      dlg.close();
      await refresh();
      toast('配置已保存，configVersion 已递增、缓存已清空');
    } catch (err) { toast(err.message, true); }
  };
}
$('#btn-new-provider').onclick = () => openProviderDialog(null);

$('#btn-reset').onclick = async () => {
  if (!confirm('重置会清空全部配置、密钥、缓存与审计，并重新生成内置演示数据。继续？')) return;
  await api('/api/reset', { method: 'POST' });
  selectedId = null;
  lastResults = {};
  await bootstrap();
  toast('演示数据已重置');
};

async function bootstrap() {
  try {
    const health = await api('/api/health');
    $('#health').textContent = health.offline ? '● 离线模式正常' : '● 服务正常';
    $('#health').className = 'pill ok';
  } catch {
    $('#health').textContent = '● 服务不可用';
    $('#health').className = 'pill bad';
    return;
  }
  const ps = await api('/api/providers');
  const filter = $('#audit-filter');
  filter.innerHTML = '<option value="">全部提供方</option>' + ps.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  await loadProviders();
  await loadAudit();
}

bootstrap();
setInterval(loadProviders, 5000);
