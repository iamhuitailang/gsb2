/* 多声道整理与试听工具 — 主逻辑 */
"use strict";

/* ---------------- 状态 ---------------- */
const LAYOUTS = {
  "自定义": [],
  "立体声 L/R": ["L", "R"],
  "5.1 (L R C LFE Ls Rs)": ["L", "R", "C", "LFE", "Ls", "Rs"],
  "7.1 (L R C LFE Ls Rs Lrs Rrs)": ["L", "R", "C", "LFE", "Ls", "Rs", "Lrs", "Rrs"],
  "四声道 (L R Ls Rs)": ["L", "R", "Ls", "Rs"],
};
const COMMON_LABELS = ["", "L", "R", "C", "LFE", "Ls", "Rs", "Lrs", "Rrs", "M"];

const state = {
  fileName: null,
  sampleRate: 0,
  numCh: 0,
  duration: 0,
  inputs: [],          // Float32Array per channel
  inputPeaks: [],      // {peak, peakDb, peakTime}
  inputLabels: [],     // string, "" = 未标记
  outputs: [],         // {name, contribs:[{src:int|null, gainDb:float, invert:bool}]}
  outMix: [],          // Float32Array per output
  outStats: [],        // {peak, peakDb, peakTime, clipCount, cancelWarn, empty}
  soloView: null,      // {kind:'in'|'out', idx} 单独显示
  play: { mode: "mix", idx: -1, playing: false, node: null, startCtx: 0, startOff: 0 },
};

let audioCtx = null;
function ctx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

const $ = (id) => document.getElementById(id);

function toast(msg, ms = 2600) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add("hidden"), ms);
}

function fmtDb(x) {
  if (x <= 0) return "-∞ dB";
  return (20 * Math.log10(x)).toFixed(1) + " dB";
}
function fmtTime(s) { return s.toFixed(2) + " s"; }

/* ---------------- 文件载入 ---------------- */
$("file-input").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const buf = await f.arrayBuffer();
    const audio = await ctx().decodeAudioData(buf);
    loadAudio(f.name, audio);
  } catch (err) {
    toast("解码失败：" + err.message + "（请确认是 WAV 文件）");
  }
  e.target.value = "";
});

function loadAudio(name, audio) {
  stopPlayback();
  state.fileName = name;
  state.sampleRate = audio.sampleRate;
  state.numCh = audio.numberOfChannels;
  state.duration = audio.duration;
  state.inputs = [];
  state.inputPeaks = [];
  state.inputLabels = [];
  for (let c = 0; c < state.numCh; c++) {
    const d = audio.getChannelData(c);
    state.inputs.push(d);
    state.inputPeaks.push(computePeak(d, state.sampleRate));
    state.inputLabels.push("");
  }
  // 输出布局按声道数取最接近的预设；映射一律留空，由用户显式指定（不自动猜用途）
  const guessKey = Object.keys(LAYOUTS).find((k) => LAYOUTS[k].length === state.numCh);
  const names = guessKey ? LAYOUTS[guessKey] : Array.from({ length: state.numCh }, (_, i) => "Out" + (i + 1));
  buildOutputs(names);
  if (guessKey) {
    $("layout-select").value = guessKey;
  } else {
    // 无匹配布局时走自定义，保持界面与实际输出数一致
    $("layout-select").value = "自定义";
    $("custom-out-count").value = state.numCh;
  }
  $("custom-out-wrap").classList.toggle("hidden", $("layout-select").value !== "自定义");

  state.soloView = null;
  state.play.mode = "mix";
  state.play.idx = -1;
  updateAuditionBadge();

  $("file-info").textContent =
    `${name} — ${state.numCh} 声道, ${state.sampleRate} Hz, ${fmtTime(state.duration)}`;
  ["sec-inputs", "sec-mapping", "sec-outputs", "sec-transport", "sec-export"].forEach((id) =>
    $(id).classList.remove("hidden"));
  renderLoadWarnings();
  renderInputs();
  renderMapping();
  recomputeMix();
  updatePlayTime();
}

function renderLoadWarnings() {
  const el = $("load-warnings");
  const silent = state.inputPeaks
    .map((p, i) => (p.peak === 0 ? i : -1))
    .filter((i) => i >= 0);
  el.innerHTML = "";
  if (silent.length) {
    el.innerHTML =
      `<div class="warn-text">⚠ 输入声道 ${silent.map((i) => i + 1).join("、")} 为全静音` +
      `（素材本身如此，与映射中的「留空」不同——留空的输出会单独标注）。</div>`;
  }
}

function computePeak(d, sr) {
  let peak = 0, idx = 0;
  for (let i = 0; i < d.length; i++) {
    const a = Math.abs(d[i]);
    if (a > peak) { peak = a; idx = i; }
  }
  return { peak, peakDb: peak > 0 ? 20 * Math.log10(peak) : -Infinity, peakTime: idx / sr, peakIdx: idx };
}

/* ---------------- 输入声道渲染 ---------------- */
function renderInputs() {
  const list = $("input-list");
  list.innerHTML = "";
  state.inputs.forEach((d, i) => {
    const p = state.inputPeaks[i];
    const row = document.createElement("div");
    row.className = "chan-row";
    row.dataset.kind = "in"; row.dataset.idx = i;

    const head = document.createElement("div");
    head.className = "chan-head";

    const idx = document.createElement("span");
    idx.className = "idx";
    idx.textContent = "声道 " + (i + 1);
    head.appendChild(idx);

    // 标记：常用名下拉 + 自定义输入
    const sel = document.createElement("select");
    COMMON_LABELS.forEach((l) => {
      const op = document.createElement("option");
      op.value = l; op.textContent = l === "" ? "（未标记）" : l;
      sel.appendChild(op);
    });
    const customOp = document.createElement("option");
    customOp.value = "__custom"; customOp.textContent = "自定义…";
    sel.appendChild(customOp);
    sel.value = COMMON_LABELS.includes(state.inputLabels[i]) ? state.inputLabels[i] : (state.inputLabels[i] ? "__custom" : "");
    head.appendChild(sel);

    const custom = document.createElement("input");
    custom.type = "text"; custom.placeholder = "自定义标记";
    custom.value = COMMON_LABELS.includes(state.inputLabels[i]) ? "" : state.inputLabels[i];
    custom.style.display = sel.value === "__custom" ? "" : "none";
    head.appendChild(custom);

    const warn = document.createElement("span");
    const refreshWarn = () => {
      const labeled = state.inputLabels[i] !== "";
      warn.innerHTML = labeled ? "" : `<span class="badge err">未标记，请指定用途</span>`;
    };
    refreshWarn();
    head.appendChild(warn);

    const applyLabel = () => {
      state.inputLabels[i] = sel.value === "__custom" ? custom.value.trim() : sel.value;
      refreshWarn();
      renderMapping(); // 映射下拉里显示标记
      renderOutputs();
    };
    sel.addEventListener("change", () => {
      custom.style.display = sel.value === "__custom" ? "" : "none";
      if (sel.value !== "__custom") applyLabel();
      else { custom.focus(); }
    });
    custom.addEventListener("change", applyLabel);

    const peak = document.createElement("span");
    peak.className = "peak-tag";
    peak.innerHTML = `峰值 <b>${fmtDb(p.peak)}</b> @ ${fmtTime(p.peakTime)}` +
      (p.peak === 0 ? ` <span class="badge dim">全静音</span>` : "") +
      (p.peak > 1 ? ` <span class="badge err">已削波</span>` : "");
    head.appendChild(peak);

    // 该输入被哪些输出使用（完整关系）
    const used = document.createElement("span");
    used.className = "muted";
    used.id = `used-by-${i}`;
    head.appendChild(used);

    addAuditionButtons(head, "in", i);

    row.appendChild(head);
    row.appendChild(makeWaveCanvas(d, p, "in", i));
    list.appendChild(row);
  });
  refreshUsageSummary();
}

/* ---------------- 波形 ---------------- */
function makeWaveCanvas(data, peakInfo, kind, idx) {
  const cv = document.createElement("canvas");
  cv.className = "wave";
  cv.dataset.kind = kind; cv.dataset.idx = idx;
  cv.addEventListener("click", (e) => {
    const r = cv.getBoundingClientRect();
    const t = ((e.clientX - r.left) / r.width) * state.duration;
    seekTo(t);
  });
  requestAnimationFrame(() => drawWave(cv, data, peakInfo));
  return cv;
}

function drawWave(cv, data, peakInfo) {
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!w) return;
  cv.width = w * devicePixelRatio; cv.height = h * devicePixelRatio;
  // 波形渲染到离屏画布并缓存，播放时只需贴图 + 画播放头
  const bg = document.createElement("canvas");
  bg.width = cv.width; bg.height = cv.height;
  const g = bg.getContext("2d");
  g.scale(devicePixelRatio, devicePixelRatio);
  const mid = h / 2;
  g.strokeStyle = "#e5e7eb";
  g.beginPath(); g.moveTo(0, mid); g.lineTo(w, mid); g.stroke();

  const n = data.length;
  g.strokeStyle = "#2563eb";
  g.beginPath();
  for (let x = 0; x < w; x++) {
    const i0 = Math.floor((x / w) * n), i1 = Math.max(i0 + 1, Math.floor(((x + 1) / w) * n));
    let mn = 1, mx = -1;
    for (let i = i0; i < i1; i++) { const v = data[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
    g.moveTo(x + 0.5, mid - mx * (mid - 2));
    g.lineTo(x + 0.5, mid - mn * (mid - 2));
  }
  g.stroke();

  // 峰值标记
  if (peakInfo && peakInfo.peak > 0) {
    const px = (peakInfo.peakIdx / n) * w;
    g.strokeStyle = "#dc2626";
    g.beginPath(); g.moveTo(px, 0); g.lineTo(px, h); g.stroke();
    g.fillStyle = "#dc2626";
    g.beginPath(); g.moveTo(px, 0); g.lineTo(px - 5, 8); g.lineTo(px + 5, 8); g.fill();
  }
  // 削波区染色
  if (peakInfo && peakInfo.peak > 1) {
    g.fillStyle = "rgba(220,38,38,0.08)";
    g.fillRect(0, 0, w, h);
  }
  cv._bg = bg;
  blitWave(cv);
}

function blitWave(cv) {
  if (!cv._bg) return;
  const g = cv.getContext("2d");
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, cv.width, cv.height);
  g.drawImage(cv._bg, 0, 0);
  const t = currentPosition();
  if (t != null && state.duration) {
    const x = (t / state.duration) * cv.width;
    g.strokeStyle = "#16a34a";
    g.lineWidth = devicePixelRatio;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, cv.height); g.stroke();
  }
}

function redrawAllWaves() {
  document.querySelectorAll("canvas.wave").forEach(blitWave);
}

/* 尺寸变化（单独显示、窗口缩放）时需要全量重渲染离屏缓存 */
function reRenderAllWaves() {
  document.querySelectorAll("canvas.wave").forEach((cv) => {
    const kind = cv.dataset.kind, idx = +cv.dataset.idx;
    const data = kind === "in" ? state.inputs[idx] : state.outMix[idx];
    const pk = kind === "in" ? state.inputPeaks[idx] : state.outStats[idx];
    if (data) drawWave(cv, data, pk);
  });
}

let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(reRenderAllWaves, 150);
});

/* ---------------- 试听 ---------------- */
function addAuditionButtons(head, kind, idx) {
  const b1 = document.createElement("button");
  b1.className = "btn small";
  b1.textContent = "试听";
  b1.addEventListener("click", () => audition(kind, idx));
  head.appendChild(b1);

  const b2 = document.createElement("button");
  b2.className = "btn small";
  b2.textContent = "单独显示";
  b2.addEventListener("click", () => toggleSoloView(kind, idx));
  head.appendChild(b2);

  if (kind === "out") {
    const b3 = document.createElement("button");
    b3.className = "btn small";
    b3.textContent = "峰值反查";
    b3.addEventListener("click", () => reverseLookup(idx));
    head.appendChild(b3);
  }
}

function toggleSoloView(kind, idx) {
  if (state.soloView && state.soloView.kind === kind && state.soloView.idx === idx) {
    state.soloView = null;
  } else {
    state.soloView = { kind, idx };
  }
  document.querySelectorAll(".chan-row").forEach((row) => {
    const match = state.soloView &&
      row.dataset.kind === state.soloView.kind && +row.dataset.idx === state.soloView.idx;
    row.classList.toggle("solo-view", !!match);
    const cv = row.querySelector("canvas.wave");
    if (cv) cv.classList.toggle("tall", !!match);
  });
  reRenderAllWaves();
}

function audition(kind, idx) {
  const pos = currentPosition(); // 切换前记下位置
  state.play.mode = kind === "mix" ? "mix" : kind;
  state.play.idx = kind === "mix" ? -1 : idx;
  updateAuditionBadge();
  if (state.play.playing) {
    stopNode();
    startPlayback(pos != null ? pos : 0);
  } else if (pos != null) {
    state.play.startOff = pos; // 保留位置，下次播放从这里开始
    updatePlayTime();
  }
}

function updateAuditionBadge() {
  const m = state.play.mode, i = state.play.idx;
  const el = $("audition-mode");
  if (m === "mix") el.textContent = "全组试听（映射后）";
  else if (m === "in") el.textContent = `单独试听：输入声道 ${i + 1}${labelOf(i) ? " (" + labelOf(i) + ")" : ""}`;
  else el.textContent = `单独试听：输出 ${i + 1} (${state.outputs[i].name})`;
}

function labelOf(i) { return state.inputLabels[i] || ""; }

function currentPosition() {
  if (!state.duration) return null;
  if (state.play.playing) {
    return Math.min(ctx().currentTime - state.play.startCtx + state.play.startOff, state.duration);
  }
  return state.play.startOff || 0;
}

function bufferFor(mode, idx) {
  const c = ctx();
  let chans;
  if (mode === "in") chans = [state.inputs[idx]];
  else if (mode === "out") chans = [state.outMix[idx]];
  else chans = state.outMix; // mix：全部输出
  if (!chans || !chans.length || !chans[0]) return null;
  const buf = c.createBuffer(chans.length, chans[0].length, state.sampleRate);
  chans.forEach((d, i) => buf.copyToChannel(d, i));
  return buf;
}

function startPlayback(offset) {
  const buf = bufferFor(state.play.mode, state.play.idx);
  if (!buf) { toast("没有可播放的内容"); return; }
  const c = ctx();
  const node = c.createBufferSource();
  node.buffer = buf;
  node.connect(c.destination);
  const off = Math.min(offset || 0, state.duration - 0.01);
  node.start(0, Math.max(0, off));
  state.play.node = node;
  state.play.playing = true;
  state.play.startCtx = c.currentTime;
  state.play.startOff = Math.max(0, off);
  node.onended = () => {
    if (state.play.node === node) { state.play.playing = false; state.play.startOff = 0; $("btn-play").textContent = "▶ 播放"; }
  };
  $("btn-play").textContent = "⏸ 暂停";
}

function stopNode() {
  if (state.play.node) {
    state.play.node.onended = null;
    try { state.play.node.stop(); } catch (e) { /* 已停止 */ }
    state.play.node = null;
  }
}

function stopPlayback() {
  stopNode();
  state.play.playing = false;
  state.play.startOff = 0;
  if ($("btn-play")) $("btn-play").textContent = "▶ 播放";
}

function seekTo(t) {
  const wasPlaying = state.play.playing;
  if (wasPlaying) stopNode();
  state.play.startOff = Math.max(0, Math.min(t, state.duration));
  if (wasPlaying) startPlayback(state.play.startOff);
  else { updatePlayTime(); redrawAllWaves(); }
}

$("btn-play").addEventListener("click", () => {
  if (state.play.playing) {
    const pos = currentPosition();
    stopNode();
    state.play.playing = false;
    state.play.startOff = pos; // 暂停保留位置
    $("btn-play").textContent = "▶ 播放";
  } else {
    startPlayback(state.play.startOff || 0);
  }
});
$("btn-stop").addEventListener("click", () => { stopPlayback(); updatePlayTime(); redrawAllWaves(); });
$("btn-mix").addEventListener("click", () => audition("mix"));

function updatePlayTime() {
  const t = currentPosition() || 0;
  $("play-time").textContent = `${t.toFixed(2)} / ${state.duration.toFixed(2)} s`;
}

// 播放时刷新播放头
(function tick() {
  if (state.play.playing) { updatePlayTime(); redrawAllWaves(); }
  requestAnimationFrame(tick);
})();

/* ---------------- 映射 ---------------- */
function buildLayouts() {
  const sel = $("layout-select");
  sel.innerHTML = "";
  Object.keys(LAYOUTS).forEach((k) => {
    const op = document.createElement("option");
    op.value = k; op.textContent = k;
    sel.appendChild(op);
  });
  sel.value = "立体声 L/R";
  sel.addEventListener("change", () => {
    $("custom-out-wrap").classList.toggle("hidden", sel.value !== "自定义");
  });
}
buildLayouts();

$("apply-layout").addEventListener("click", () => {
  const k = $("layout-select").value;
  let names;
  if (k === "自定义") {
    const n = Math.max(1, Math.min(32, +$("custom-out-count").value || 2));
    names = Array.from({ length: n }, (_, i) => "Out" + (i + 1));
  } else {
    names = LAYOUTS[k];
  }
  buildOutputs(names);
  renderMapping();
  recomputeMix();
});

// 用户显式触发的 1:1 直通（非自动猜测）
$("btn-direct").addEventListener("click", () => {
  state.outputs.forEach((o, i) => {
    o.contribs = i < state.numCh ? [{ src: i, gainDb: 0, invert: false }] : [];
  });
  renderMapping();
  recomputeMix();
  toast("已按 1:1 直通填充映射，请确认每条对应关系");
});

function buildOutputs(names) {
  state.outputs = names.map((n) => ({ name: n, contribs: [] }));
}

function renderMapping() {
  const list = $("mapping-list");
  list.innerHTML = "";
  state.outputs.forEach((o, oi) => {
    const box = document.createElement("div");
    box.className = "map-out";

    const head = document.createElement("div");
    head.className = "map-out-head";
    const nm = document.createElement("span");
    nm.className = "out-name";
    nm.textContent = `输出 ${oi + 1}: ${o.name}`;
    head.appendChild(nm);
    const add = document.createElement("button");
    add.className = "btn small";
    add.textContent = "+ 添加输入";
    add.addEventListener("click", () => {
      o.contribs.push({ src: null, gainDb: 0, invert: false });
      renderMapping(); recomputeMix();
    });
    head.appendChild(add);
    addAuditionButtons(head, "out", oi);
    box.appendChild(head);

    if (!o.contribs.length) {
      const em = document.createElement("div");
      em.className = "empty-note";
      em.textContent = "留空 —— 该输出将写入静音（与素材本身静音不同，导出与校验中均按空声道处理）";
      box.appendChild(em);
    }

    o.contribs.forEach((cb, ci) => {
      const row = document.createElement("div");
      row.className = "contrib";

      const sel = document.createElement("select");
      const op0 = document.createElement("option");
      op0.value = ""; op0.textContent = "（选择输入）";
      sel.appendChild(op0);
      for (let i = 0; i < state.numCh; i++) {
        const op = document.createElement("option");
        op.value = i;
        op.textContent = `输入 ${i + 1}${labelOf(i) ? " · " + labelOf(i) : " · 未标记"}`;
        sel.appendChild(op);
      }
      sel.value = cb.src == null ? "" : cb.src;
      sel.addEventListener("change", () => {
        cb.src = sel.value === "" ? null : +sel.value;
        if (cb.src != null && state.inputLabels[cb.src] === "") {
          toast(`注意：输入 ${cb.src + 1} 尚未标记，请先在第 2 节指定它的用途`);
        }
        renderMapping(); recomputeMix();
      });
      row.appendChild(sel);

      const gainLabel = document.createElement("span");
      gainLabel.textContent = "比例 dB:";
      row.appendChild(gainLabel);
      const gain = document.createElement("input");
      gain.type = "number"; gain.step = "0.5"; gain.min = "-60"; gain.max = "24";
      gain.value = cb.gainDb;
      gain.addEventListener("change", () => {
        cb.gainDb = parseFloat(gain.value) || 0;
        recomputeMix();
      });
      row.appendChild(gain);

      const pol = document.createElement("button");
      pol.className = "btn small" + (cb.invert ? " danger" : "");
      pol.textContent = cb.invert ? "极性：反 (−)" : "极性：正 (+)";
      pol.addEventListener("click", () => {
        cb.invert = !cb.invert;
        renderMapping(); recomputeMix();
      });
      row.appendChild(pol);

      const del = document.createElement("button");
      del.className = "btn small danger";
      del.textContent = "移除";
      del.addEventListener("click", () => {
        o.contribs.splice(ci, 1);
        renderMapping(); recomputeMix();
      });
      row.appendChild(del);

      box.appendChild(row);
    });

    list.appendChild(box);
  });
  refreshUsageSummary();
}

/* 输入 → 输出 完整使用关系 */
function refreshUsageSummary() {
  // 输入行内 "被用于"
  for (let i = 0; i < state.numCh; i++) {
    const el = $(`used-by-${i}`);
    if (!el) continue;
    const targets = [];
    state.outputs.forEach((o, oi) => {
      o.contribs.forEach((cb) => { if (cb.src === i) targets.push(`${oi + 1}(${o.name})`); });
    });
    el.textContent = targets.length
      ? `→ 用于输出 ${targets.join("、")}${targets.length > 1 ? "（一进多出）" : ""}`
      : "→ 未被任何输出使用";
  }
  // 汇总表
  const sum = $("usage-summary");
  const unused = [];
  for (let i = 0; i < state.numCh; i++) {
    if (!state.outputs.some((o) => o.contribs.some((cb) => cb.src === i))) unused.push(i + 1);
  }
  sum.innerHTML = unused.length
    ? `<div class="warn-text">⚠ 输入声道 ${unused.join("、")} 未被任何输出使用，导出后将丢失。</div>`
    : "";
}

/* ---------------- 混合与检查 ---------------- */
function recomputeMix() {
  const n = state.inputs.length ? state.inputs[0].length : 0;
  state.outMix = [];
  state.outStats = [];
  state.outputs.forEach((o) => {
    const mix = new Float32Array(n);
    o.contribs.forEach((cb) => {
      if (cb.src == null) return;
      const g = Math.pow(10, cb.gainDb / 20) * (cb.invert ? -1 : 1);
      const src = state.inputs[cb.src];
      for (let i = 0; i < n; i++) mix[i] += g * src[i];
    });
    const st = computePeak(mix, state.sampleRate);
    // 削波样本数
    let clipCount = 0;
    if (st.peak > 1) for (let i = 0; i < n; i++) if (Math.abs(mix[i]) >= 1) clipCount++;
    // 分区段相消检测：50ms 窗，比较窗内实际峰值与各贡献峰值之和，
    // 能发现"只有部分时段相消"的情况（全程反相只是其特例）
    let cancelFrac = 0;
    const active = o.contribs.filter((c) => c.src != null);
    if (active.length && n > 0) {
      const win = Math.max(1, Math.floor(state.sampleRate * 0.05));
      let windows = 0, cancelled = 0;
      for (let w0 = 0; w0 < n; w0 += win) {
        const w1 = Math.min(w0 + win, n);
        let naive = 0;
        for (const cb of active) {
          const g = Math.abs(Math.pow(10, cb.gainDb / 20));
          const src = state.inputs[cb.src];
          let p = 0;
          for (let i = w0; i < w1; i++) { const a = Math.abs(src[i]); if (a > p) p = a; }
          naive += g * p;
        }
        if (naive <= 0.05) continue; // 该窗输入本来就接近静音，不参与判断
        let mx = 0;
        for (let i = w0; i < w1; i++) { const a = Math.abs(mix[i]); if (a > mx) mx = a; }
        windows++;
        if (mx < naive * 0.35) cancelled++;
      }
      cancelFrac = windows ? cancelled / windows : 0;
    }
    const cancelWarn = cancelFrac > 0.05;
    state.outMix.push(mix);
    state.outStats.push({
      ...st, clipCount, cancelWarn, cancelFrac,
      empty: o.contribs.filter((c) => c.src != null).length === 0,
      multi: o.contribs.filter((c) => c.src != null).length > 1,
    });
  });
  renderOutputs();
}

function renderOutputs() {
  const list = $("output-list");
  list.innerHTML = "";
  state.outputs.forEach((o, oi) => {
    const st = state.outStats[oi];
    const row = document.createElement("div");
    row.className = "chan-row";
    row.dataset.kind = "out"; row.dataset.idx = oi;

    const head = document.createElement("div");
    head.className = "chan-head";
    const nm = document.createElement("span");
    nm.className = "idx";
    nm.textContent = `输出 ${oi + 1}: ${o.name}`;
    head.appendChild(nm);

    const peak = document.createElement("span");
    peak.className = "peak-tag";
    if (st.empty) {
      peak.innerHTML = `<span class="badge warn">留空（写入静音）</span>`;
    } else {
      peak.innerHTML = `实际峰值 <b>${fmtDb(st.peak)}</b> @ ${fmtTime(st.peakTime)}`;
      if (st.peak > 1) {
        peak.innerHTML += ` <span class="badge err">削波！超出 ${fmtDb(st.peak)}，${st.clipCount} 个样本触顶</span>`;
      } else if (st.peak > 0.891) { // -1dBFS 余量提示
        peak.innerHTML += ` <span class="badge warn">接近满幅（余量不足 1 dB）</span>`;
      }
      if (st.peak === 0 && !st.empty) {
        peak.innerHTML += ` <span class="badge dim">合成结果为静音</span>`;
      }
      if (st.cancelWarn) {
        peak.innerHTML += ` <span class="badge warn">疑似相消：约 ${Math.round(st.cancelFrac * 100)}% 时段实际峰值远低于各输入之和，请检查极性设置</span>`;
      }
    }
    head.appendChild(peak);
    addAuditionButtons(head, "out", oi);
    row.appendChild(head);

    row.appendChild(makeWaveCanvas(state.outMix[oi], st, "out", oi));
    list.appendChild(row);
  });
  // 单独显示状态恢复
  if (state.soloView) {
    const sv = state.soloView;
    state.soloView = null;
    toggleSoloView(sv.kind, sv.idx);
  }
}

/* 峰值反查：输出峰值时刻，各输入贡献分别是多少 */
function reverseLookup(oi) {
  const o = state.outputs[oi];
  const st = state.outStats[oi];
  if (st.empty) { toast(`输出 ${oi + 1} 为留空声道，无来源`); return; }
  const idx = st.peakIdx;
  const parts = [];
  o.contribs.forEach((cb) => {
    if (cb.src == null) return;
    const g = Math.pow(10, cb.gainDb / 20) * (cb.invert ? -1 : 1);
    const v = g * state.inputs[cb.src][idx];
    parts.push({ src: cb.src, v, g });
  });
  parts.sort((a, b) => Math.abs(b.v) - Math.abs(a.v));
  const lines = parts.map((p) =>
    `输入 ${p.src + 1}${labelOf(p.src) ? " (" + labelOf(p.src) + ")" : ""}：贡献 ${p.v.toFixed(4)}` +
    `（系数 ${p.g.toFixed(3)}，该声道自身峰值 ${state.inputPeaks[p.src].peak.toFixed(3)} @ ${fmtTime(state.inputPeaks[p.src].peakTime)}）`);
  toast(
    `输出 ${oi + 1} (${o.name}) 峰值 ${st.peak.toFixed(3)} @ ${fmtTime(st.peakTime)} 的来源：\n` + lines.join("\n"),
    8000);
}

/* ---------------- 预设 ---------------- */
const PRESET_KEY = "mcmap.presets";

function getPresets() {
  try { return JSON.parse(localStorage.getItem(PRESET_KEY) || "{}"); }
  catch (e) { return {}; }
}
function setPresets(p) { localStorage.setItem(PRESET_KEY, JSON.stringify(p)); }

function refreshPresetList() {
  const sel = $("preset-list");
  const names = Object.keys(getPresets());
  sel.innerHTML = names.length ? "" : `<option value="">（无已存预设）</option>`;
  names.forEach((n) => {
    const op = document.createElement("option");
    op.value = n; op.textContent = n;
    sel.appendChild(op);
  });
}
refreshPresetList();

function collectMapping() {
  return {
    version: 1,
    inputLabels: state.inputLabels,
    outputNames: state.outputs.map((o) => o.name),
    outputs: state.outputs.map((o) => ({
      name: o.name,
      contribs: o.contribs.map((c) => ({ src: c.src, gainDb: c.gainDb, invert: c.invert })),
    })),
  };
}

function applyMapping(m) {
  if (!state.numCh) { toast("请先载入 WAV 文件再应用预设"); return; }
  if (!m || !Array.isArray(m.outputs)) { toast("预设格式不正确"); return; }
  state.inputLabels = (m.inputLabels || []).slice(0, state.numCh);
  while (state.inputLabels.length < state.numCh) state.inputLabels.push("");
  state.outputs = m.outputs.map((o) => ({
    name: o.name || "Out",
    contribs: (o.contribs || []).map((c) => ({
      src: c.src != null && c.src < state.numCh ? c.src : null,
      gainDb: +c.gainDb || 0,
      invert: !!c.invert,
    })),
  }));
  const bad = m.outputs.some((o) => (o.contribs || []).some((c) => c.src != null && c.src >= state.numCh));
  renderInputs(); renderMapping(); recomputeMix();
  if (bad) toast("预设中部分输入编号超出当前文件声道数，已置为未选择");
}

$("btn-save-preset").addEventListener("click", () => {
  const name = $("preset-name").value.trim();
  if (!name) { toast("请先输入预设名称"); return; }
  const p = getPresets();
  p[name] = collectMapping();
  setPresets(p);
  refreshPresetList();
  $("preset-list").value = name;
  toast(`预设「${name}」已保存`);
});
$("btn-load-preset").addEventListener("click", () => {
  const name = $("preset-list").value;
  const m = getPresets()[name];
  if (!m) { toast("请选择要载入的预设"); return; }
  applyMapping(m);
  toast(`预设「${name}」已载入`);
});
$("btn-del-preset").addEventListener("click", () => {
  const name = $("preset-list").value;
  if (!name) return;
  const p = getPresets();
  delete p[name];
  setPresets(p);
  refreshPresetList();
});
$("btn-export-preset").addEventListener("click", () => {
  const name = $("preset-name").value.trim() || "mapping";
  downloadBlob(new Blob([JSON.stringify(collectMapping(), null, 2)], { type: "application/json" }),
    name + ".json");
});
$("import-preset").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try { applyMapping(JSON.parse(await f.text())); toast("预设已导入"); }
  catch (err) { toast("预设导入失败：" + err.message); }
  e.target.value = "";
});

/* ---------------- 导出与校验 ---------------- */
function downloadBlob(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

$("btn-export-wav").addEventListener("click", () => {
  if (!state.outMix.length) { toast("请先载入文件并配置映射"); return; }
  const clipped = state.outStats.filter((s) => s.peak > 1);
  const fmt = $("export-format").value;
  const buf = encodeWAV(state.outMix, state.sampleRate, fmt);
  const base = (state.fileName || "output").replace(/\.wav$/i, "");
  downloadBlob(new Blob([buf], { type: "audio/wav" }), `${base}_remapped_${state.outMix.length}ch.wav`);
  $("export-status").innerHTML = clipped.length
    ? `<span class="err-text">已导出，但输出 ${clipped.map((s, i) => state.outStats.indexOf(s) + 1).join("、")} 存在削波，写文件时已截幅，请降低比例后重新导出！</span>`
    : `<span class="badge ok">已导出 ${state.outMix.length} 声道 / ${state.sampleRate} Hz / ${fmt}-bit</span>`;
});

$("verify-input").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const box = $("verify-result");
  try {
    const raw = await f.arrayBuffer();
    const hdr = parseWavHeader(raw);
    const audio = await ctx().decodeAudioData(raw.slice(0));
    const rows = [];
    let okAll = true;

    // 声道数
    const chOK = audio.numberOfChannels === state.outMix.length;
    // 采样率
    const srOK = audio.sampleRate === state.sampleRate;
    okAll = chOK && srOK;

    rows.push(`<tr><th>声道数</th><td>期望 ${state.outMix.length}</td><td>实际 ${audio.numberOfChannels}</td><td>${chOK ? "✅" : "❌"}</td></tr>`);
    rows.push(`<tr><th>采样率</th><td>期望 ${state.sampleRate} Hz</td><td>实际 ${audio.sampleRate} Hz</td><td>${srOK ? "✅" : "❌"}</td></tr>`);

    if (chOK) {
      for (let c = 0; c < state.outMix.length; c++) {
        const got = audio.getChannelData(c);
        const exp = state.outMix[c];
        const name = state.outputs[c].name;
        const empty = state.outStats[c].empty;
        let verdict, ok;
        if (empty) {
          // 留空声道：应全静音
          let mx = 0;
          for (let i = 0; i < got.length; i++) mx = Math.max(mx, Math.abs(got[i]));
          ok = mx < 1e-4;
          verdict = ok ? "留空声道，读回为静音 ✓" : `留空声道但读回峰值 ${fmtDb(mx)}`;
        } else if (got.length === exp.length) {
          // 逐样本比对（容差按 16bit 量化）
          let maxDiff = 0;
          const step = Math.max(1, Math.floor(exp.length / 200000));
          for (let i = 0; i < exp.length; i += step) {
            const d = Math.abs(got[i] - exp[i]);
            if (d > maxDiff) maxDiff = d;
          }
          const tol = 3 / 32768; // 16bit 量化容差
          ok = maxDiff <= tol;
          verdict = ok
            ? `内容一致（最大偏差 ${maxDiff.toExponential(1)}）`
            : `内容不一致！最大偏差 ${maxDiff.toFixed(4)}`;
        } else {
          ok = false;
          verdict = `长度不符（期望 ${exp.length} 实际 ${got.length}）`;
        }
        if (!ok) okAll = false;
        rows.push(`<tr><td>声道 ${c + 1} (${name})${empty ? " [留空]" : ""}</td>` +
          `<td colspan="2">${verdict}</td><td>${ok ? "✅" : "❌"}</td></tr>`);
      }
    }
    box.innerHTML =
      `<p>${okAll ? '<span class="badge ok">校验通过</span>' : '<span class="badge err">校验未通过</span>'}` +
      ` 文件：${f.name}${hdr ? "" : "（文件头非标准 RIFF，仅供参考）"}</p>` +
      `<table>${rows.join("")}</table>`;
  } catch (err) {
    box.innerHTML = `<span class="err-text">校验失败：${err.message}</span>`;
  }
  e.target.value = "";
});
