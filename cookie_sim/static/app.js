/* Cookie 安全策略模拟器前端: 纯原生 JS, 只访问本机 API, 无外部资源。 */
"use strict";

const $ = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const resp = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || `请求失败: ${resp.status}`);
  return data;
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[ch]));

function formatExpiry(cookie, serverTime) {
  if (cookie.expires === null || cookie.expires === undefined) {
    return "会话 cookie";
  }
  const expired = serverTime >= cookie.expires;
  const label = new Date(cookie.expires * 1000).toLocaleString();
  return expired ? `已过期(${label})` : label;
}

// ---------- 样例 ----------
async function loadSamples() {
  const { samples } = await api("/api/samples");
  const box = $("sample-list");
  box.innerHTML = "";
  samples.forEach((s) => {
    const btn = document.createElement("button");
    btn.className = "sample-btn";
    btn.innerHTML = `<b>${esc(s.title)}</b><span class="desc">${esc(s.description)}</span>`;
    btn.addEventListener("click", () => loadSample(s.id));
    box.appendChild(btn);
  });
}

async function loadSample(id) {
  const data = await api("/api/load-sample", {
    method: "POST",
    body: JSON.stringify({ sample_id: id }),
  });
  const sample = (await api("/api/samples")).samples.find((s) => s.id === id);
  $("source-url").value = sample.source_url;
  $("set-cookie-input").value = sample.set_cookies.join("\n");
  $("request-url").value = sample.request_url;
  $("top-url").value = sample.top_url;
  $("method").value = sample.method;
  $("is-navigation").checked = sample.is_navigation;
  if (sample.document_url) $("document-url").value = sample.document_url;
  renderJar(data.jar);
  await evaluate();
  if (sample.document_url) await scriptView();
}

// ---------- Cookie 库渲染 ----------
function renderJar(jar) {
  const tbody = $("cookie-table").querySelector("tbody");
  tbody.innerHTML = "";
  $("cookie-count").textContent = jar.cookies.length;
  $("reject-count").textContent = jar.rejections.length;

  if (jar.cookies.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty-note">暂无 cookie, 先在左侧接收 Set-Cookie</td></tr>';
  }
  jar.cookies
    .slice()
    .sort((a, b) => a.domain.localeCompare(b.domain) || a.path.localeCompare(b.path) || a.name.localeCompare(b.name))
    .forEach((c) => {
      const tr = document.createElement("tr");
      const expired = c.expires !== null && jar.server_time >= c.expires;
      tr.innerHTML = `
        <td class="mono">${esc(c.name)}</td>
        <td class="mono">${esc(c.value)}</td>
        <td class="mono ${c.host_only ? "scope-host" : "scope-domain"}">
          ${c.host_only ? "主机级: " : "Domain: "}${esc(c.domain)}
        </td>
        <td class="mono">${esc(c.path)}</td>
        <td>${c.secure ? "✓" : "—"}</td>
        <td>${c.http_only ? "✓" : "—"}</td>
        <td>${esc(c.same_site)}</td>
        <td class="${expired ? "expired" : ""}">${esc(formatExpiry(c, jar.server_time))}</td>
        <td><button class="del-btn">删除</button></td>`;
      tr.querySelector(".del-btn").addEventListener("click", () => deleteCookie(c));
      tbody.appendChild(tr);
    });

  const rj = $("rejection-list");
  rj.innerHTML = "";
  if (jar.rejections.length === 0) {
    rj.innerHTML = '<p class="empty-note">暂无拒收记录</p>';
  }
  jar.rejections.slice().reverse().forEach((r) => {
    const div = document.createElement("div");
    div.className = "reject-item";
    div.innerHTML = `
      <div class="reason">✗ ${esc(r.reason)}</div>
      <div class="raw">${esc(r.raw)}</div>
      <div class="meta">来源主机: ${esc(r.source_host)}${r.detail ? " · " + esc(r.detail) : ""}</div>`;
    rj.appendChild(div);
  });
}

async function refreshJar() {
  renderJar(await api("/api/jar"));
}

async function deleteCookie(c) {
  const q = new URLSearchParams({ name: c.name, domain: c.domain, path: c.path });
  const jar = await api(`/api/cookie?${q.toString()}`, { method: "DELETE" });
  renderJar(jar);
}

// ---------- 接收 Set-Cookie ----------
async function addCookies() {
  const payload = {
    source_url: $("source-url").value.trim(),
    set_cookies: $("set-cookie-input").value,
  };
  try {
    const data = await api("/api/set-cookie", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    renderJar(data.jar);
    const rejected = data.results.filter((r) => !r.accepted);
    if (rejected.length > 0) {
      alert(`有 ${rejected.length} 条 cookie 被拒收, 原因见页面左下方「拒收记录」`);
    }
  } catch (err) {
    alert(err.message);
  }
}

// ---------- 请求决策 ----------
function renderDecision(d) {
  const tag = $("cross-site-tag");
  tag.classList.remove("hidden", "cross", "same");
  tag.classList.add(d.cross_site ? "cross" : "same");
  tag.textContent = d.cross_site ? "跨站请求" : "同站请求";

  const headerBox = $("cookie-header");
  headerBox.classList.toggle("empty", !d.cookie_header);
  headerBox.textContent = d.cookie_header || "(没有任何 cookie 满足发送条件, 请求不带 Cookie 头)";
  const sentCount = d.decisions.filter((x) => x.sent).length;
  $("header-hint").textContent =
    `共评估 ${d.evaluated_count} 条 cookie, 实际发送 ${sentCount} 条; 已按路径长度降序、创建先后稳定排序。`;

  const list = $("decision-list");
  list.innerHTML = "";
  if (d.decisions.length === 0) {
    list.innerHTML = '<p class="empty-note">Cookie 库为空</p>';
    return;
  }
  d.decisions.forEach((item) => {
    const c = item.cookie;
    const div = document.createElement("div");
    div.className = "decision";
    const checks = item.checks.map((chk) => `
      <li>
        <span class="check-icon ${chk.passed ? "ok" : "no"}">${chk.passed ? "✓" : "✗"}</span>
        <span><b>${esc(chk.label)}</b> — <span class="detail">${esc(chk.detail)}</span></span>
      </li>`).join("");
    div.innerHTML = `
      <div class="cookie-title">
        <span class="mono">${esc(c.name)}=${esc(c.value)}</span>
        <span class="pill ${item.sent ? "sent" : "blocked"}">${item.sent ? "允许发送" : "阻止"}</span>
        <span class="meta">${c.host_only ? "主机级" : "Domain=" + esc(c.domain)} · Path=${esc(c.path)}
          · SameSite=${esc(c.same_site)}${c.http_only ? " · HttpOnly" : ""}${c.secure ? " · Secure" : ""}</span>
      </div>
      <ul class="checks">${checks}</ul>
      ${item.sent ? "" : `<div class="block-line">阻止原因: ${esc(item.block_reason)}</div>`}`;
    list.appendChild(div);
  });
}

async function evaluate() {
  const payload = {
    request_url: $("request-url").value.trim(),
    top_url: $("top-url").value.trim(),
    method: $("method").value,
    is_navigation: $("is-navigation").checked,
  };
  try {
    renderDecision(await api("/api/evaluate", {
      method: "POST",
      body: JSON.stringify(payload),
    }));
  } catch (err) {
    alert(err.message);
  }
}

// ---------- 脚本可读视图 ----------
async function scriptView() {
  try {
    const view = await api("/api/script-view", {
      method: "POST",
      body: JSON.stringify({ document_url: $("document-url").value.trim() }),
    });
    const box = $("script-header");
    box.classList.toggle("empty", !view.readable_header);
    box.textContent = view.readable_header || "(脚本读不到任何 cookie)";

    const detail = $("script-detail");
    detail.innerHTML = "";
    view.readable.forEach((c) => {
      const div = document.createElement("div");
      div.className = "decision script-item";
      div.innerHTML = `<b class="mono">${esc(c.name)}=${esc(c.value)}</b> — 脚本可读`;
      detail.appendChild(div);
    });
    view.excluded.forEach((item) => {
      const c = item.cookie;
      const div = document.createElement("div");
      div.className = "decision script-item excluded";
      div.innerHTML = `<b class="mono">${esc(c.name)}=${esc(c.value)}</b>
        — <span class="why">不可读: ${esc(item.reason)}</span>`;
      detail.appendChild(div);
    });
  } catch (err) {
    alert(err.message);
  }
}

// ---------- 初始化 ----------
document.addEventListener("DOMContentLoaded", async () => {
  $("btn-add").addEventListener("click", addCookies);
  $("btn-evaluate").addEventListener("click", evaluate);
  $("btn-script-view").addEventListener("click", scriptView);
  $("btn-clear").addEventListener("click", async () => {
    if (!confirm("确认清空全部 cookie 与拒收记录?")) return;
    renderJar(await api("/api/clear", { method: "POST" }));
  });
  $("btn-purge").addEventListener("click", async () => {
    const data = await api("/api/purge-expired", { method: "POST" });
    renderJar(data.jar);
    alert(`已清理 ${data.removed} 条过期 cookie`);
  });
  await loadSamples();
  await refreshJar();
});
