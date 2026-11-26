import {
  COMPONENT_DEFS,
  CONFLICT,
  HIGH,
  TICK_MS,
  advanceRun,
  compareLampRuns,
  connect,
  createComponent,
  createRun,
  deleteComponent,
  deleteConnection,
  explainWire,
  sameCircuit,
  scheduleSwitch,
} from './core.js';
import {
  createBlankProject,
  createSeededProject,
  delayedFeedbackGraph,
  dualSwitchGraph,
  illegalFeedbackGraph,
  starterGraph,
  unknownStateGraph,
} from './examples.js';
import { loadStoredProject, saveStoredProject } from './storage.js';
import { escapeHtml, formatDateTime, valueBadge, valueClass, valueText } from './ui/format.js';
import { renderComparisonTable, renderWaveformComparison } from './ui/waveform.js';

const MAX_TICKS = 240;
const CANVAS_PADDING = 40;

const paletteCopy = {
  switch: ['开关', '点击后安排下一时步事件'],
  constant: ['常量', '固定 0 或 1'],
  and: ['与门', '全 1 才输出 1'],
  or: ['或门', '有 1 就输出 1'],
  xor: ['异或', '两值不同才输出 1'],
  not: ['非门', '输出取反'],
  delay: ['延时器', '按固定时步延迟'],
  lamp: ['显示灯', '查看当前亮灭'],
};

const glyphs = {
  switch: '⏻',
  constant: '0/1',
  and: '&',
  or: '≥1',
  xor: 'XOR',
  not: 'NOT',
  delay: 'D→Q',
  lamp: '◉',
};

let project = loadStoredProject() ?? createSeededProject();
normalizeProject();

const initialTab = window.location.hash.replace('#', '');
const ui = {
  bottomTab: ['compare', 'runs', 'trace'].includes(initialTab) ? initialTab : 'compare',
  selection: null,
  playing: false,
  playHandle: null,
  showTable: false,
  onlyMismatches: false,
  drag: null,
  wiring: null,
  compareRows: [],
  saveTimer: null,
};

const el = {
  saveStatus: document.querySelector('#saveStatus'),
  paletteList: document.querySelector('#paletteList'),
  simbar: document.querySelector('.simbar'),
  tickScrubber: document.querySelector('#tickScrubber'),
  tickLabel: document.querySelector('#tickLabel'),
  runStatusPill: document.querySelector('#runStatusPill'),
  switchHint: document.querySelector('#switchHint'),
  alertRegion: document.querySelector('#alertRegion'),
  canvasViewport: document.querySelector('#canvasViewport'),
  canvas: document.querySelector('#canvas'),
  componentLayer: document.querySelector('#componentLayer'),
  noteLayer: document.querySelector('#noteLayer'),
  wireHitLayer: document.querySelector('#wireHitLayer'),
  wireStateLayer: document.querySelector('#wireStateLayer'),
  wireVisibleLayer: document.querySelector('#wireVisibleLayer'),
  wireLabelLayer: document.querySelector('#wireLabelLayer'),
  draftWire: document.querySelector('#draftWire'),
  inspectorContent: document.querySelector('#inspectorContent'),
  bottomContent: document.querySelector('#bottomContent'),
  toastRegion: document.querySelector('#toastRegion'),
  exampleMenuButton: document.querySelector('#exampleMenuButton'),
  exampleMenu: document.querySelector('#exampleMenu'),
};

function normalizeProject() {
  project.runs ??= [];
  project.graph ??= { version: 1, components: [], connections: [], notes: [] };
  project.graph.components ??= [];
  project.graph.connections ??= [];
  project.graph.notes ??= [];
  if (!project.runs.some((r) => r.id === project.compareAId)) project.compareAId = project.runs[0]?.id ?? null;
  if (!project.runs.some((r) => r.id === project.compareBId)) {
    project.compareBId = project.runs[project.runs.length - 1]?.id ?? null;
  }
  if (!project.runs.some((r) => r.id === project.inspectionRunId)) {
    project.inspectionRunId = project.compareBId ?? project.runs[0]?.id ?? null;
  }
  if (!project.runs.some((r) => r.id === project.activeRunId)) {
    project.activeRunId = project.runs[project.runs.length - 1]?.id ?? null;
  }
  project.selectedTick ??= 0;
}

/* ------------------------------- Utilities ------------------------------ */

function toast(message, type = 'info', timeout = 3600) {
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.textContent = message;
  el.toastRegion.appendChild(node);
  window.setTimeout(() => node.remove(), timeout);
}

function persistNow() {
  const result = saveStoredProject(project);
  if (result.ok) {
    el.saveStatus.textContent = `已自动保存 · ${result.savedAt.toLocaleTimeString('zh-CN', { hour12: false })}`;
    el.saveStatus.classList.add('is-saved');
  } else {
    el.saveStatus.textContent = '自动保存失败（浏览器存储不可用）';
    el.saveStatus.classList.remove('is-saved');
  }
}

function schedulePersist() {
  el.saveStatus.textContent = '有修改，等待保存…';
  el.saveStatus.classList.remove('is-saved');
  clearTimeout(ui.saveTimer);
  ui.saveTimer = setTimeout(persistNow, 250);
}

function clampTick(tick, run) {
  const max = run ? Math.max(0, run.ticks.length - 1) : 0;
  if (!Number.isFinite(tick)) return 0;
  return Math.max(0, Math.min(Math.round(tick), max));
}

function getRun(runId) {
  return project.runs.find((run) => run.id === runId) ?? null;
}

function getCurrentRun() {
  const run = getRun(project.activeRunId);
  return run && sameCircuit(run.graph, project.graph) ? run : null;
}

function getInspectionRun() {
  return getRun(project.inspectionRunId) ?? getCurrentRun() ?? project.runs.at(-1) ?? null;
}

function getCanvasContext() {
  const run = getCurrentRun();
  const tick = clampTick(project.selectedTick, run);
  const trace = run?.ticks[tick] ?? null;
  return { run, tick, trace };
}

function signalClass(value) {
  if (value === HIGH) return 'signal-1';
  if (value === 0) return 'signal-0';
  if (value === CONFLICT) return 'signal-conflict';
  if (value === null) return 'signal-null';
  return '';
}

function svgNode(tag, attributes = {}) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  return node;
}

function componentName(componentId, graph = project.graph) {
  const component = graph.components.find((c) => c.id === componentId);
  return component?.name ?? componentId;
}

function commitElectricalChange(message) {
  pausePlayback();
  schedulePersist();
  renderAll();
  if (message) toast(message, 'success');
}

/* ------------------------------ Run actions ----------------------------- */

function createNewRun(showToast = true) {
  pausePlayback();
  const number = Math.max(0, ...project.runs.map((run) => run.number ?? 0)) + 1;
  const run = createRun(project.graph, {
    number,
    name: `运行 #${number}`,
  });
  const previousLatest = project.runs.at(-1) ?? null;
  const previousCompareRun = getRun(project.compareBId) ?? getRun(project.activeRunId) ?? previousLatest;
  project.runs.push(run);
  project.activeRunId = run.id;
  project.inspectionRunId = run.id;
  project.compareBId = run.id;
  project.compareAId = previousCompareRun?.id ?? run.id;
  project.selectedTick = 0;
  ui.selection = null;
  persistNow();
  renderAll();
  if (showToast) {
    toast(previousLatest
      ? `已创建独立的 ${run.name}；上一轮“${previousLatest.name}”仍保留在记录中。`
      : `已创建 ${run.name}。`, 'success');
  }
  return run;
}

function stepOnce() {
  let run = getCurrentRun();
  if (!run) {
    run = createNewRun(false);
    toast('当前电路与旧运行不同，已按当前画布创建新记录；旧结果未被覆盖。', 'warning');
  }
  if (run.ticks.length >= MAX_TICKS) {
    pausePlayback();
    toast(`为避免本地记录过大，最多记录 ${MAX_TICKS} 步；可导出工程后继续。`, 'warning');
    return;
  }
  const beforeFaults = run.faults.length;
  advanceRun(run, 1);
  project.selectedTick = run.ticks.length - 1;
  project.inspectionRunId = run.id;
  if (run.faults.length > beforeFaults) {
    const fault = run.faults.at(-1);
    toast(`第 ${fault.firstTick} 步发现无法稳定的组合反馈，相关电路组已暂停。`, 'error', 5200);
  }
  schedulePersist();
  renderAll();
}

function startPlayback() {
  if (ui.playing) return;
  if (!getCurrentRun()) createNewRun(false);
  ui.playing = true;
  updatePlayButton();
  ui.playHandle = setInterval(() => {
    if (!ui.playing) return;
    stepOnce();
  }, TICK_MS);
}

function pausePlayback() {
  ui.playing = false;
  if (ui.playHandle) clearInterval(ui.playHandle);
  ui.playHandle = null;
  updatePlayButton();
}

function togglePlayback() {
  if (ui.playing) pausePlayback();
  else startPlayback();
}

function updatePlayButton() {
  const button = document.querySelector('#playButton');
  if (!button) return;
  button.textContent = ui.playing ? '⏸ 暂停' : '▶ 播放';
  button.setAttribute('aria-pressed', String(ui.playing));
  button.classList.toggle('is-active', ui.playing);
}

/* ------------------------------- Palette ------------------------------- */

function renderPalette() {
  el.paletteList.innerHTML = Object.entries(paletteCopy).map(([type, [title, subtitle]]) => `
    <button class="palette-item" type="button" data-add-type="${type}" draggable="true">
      <span class="palette-glyph">${escapeHtml(glyphs[type])}</span>
      <span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(subtitle)}</small></span>
    </button>
  `).join('');

  el.paletteList.addEventListener('dragstart', (event) => {
    const item = event.target.closest('[data-add-type]');
    if (!item) return;
    event.dataTransfer.setData('text/component-type', item.dataset.addType);
    event.dataTransfer.effectAllowed = 'copy';
  });
}

function addComponentAt(type, x, y) {
  const component = createComponent(type, Math.max(8, Math.round(x - 79)), Math.max(8, Math.round(y - 34)));
  project.graph.components.push(component);
  ui.selection = { kind: 'component', id: component.id };
  commitElectricalChange();
  schedulePersist();
}

function addComponentVisibleCenter(type) {
  const rect = el.canvasViewport.getBoundingClientRect();
  const x = el.canvasViewport.scrollLeft + rect.width / 2 + (Math.random() * 40 - 20);
  const y = el.canvasViewport.scrollTop + rect.height / 2 + (Math.random() * 30 - 15);
  addComponentAt(type, x, y);
}

/* -------------------------------- Canvas ------------------------------- */

function portSignal(component, port, direction, trace) {
  if (!trace) return undefined;
  if (direction === 'output') return trace.componentValues[component.id];
  const wire = project.graph.connections.find(
    (w) => w.to.componentId === component.id && w.to.portId === port.id,
  );
  return wire ? trace.wireValues[wire.id] : undefined;
}

function activeFaultContext(run, trace) {
  const result = { components: new Set(), wires: new Set(), groups: new Set(), faults: [] };
  if (!run || !trace) return result;
  for (const faultId of trace.faultIds ?? []) {
    const fault = run.faults.find((f) => f.id === faultId);
    if (!fault) continue;
    result.faults.push(fault);
    result.groups.add(fault.groupId);
    fault.componentIds.forEach((id) => result.components.add(id));
    fault.connectionIds.forEach((id) => result.wires.add(id));
  }
  return result;
}

function renderCanvas() {
  const { run, tick, trace } = getCanvasContext();
  const faultContext = activeFaultContext(run, trace);
  const groupOf = new Map();
  // findCircuitGroups is available indirectly via core export? We did not import it.
  // Build undirected components locally for paused-group styling.
  const adjacency = new Map(project.graph.components.map((c) => [c.id, new Set()]));
  for (const wire of project.graph.connections) {
    adjacency.get(wire.from.componentId)?.add(wire.to.componentId);
    adjacency.get(wire.to.componentId)?.add(wire.from.componentId);
  }
  const seen = new Set();
  for (const startId of adjacency.keys()) {
    if (seen.has(startId)) continue;
    const stack = [startId];
    const group = new Set();
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      group.add(id);
      for (const next of adjacency.get(id) ?? []) if (!seen.has(next)) stack.push(next);
    }
    const isFaultGroup = [...faultContext.components].some((id) => group.has(id));
    for (const id of group) if (isFaultGroup) faultContext.groups.add(`group:${id}`);
    group.forEach((id) => groupOf.set(id, isFaultGroup));
  }

  el.noteLayer.innerHTML = (project.graph.notes ?? []).map((note) => `
    <article class="note-card tone-${escapeHtml(note.tone ?? 'info')}" style="left:${note.x}px;top:${note.y}px;${note.w ? `width:${note.w}px` : ''}">
      <h3>${escapeHtml(note.title)}</h3>
      <p>${escapeHtml(note.text)}</p>
    </article>
  `).join('');

  el.componentLayer.innerHTML = project.graph.components.map((component) => {
    const def = COMPONENT_DEFS[component.type];
    const outputValue = trace?.componentValues[component.id];
    const selected = ui.selection?.kind === 'component' && ui.selection.id === component.id;
    const faultNode = faultContext.components.has(component.id);
    const pausedGroup = groupOf.get(component.id) && !faultNode;
    const classes = [
      'component',
      `type-${component.type}`,
      signalClass(outputValue),
      selected ? 'is-selected' : '',
      faultNode ? 'is-fault-node' : '',
      pausedGroup ? 'is-paused-group' : '',
    ].filter(Boolean).join(' ');

    const inputRows = def.inputs.map((port) => {
      const value = portSignal(component, port, 'input', trace);
      return `
        <div class="port-row">
          <button type="button" class="port port-in ${signalClass(value)}"
            data-port-component-id="${escapeHtml(component.id)}" data-port-id="${escapeHtml(port.id)}" data-port-direction="input"
            aria-label="${escapeHtml(component.name)} ${escapeHtml(port.label)} 输入口，当前${valueText(value)}"
            title="${escapeHtml(port.label)}：${valueText(value)}"></button>
          <span>${escapeHtml(port.label)}</span>
        </div>`;
    }).join('');

    const outputPort = def.outputs.length ? (() => {
      const port = def.outputs[0];
      const value = portSignal(component, port, 'output', trace);
      return `
        <button type="button" class="port port-out ${signalClass(value)}"
          data-port-component-id="${escapeHtml(component.id)}" data-port-id="${escapeHtml(port.id)}" data-port-direction="output"
          aria-label="${escapeHtml(component.name)} ${escapeHtml(port.label)} 输出口，当前${valueText(value)}"
          title="${escapeHtml(port.label)}：${valueText(value)}"></button>`;
    })() : '';

    let body = '';
    if (component.type === 'switch') {
      const value = outputValue ?? (component.props.value ? HIGH : 0);
      const isOn = value === HIGH;
      body = `
        <button type="button" class="switch-lever ${isOn ? 'is-on' : 'is-off'} ${run ? 'is-runtime' : ''}" data-switch-toggle="${escapeHtml(component.id)}"
          title="${run ? '点击安排下一时步切换' : '点击设置新运行的初始状态'}">
          <span class="knob"></span><span class="lever-text">${isOn ? 'ON / 1' : 'OFF / 0'}</span>
        </button>`;
    } else if (component.type === 'constant') {
      const isOne = Boolean(component.props.value);
      body = `<button type="button" class="constant-toggle ${isOne ? 'is-1' : ''}" data-constant-toggle="${escapeHtml(component.id)}"
        title="点击切换常量">CONST = ${isOne ? '1' : '0'}</button>`;
    } else if (component.type === 'lamp') {
      body = `<div class="lamp-bulb ${signalClass(outputValue)}" title="显示灯：${valueText(outputValue)}"></div>`;
    } else if (component.type === 'delay') {
      body = `<div class="comp-formula">D → Q · ${Number(component.props.delayTicks)} 步</div>
              <div class="comp-meta">初态 ${valueText(component.props.initialValue ?? null)}</div>`;
    } else {
      const formula = { and: 'Q=A∧B', or: 'Q=A∨B', xor: 'Q=A⊕B', not: 'Q=¬In' }[component.type];
      body = `<div class="comp-formula">${formula}</div>`;
    }

    return `
      <div class="${classes}" data-component-id="${escapeHtml(component.id)}"
        style="left:${component.x}px;top:${component.y}px" tabindex="0"
        aria-label="${escapeHtml(component.name)}">
        <div class="component-head">
          <span class="comp-glyph">${escapeHtml(glyphs[component.type] ?? '?')}</span>
          <span class="comp-name">${escapeHtml(component.name)}</span>
          <span class="fault-badge" title="组合反馈不稳定">!</span>
        </div>
        <div class="component-body">${inputRows}${body}</div>
        ${outputPort}
      </div>`;
  }).join('');

  renderWires(trace, faultContext);
}

function portCenter(element) {
  const canvasRect = el.canvas.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  return {
    x: rect.left - canvasRect.left + rect.width / 2,
    y: rect.top - canvasRect.top + rect.height / 2,
  };
}

function wirePathD(from, to, sameComponent = false) {
  if (sameComponent) {
    const loopY = Math.max(from.y, to.y) + 118;
    return `M ${from.x} ${from.y}
      C ${from.x + 72} ${from.y + 8}, ${from.x + 82} ${loopY - 42}, ${(from.x + to.x) / 2 + 42} ${loopY}
      C ${(from.x + to.x) / 2 - 42} ${loopY + 24}, ${to.x - 82} ${loopY - 42}, ${to.x} ${to.y}`;
  }
  const delta = Math.max(38, Math.abs(to.x - from.x) * 0.45);
  const direction = to.x >= from.x ? 1 : -1;
  return `M ${from.x} ${from.y}
    C ${from.x + delta * direction} ${from.y},
      ${to.x - delta * direction} ${to.y},
      ${to.x} ${to.y}`;
}

function renderWires(trace = null, faultContext = { wires: new Set() }) {
  el.wireHitLayer.innerHTML = '';
  el.wireStateLayer.innerHTML = '';
  el.wireVisibleLayer.innerHTML = '';
  el.wireLabelLayer.innerHTML = '';

  for (const wire of project.graph.connections) {
    const outputPort = el.canvas.querySelector(
      `[data-port-component-id="${CSS.escape(wire.from.componentId)}"][data-port-id="${CSS.escape(wire.from.portId)}"]`,
    );
    const inputPort = el.canvas.querySelector(
      `[data-port-component-id="${CSS.escape(wire.to.componentId)}"][data-port-id="${CSS.escape(wire.to.portId)}"]`,
    );
    if (!outputPort || !inputPort) continue;

    const from = portCenter(outputPort);
    const to = portCenter(inputPort);
    const d = wirePathD(from, to, wire.from.componentId === wire.to.componentId);
    const selected = ui.selection?.kind === 'wire' && ui.selection.id === wire.id;
    const faultWire = faultContext.wires?.has(wire.id);
    const value = trace?.wireValues?.[wire.id];

    const hit = svgNode('path', { d, class: 'wire-hit', 'data-wire-id': wire.id, role: 'button', tabindex: '0' });
    hit.addEventListener('click', (event) => {
      event.stopPropagation();
      ui.selection = { kind: 'wire', id: wire.id };
      renderAll();
    });
    el.wireHitLayer.appendChild(hit);

    if (selected) {
      el.wireStateLayer.appendChild(svgNode('path', { d, class: 'wire-halo' }));
    }

    const path = svgNode('path', {
      d,
      class: [
        'wire-path',
        signalClass(value),
        selected ? 'is-selected' : '',
        faultWire ? 'is-fault-wire' : '',
      ].filter(Boolean).join(' '),
    });
    el.wireVisibleLayer.appendChild(path);

    if (trace && value !== undefined) {
      const mid = path.getPointAtLength(path.getTotalLength() / 2);
      const labelGroup = svgNode('g', {
        class: `wire-label ${signalClass(value)}`,
        transform: `translate(${Math.round(mid.x)},${Math.round(mid.y)})`,
      });
      labelGroup.appendChild(svgNode('rect', { x: -13, y: -9, width: 26, height: 18, rx: 9 }));
      const text = svgNode('text', { x: 0, y: 0 });
      text.textContent = valueText(value);
      labelGroup.appendChild(text);
      el.wireLabelLayer.appendChild(labelGroup);
    }
  }

  if (ui.wiring) updateDraftWire(ui.wiring.lastEvent);
}

function canvasPointFromEvent(event) {
  const rect = el.canvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function setDraftVisible(visible) {
  el.draftWire.toggleAttribute('hidden', !visible);
}

function updateDraftWire(event) {
  if (!ui.wiring || !event) {
    setDraftVisible(false);
    return;
  }
  const portElement = el.canvas.querySelector(
    `[data-port-component-id="${CSS.escape(ui.wiring.componentId)}"][data-port-id="${CSS.escape(ui.wiring.portId)}"]`,
  );
  if (!portElement) return;
  const fixed = portCenter(portElement);
  const cursor = canvasPointFromEvent(event);
  const from = ui.wiring.direction === 'output' ? fixed : cursor;
  const to = ui.wiring.direction === 'output' ? cursor : fixed;
  el.draftWire.setAttribute('d', wirePathD(from, to, ui.wiring.componentId === document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-component-id]')?.dataset.componentId));
  setDraftVisible(true);
}

function startWiring(event, portElement) {
  event.preventDefault();
  event.stopPropagation();
  ui.wiring = {
    componentId: portElement.dataset.portComponentId,
    portId: portElement.dataset.portId,
    direction: portElement.dataset.portDirection,
    lastEvent: event,
  };
  updateDraftWire(event);
}

function finishWiring(event) {
  if (!ui.wiring) return;
  const start = { componentId: ui.wiring.componentId, portId: ui.wiring.portId };
  const targetPort = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-port-id]');
  setDraftVisible(false);
  ui.wiring = null;
  if (!targetPort) return;

  const end = {
    componentId: targetPort.dataset.portComponentId,
    portId: targetPort.dataset.portId,
  };
  const result = connect(project.graph, start, end);
  if (!result.ok) {
    if (result.code === 'DUPLICATE' && result.connectionId) {
      ui.selection = { kind: 'wire', id: result.connectionId };
      toast(result.message, 'info');
      renderAll();
    } else {
      toast(result.message, 'error', 4600);
    }
    return;
  }
  project.graph = result.graph;
  ui.selection = { kind: 'wire', id: result.connection.id };
  commitElectricalChange();
}

/* ------------------------------ Inspector ------------------------------ */

function renderInspector() {
  const selection = ui.selection;
  if (!selection) {
    const current = getCurrentRun();
    el.inspectorContent.innerHTML = `
      <section class="inspector-section">
        <h3>当前工程</h3>
        <dl class="property-list">
          <div><dt>元件</dt><dd>${project.graph.components.length}</dd></div>
          <div><dt>连线</dt><dd>${project.graph.connections.length}</dd></div>
          <div><dt>运行记录</dt><dd>${project.runs.length}</dd></div>
          <div><dt>当前模拟</dt><dd>${current ? `#${current.number} · ${current.ticks.length} 步` : '未匹配新电路'}</dd></div>
        </dl>
      </section>
      <section class="inspector-section">
        <h3>操作提示</h3>
        <p class="field hint">点击元件可改名称、延时和初态；按 <span class="kbd">Delete</span> 删除选中项。点击一根线可查看当前值并跳到溯源视图。</p>
        <p class="field hint">播放时点击画布上的开关，会把变化安排到<strong>下一个未计算时步</strong>，因此相同事件序列可完全复现。</p>
      </section>`;
    return;
  }

  if (selection.kind === 'component') return renderComponentInspector(selection.id);
  return renderWireInspector(selection.id);
}

function renderPortStatus(component, trace) {
  const def = COMPONENT_DEFS[component.type];
  const rows = [];
  for (const port of def.inputs) {
    const wire = project.graph.connections.find((w) => w.to.componentId === component.id && w.to.portId === port.id);
    const value = trace ? trace.wireValues[wire?.id] : undefined;
    rows.push(`
      <div class="port-status-row">
        <span class="dot ${signalClass(value)}"></span>
        <code>${escapeHtml(port.id)}</code>
        <span>${wire ? escapeHtml(componentName(wire.from.componentId)) : '未连接'}</span>
        ${valueBadge(value)}
      </div>`);
  }
  for (const port of def.outputs) {
    const value = trace?.componentValues?.[component.id];
    rows.push(`
      <div class="port-status-row">
        <span class="dot ${signalClass(value)}"></span>
        <code>${escapeHtml(port.id)}</code>
        <span>输出 ${escapeHtml(port.label)}</span>
        ${valueBadge(value)}
      </div>`);
  }
  return rows.join('');
}

function renderComponentInspector(componentId) {
  const component = project.graph.components.find((c) => c.id === componentId);
  if (!component) {
    ui.selection = null;
    renderInspector();
    return;
  }
  const { run, trace } = getCanvasContext();
  const def = COMPONENT_DEFS[component.type];
  let properties = '';

  if (component.type === 'constant') {
    properties = `
      <div class="field">
        <label for="propValue">常量值</label>
        <select id="propValue" class="select" data-prop="value">
          <option value="0" ${!component.props.value ? 'selected' : ''}>0 / 低电平</option>
          <option value="1" ${component.props.value ? 'selected' : ''}>1 / 高电平</option>
        </select>
      </div>`;
  }
  if (component.type === 'delay') {
    properties = `
      <div class="field">
        <label for="propDelay">延时步数</label>
        <input id="propDelay" class="input" type="number" min="1" max="8" data-prop="delayTicks" value="${Number(component.props.delayTicks ?? 1)}" />
        <span class="hint">1 步表示输入在一个固定 500ms 时步后到达输出。</span>
      </div>
      <div class="field">
        <label for="propInitial">初始输出</label>
        <select id="propInitial" class="select" data-prop="initialValue">
          <option value="unknown" ${component.props.initialValue == null ? 'selected' : ''}>未知 ?</option>
          <option value="0" ${component.props.initialValue === 0 ? 'selected' : ''}>0 / 低</option>
          <option value="1" ${component.props.initialValue === 1 ? 'selected' : ''}>1 / 高</option>
        </select>
      </div>`;
  }
  if (component.type === 'switch' && run) {
    const pending = run.events.find((event) => event.tick === run.ticks.length && event.componentId === component.id);
    properties += `
      <div class="field">
        <label>运行输入</label>
        <button class="btn btn-small" type="button" data-action="schedule-switch" data-id="${escapeHtml(component.id)}">
          安排下一步：${pending ? `已安排为 ${pending.value ? '1' : '0'}，再次切换` : '切换当前开关'}
        </button>
        <span class="hint">事件写入当前运行记录，不修改初始电路。</span>
      </div>`;
  }

  el.inspectorContent.innerHTML = `
    <section class="inspector-section">
      <div class="field">
        <label for="compName">名称</label>
        <input id="compName" class="input" data-field="name" value="${escapeHtml(component.name)}" />
      </div>
      <dl class="property-list">
        <div><dt>类型</dt><dd>${escapeHtml(def.label)}</dd></div>
        <div><dt>ID</dt><dd><code>${escapeHtml(component.id)}</code></dd></div>
        <div><dt>坐标</dt><dd>${component.x}, ${component.y}</dd></div>
      </dl>
    </section>
    ${properties ? `<section class="inspector-section"><h3>参数</h3>${properties}</section>` : ''}
    <section class="inspector-section">
      <h3>接口状态 ${run ? `· T+${clampTick(project.selectedTick, run)}` : ''}</h3>
      ${renderPortStatus(component, trace)}
    </section>
    <section class="inspector-section">
      <button class="btn btn-danger" type="button" data-action="delete-component" data-id="${escapeHtml(component.id)}">删除元件和相关连线</button>
    </section>`;
}

function renderWireInspector(wireId) {
  const wire = project.graph.connections.find((w) => w.id === wireId);
  if (!wire) {
    ui.selection = null;
    renderInspector();
    return;
  }
  const { run, trace } = getCanvasContext();
  const value = trace?.wireValues?.[wire.id];
  el.inspectorContent.innerHTML = `
    <section class="inspector-section">
      <h3>选中连线</h3>
      <dl class="property-list">
        <div><dt>来源</dt><dd>${escapeHtml(componentName(wire.from.componentId))}.${escapeHtml(wire.from.portId)}</dd></div>
        <div><dt>接入</dt><dd>${escapeHtml(componentName(wire.to.componentId))}.${escapeHtml(wire.to.portId)}</dd></div>
        <div><dt>当前值</dt><dd>${valueBadge(value)}</dd></div>
      </dl>
    </section>
    <section class="inspector-section">
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-primary btn-small" type="button" data-action="trace-wire" data-id="${escapeHtml(wire.id)}">顺着这根线排查</button>
        <button class="btn btn-danger btn-small" type="button" data-action="delete-wire" data-id="${escapeHtml(wire.id)}">删除连线</button>
      </div>
    </section>`;
}

/* ------------------------------ Simbar/alerts --------------------------- */

function renderSimbar() {
  const current = getCurrentRun();
  const active = getRun(project.activeRunId);
  const maxTick = current ? Math.max(0, current.ticks.length - 1) : (getInspectionRun()?.ticks.length ?? 1) - 1;
  el.tickScrubber.max = String(Math.max(0, maxTick));
  el.tickScrubber.value = String(clampTick(project.selectedTick, current ?? getInspectionRun()));
  el.tickLabel.textContent = `T+${el.tickScrubber.value}`;

  el.runStatusPill.className = 'run-pill';
  if (ui.playing) {
    el.runStatusPill.classList.add('is-running');
    el.runStatusPill.textContent = current?.faults.length ? `故障组已暂停 · ${current.faults.length}` : '播放中 · 固定时步';
  } else if (current?.faults.length) {
    el.runStatusPill.classList.add('is-fault');
    el.runStatusPill.textContent = `故障组已暂停 · ${current.faults.length}`;
  } else if (current) {
    el.runStatusPill.textContent = `已记录 T+0…${current.ticks.length - 1}`;
  } else if (active && !sameCircuit(active.graph, project.graph)) {
    el.runStatusPill.classList.add('is-stale');
    el.runStatusPill.textContent = '电路已改动 · 需新建运行';
  } else {
    el.runStatusPill.textContent = '尚未运行';
  }

  el.switchHint.textContent = current
    ? '点击开关：事件安排在下一时步'
    : '点击开关：设置新运行的初始 0/1';
  updatePlayButton();
}

function renderAlerts() {
  const run = getCurrentRun();
  const active = getRun(project.activeRunId);
  const alerts = [];

  if (!run && active && !sameCircuit(active.graph, project.graph)) {
    alerts.push(`
      <div class="alert alert-warning">
        <span class="alert-icon">●</span>
        <div class="alert-body">
          <strong>当前电路已不同于 ${escapeHtml(active.name)}</strong>
          <p>旧运行和时序记录仍完整保留；画布不会把旧信号叠到新接线上。点击“新建运行”生成独立记录。</p>
        </div>
        <div class="alert-actions"><button class="btn btn-small btn-primary" data-action="new-run">新建运行</button></div>
      </div>`);
  }

  if (run) {
    const tick = clampTick(project.selectedTick, run);
    for (const fault of run.faults) {
      if (fault.firstTick > tick) continue;
      const names = fault.componentIds.map((id) => escapeHtml(componentName(id, run.graph))).join('、');
      alerts.push(`
        <div class="alert alert-critical">
          <span class="alert-icon">!</span>
          <div class="alert-body">
            <strong>T+${fault.firstTick} 组合反馈无法稳定 · ${names}</strong>
            <p>${escapeHtml(fault.message)}</p>
          </div>
          <div class="alert-actions">
            <button class="btn btn-small" data-action="locate-fault" data-id="${escapeHtml(fault.id)}">定位</button>
          </div>
        </div>`);
    }
  }

  el.alertRegion.innerHTML = alerts.join('');
}

/* ------------------------------- Bottom UI ------------------------------ */

function setBottomTab(tab) {
  ui.bottomTab = tab;
  document.querySelectorAll('.bottom-tab').forEach((button) => {
    const active = button.dataset.bottomTab === tab;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', String(active));
  });
  renderBottom();
}

function renderBottom() {
  if (ui.bottomTab === 'runs') return renderRunsTab();
  if (ui.bottomTab === 'trace') return renderTraceTab();
  return renderCompareTab();
}

function runOptions(selectedId) {
  return project.runs.map((run) => `
    <option value="${escapeHtml(run.id)}" ${run.id === selectedId ? 'selected' : ''}>
      ${escapeHtml(run.name)} · ${run.ticks.length}步 · ${formatDateTime(run.createdAt)}
    </option>`).join('');
}

function renderCompareTab() {
  if (project.runs.length < 2) {
    el.bottomContent.innerHTML = `
      <div class="empty-state">
        <h3>需要两次运行才能比较时序</h3>
        <p>先运行一轮并点击“新建运行”做改动后的第二轮。每轮都是独立记录，电路修改不会静默覆盖上一轮。当前已有 ${project.runs.length} 条记录。</p>
        <button class="btn btn-primary" data-action="new-run">＋ 新建运行</button>
      </div>`;
    return;
  }

  const runA = getRun(project.compareAId) ?? project.runs.at(-2);
  const runB = getRun(project.compareBId) ?? project.runs.at(-1);
  if (runA) project.compareAId = runA.id;
  if (runB) project.compareBId = runB.id;
  const rows = compareLampRuns(runA, runB);
  ui.compareRows = rows;
  const visibleRows = ui.onlyMismatches ? rows.filter((row) => row.mismatches > 0) : rows;
  const totalMismatch = rows.reduce((sum, row) => sum + row.mismatches, 0);
  const totalUnknown = rows.reduce((sum, row) => sum + row.unknownA + row.unknownB, 0);
  const circuitChanged = !sameCircuit(runA.graph, runB.graph);

  el.bottomContent.innerHTML = `
    <div class="compare-toolbar">
      <label>A 运行
        <select class="select" data-compare-select="a">${runOptions(runA.id)}</select>
      </label>
      <label>B 运行
        <select class="select" data-compare-select="b">${runOptions(runB.id)}</select>
      </label>
      <label><input type="checkbox" data-action="toggle-table" ${ui.showTable ? 'checked' : ''} /> 表格视图</label>
      <label><input type="checkbox" data-action="toggle-mismatch-filter" ${ui.onlyMismatches ? 'checked' : ''} /> 只看差异</label>
      <div class="compare-summary">
        <span class="summary-chip ${totalMismatch ? 'bad' : ''}">${totalMismatch} 个亮灭差异</span>
        <span class="summary-chip warn">${totalUnknown} 个未知采样</span>
        ${circuitChanged ? '<span class="summary-chip warn">两次电路快照不同</span>' : '<span class="summary-chip">相同电路快照</span>'}
      </div>
    </div>
    ${ui.onlyMismatches && !visibleRows.length ? `
      <div class="empty-state"><h3>所选显示灯没有已知亮灭差异</h3><p>未知（?）和冲突（!）状态仍可在完整视图或排查页查看。</p></div>
    ` : ui.showTable ? renderComparisonTable(visibleRows) : renderWaveformComparison(visibleRows)}`;

  bindWaveformInteractions();
}

function renderRunsTab() {
  if (!project.runs.length) {
    el.bottomContent.innerHTML = `
      <div class="empty-state">
        <h3>还没有运行记录</h3>
        <p>点击播放或单步，会按当前画布创建第一条确定性记录。</p>
        <button class="btn btn-primary" data-action="new-run">＋ 新建运行</button>
      </div>`;
    return;
  }

  const cards = [...project.runs].reverse().map((run) => {
    const matches = sameCircuit(run.graph, project.graph);
    const isA = project.compareAId === run.id;
    const isB = project.compareBId === run.id;
    return `
      <article class="run-card ${project.activeRunId === run.id ? 'is-current' : ''}">
        <div class="run-card-head">
          <div>
            <h3>${escapeHtml(run.name)} ${isA ? '<span class="run-tag a" title="比较 A"></span>' : ''} ${isB ? '<span class="run-tag b" title="比较 B"></span>' : ''}</h3>
            <time>${formatDateTime(run.createdAt)}</time>
          </div>
          ${run.faults.length ? '<span class="meta-chip fault">反馈故障</span>' : '<span class="meta-chip">可复现</span>'}
        </div>
        <div class="run-meta">
          <span class="meta-chip">${run.ticks.length} 个时步</span>
          <span class="meta-chip">${run.events.length} 个输入事件</span>
          <span class="meta-chip ${matches ? '' : 'stale'}">${matches ? '匹配当前电路' : '基于旧电路 · 已保留'}</span>
        </div>
        <div class="run-card-actions">
          <button class="btn btn-small" data-action="inspect-run" data-id="${escapeHtml(run.id)}">排查溯源</button>
          <button class="btn btn-small" data-action="compare-a" data-id="${escapeHtml(run.id)}">设为 A</button>
          <button class="btn btn-small" data-action="compare-b" data-id="${escapeHtml(run.id)}">设为 B</button>
        </div>
      </article>`;
  }).join('');

  el.bottomContent.innerHTML = `
    <div class="compare-toolbar">
      <button class="btn btn-primary" data-action="new-run">＋ 新建运行（保留旧记录）</button>
      <span class="field hint" style="margin:0">记录包含电路快照、输入事件和每一步的线值；重开浏览器后仍在。</span>
    </div>
    <div class="run-grid">${cards}</div>`;
}

function renderTraceTab() {
  const run = getInspectionRun();
  if (!run) {
    el.bottomContent.innerHTML = `
      <div class="empty-state">
        <h3>还没有可排查的运行</h3>
        <p>创建运行并执行几步后，可从这里或画布点击一根线，查看它的驱动来源、输入事件和延时状态。</p>
        <button class="btn btn-primary" data-action="new-run">＋ 新建运行</button>
      </div>`;
    return;
  }

  const tick = clampTick(project.selectedTick, run);
  const wires = run.graph.connections;
  const selectedWire = wires.find((w) => w.id === project.selectedWireId) ?? wires[0] ?? null;
  if (selectedWire) project.selectedWireId = selectedWire.id;
  const explanation = selectedWire ? explainWire(run, selectedWire.id, tick) : null;

  const wireOptions = wires.map((wire) => {
    const label = `${componentName(wire.from.componentId, run.graph)}.${wire.from.portId} → ${componentName(wire.to.componentId, run.graph)}.${wire.to.portId}`;
    return `<option value="${escapeHtml(wire.id)}" ${selectedWire?.id === wire.id ? 'selected' : ''}>${escapeHtml(label)}</option>`;
  }).join('');

  el.bottomContent.innerHTML = `
    <div class="trace-toolbar">
      <label>运行
        <select class="select" data-trace-run>${runOptions(run.id)}</select>
      </label>
      <label>时步 <input class="input" type="number" min="0" max="${run.ticks.length - 1}" value="${tick}" data-trace-tick-number style="width:72px" /></label>
      <input type="range" min="0" max="${run.ticks.length - 1}" value="${tick}" data-trace-tick-range style="width:220px;accent-color:var(--blue)" />
      <label style="flex:1;min-width:260px">沿线查看
        <select class="select" data-trace-wire ${wires.length ? '' : 'disabled'}>
          ${wires.length ? wireOptions : '<option>当前运行没有连线</option>'}
        </select>
      </label>
      <span>${explanation ? valueBadge(explanation.value) : ''}</span>
    </div>
    ${explanation ? `<div class="trace-tree">${renderTraceNode(explanation)}</div>` : `
      <div class="empty-state"><h3>没有连线</h3><p>请先连接输出口和输入口。</p></div>
    `}`;
}

function traceIcon(node) {
  if (node.kind === 'wire') return '线';
  if (node.kind === 'switch') return '开';
  if (node.kind === 'constant') return '常';
  if (node.kind === 'delay') return '延';
  if (node.kind === 'lamp') return '灯';
  if (node.kind === 'event') return '事';
  if (node.kind === 'state') return '态';
  if (node.kind === 'cycle') return '环';
  return '?';
}

function renderTraceNode(node) {
  return `
    <li class="trace-node kind-${escapeHtml(node.kind)}">
      <div class="trace-node-head">
        <span class="trace-kind-icon">${traceIcon(node)}</span>
        <span class="trace-node-title">${escapeHtml(node.label ?? '')}</span>
        ${valueBadge(node.value)}
      </div>
      ${node.text ? `<p class="trace-node-text">${escapeHtml(node.text)}</p>` : ''}
      ${node.children?.length ? `<ul>${node.children.map(renderTraceNode).join('')}</ul>` : ''}
    </li>`;
}

/* --------------------------- Waveform interaction ---------------------- */

function bindWaveformInteractions() {
  let tooltip = document.querySelector('#waveTooltip');
  const ensureTooltip = () => {
    if (!tooltip) {
      tooltip = document.createElement('div');
      tooltip.id = 'waveTooltip';
      tooltip.className = 'wave-tooltip';
      tooltip.hidden = true;
      document.body.appendChild(tooltip);
    }
    return tooltip;
  };

  el.bottomContent.querySelectorAll('.wave-hit').forEach((hit) => {
    hit.addEventListener('pointerenter', () => {
      el.bottomContent.querySelectorAll('.wave-crosshair').forEach((line) => {
        const tick = Number(hit.dataset.waveTick);
        line.setAttribute('x1', String(tick * 46 + 23));
        line.setAttribute('x2', String(tick * 46 + 23));
        line.toggleAttribute('hidden', false);
      });
    });
    hit.addEventListener('pointermove', (event) => {
      const tip = ensureTooltip();
      const tick = Number(hit.dataset.waveTick);
      const row = ui.compareRows.find((item) => item.key === hit.dataset.rowKey);
      const point = row?.points[tick];
      if (!point) return;
      tip.hidden = false;
      tip.style.left = `${Math.min(event.clientX + 14, window.innerWidth - 270)}px`;
      tip.style.top = `${Math.min(event.clientY + 14, window.innerHeight - 110)}px`;
      tip.innerHTML = `
        <strong>${escapeHtml(row.name)}</strong> · T+${tick}<br>
        <span class="muted">A：</span>${valueText(point.a)}　<span class="muted">B：</span>${valueText(point.b)}
        ${point.mismatch ? '<br><strong>已知亮灭不一致</strong>' : ''}`;
    });
    hit.addEventListener('pointerleave', () => {
      if (tooltip) tooltip.hidden = true;
      el.bottomContent.querySelectorAll('.wave-crosshair').forEach((line) => { line.toggleAttribute('hidden', true); });
    });
    hit.addEventListener('click', () => {
      const tick = Number(hit.dataset.waveTick);
      project.selectedTick = tick;
      const runB = getRun(project.compareBId);
      if (runB) project.inspectionRunId = runB.id;
      schedulePersist();
      renderAll();
      toast(`已定位到 T+${tick}；可打开“排查溯源”查看该时刻来源。`, 'info', 2200);
    });
  });
}

/* ------------------------------- Examples ------------------------------- */

function loadExample(kind) {
  const confirmed = window.confirm('载入示例会替换当前浏览器中的工程。建议先“导出工程”备份，是否继续？');
  if (!confirmed) return;
  pausePlayback();

  if (kind === 'starter') {
    project = createSeededProject();
  } else {
    project = createBlankProject();
    if (kind === 'dual') project.graph = dualSwitchGraph();
    if (kind === 'bad') project.graph = illegalFeedbackGraph();
    if (kind === 'delay') project.graph = delayedFeedbackGraph();
    if (kind === 'unknown') project.graph = unknownStateGraph();
    const run = createRun(project.graph, { number: 1, name: '运行 #1' });
    if (kind === 'delay') advanceRun(run, 5);
    project.runs = [run];
    project.activeRunId = run.id;
    project.inspectionRunId = run.id;
    project.compareAId = run.id;
    project.compareBId = run.id;
    project.selectedTick = run.ticks.length - 1;
  }
  normalizeProject();
  ui.selection = null;
  ui.bottomTab = 'compare';
  persistNow();
  renderAll();
  toast('示例已载入并自动保存，可随时关闭后重开。', 'success');
}

/* -------------------------------- Events -------------------------------- */

function bindEvents() {
  renderPalette();

  document.querySelector('#newRunButton').addEventListener('click', () => createNewRun());
  document.querySelector('#playButton').addEventListener('click', togglePlayback);
  document.querySelector('#stepButton').addEventListener('click', stepOnce);

  el.tickScrubber.addEventListener('input', () => {
    const run = getCurrentRun() ?? getInspectionRun();
    project.selectedTick = clampTick(Number(el.tickScrubber.value), run);
    el.tickLabel.textContent = `T+${project.selectedTick}`;
    renderCanvas();
    renderInspector();
  });
  el.tickScrubber.addEventListener('change', () => {
    schedulePersist();
    renderBottom();
  });

  el.exampleMenuButton.addEventListener('click', (event) => {
    event.stopPropagation();
    const hidden = el.exampleMenu.hidden;
    el.exampleMenu.hidden = !hidden;
    el.exampleMenuButton.setAttribute('aria-expanded', String(hidden));
  });
  el.exampleMenu.addEventListener('click', (event) => {
    const button = event.target.closest('[data-example]');
    if (!button) return;
    el.exampleMenu.hidden = true;
    loadExample(button.dataset.example);
  });
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.menu-wrap')) {
      el.exampleMenu.hidden = true;
      el.exampleMenuButton.setAttribute('aria-expanded', 'false');
    }
  });

  document.querySelector('#exportButton').addEventListener('click', exportProject);
  document.querySelector('#importButton').addEventListener('click', () => document.querySelector('#importFile').click());
  document.querySelector('#importFile').addEventListener('change', importProject);

  el.canvasViewport.addEventListener('dragover', (event) => {
    if (event.dataTransfer.types.includes('text/component-type')) event.preventDefault();
  });
  el.canvasViewport.addEventListener('drop', (event) => {
    const type = event.dataTransfer.getData('text/component-type');
    if (!type || !COMPONENT_DEFS[type]) return;
    event.preventDefault();
    const rect = el.canvas.getBoundingClientRect();
    addComponentAt(type, event.clientX - rect.left, event.clientY - rect.top);
  });

  el.canvas.addEventListener('pointerdown', onCanvasPointerDown);
  el.canvas.addEventListener('click', (event) => {
    if (!event.target.closest('.component') && !event.target.closest('[data-wire-id]')) {
      ui.selection = null;
      renderInspector();
      renderWires(getCanvasContext().trace, activeFaultContext(getCurrentRun(), getCanvasContext().trace));
    }
  });

  window.addEventListener('pointermove', onWindowPointerMove);
  window.addEventListener('pointerup', onWindowPointerUp);
  window.addEventListener('pointercancel', () => {
    ui.drag = null;
    ui.wiring = null;
    setDraftVisible(false);
  });

  el.inspectorContent.addEventListener('change', onInspectorChange);
  el.inspectorContent.addEventListener('input', onInspectorInput);

  document.querySelector('.bottom-tabs').addEventListener('click', (event) => {
    const button = event.target.closest('[data-bottom-tab]');
    if (button) setBottomTab(button.dataset.bottomTab);
  });
  el.bottomContent.addEventListener('change', onBottomChange);

  document.addEventListener('click', onGlobalClick);
  document.addEventListener('keydown', onKeyDown);
  window.addEventListener('beforeunload', persistNow);
}

function onCanvasPointerDown(event) {
  const port = event.target.closest('[data-port-id]');
  if (port) {
    startWiring(event, port);
    return;
  }

  const componentElement = event.target.closest('.component');
  if (!componentElement) return;
  if (event.target.closest('button, input, select, a, [data-switch-toggle], [data-constant-toggle]')) return;

  const id = componentElement.dataset.componentId;
  ui.selection = { kind: 'component', id };
  document.querySelectorAll('.component.is-selected').forEach((node) => node.classList.remove('is-selected'));
  componentElement.classList.add('is-selected');
  renderInspector();

  const component = project.graph.components.find((c) => c.id === id);
  if (!component) return;
  ui.drag = {
    id,
    element: componentElement,
    pointerId: event.pointerId,
    startClientX: event.clientX,
    startClientY: event.clientY,
    originalX: component.x,
    originalY: component.y,
    moved: false,
  };
}

function onWindowPointerMove(event) {
  if (ui.wiring) {
    ui.wiring.lastEvent = event;
    updateDraftWire(event);
    return;
  }
  const drag = ui.drag;
  if (!drag || event.pointerId !== drag.pointerId) return;
  const dx = event.clientX - drag.startClientX;
  const dy = event.clientY - drag.startClientY;
  if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
  const component = project.graph.components.find((c) => c.id === drag.id);
  if (!component) return;
  component.x = Math.max(0, Math.round(drag.originalX + dx));
  component.y = Math.max(0, Math.round(drag.originalY + dy));
  drag.element.style.left = `${component.x}px`;
  drag.element.style.top = `${component.y}px`;
  const ctx = getCanvasContext();
  renderWires(ctx.trace, activeFaultContext(ctx.run, ctx.trace));
}

function onWindowPointerUp(event) {
  if (ui.wiring) {
    finishWiring(event);
    return;
  }
  if (ui.drag) {
    if (ui.drag.moved) {
      schedulePersist();
      if (ui.selection?.kind === 'component' && ui.selection.id === ui.drag.id) renderInspector();
    }
    ui.drag = null;
  }
}

function onInspectorInput(event) {
  const field = event.target.dataset.field;
  if (field === 'name') {
    const component = project.graph.components.find((c) => c.id === ui.selection?.id);
    if (component) {
      component.name = event.target.value;
      const nameNode = el.canvas.querySelector(`[data-component-id="${CSS.escape(component.id)}"] .comp-name`);
      if (nameNode) nameNode.textContent = component.name;
      schedulePersist();
    }
  }
}

function onInspectorChange(event) {
  const prop = event.target.dataset.prop;
  if (!prop || ui.selection?.kind !== 'component') return;
  const component = project.graph.components.find((c) => c.id === ui.selection.id);
  if (!component) return;

  if (prop === 'value') component.props.value = event.target.value === '1';
  if (prop === 'delayTicks') component.props.delayTicks = Math.max(1, Math.min(8, Number(event.target.value) || 1));
  if (prop === 'initialValue') {
    component.props.initialValue = event.target.value === 'unknown' ? null : Number(event.target.value);
  }
  commitElectricalChange('参数已更新；旧运行记录保留，可新建运行查看新时序。');
}

function onBottomChange(event) {
  if (event.target.matches('[data-compare-select]')) {
    const which = event.target.dataset.compareSelect;
    if (which === 'a') project.compareAId = event.target.value;
    if (which === 'b') project.compareBId = event.target.value;
    schedulePersist();
    renderCompareTab();
  }
  if (event.target.matches('[data-trace-run]')) {
    project.inspectionRunId = event.target.value;
    project.selectedWireId = null;
    const run = getRun(project.inspectionRunId);
    project.selectedTick = clampTick(project.selectedTick, run);
    schedulePersist();
    renderTraceTab();
  }
  if (event.target.matches('[data-trace-wire]')) {
    project.selectedWireId = event.target.value;
    schedulePersist();
    renderTraceTab();
  }
  if (event.target.matches('[data-trace-tick-range], [data-trace-tick-number]')) {
    const run = getInspectionRun();
    project.selectedTick = clampTick(Number(event.target.value), run);
    schedulePersist();
    renderTraceTab();
    renderSimbar();
    renderCanvas();
  }
}

async function onGlobalClick(event) {
  const addType = event.target.closest('[data-add-type]');
  if (addType) {
    addComponentVisibleCenter(addType.dataset.addType);
    return;
  }

  const switchToggle = event.target.closest('[data-switch-toggle]');
  if (switchToggle) {
    event.stopPropagation();
    handleSwitchClick(switchToggle.dataset.switchToggle);
    return;
  }

  const constantToggle = event.target.closest('[data-constant-toggle]');
  if (constantToggle) {
    const component = project.graph.components.find((c) => c.id === constantToggle.dataset.constantToggle);
    component.props.value = !component.props.value;
    commitElectricalChange();
    return;
  }

  const actionElement = event.target.closest('[data-action]');
  if (!actionElement) return;
  const action = actionElement.dataset.action;
  const id = actionElement.dataset.id;

  if (action === 'new-run') createNewRun();
  if (action === 'toggle-table') {
    ui.showTable = actionElement.checked;
    renderCompareTab();
  }
  if (action === 'toggle-mismatch-filter') {
    ui.onlyMismatches = actionElement.checked;
    renderCompareTab();
  }
  if (action === 'delete-component' && id) deleteSelectedComponent(id);
  if (action === 'delete-wire' && id) deleteSelectedWire(id);
  if (action === 'trace-wire' && id) {
    project.selectedWireId = id;
    const current = getCurrentRun();
    if (current) project.inspectionRunId = current.id;
    setBottomTab('trace');
  }
  if (action === 'inspect-run' && id) {
    project.inspectionRunId = id;
    const run = getRun(id);
    project.selectedTick = run ? run.ticks.length - 1 : 0;
    setBottomTab('trace');
  }
  if (action === 'compare-a' && id) {
    project.compareAId = id;
    schedulePersist();
    setBottomTab('compare');
  }
  if (action === 'compare-b' && id) {
    project.compareBId = id;
    schedulePersist();
    setBottomTab('compare');
  }
  if (action === 'schedule-switch' && id) handleSwitchClick(id);
  if (action === 'locate-fault' && id) locateFault(id);
}

function handleSwitchClick(componentId) {
  const run = getCurrentRun();
  if (!run) {
    const component = project.graph.components.find((c) => c.id === componentId);
    if (!component) return;
    component.props.value = !component.props.value;
    schedulePersist();
    renderAll();
    toast(`已将初始状态设为 ${component.props.value ? '1（高电平）' : '0（低电平）'}。`, 'success', 1800);
    return;
  }

  const tick = run.ticks.length;
  const pending = run.events.find((event) => event.tick === tick && event.componentId === componentId);
  const current = pending ? pending.value : (run.switchValues[componentId] ?? 0);
  const next = current === HIGH ? 0 : HIGH;
  const result = scheduleSwitch(run, tick, componentId, next);
  if (!result.ok) {
    toast(result.message, 'error');
    return;
  }
  project.selectedTick = run.ticks.length - 1;
  schedulePersist();
  renderAll();
  toast(`已安排 ${componentName(componentId)} 在 T+${tick} 变为 ${next ? '1' : '0'}；下一次单步/播放时生效。`, 'info', 2600);
}

function deleteSelectedComponent(id) {
  project.graph = deleteComponent(project.graph, id);
  if (ui.selection?.id === id) ui.selection = null;
  commitElectricalChange('元件和相关连线已删除；运行记录仍保留。');
}

function deleteSelectedWire(id) {
  project.graph = deleteConnection(project.graph, id);
  if (ui.selection?.id === id) ui.selection = null;
  commitElectricalChange('连线已删除；运行记录仍保留。');
}

function locateFault(faultId) {
  const run = getCurrentRun();
  const fault = run?.faults.find((f) => f.id === faultId);
  if (!fault) return;
  pausePlayback();
  project.selectedTick = fault.firstTick;
  ui.selection = { kind: 'component', id: fault.componentIds[0] };
  renderAll();
  requestAnimationFrame(() => {
    el.canvas.querySelector(`[data-component-id="${CSS.escape(fault.componentIds[0])}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
  });
}

function onKeyDown(event) {
  const target = event.target;
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable;
  if (event.key === 'Escape') {
    ui.selection = null;
    ui.wiring = null;
    setDraftVisible(false);
    el.exampleMenu.hidden = true;
    renderAll();
    return;
  }
  if (typing) return;
  if (event.key === 'Delete' || event.key === 'Backspace') {
    if (ui.selection?.kind === 'component') deleteSelectedComponent(ui.selection.id);
    if (ui.selection?.kind === 'wire') deleteSelectedWire(ui.selection.id);
    event.preventDefault();
  }
  if (event.code === 'Space' && target.tagName !== 'BUTTON') {
    event.preventDefault();
    togglePlayback();
  }
}

function exportProject() {
  persistNow();
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `wiring-signal-lab-${new Date().toISOString().slice(0, 19).replaceAll(':', '-')}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
  toast('工程 JSON 已导出。', 'success');
}

async function importProject(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    if (!parsed || parsed.version !== 1 || !parsed.graph || !Array.isArray(parsed.graph.components)) {
      throw new Error('invalid project');
    }
    pausePlayback();
    project = parsed;
    normalizeProject();
    persistNow();
    renderAll();
    toast('工程已导入，可以继续修改和运行。', 'success');
  } catch {
    toast('导入失败：文件不是本工具导出的有效工程 JSON。', 'error', 5000);
  } finally {
    event.target.value = '';
  }
}

function renderAll() {
  normalizeProject();
  renderSimbar();
  renderAlerts();
  renderCanvas();
  renderInspector();
  renderBottom();
}

bindEvents();
setBottomTab(ui.bottomTab);
persistNow();
renderAll();
