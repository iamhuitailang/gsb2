"use strict";

const $ = (id) => document.getElementById(id);
const input = $("xml-input");
const STATUS_TEXT = {
  ok: "✓ 正常：未发现格式错误或危险构造",
  blocked: "⚠ 已阻止：发现危险构造，已按策略拦截",
  error: "✗ 格式错误：文档不是良构 XML",
  limited: "⛔ 已终止：触发处理限制",
};
const SEV_TEXT = { error: "格式错误", blocked: "已阻止", limit: "限制终止", info: "信息" };

function updateSize() {
  const n = new Blob([input.value]).size;
  $("input-size").textContent = n ? `输入 ${n} 字节` : "";
}
input.addEventListener("input", updateSize);

// --- 样例与文件导入 ---
async function loadSamples() {
  const res = await fetch("/api/samples");
  const data = await res.json();
  const sel = $("sample-select");
  for (const name of data.samples) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    sel.appendChild(opt);
  }
}
$("load-sample").addEventListener("click", async () => {
  const name = $("sample-select").value;
  if (!name) return;
  const res = await fetch(`/api/samples/${encodeURIComponent(name)}`);
  input.value = await res.text();
  updateSize();
});
$("file-input").addEventListener("change", (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => { input.value = reader.result; updateSize(); };
  reader.readAsText(file);
  ev.target.value = "";
});
$("clear-btn").addEventListener("click", () => { input.value = ""; updateSize(); });

// --- 检查 ---
$("inspect-btn").addEventListener("click", async () => {
  const res = await fetch("/api/inspect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ xml: input.value }),
  });
  const result = await res.json();
  if (result.error) { alert(result.error); return; }
  render(result);
});

function render(result) {
  const banner = $("status-banner");
  banner.className = `banner ${result.status}`;
  banner.textContent = STATUS_TEXT[result.status] || result.status;

  const s = result.stats;
  $("stats").className = "stats";
  $("stats").innerHTML =
    `<span>元素 ${s.elements}</span><span>最大深度 ${s.max_depth}</span>` +
    `<span>文本 ${s.text_chars} 字符</span><span>实体声明 ${s.entity_decls}</span>` +
    `<span>输入 ${result.input_bytes} 字节</span><span>耗时 ${result.duration_ms} ms</span>`;

  renderDiagnostics(result.diagnostics);
  renderTree(result.tree);
  renderSource(input.value);
}

function renderDiagnostics(diags) {
  const ul = $("diagnostics");
  ul.innerHTML = "";
  if (!diags.length) {
    ul.innerHTML = '<li class="muted">无诊断信息</li>';
    return;
  }
  for (const d of diags) {
    const li = document.createElement("li");
    li.className = `sev-${d.severity}`;
    const pos = d.line != null ? `<span class="pos">第 ${d.line} 行${d.column != null ? ` 第 ${d.column} 列` : ""}</span>` : "";
    li.innerHTML = `<span class="badge sev-${d.severity}">${SEV_TEXT[d.severity] || d.severity}</span>` +
      `<span class="msg"></span>${pos}`;
    li.querySelector(".msg").textContent = d.message;
    if (d.line != null) li.addEventListener("click", () => highlightLine(d.line));
    ul.appendChild(li);
  }
}

function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function truncate(s, n = 120) {
  return s.length > n ? s.slice(0, n) + `…（共 ${s.length} 字符）` : s;
}

function renderTree(root) {
  const box = $("tree");
  box.className = "tree";
  box.innerHTML = "";
  if (!root || !root.children || !root.children.length) {
    box.textContent = "没有可展示的结构（解析可能被提前终止）";
    box.classList.add("muted");
    return;
  }
  for (const child of root.children) box.appendChild(renderNode(child));
}

function renderNode(node) {
  if (node.type === "element") {
    const details = document.createElement("details");
    details.open = true;
    const summary = document.createElement("summary");
    let html = `<span class="el">&lt;${esc(node.name)}&gt;</span>`;
    if (node.namespace) html += ` <span class="ns">ns: ${esc(node.namespace)}</span>`;
    for (const ns of node.namespaces || []) {
      html += ` <span class="ns">xmlns${ns.prefix ? ":" + esc(ns.prefix) : ""}="${esc(ns.uri)}"</span>`;
    }
    for (const a of node.attributes) {
      html += ` <span class="attr">${esc(a.name)}="${esc(truncate(a.value, 60))}"</span>`;
    }
    html += ` <span class="loc">第 ${node.line} 行</span>`;
    summary.innerHTML = html;
    details.appendChild(summary);
    for (const child of node.children) details.appendChild(renderNode(child));
    return details;
  }
  const div = document.createElement("div");
  div.style.marginLeft = "16px";
  if (node.type === "text") {
    const cls = node.cdata ? "cdata" : "text";
    const label = node.cdata ? "CDATA: " : "";
    div.innerHTML = `<span class="${cls}">${label}${esc(truncate(node.content))}</span>` +
      ` <span class="loc">第 ${node.line} 行</span>`;
  } else if (node.type === "comment") {
    div.innerHTML = `<span class="comment">&lt;!--${esc(truncate(node.content))}--&gt;</span>` +
      ` <span class="loc">第 ${node.line} 行</span>`;
  } else if (node.type === "pi") {
    div.innerHTML = `<span class="pi">&lt;?${esc(node.target)} ${esc(truncate(node.content))}?&gt;</span>` +
      ` <span class="loc">第 ${node.line} 行</span>`;
  }
  return div;
}

function renderSource(text) {
  const box = $("source");
  box.className = "source";
  box.innerHTML = "";
  const lines = text.split("\n");
  const frag = document.createDocumentFragment();
  lines.forEach((line, i) => {
    const div = document.createElement("div");
    div.className = "line";
    div.id = `src-line-${i + 1}`;
    const ln = document.createElement("span");
    ln.className = "ln";
    ln.textContent = i + 1;
    const code = document.createElement("span");
    code.textContent = line || " ";
    div.appendChild(ln);
    div.appendChild(code);
    frag.appendChild(div);
  });
  box.appendChild(frag);
}

function highlightLine(lineNo) {
  document.querySelectorAll(".source .line.hl").forEach((el) => el.classList.remove("hl"));
  const el = $(`src-line-${lineNo}`);
  if (el) {
    el.classList.add("hl");
    el.scrollIntoView({ block: "center", behavior: "smooth" });
  }
}

loadSamples().catch(() => {});
