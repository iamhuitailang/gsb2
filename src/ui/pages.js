// 授权服务的页面渲染。所有用户输入都经过转义。
import {
  SCOPES,
  TICKET_STATUS_LABELS,
} from '../config.js';
import { escapeHtml } from '../util.js';

export function scopePill(scope) {
  const cls = scope === 'tickets:read' ? 'read' : 'update';
  return `<span class="pill ${cls}">${escapeHtml(SCOPES[scope]?.label || scope)}</span>`;
}

export function loginPage({ csrf, next, error = '' }) {
  return `
  <div class="card" style="max-width:420px;margin:60px auto">
    <h1>登录工单系统</h1>
    <p class="muted">演示账号：alice 或 bob，密码 ticket-demo-pass</p>
    ${error ? `<div class="notice err">${escapeHtml(error)}</div>` : ''}
    <form method="post" action="/login">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <input type="hidden" name="next" value="${escapeHtml(next)}">
      <p><label>用户名<br><input name="username" autocomplete="username" required style="width:100%;padding:8px;border:1px solid #cfd6df;border-radius:6px"></label></p>
      <p><label>密码<br><input name="password" type="password" autocomplete="current-password" required style="width:100%;padding:8px;border:1px solid #cfd6df;border-radius:6px"></label></p>
      <div class="actions"><button class="primary" type="submit">登录</button></div>
    </form>
  </div>`;
}

export function errorPage({ title, message, status }) {
  return `<div class="card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p class="muted">错误码：<code>${escapeHtml(status)}</code></p></div>`;
}

// 授权确认页：按应用展示它申请的范围，用户可以逐项勾选。
// 已授权的范围会标注“已授权”，勾选它表示维持；不勾选不会缩小既有授权（缩小请到设置页撤销）。
export function consentPage({ client, requestedScopes, existingScopes, csrf, params }) {
  const rows = requestedScopes.map((scope) => {
    const meta = SCOPES[scope] || { label: scope, description: '' };
    const already = existingScopes.includes(scope);
    return `
      <label class="scope">
        <input type="checkbox" name="approved_scope" value="${escapeHtml(scope)}" checked>
        <strong>${escapeHtml(meta.label)}</strong>
        ${already ? '<span class="pill ok">已授权</span>' : '<span class="pill">新增</span>'}
        <div class="muted" style="margin-top:4px">${escapeHtml(meta.description)}</div>
        <div class="muted" style="margin-top:4px">范围代码：<code>${escapeHtml(scope)}</code></div>
      </label>`;
  }).join('');

  const hidden = [
    'client_id', 'redirect_uri', 'response_type', 'scope', 'state',
    'code_challenge', 'code_challenge_method',
  ].map((k) => params[k] != null
    ? `<input type="hidden" name="${k}" value="${escapeHtml(params[k])}">`
    : '').join('');

  const upgrade = requestedScopes.some((s) => !existingScopes.includes(s)) && existingScopes.length > 0;

  return `
  <div class="card">
    <h1>${upgrade ? '应用申请扩大权限' : '应用申请访问你的工单'}</h1>
    <p><strong>${escapeHtml(client.name)}</strong> 请求访问你的工单数据。它只能获得你在此勾选的范围，并且始终受你本人可访问的工单限制。</p>
    ${upgrade ? `<div class="notice info">这是权限升级：应用此前已获得 ${existingScopes.map(scopePill).join(' ')}。升级需要你重新确认。</div>` : ''}
    <form method="post" action="/oauth/authorize">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      ${hidden}
      ${rows}
      <p class="muted">取消勾选某项即本次不授予该范围。已授予的范围如需收回，请到「已授权应用」页撤销。</p>
      <div class="actions">
        <button class="primary" type="submit" name="decision" value="approve">允许所选范围</button>
        <button class="danger" type="submit" name="decision" value="deny">拒绝</button>
      </div>
    </form>
  </div>`;
}

export function settingsPage({ user, grants, csrf, flash = null }) {
  const rows = grants.length
    ? grants.map((g) => `
      <tr>
        <td><strong>${escapeHtml(g.clientName)}</strong><div class="muted"><code>${escapeHtml(g.clientId)}</code></div></td>
        <td>${g.scopes.map(scopePill).join(' ')}</td>
        <td class="muted">${escapeHtml(formatTime(g.updatedAt))}</td>
        <td>
          <form method="post" action="/settings/grants/${encodeURIComponent(g.grantId)}/revoke" style="margin:0">
            <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
            <button class="danger" type="submit">撤销授权</button>
          </form>
        </td>
      </tr>`).join('')
    : '<tr><td colspan="4"><div class="empty">还没有任何应用获得授权。</div></td></tr>';

  return `
  <div class="card">
    <h1>已授权应用</h1>
    <p class="muted">这里列出已获得你授权的应用及其范围。撤销后，该应用已取得的访问凭据和刷新能力会立即失效，其它应用不受影响。</p>
    ${flash ? `<div class="notice ${flash.type === 'error' ? 'err' : 'ok'}">${escapeHtml(flash.message)}</div>` : ''}
    <table>
      <thead><tr><th>应用</th><th>授权范围</th><th>更新时间</th><th>操作</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

export function homePage({ user, tickets, appAUrl, appBUrl }) {
  const rows = tickets.length
    ? tickets.map((t) => `
      <tr>
        <td><code>${escapeHtml(t.id)}</code></td>
        <td>${escapeHtml(t.title)}</td>
        <td><span class="pill">${escapeHtml(TICKET_STATUS_LABELS[t.status] || t.status)}</span></td>
      </tr>`).join('')
    : '<tr><td colspan="3"><div class="empty">没有可访问的工单。</div></td></tr>';
  return `
  <div class="card">
    <h1>你好，${escapeHtml(user.displayName)}</h1>
    <p class="muted">你当前可访问的工单（用户自己的可见范围）：</p>
    <table>
      <thead><tr><th>编号</th><th>标题</th><th>状态</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="muted">你的团队：${user.teams.map((t) => `<span class="pill">${escapeHtml(t)}</span>`).join(' ') || '（无）'}</p>
  </div>
  <div class="card">
    <h2>演示应用</h2>
    <p class="muted">两个应用各自使用独立凭据，需分别由你授权；授权后它们只能看到你在上方可见的工单。</p>
    <p><a class="btn secondary" href="${escapeHtml(appAUrl)}">打开甲应用（只读）</a>
       <a class="btn secondary" href="${escapeHtml(appBUrl)}">打开乙应用（可更新）</a></p>
  </div>`;
}

export function docsPage() {
  return `
  <div class="card">
    <h1>接口说明</h1>
    <p class="muted">应用以 OAuth2 授权码 + PKCE 获取访问令牌，再用 Bearer 令牌调用工单接口。所有接口都会同时校验：令牌有效、令牌范围、以及当前用户对该工单的可见性。</p>
    <h2>授权端点</h2>
    <table>
      <thead><tr><th>端点</th><th>说明</th></tr></thead>
      <tbody>
        <tr><td><code>GET /oauth/authorize</code></td><td>浏览器跳转，展示确认页（需登录）</td></tr>
        <tr><td><code>POST /oauth/token</code></td><td>应用凭据 + 授权码（或 refresh_token）换取令牌，需 PKCE</td></tr>
        <tr><td><code>POST /oauth/revoke</code></td><td>应用主动归还令牌</td></tr>
      </tbody>
    </table>
    <h2>工单接口</h2>
    <table>
      <thead><tr><th>接口</th><th>所需范围</th><th>返回</th></tr></thead>
      <tbody>
        <tr><td><code>GET /api/tickets</code></td><td><code>tickets:read</code></td><td>可见工单的 <code>id</code> 与 <code>title</code>，不含正文/状态</td></tr>
        <tr><td><code>POST /api/tickets/:id/status</code></td><td><code>tickets:update</code></td><td>仅回写后的 <code>id</code> 与 <code>status</code></td></tr>
        <tr><td><code>GET /api/me</code></td><td>任意有效令牌</td><td>当前用户、应用与本次生效范围</td></tr>
      </tbody>
    </table>
    <h2>状态码</h2>
    <p class="muted"><code>401 invalid_token</code> 令牌无效/过期/授权已撤销；<code>403 insufficient_scope</code> 范围不足；<code>404</code> 工单不存在或当前用户无权访问。</p>
  </div>`;
}

export function formatTime(seconds) {
  if (!seconds) return '-';
  const d = new Date(seconds * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
