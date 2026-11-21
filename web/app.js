/* 任务链编辑器前端 (原生 JS, 无构建依赖)
 *
 * 模块: api / state / graph(渲染与交互) / editor(属性面板) /
 *       issues / simulator / impact / io(导入导出)
 */
"use strict";

// ---------------------------------------------------------------------------
// API 封装
// ---------------------------------------------------------------------------

const api = {
  async post(path, body) {
    const resp = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (!resp.ok || data.error) throw new Error(data.error || `HTTP ${resp.status}`);
    return data;
  },
  async get(path) {
    const resp = await fetch(path);
    const data = await resp.json();
    if (!resp.ok || data.error) throw new Error(data.error || `HTTP ${resp.status}`);
    return data;
  },
};

const SVG_NS = "http://www.w3.org/2000/svg";
const NODE_W = 168;
const NODE_H = 58;

const STATE_LABELS = {
  locked: "等待/失效",
  available: "可接取",
  active: "进行中",
  completed: "已完成",
  failed: "已失败",
};
const STATE_COLORS = {
  locked: "#8a94a6",
  available: "#98c379",
  active: "#e5c07b",
  completed: "#61afef",
  failed: "#e06c75",
};

// ---------------------------------------------------------------------------
// 全局状态
// ---------------------------------------------------------------------------

const state = {
  project: null,              // 当前工程对象 (普通 JSON)
  selectedId: null,
  sessionId: null,            // 模拟器会话
  simStates: null,            // quest_id -> 状态
  blockedReasons: {},
  simMode: false,
  view: { x: 0, y: 0, scale: 1 },
  baselineForDiff: null,      // 进入编辑器时的工程快照, 用于条件变更对比
};

const $ = (sel) => document.querySelector(sel);

function toast(message, kind = "") {
  const el = $("#toast");
  el.textContent = message;
  el.className = `toast ${kind}`;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => el.classList.add("hidden"), 3600);
}

function questIndex() {
  const map = new Map();
  for (const q of state.project.quests) map.set(q.id, q);
  return map;
}

// ---------------------------------------------------------------------------
// 画布视图变换
// ---------------------------------------------------------------------------

function applyViewport() {
  const { x, y, scale } = state.view;
  $("#viewport")
    .setAttribute("transform", `translate(${x},${y}) scale(${scale})`);
}

function screenToWorld(clientX, clientY) {
  const rect = $("#graph").getBoundingClientRect();
  return {
    x: (clientX - rect.left - state.view.x) / state.view.scale,
    y: (clientY - rect.top - state.view.y) / state.view.scale,
  };
}

// ---------------------------------------------------------------------------
// 图渲染
// ---------------------------------------------------------------------------

function renderGraph() {
  if (!state.project) return;
  renderEdges();
  renderNodes();
  applyViewport();
}

function renderEdges() {
  const layer = $("#edges-layer");
  layer.innerHTML = "";
  const index = questIndex();
  const drawnMutex = new Set();

  for (const quest of state.project.quests) {
    // 前置依赖边: 前置 -> 当前任务
    for (const preId of quest.prerequisites) {
      const pre = index.get(preId);
      if (!pre) continue;
      layer.appendChild(makeEdge(pre, quest, "dep"));
    }
    // 互斥边 (去重, 无方向虚线)
    for (const otherId of quest.exclusive_with) {
      const key = [quest.id, otherId].sort().join("::");
      if (drawnMutex.has(key)) continue;
      drawnMutex.add(key);
      const other = index.get(otherId);
      if (other) layer.appendChild(makeEdge(quest, other, "mutex"));
    }
  }
}

function makeEdge(from, to, kind) {
  const x1 = from.position.x + NODE_W / 2;
  const y1 = from.position.y + NODE_H / 2;
  const x2 = to.position.x + NODE_W / 2;
  const y2 = to.position.y + NODE_H / 2;
  const path = document.createElementNS(SVG_NS, "path");
  const d = curvePath(x1, y1, x2, y2, kind);
  path.setAttribute("d", d);
  path.setAttribute("class", `edge ${kind === "mutex" ? "mutex" : ""}`);
  path.setAttribute("marker-end", kind === "mutex" ? "url(#arrow-mutex)" : "url(#arrow)");
  path.dataset.from = from.id;
  path.dataset.to = to.id;
  path.dataset.kind = kind;
  return path;
}

function curvePath(x1, y1, x2, y2, kind) {
  if (kind === "mutex") {
    // 互斥任务通常同层, 画轻微外凸的曲线
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2 - 26;
    return `M ${x1} ${y1} Q ${mx} ${my} ${x2} ${y2}`;
  }
  const dy = Math.max(40, (y2 - y1) / 2);
  return `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`;
}

function renderNodes() {
  const layer = $("#nodes-layer");
  layer.innerHTML = "";
  for (const quest of state.project.quests) {
    layer.appendChild(makeNode(quest));
  }
  highlightSelection();
}

function makeNode(quest) {
  const g = document.createElementNS(SVG_NS, "g");
  g.setAttribute("class", "node-group");
  g.dataset.id = quest.id;
  g.setAttribute("transform", `translate(${quest.position.x},${quest.position.y})`);

  const rect = document.createElementNS(SVG_NS, "rect");
  rect.setAttribute("width", NODE_W);
  rect.setAttribute("height", NODE_H);
  rect.setAttribute("class", "node-rect");
  rect.setAttribute("rx", 8);
  g.appendChild(rect);

  const title = document.createElementNS(SVG_NS, "text");
  title.setAttribute("x", 10);
  title.setAttribute("y", 22);
  title.setAttribute("class", "node-title");
  title.textContent = quest.title || quest.id;
  g.appendChild(title);

  const idText = document.createElementNS(SVG_NS, "text");
  idText.setAttribute("x", 10);
  idText.setAttribute("y", 38);
  idText.setAttribute("class", "node-id");
  idText.textContent = quest.id;
  g.appendChild(idText);

  // 角标: 结局 / 支线
  let badgeX = NODE_W - 12;
  if (quest.is_ending) {
    const badge = makeBadge("★", "#c678dd", badgeX, 14);
    g.appendChild(badge);
    badgeX -= 20;
  }
  if (quest.optional) {
    g.appendChild(makeBadge("支", "#56b6c2", badgeX, 14));
  }

  // 模拟状态色条
  if (state.simMode && state.simStates) {
    const simState = state.simStates[quest.id] || "locked";
    rect.classList.add(`state-${simState}`);
    if (quest.is_ending && simState === "completed") rect.classList.add("ending-completed");
    const stateDot = document.createElementNS(SVG_NS, "circle");
    stateDot.setAttribute("cx", NODE_W - 12);
    stateDot.setAttribute("cy", NODE_H - 12);
    stateDot.setAttribute("r", 5);
    stateDot.setAttribute("fill", STATE_COLORS[simState]);
    g.appendChild(stateDot);
  }
  if (quest.is_ending) rect.classList.add("is-ending");

  attachNodeDrag(g, quest);
  return g;
}

function makeBadge(text, color, x, y) {
  const t = document.createElementNS(SVG_NS, "text");
  t.setAttribute("x", x);
  t.setAttribute("y", y);
  t.setAttribute("class", "node-badge");
  t.setAttribute("fill", color);
  t.setAttribute("text-anchor", "end");
  t.textContent = text;
  return t;
}

function highlightSelection() {
  document.querySelectorAll(".node-group").forEach((g) => {
    g.classList.toggle("selected", g.dataset.id === state.selectedId);
  });
}

// 点击问题项时聚焦任务
function focusQuest(questId) {
  const q = questIndex().get(questId);
  if (!q) return;
  state.selectedId = questId;
  state.view.x = -q.position.x * state.view.scale + 80;
  state.view.y = -q.position.y * state.view.scale + 120;
  applyViewport();
  highlightSelection();
  renderEditor();
}

// ---------------------------------------------------------------------------
// 节点拖拽 + 画布平移
// ---------------------------------------------------------------------------

function attachNodeDrag(group, quest) {
  group.addEventListener("mousedown", (ev) => {
    ev.stopPropagation();
    state.selectedId = quest.id;
    highlightSelection();
    renderEditor();

    const start = screenToWorld(ev.clientX, ev.clientY);
    const orig = { ...quest.position };
    let moved = false;
    group.classList.add("dragging");

    function onMove(moveEv) {
      const p = screenToWorld(moveEv.clientX, moveEv.clientY);
      // 3px 阈值, 避免单纯点击被当成拖拽改坐标
      if (!moved && Math.abs(p.x - start.x) < 3 && Math.abs(p.y - start.y) < 3) return;
      moved = true;
      quest.position = {
        x: Math.max(0, orig.x + (p.x - start.x)),
        y: Math.max(0, orig.y + (p.y - start.y)),
      };
      renderGraph();
    }
    function onUp() {
      group.classList.remove("dragging");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (moved) {
        markDirty();
        renderEditor();
      }
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });
}

function initCanvasGestures() {
  const svg = $("#graph");
  let panning = null;

  svg.addEventListener("mousedown", (ev) => {
    if (ev.target.closest(".node-group")) return;
    panning = { x: ev.clientX - state.view.x, y: ev.clientY - state.view.y };
    svg.classList.add("panning");
  });
  window.addEventListener("mousemove", (ev) => {
    if (!panning) return;
    state.view.x = ev.clientX - panning.x;
    state.view.y = ev.clientY - panning.y;
    applyViewport();
  });
  window.addEventListener("mouseup", () => {
    panning = null;
    svg.classList.remove("panning");
  });

  svg.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    const factor = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
    const newScale = Math.min(2.2, Math.max(0.35, state.view.scale * factor));
    const rect = svg.getBoundingClientRect();
    const mx = ev.clientX - rect.left;
    const my = ev.clientY - rect.top;
    // 以鼠标为锚点缩放
    state.view.x = mx - (mx - state.view.x) * (newScale / state.view.scale);
    state.view.y = my - (my - state.view.y) * (newScale / state.view.scale);
    state.view.scale = newScale;
    applyViewport();
  }, { passive: false });

  svg.addEventListener("dblclick", (ev) => {
    if (ev.target.closest(".node-group")) return;
    const p = screenToWorld(ev.clientX, ev.clientY);
    createQuest(p);
  });
}

// ---------------------------------------------------------------------------
// 任务增删改
// ---------------------------------------------------------------------------

function createQuest(worldPos) {
  const ids = new Set(state.project.quests.map((q) => q.id));
  let n = state.project.quests.length + 1;
  let id = `q_${n}`;
  while (ids.has(id)) id = `q_${++n}`;
  const quest = {
    id,
    title: "新任务",
    description: "",
    prerequisites: [],
    condition: "",
    exclusive_with: [],
    is_ending: false,
    optional: false,
    rewards: [],
    position: { x: Math.round(worldPos.x), y: Math.round(worldPos.y) },
  };
  state.project.quests.push(quest);
  state.selectedId = id;
  renderGraph();
  renderEditor();
  markDirty();
}

function deleteQuest(id) {
  const q = questIndex().get(id);
  if (!q) return;
  if (!confirm(`确定删除任务 ${id}? 其他任务对它的引用会变成缺失引用。`)) return;
  state.project.quests = state.project.quests.filter((x) => x.id !== id);
  for (const other of state.project.quests) {
    other.prerequisites = other.prerequisites.filter((x) => x !== id);
    other.exclusive_with = other.exclusive_with.filter((x) => x !== id);
  }
  state.selectedId = null;
  renderGraph();
  renderEditor();
  markDirty();
}

let dirty = false;
function markDirty() {
  dirty = true;
  if (state.simMode) {
    toast("工程已修改, 请重新开始模拟以使状态一致", "warn");
  }
}

// ---------------------------------------------------------------------------
// 属性编辑器
// ---------------------------------------------------------------------------

function renderEditor() {
  const root = $("#editor");
  const q = state.selectedId ? questIndex().get(state.selectedId) : null;
  if (!q) {
    root.innerHTML = `<p class="hint">选中一个任务节点进行编辑, 或双击画布新建任务。</p>`;
    return;
  }
  const all = state.project.quests.filter((x) => x.id !== q.id);
  const preOptions = all
    .map((x) => `<option value="${esc(x.id)}">${esc(x.title || x.id)}</option>`)
    .join("");

  root.innerHTML = `
    <label>任务 ID *</label>
    <input type="text" class="mono" id="f-id" value="${esc(q.id)}" />
    <label>标题</label>
    <input type="text" id="f-title" value="${esc(q.title)}" />
    <label>描述</label>
    <textarea id="f-desc">${esc(q.description)}</textarea>

    <label>前置任务 (全部完成才可接取)</label>
    <div class="chips" id="f-pre-chips">${q.prerequisites
      .map((id) => chip(id, "pre"))
      .join("")}</div>
    <div class="row" style="display:flex;gap:6px;margin-top:6px">
      <select id="f-pre-select" style="flex:1">${preOptions}</select>
      <button class="btn small" id="f-pre-add">添加</button>
    </div>

    <label>完成条件表达式 (DSL, 与前置取 AND; 留空恒真)</label>
    <textarea id="f-condition" class="mono" placeholder='例: var("reputation") >= 25 and flag("village_known")'>${esc(
      q.condition
    )}</textarea>

    <label>互斥任务</label>
    <div class="chips" id="f-mut-chips">${q.exclusive_with
      .map((id) => chip(id, "mut"))
      .join("")}</div>
    <div class="row" style="display:flex;gap:6px;margin-top:6px">
      <select id="f-mut-select" style="flex:1">${preOptions}</select>
      <button class="btn small" id="f-mut-add">添加</button>
    </div>

    <div class="check-row">
      <input type="checkbox" id="f-ending" ${q.is_ending ? "checked" : ""} />
      <label for="f-ending" style="margin:0">结局任务</label>
    </div>
    <div class="check-row">
      <input type="checkbox" id="f-optional" ${q.optional ? "checked" : ""} />
      <label for="f-optional" style="margin:0">可选支线 (不可达时仅警告)</label>
    </div>

    <label>完成奖励</label>
    <div id="f-rewards">${q.rewards.map((r, i) => rewardCard(r, i)).join("")}</div>
    <button class="btn small" id="f-reward-add" style="margin-top:6px">+ 添加奖励</button>

    <div class="editor-actions">
      <button class="btn primary small" id="f-save">应用修改</button>
      <button class="btn danger small" id="f-delete">删除任务</button>
    </div>
  `;
  bindEditorEvents(q);
}

function chip(id, kind) {
  return `<span class="chip">${esc(id)}<span class="x" data-kind="${kind}" data-id="${esc(
    id
  )}">✕</span></span>`;
}

function rewardCard(r, idx) {
  const fields = Object.entries(r)
    .filter(([k]) => k !== "type")
    .map(([k, v]) =>
      k === "note"
        ? ""
        : `<input type="text" data-k="${esc(k)}" value="${esc(String(v))}" placeholder="${esc(k)}" style="flex:1" />`
    )
    .join("");
  const types = ["item", "currency", "flag", "variable", "quest"];
  return `
    <div class="reward-card" data-idx="${idx}">
      <div class="row">
        <select data-k="type" style="flex:1">
          ${types
            .map((t) => `<option ${t === r.type ? "selected" : ""}>${t}</option>`)
            .join("")}
        </select>
        <button class="btn small danger reward-del">删除</button>
      </div>
      <div class="row">${fields}</div>
    </div>`;
}

function bindEditorEvents(q) {
  $("#f-save").onclick = () => applyEditor(q);
  $("#f-delete").onclick = () => deleteQuest(q.id);
  $("#f-pre-add").onclick = () => {
    const val = $("#f-pre-select").value;
    if (val && !q.prerequisites.includes(val)) {
      q.prerequisites.push(val);
      markDirty();
      renderEditor();
    }
  };
  $("#f-mut-add").onclick = () => {
    const val = $("#f-mut-select").value;
    if (val && !q.exclusive_with.includes(val)) {
      q.exclusive_with.push(val);
      const other = questIndex().get(val);
      if (other && !other.exclusive_with.includes(q.id)) other.exclusive_with.push(q.id);
      markDirty();
      renderEditor();
    }
  };
  $("#f-pre-chips").addEventListener("click", (ev) => {
    if (!ev.target.dataset.id) return;
    q.prerequisites = q.prerequisites.filter((x) => x !== ev.target.dataset.id);
    markDirty();
    renderEditor();
  });
  $("#f-mut-chips").addEventListener("click", (ev) => {
    if (!ev.target.dataset.id) return;
    const otherId = ev.target.dataset.id;
    q.exclusive_with = q.exclusive_with.filter((x) => x !== otherId);
    const other = questIndex().get(otherId);
    if (other) other.exclusive_with = other.exclusive_with.filter((x) => x !== q.id);
    markDirty();
    renderEditor();
  });
  $("#f-reward-add").onclick = () => {
    applyEditor(q);
    q.rewards.push({ type: "item", item_id: "new_item", amount: 1 });
    markDirty();
    renderEditor();
  };
  $("#f-rewards").addEventListener("click", (ev) => {
    if (!ev.target.classList.contains("reward-del")) return;
    const card = ev.target.closest(".reward-card");
    applyEditor(q);
    q.rewards.splice(Number(card.dataset.idx), 1);
    markDirty();
    renderEditor();
  });
}

function applyEditor(q) {
  const newId = $("#f-id").value.trim();
  if (!newId) return toast("任务 ID 不能为空", "error");
  if (newId !== q.id && state.project.quests.some((x) => x.id === newId)) {
    return toast("任务 ID 与已有任务冲突", "error");
  }
  if (newId !== q.id) rewriteQuestId(q.id, newId);

  q.title = $("#f-title").value;
  q.description = $("#f-desc").value;
  q.condition = $("#f-condition").value;
  q.is_ending = $("#f-ending").checked;
  q.optional = $("#f-optional").checked;

  // 收集奖励卡片
  q.rewards = [...document.querySelectorAll(".reward-card")].map((card) => {
    const reward = {};
    card.querySelectorAll("[data-k]").forEach((input) => {
      const key = input.dataset.k;
      let value = input.value;
      if (key === "amount" || key === "value") {
        const num = Number(value);
        value = Number.isNaN(num) ? value : num;
      }
      reward[key] = value;
    });
    const rtype = reward.type;
    delete reward.type;
    return { type: rtype, ...reward };
  });

  markDirty();
  renderGraph();
  toast("已应用修改 (记得保存工程)");
}

function rewriteQuestId(oldId, newId) {
  const q = questIndex().get(oldId);
  q.id = newId;
  for (const other of state.project.quests) {
    other.prerequisites = other.prerequisites.map((x) => (x === oldId ? newId : x));
    other.exclusive_with = other.exclusive_with.map((x) => (x === oldId ? newId : x));
    for (const reward of other.rewards) {
      if (reward.type === "quest" && reward.quest_id === oldId) reward.quest_id = newId;
    }
  }
  state.selectedId = newId;
}

function renderProjectMeta() {
  const p = state.project;
  $("#proj-meta").innerHTML = `
    <label style="color:var(--text-dim);font-size:11px">工程名称</label>
    <input type="text" id="m-name" value="${esc(p.name)}" />
    <label style="color:var(--text-dim);font-size:11px">初始变量 (JSON)</label>
    <input type="text" class="mono" id="m-vars" value="${esc(
      JSON.stringify(p.initial_variables)
    )}" />
    <label style="color:var(--text-dim);font-size:11px">初始 flags (JSON)</label>
    <input type="text" class="mono" id="m-flags" value="${esc(
      JSON.stringify(p.initial_flags)
    )}" />
    <button class="btn small" id="m-save" style="margin-top:6px">应用工程设置</button>
  `;
  $("#m-save").onclick = () => {
    try {
      p.initial_variables = JSON.parse($("#m-vars").value || "{}");
      p.initial_flags = JSON.parse($("#m-flags").value || "{}");
      p.name = $("#m-name").value;
      markDirty();
      toast("工程设置已更新");
    } catch (err) {
      toast("JSON 解析失败: " + err.message, "error");
    }
  };
}

function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// ---------------------------------------------------------------------------
// 诊断面板
// ---------------------------------------------------------------------------

async function runValidate() {
  try {
    const { issues } = await api.post("/api/validate", state.project);
    renderIssues(issues);
  } catch (err) {
    renderIssues([{ code: "PARSE", severity: "error", message: err.message }]);
  }
}

function renderIssues(issues) {
  const root = $("#issues-list");
  const errors = issues.filter((i) => i.severity === "error");
  const warns = issues.filter((i) => i.severity === "warning");
  if (!issues.length) {
    root.innerHTML = `<div class="summary-banner ok">✓ 未发现问题, 任务图结构健康</div>`;
    return;
  }
  const banner = errors.length
    ? `<div class="summary-banner bad">✗ ${errors.length} 个错误, ${warns.length} 个警告</div>`
    : `<div class="summary-banner ok">⚠ ${warns.length} 个警告, 无阻断性错误</div>`;
  root.innerHTML =
    banner +
    issues
      .map(
        (i) => `
      <div class="issue ${i.severity}" data-focus="${esc((i.quest_ids || [])[0] || "")}">
        <div class="code">${esc(i.code)}</div>
        <div class="msg">${esc(i.message)}</div>
        ${i.path && i.path.length ? `<div class="path">路径: ${esc(i.path.join(" → "))}</div>` : ""}
      </div>`
      )
      .join("");
  root.querySelectorAll(".issue").forEach((el) => {
    el.onclick = () => el.dataset.focus && focusQuest(el.dataset.focus);
  });
}

// ---------------------------------------------------------------------------
// 模拟器面板
// ---------------------------------------------------------------------------

async function startSimulation() {
  try {
    const data = await api.post("/api/sim/create", state.project);
    state.sessionId = data.session_id;
    state.simStates = data.quest_states;
    state.blockedReasons = data.blocked_reasons;
    state.simMode = true;
    renderGraph();
    renderSimPanel(data);
    switchTab("simulator");
    toast("模拟已开始, 点击画布节点执行接取/完成/失败");
  } catch (err) {
    toast("无法开始模拟: " + err.message, "error");
  }
}

async function simStep(action, questId) {
  if (!state.sessionId) return;
  try {
    const data = await api.post(`/api/sim/${state.sessionId}/step`, {
      action,
      quest_id: questId,
    });
    state.simStates = data.quest_states;
    state.blockedReasons = data.blocked_reasons;
    renderGraph();
    renderSimPanel(data, data.diff);
    if (!data.diff.ok) toast(data.diff.message, "warn");
  } catch (err) {
    toast(err.message, "error");
  }
}

async function simUndo() {
  if (!state.sessionId) return;
  const data = await api.post(`/api/sim/${state.sessionId}/undo`, {});
  if (!data.ok) return toast("没有可撤销的步骤", "warn");
  state.simStates = data.quest_states;
  state.blockedReasons = data.blocked_reasons;
  renderGraph();
  renderSimPanel(data);
}

async function simReset() {
  if (!state.sessionId) return;
  const data = await api.post(`/api/sim/${state.sessionId}/reset`, {});
  state.simStates = data.quest_states;
  state.blockedReasons = data.blocked_reasons;
  renderGraph();
  renderSimPanel(data);
}

async function saveProgress() {
  if (!state.sessionId) return toast("请先开始模拟", "warn");
  const progress = await api.get(`/api/sim/${state.sessionId}/progress`);
  downloadJson("sim_progress.json", progress);
  toast("模拟进度已保存 (与工程文件分开存放)");
}

function loadProgressFile(file) {
  if (!state.sessionId) {
    toast("请先开始模拟, 再载入进度", "warn");
    return;
  }
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const data = await api.post(
        `/api/sim/${state.sessionId}/progress`,
        JSON.parse(reader.result)
      );
      state.simStates = data.quest_states;
      state.blockedReasons = data.blocked_reasons;
      renderGraph();
      renderSimPanel(data);
      if (data.warnings && data.warnings.length) {
        toast("进度已载入, 但有警告: " + data.warnings.join("; "), "warn");
      } else {
        toast("模拟进度已恢复");
      }
    } catch (err) {
      toast("进度载入失败: " + err.message, "error");
    }
  };
  reader.readAsText(file);
}

function renderSimPanel(data, diff = null) {
  const s = data.summary;
  const legend = Object.entries(STATE_LABELS)
    .map(
      ([k, label]) =>
        `<span><span class="dot" style="background:${STATE_COLORS[k]}"></span>${label} ${
          s.counts[k] || 0
        }</span>`
    )
    .join("");
  $("#sim-legend").innerHTML = legend;

  let banners = "";
  if (s.stuck) {
    banners += `<div class="stuck-banner">✗ <b>玩家卡住了!</b><br>` +
      s.stuck.blocked_quests
        .map((b) => `${esc(b.quest_id)}: ${esc(b.reason)}`)
        .join("<br>") +
      `</div>`;
  }
  if (diff && diff.endings_reached && diff.endings_reached.length) {
    banners += `<div class="ending-banner">★ 达成结局: ${esc(
      diff.endings_reached.join(", ")
    )}</div>`;
  }

  let diffHtml = "";
  if (diff && diff.ok) {
    const lines = [];
    diff.new_available.forEach((id) =>
      lines.push(`<div class="diff-line diff-available">▲ 新可接取: ${esc(id)}</div>`)
    );
    diff.invalidated.forEach((x) =>
      lines.push(
        `<div class="diff-line diff-invalid">✕ 失效: ${esc(x.quest_id)} (${esc(x.reason)})</div>`
      )
    );
    diff.new_completed
      .filter((id) => id !== diff.quest_id)
      .forEach((id) =>
        lines.push(`<div class="diff-line diff-complete">✓ 联动完成: ${esc(id)}</div>`)
      );
    diff.new_failed
      .filter((id) => id !== diff.quest_id)
      .forEach((id) =>
        lines.push(`<div class="diff-line diff-fail">✗ 联动失败: ${esc(id)}</div>`)
      );
    diff.rewards_gained.forEach((r) =>
      lines.push(`<div class="diff-line diff-reward">🎁 ${esc(JSON.stringify(r))}</div>`)
    );
    diffHtml = lines.join("");
  }
  $("#sim-diff").innerHTML = banners + diffHtml;

  $("#sim-summary").innerHTML = `
    <div class="kv"><span>步骤数</span><span>${s.steps_taken}</span></div>
    <div class="kv"><span>可接取</span><span>${esc(s.available.join(", ") || "-")}</span></div>
    <div class="kv"><span>进行中</span><span>${esc(s.active.join(", ") || "-")}</span></div>
    <div class="kv"><span>已完成</span><span>${esc(s.completed.length)}</span></div>
    <div class="kv"><span>已失败</span><span>${esc(s.failed.join(", ") || "-")}</span></div>
    <div class="kv"><span>变量</span><span>${esc(JSON.stringify(s.variables))}</span></div>
    <div class="kv"><span>flags</span><span>${esc(JSON.stringify(s.flags))}</span></div>
  `;
  $("#sim-log").innerHTML = data.log
    .slice()
    .reverse()
    .map((line) => `<li>${esc(line)}</li>`)
    .join("");
}

// 模拟模式下点击节点弹出操作
function initSimNodeClicks() {
  $("#nodes-layer").addEventListener("click", (ev) => {
    const group = ev.target.closest(".node-group");
    if (!group || !state.simMode) return;
    const id = group.dataset.id;
    const st = state.simStates[id];
    const reason = state.blockedReasons[id];
    const actions = [];
    if (st === "available") {
      actions.push(["accept", "接取"]);
      actions.push(["complete", "直接完成"]);
      actions.push(["fail", "标记失败"]);
    } else if (st === "active") {
      actions.push(["complete", "完成"]);
      actions.push(["fail", "失败"]);
    }
    if (!actions.length) {
      toast(`${id} 当前为「${STATE_LABELS[st]}」${reason ? " — " + reason : ""}`, "warn");
      return;
    }
    const label = prompt(
      `任务 ${id} (${STATE_LABELS[st]})\n` +
        (reason ? `提示: ${reason}\n` : "") +
        `输入操作序号: ${actions.map((a, i) => `${i + 1}=${a[1]}`).join("  ")}`,
      "1"
    );
    if (label === null) return;
    const idx = Number(label) - 1;
    if (!actions[idx]) return;
    simStep(actions[idx][0], id);
  });
}

// ---------------------------------------------------------------------------
// 影响分析 / 版本对比
// ---------------------------------------------------------------------------

function populateImpactSelect() {
  const sel = $("#impact-quest");
  sel.innerHTML =
    `<option value="">选择任务…</option>` +
    state.project.quests
      .map((q) => `<option value="${esc(q.id)}">${esc(q.title || q.id)}</option>`)
      .join("");
}

async function runImpact() {
  const questId = $("#impact-quest").value;
  if (!questId) return toast("请先选择任务", "warn");
  try {
    const r = await api.post("/api/impact", {
      project: state.project,
      quest_id: questId,
    });
    $("#impact-result").innerHTML = `
      <div class="impact-block">
        <h4>直接后继 (${r.direct.length})</h4>
        <div class="ids ${r.direct.length ? "" : "empty"}">${
      r.direct.map(esc).join(", ") || "无"
    }</div>
      </div>
      <div class="impact-block">
        <h4>全部传递后继 (${r.transitive.length})</h4>
        <div class="ids ${r.transitive.length ? "" : "empty"}">${
      r.transitive.map(esc).join(", ") || "无"
    }</div>
      </div>
      <div class="impact-block">
        <h4>受影响结局 (${r.endings.length})</h4>
        <div class="ids ${r.endings.length ? "" : "empty"}">${
      r.endings.map(esc).join(", ") || "无"
    }</div>
      </div>`;
  } catch (err) {
    toast(err.message, "error");
  }
}

async function runDiff(file) {
  try {
    const before = JSON.parse(await file.text());
    const result = await api.post("/api/diff", { before, after: state.project });
    const blocks = [];
    if (result.added.length)
      blocks.push(block("新增任务", result.added, "#98c379"));
    if (result.removed.length)
      blocks.push(block("删除任务", result.removed, "#e06c75"));
    for (const c of result.changed) {
      blocks.push(`
        <div class="impact-block diff-item">
          <h4>${esc(c.quest_id)} 变更字段: ${esc(c.fields.join(", "))}</h4>
          <div class="ids">直接受影响: ${esc(c.affected_direct.join(", ") || "无")}</div>
          <div class="ids">传递受影响: ${esc(c.affected_transitive.join(", ") || "无")}</div>
          <div class="ids">受影响结局: ${esc(c.affected_endings.join(", ") || "无")}</div>
        </div>`);
    }
    for (const r of result.removal_impact) {
      blocks.push(`
        <div class="impact-block diff-item">
          <h4>删除 ${esc(r.quest_id)} 的波及面</h4>
          <div class="ids">${esc(r.affected_transitive.join(", ") || "无后续任务")}</div>
        </div>`);
    }
    $("#diff-result").innerHTML =
      `<h4 style="color:var(--yellow)">与 ${esc(file.name)} 对比</h4>` +
      (blocks.join("") || `<p class="hint">两个版本没有差异。</p>`);
  } catch (err) {
    toast("对比失败: " + err.message, "error");
  }
}

function block(title, ids, color) {
  return `<div class="impact-block"><h4 style="color:${color}">${title} (${ids.length})</h4>
    <div class="ids">${ids.map(esc).join(", ")}</div></div>`;
}

// ---------------------------------------------------------------------------
// 导入 / 导出 / 样例
// ---------------------------------------------------------------------------

function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function saveProjectFile() {
  downloadJson((state.project.name || "quests").replace(/\s+/g, "_") + ".qchain.json", state.project);
  dirty = false;
  state.baselineForDiff = JSON.parse(JSON.stringify(state.project));
  toast("工程文件已保存");
}

async function exportRuntime() {
  try {
    const runtime = await api.post("/api/export", state.project);
    downloadJson("quest_runtime.json", runtime);
    toast("已导出游戏运行时数据 (不含编辑器坐标)");
  } catch (err) {
    toast("导出失败: " + err.message, "error");
  }
}

function loadProjectData(data, sourceName = "") {
  state.project = data;
  state.selectedId = null;
  state.simMode = false;
  state.simStates = null;
  state.sessionId = null;
  state.baselineForDiff = JSON.parse(JSON.stringify(data));
  renderGraph();
  renderEditor();
  renderProjectMeta();
  populateImpactSelect();
  runValidate();
}

function openProjectFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      loadProjectData(data, file.name);
      toast(`已载入工程: ${file.name}`);
    } catch (err) {
      toast("工程解析失败: " + err.message, "error");
    }
  };
  reader.readAsText(file);
}

async function importRuntimeFile(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const raw = JSON.parse(reader.result);
      const result = await api.post("/api/import", raw);
      loadProjectData(result.project, file.name);
      if (result.problems.length) {
        toast(`导入完成但有 ${result.problems.length} 个引用问题, 见诊断面板`, "warn");
        const { issues } = await api.post("/api/validate", result.project);
        renderIssues(issues);
      } else {
        toast("导入成功, 引用完整性检查全部通过");
      }
    } catch (err) {
      toast("导入失败: " + err.message, "error");
    }
  };
  reader.readAsText(file);
}

async function loadSamplesMenu() {
  const { samples } = await api.get("/api/samples");
  const menu = $("#sample-menu");
  menu.innerHTML = samples
    .map((name) => `<div class="item" data-name="${esc(name)}">${esc(name)}</div>`)
    .join("");
  menu.querySelectorAll(".item").forEach((el) => {
    el.onclick = async () => {
      menu.classList.add("hidden");
      const data = await api.get(`/api/samples/${encodeURIComponent(el.dataset.name)}`);
      loadProjectData(data, el.dataset.name);
      toast(`已载入样例: ${el.dataset.name}`);
    };
  });
}

function newProject() {
  if (dirty && !confirm("当前工程有未保存修改, 确定新建?")) return;
  loadProjectData({
    format_version: 1,
    name: "新任务工程",
    description: "",
    initial_flags: {},
    initial_variables: {},
    quests: [],
  });
}

// ---------------------------------------------------------------------------
// 标签页
// ---------------------------------------------------------------------------

function switchTab(name) {
  document.querySelectorAll(".tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.tab === name)
  );
  document.querySelectorAll(".tab-panel").forEach((p) =>
    p.classList.toggle("active", p.id === `panel-${name}`)
  );
}

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------

async function init() {
  initCanvasGestures();
  initSimNodeClicks();

  document.querySelectorAll(".tab").forEach((t) => {
    t.onclick = () => switchTab(t.dataset.tab);
  });

  $("#btn-new").onclick = newProject;
  $("#btn-save").onclick = saveProjectFile;
  $("#btn-export").onclick = exportRuntime;
  $("#btn-validate").onclick = runValidate;
  $("#btn-impact").onclick = () => switchTab("impact");
  $("#btn-impact-run").onclick = runImpact;
  $("#btn-sim-create").onclick = startSimulation;
  $("#btn-sim-reset").onclick = simReset;
  $("#btn-sim-undo").onclick = simUndo;
  $("#btn-sim-save").onclick = saveProgress;
  $("#btn-sim-load").onclick = () => $("#progress-input").click();
  $("#progress-input").onchange = (ev) => {
    if (ev.target.files[0]) loadProgressFile(ev.target.files[0]);
    ev.target.value = "";
  };

  $("#btn-load-sample").onclick = () => $("#sample-menu").classList.toggle("hidden");
  $("#btn-open").onclick = () => $("#file-input").click();
  $("#file-input").onchange = (ev) => {
    if (ev.target.files[0]) openProjectFile(ev.target.files[0]);
    ev.target.value = "";
  };
  $("#btn-import-rt").onclick = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = () => input.files[0] && importRuntimeFile(input.files[0]);
    input.click();
  };
  $("#btn-diff").onclick = () => $("#diff-input").click();
  $("#diff-input").onchange = (ev) => {
    if (ev.target.files[0]) {
      switchTab("impact");
      runDiff(ev.target.files[0]);
    }
    ev.target.value = "";
  };

  await loadSamplesMenu();
  const samples = (await api.get("/api/samples")).samples;
  const first = samples.find((name) => name.includes("demo")) || samples[0];
  const data = await api.get(`/api/samples/${encodeURIComponent(first)}`);
  loadProjectData(data, first);

  // 隐藏钩子: ?autosim 自动开始模拟并走几步, 用于快速预览试玩效果
  if (new URLSearchParams(location.search).has("autosim")) {
    await startSimulation();
    for (const [action, questId] of [
      ["complete", "q_intro"],
      ["complete", "q_herb_gathering"],
      ["complete", "q_training"],
      ["complete", "q_goblin_camp"],
      ["complete", "q_join_knights"],
      ["accept", "q_escort_mission"],
    ]) {
      await simStep(action, questId);
    }
  }
}

init().catch((err) => toast("初始化失败: " + err.message, "error"));
