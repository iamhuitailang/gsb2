import {
  alignmentDescription,
  centeredAlignment,
  invertMatrix,
  matrixFromAlignment,
  scaleAroundPivot,
  rotateAroundPivot,
} from '../src/core/alignment.js';
import {
  PAIR_STATUSES,
  alignmentMethodLabel,
  pairStatusLabel,
} from '../src/core/project.js';
import {
  formatArea,
  formatDate,
  formatNumber,
  formatPercent,
  formatShortDate,
  formatScale,
  formatDegrees,
} from '../src/core/format.js';
import { inspectImageBlob } from '../src/core/images.js';
import { WorkbenchStore } from './store.js';
import { DiffService } from './diff-service.js';
import { Viewport } from './viewport.js';
import { exportProjectFile, exportResults } from './export.js';
import { importSamples } from './samples.js';

const $ = (id) => document.getElementById(id);
const store = new WorkbenchStore();
const diffService = new DiffService();
let viewport = null;
let currentMode = 'overlay';
let currentTool = 'hand';
let overlayOpacity = 0.55;
let blinkInterval = 520;
let blinkTimer = null;
let blinkShowB = false;
let blinkPaused = false;
let brushSize = 32;
let brushMode = 'paint';
let sensitivityDebounce = null;
let diffBusyToken = 0;
let cornerStage = 'a';
let pendingCorner = null;
let spacePeek = false;
let inspectorTab = 'align';
let newPairImages = { a: null, b: null };
let activeIgnoreStroke = null;

const els = {};

function cacheEls() {
  const ids = [
    'projectName', 'projectMeta', 'pairList', 'pairCount', 'rail', 'statPairs',
    'statRegions', 'statArea', 'btnNewPair', 'btnLoadSamples', 'btnOpenProject',
    'btnSaveProject', 'btnExport', 'btnSaveProjectSide', 'railAddPair',
    'modeSwitch', 'overlayTools', 'blinkTools', 'diffTools', 'opacityRange',
    'opacityOut', 'btnBlinkOnce', 'blinkRange', 'blinkOut', 'btnBlinkToggle',
    'sensitivityRange', 'sensitivityOut', 'uncoveredToggle', 'btnZoomIn',
    'btnZoomOut', 'btnZoomFit', 'btnZoomReset', 'zoomLabel', 'alignModeSwitch',
    'stageBody', 'emptyStage', 'viewport', 'viewCanvas',
    'cornerBanner', 'cornerBannerText', 'btnCornerUndo', 'btnCornerCancel',
    'dropHint', 'statusLeft', 'cursorInfo', 'alignInfo', 'inspectorTabs',
    'inspectorBody', 'alignMethodBadge', 'alignTx', 'alignTy', 'alignScale',
    'alignRotation', 'scaleSlider', 'rotationSlider', 'btnCenterAlign',
    'btnFitScale', 'btnCopyAlign', 'cornerCount', 'cornerList', 'btnCornerTool',
    'btnCornerClear', 'btnCornerFit', 'fitResult', 'diffBadge', 'sensValue',
    'sensRange2', 'minAreaValue', 'minAreaRange', 'includeUncovered2',
    'diffChangedArea', 'diffChangedPct', 'diffRegionCount', 'diffIgnoredArea',
    'diffLayerToggle', 'ignoreCount', 'brushModeSwitch', 'brushSize',
    'brushSizeOut', 'btnUndoStroke', 'btnClearStrokes', 'regionList',
    'regionListCount', 'pairStatusBadge', 'pairName', 'imageFields',
    'statusSwitch', 'pairNotes', 'pairSummary', 'btnDeletePair',
    'btnDuplicatePair', 'saveBadge', 'projId', 'projCreated', 'projUpdated',
    'projImages', 'btnExportBundle', 'btnExportProject', 'btnExportReport',
    'btnImportSamples', 'btnResetWorkspace', 'toastStack', 'busy', 'busyText',
    'newPairDialog', 'newPairName', 'dropA', 'dropB', 'fileA', 'fileB',
    'previewA', 'previewB', 'metaA', 'metaB', 'versionA', 'versionB',
    'dialogHint', 'btnCreatePair', 'exportDialog', 'exportDiffImages',
    'exportOverlays', 'exportReportHtml', 'exportReportMarkdown',
    'exportReportJson', 'exportProjectFile', 'exportName', 'btnDoExport',
    'projectFileInput', 'quickImageInput', 'newPairForm', 'btnEmptyNewPair',
    'btnEmptySamples',
  ];
  for (const id of ids) els[id] = $(id);
}

/* ------------------------------- bootstrap ------------------------------- */

async function init() {
  cacheEls();
  viewport = new Viewport(els.viewCanvas, els.stageBody);
  viewport.setCallbacks({
    onViewChange: (view) => store.setView(view),
    onPan: (dx, dy) => {
      const v = store.view;
      store.setView({ panX: v.panX + dx, panY: v.panY + dy });
    },
    onAlignDrag: handleAlignDrag,
    onRotateDrag: handleRotateDrag,
    onAlignEnd: () => {
      store.save();
      scheduleDiff({ immediate: true });
      refreshAfterAlign();
    },
    onAlignStart: () => {},
    onCornerClick: handleCornerClick,
    onStrokeStart: (world, mode) => {
      activeIgnoreStroke = {
        id: `stroke_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        mode,
        size: brushSize,
        points: [world],
      };
      setStatus(mode === 'erase' ? '正在擦除忽略区…' : '正在涂抹忽略区…');
      queueViewportSync();
    },
    onStrokeMove: (world) => {
      if (!activeIgnoreStroke) return;
      const last = activeIgnoreStroke.points.at(-1);
      if (!last || Math.hypot(world.x - last.x, world.y - last.y) > 1.2) {
        activeIgnoreStroke.points.push(world);
        queueViewportSync();
      }
    },
    onStrokeEnd: () => {
      const pair = store.activePair;
      if (activeIgnoreStroke && pair && activeIgnoreStroke.points.length) {
        store.addIgnoreStroke(pair.id, activeIgnoreStroke);
        viewport.invalidateIgnore();
        scheduleDiff({ immediate: true });
        updateIgnoreCount();
      }
      activeIgnoreStroke = null;
      setStatus('就绪');
      queueViewportSync();
    },
    onHover: handleHover,
    onBlocked: (reason) => {
      if (reason === 'align-side') {
        setStatus('并排模式不显示平移；请切到「叠加」或「差异」模式拖动 B 图对齐');
      } else if (reason === 'ignore-side-b') {
        setStatus('忽略区基于 A 图坐标，请在左侧 A 面板涂抹');
      }
    },
    onResize: () => {},
  });

  wireHeader();
  wireToolbar();
  wireInspector();
  wireNewPairDialog();
  wireExportDialog();
  wireKeyboard();
  wireDragAndDrop();

  store.subscribe(onStoreEvent);
  const restored = await store.restore();
  if (restored?.warnings?.length) {
    for (const warning of restored.warnings) toast(warning, 'warn');
  }
  if (!restored.empty) {
    setActivePairFromStore();
    toast(`已恢复上次的项目（${formatShortDate(restored.savedAt)} 保存）`, 'ok');
  } else {
    showEmptyStage();
  }
  syncSaveBadge('idle');
  setInspectorTab('align');
  syncViewportState();
  refreshAllUI();
  if (store.activePair) scheduleDiff({ immediate: true });
}

/* ---------------------------- state wiring ------------------------------ */

function onStoreEvent(type, detail) {
  switch (type) {
    case 'active-pair':
    case 'pairs':
      setActivePairFromStore();
      refreshAllUI();
      break;
    case 'alignment':
      // Numeric edits, nudges and corner fits: update only what changed so
      // text fields keep focus while the user types.
      refreshAfterAlign();
      queueViewportSync();
      scheduleDiff();
      break;
    case 'corners':
      refreshCornerPanel();
      refreshPairList();
      queueViewportSync();
      break;
    case 'settings':
      // The control that changed already reflects the new value; only the
      // aggregates need refreshing (avoid fighting an in-progress drag).
      onDiffSettingsApplied(store.activePair);
      updateStatsRail();
      break;
    case 'pair-updated':
      if (store.activePair) refreshNotesPanel(store.activePair);
      refreshStatusPanel();
      refreshPairList();
      refreshProjectPanel();
      break;
    case 'project':
      refreshProjectPanel();
      break;
    case 'pair-meta':
      if (store.activePair) refreshNotesPanel(store.activePair);
      refreshPairList();
      queueViewportSync();
      break;
    case 'strokes':
      viewport.invalidateIgnore();
      updateIgnoreCount();
      scheduleDiff();
      break;
    case 'view':
      syncViewportState();
      updateZoomLabel();
      updateAlignInfo();
      break;
    case 'save-state':
      syncSaveBadge(detail.state, detail.error);
      break;
    case 'imported':
    case 'restored':
      setActivePairFromStore();
      refreshAllUI();
      break;
    case 'reset':
      showEmptyStage();
      refreshAllUI();
      break;
    case 'diff':
      if (detail.pairId === store.activePairId) {
        updateDiffPanel(detail.result);
        if (currentMode === 'diff') queueViewportSync();
      }
      refreshPairList();
      break;
    default:
      break;
  }
}

function setActivePairFromStore() {
  const pair = store.activePair;
  if (!pair) {
    showEmptyStage();
    return;
  }
  els.emptyStage.hidden = true;
  els.viewport.hidden = false;
  viewport.setState(makeViewportState(pair));
  updateZoomLabel();
  updateAlignInfo();
  if (store.viewFitted?.has(pair.id)) {
    queueViewportSync();
  } else {
    requestAnimationFrame(() => {
      viewport.fitView();
      store.viewFitted = store.viewFitted || new Set();
      store.viewFitted.add(pair.id);
      store.resetViewFor(pair.id, { ...store.view });
      queueViewportSync();
    });
  }
}

function makeViewportState(pair) {
  // Ensure dimensions come from the decoded image when a restored record's
  // stored size is missing or stale.
  const imageA = store.imageRecord(pair.a.imageId);
  const imageB = store.imageRecord(pair.b.imageId);
  if (imageA && (!pair.a.width || !pair.a.height)) {
    pair.a.width = imageA.width;
    pair.a.height = imageA.height;
  }
  if (imageB && (!pair.b.width || !pair.b.height)) {
    pair.b.width = imageB.width;
    pair.b.height = imageB.height;
  }
  const diff = store.getDiff(pair.id);
  return {
    pairId: pair.id,
    imgA: imageA?.img || null,
    imgB: imageB?.img || null,
    wA: pair.a.width,
    hA: pair.a.height,
    wB: pair.b.width,
    hB: pair.b.height,
    alignment: pair.alignment,
    mode: currentMode,
    blinkShowB,
    peekB: spacePeek,
    overlayOpacity,
    tool: currentTool,
    brushSize,
    brushMode,
    view: store.view,
    diffResult: diff,
    diffLayer: els.diffLayerToggle?.checked !== false,
    ignoreStrokes: pair.ignoreStrokes,
    activeStroke: activeIgnoreStroke,
    ignoreRevision: pair.ignoreRevision,
    cornerPoints: pair.cornerPoints,
    pendingCorner,
    aLabel: pair.a.version || pair.a.name,
    bLabel: pair.b.version || pair.b.name,
  };
}

function syncViewportState() {
  const pair = store.activePair;
  if (!pair) return;
  viewport.setState(makeViewportState(pair));
}

let viewportSyncQueued = false;
function queueViewportSync() {
  if (viewportSyncQueued) return;
  viewportSyncQueued = true;
  requestAnimationFrame(() => {
    viewportSyncQueued = false;
    syncViewportState();
  });
}

/* -------------------------------- header -------------------------------- */

function wireHeader() {
  els.projectName.value = store.project.name;
  els.projectName.addEventListener('change', () => {
    store.setProjectName(els.projectName.value.trim() || '未命名对比项目');
    els.projectName.value = store.project.name;
  });
  els.projectName.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') els.projectName.blur();
  });

  els.btnNewPair.addEventListener('click', () => openNewPairDialog());
  els.railAddPair.addEventListener('click', () => openNewPairDialog());
  els.btnEmptyNewPair.addEventListener('click', () => openNewPairDialog());
  els.btnLoadSamples.addEventListener('click', loadSamples);
  els.btnEmptySamples.addEventListener('click', loadSamples);
  els.btnImportSamples.addEventListener('click', loadSamples);

  els.btnOpenProject.addEventListener('click', () => els.projectFileInput.click());
  els.projectFileInput.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) await importProjectFile(file);
  });

  const save = async () => {
    await store.save();
    toast('项目已保存到本机浏览器', 'ok');
  };
  els.btnSaveProject.addEventListener('click', save);
  els.btnSaveProjectSide.addEventListener('click', save);

  els.btnExport.addEventListener('click', openExportDialog);
  els.btnExportBundle.addEventListener('click', () => {
    setInspectorTab('project');
    openExportDialog();
  });
  els.btnExportProject.addEventListener('click', async () => {
    await exportProjectFile(store);
    toast('项目文件已导出', 'ok');
  });
  els.btnExportReport.addEventListener('click', () => {
    setInspectorTab('project');
    openExportDialog();
    els.exportDiffImages.checked = true;
    els.exportOverlays.checked = true;
    els.exportReportHtml.checked = true;
    els.exportReportMarkdown.checked = false;
    els.exportReportJson.checked = false;
    els.exportProjectFile.checked = false;
  });

  els.btnResetWorkspace.addEventListener('click', async () => {
    if (!confirm('清空本地工作区？当前项目、对齐参数与忽略区都会被删除（已导出的文件不受影响）。')) {
      return;
    }
    await store.resetWorkspace();
    els.projectName.value = store.project.name;
    setInspectorTab('align');
    toast('本地工作区已清空', 'ok');
  });
}

async function loadSamples() {
  if (store.project.pairs.length && !confirm('载入示例会新建 3 组对比，是否继续？')) return;
  setBusy(true, '正在生成示例对比…');
  try {
    const { created } = await importSamples({ store, withAlignment: true });
    setActivePairFromStore();
    refreshAllUI();
    scheduleDiff({ immediate: true });
    toast(`已载入 ${created} 组示例对比（尺寸不同，含局部改动）`, 'ok');
  } catch (error) {
    toast(error.message || '示例载入失败', 'error');
  } finally {
    setBusy(false);
  }
}

async function importProjectFile(file) {
  setBusy(true, '正在读取项目…');
  try {
    const text = await file.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error('项目文件不是有效的 JSON');
    }
    const result = await store.importProjectPayload(payload);
    setActivePairFromStore();
    refreshAllUI();
    scheduleDiff({ immediate: true });
    for (const warning of result.warnings || []) toast(warning, 'warn');
    toast(`已导入项目：${result.pairCount} 组对比`, 'ok');
  } catch (error) {
    toast(error.message || '项目导入失败', 'error');
  } finally {
    setBusy(false);
  }
}

/* ------------------------------- toolbar -------------------------------- */

function wireToolbar() {
  els.modeSwitch.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-mode]');
    if (!btn) return;
    setMode(btn.dataset.mode);
  });

  els.opacityRange.addEventListener('input', () => {
    overlayOpacity = Number(els.opacityRange.value) / 100;
    els.opacityOut.textContent = `${Math.round(overlayOpacity * 100)}%`;
    queueViewportSync();
  });

  els.btnBlinkOnce.addEventListener('click', () => {
    blinkShowB = true;
    queueViewportSync();
    setTimeout(() => {
      blinkShowB = false;
      queueViewportSync();
    }, Math.max(180, blinkInterval / 2));
  });

  els.blinkRange.addEventListener('input', () => {
    blinkInterval = Number(els.blinkRange.value);
    els.blinkOut.textContent = `${blinkInterval} ms`;
    if (currentMode === 'blink' && !blinkPaused) startBlink();
  });

  els.btnBlinkToggle.addEventListener('click', () => {
    blinkPaused = !blinkPaused;
    els.btnBlinkToggle.textContent = blinkPaused ? '继续' : '暂停';
    if (blinkPaused) stopBlink();
    else startBlink();
  });

  // Shared sensitivity controls: toolbar (diff mode) and inspector panel.
  const syncSensitivityUI = (value) => {
    els.sensitivityOut.textContent = String(value);
    els.sensRange2.value = String(value);
    els.sensValue.textContent = String(value);
  };
  els.sensitivityRange.addEventListener('input', () => {
    const value = Number(els.sensitivityRange.value);
    syncSensitivityUI(value);
    applySensitivity(value);
  });
  els.sensRange2.addEventListener('input', () => {
    const value = Number(els.sensRange2.value);
    els.sensitivityRange.value = String(value);
    syncSensitivityUI(value);
    applySensitivity(value);
  });
  els.uncoveredToggle.addEventListener('change', () => {
    const pair = store.activePair;
    if (!pair) return;
    store.setDiffSettings(pair.id, { includeUncovered: els.uncoveredToggle.checked });
    els.includeUncovered2.checked = els.uncoveredToggle.checked;
    scheduleDiff({ immediate: true });
  });

  els.alignModeSwitch.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-tool]');
    if (!btn) return;
    setTool(btn.dataset.tool);
  });

  els.btnZoomIn.addEventListener('click', () => viewport.zoomCenter(1.25));
  els.btnZoomOut.addEventListener('click', () => viewport.zoomCenter(0.8));
  els.btnZoomFit.addEventListener('click', () => {
    viewport.fitView();
    const pair = store.activePair;
    if (pair) store.resetViewFor(pair.id, { ...store.view });
  });
  els.btnZoomReset.addEventListener('click', () => {
    viewport.fitView();
    const pair = store.activePair;
    if (pair) store.resetViewFor(pair.id, { ...store.view });
  });

  els.btnCornerUndo.addEventListener('click', () => {
    if (pendingCorner) {
      pendingCorner = null;
    } else {
      const pair = store.activePair;
      const last = pair?.cornerPoints.at(-1);
      if (pair && last) store.removeCornerPoint(pair.id, last.id);
    }
    updateCornerBanner();
    refreshCornerPanel();
    queueViewportSync();
  });
  els.btnCornerCancel.addEventListener('click', () => {
    pendingCorner = null;
    setTool('hand');
    updateCornerBanner();
    queueViewportSync();
  });
}

function setMode(mode) {
  const previous = currentMode;
  currentMode = mode;
  // Corner picking only makes sense when A and B are shown side by side.
  if (mode !== 'side' && currentTool === 'corner') {
    setTool('hand', { silent: true });
  }
  for (const btn of els.modeSwitch.querySelectorAll('[data-mode]')) {
    const active = btn.dataset.mode === mode;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', String(active));
  }
  els.overlayTools.classList.toggle('hidden', mode !== 'overlay');
  els.blinkTools.classList.toggle('hidden', mode !== 'blink');
  els.diffTools.classList.toggle('hidden', mode !== 'diff');
  if (mode === 'blink') {
    blinkPaused = false;
    els.btnBlinkToggle.textContent = '暂停';
    startBlink();
  } else {
    stopBlink();
    blinkShowB = false;
  }
  queueViewportSync();
  if (mode === 'side' || previous === 'side') {
    // Panel layout changes alter the available area; refit the shared view.
    requestAnimationFrame(() => {
      viewport.fitView();
      const pair = store.activePair;
      if (pair) store.resetViewFor(pair.id, { ...store.view });
      queueViewportSync();
    });
  }
  if (mode === 'diff') scheduleDiff({ immediate: true });
}

function startBlink() {
  stopBlink();
  blinkShowB = false;
  queueViewportSync();
  blinkTimer = setInterval(() => {
    blinkShowB = !blinkShowB;
    queueViewportSync();
  }, blinkInterval);
}

function stopBlink() {
  if (blinkTimer) clearInterval(blinkTimer);
  blinkTimer = null;
}

function setTool(tool, { silent = false } = {}) {
  currentTool = tool;
  // Corner picking needs A and B visible separately, so switch to the
  // side-by-side layout automatically.
  if (tool === 'corner' && currentMode !== 'side') {
    setMode('side');
  }
  for (const btn of els.alignModeSwitch.querySelectorAll('[data-tool]')) {
    btn.classList.toggle('is-active', btn.dataset.tool === tool);
  }
  viewport.updateCursor();
  if (tool === 'corner') {
    cornerStage = 'a';
    pendingCorner = null;
    els.cornerBanner.hidden = false;
    updateCornerBanner();
    if (!silent) setInspectorTab('align');
  } else {
    els.cornerBanner.hidden = true;
    pendingCorner = null;
  }
  if (tool === 'ignore' && !silent) setInspectorTab('diff');
  queueViewportSync();
  updateCornerBanner();
}

/* ------------------------------ inspector ------------------------------- */

function wireInspector() {
  els.inspectorTabs.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-tab]');
    if (!btn) return;
    setInspectorTab(btn.dataset.tab);
  });

  const alignInputs = [
    ['alignTx', 'tx', 1],
    ['alignTy', 'ty', 1],
    ['alignScale', 'scale', 1],
    ['alignRotation', 'rotation', Math.PI / 180],
  ];
  for (const [id, key, factor] of alignInputs) {
    els[id].addEventListener('change', () => {
      const pair = store.activePair;
      if (!pair) return;
      const value = Number(els[id].value);
      if (!Number.isFinite(value)) {
        refreshAlignPanel();
        return;
      }
      const patch = { ...pair.alignment, [key]: value * factor };
      if (key === 'rotation') {
        const pivot = { x: pair.b.width / 2, y: pair.b.height / 2 };
        store.setAlignment(pair.id, rotateAroundPivot(pair.alignment, value * factor, pivot));
      } else if (key === 'scale') {
        const pivot = { x: pair.b.width / 2, y: pair.b.height / 2 };
        store.setAlignment(pair.id, scaleAroundPivot(pair.alignment, value, pivot));
      } else {
        store.setAlignment(pair.id, patch);
      }
      afterAlignmentChange();
    });
  }

  for (const btn of document.querySelectorAll('[data-nudge]')) {
    btn.addEventListener('click', (event) => {
      const pair = store.activePair;
      if (!pair) return;
      const step = event.shiftKey ? 10 : 1;
      const dx = btn.dataset.nudge === 'left' ? -step : btn.dataset.nudge === 'right' ? step : 0;
      const dy = btn.dataset.nudge === 'up' ? -step : btn.dataset.nudge === 'down' ? step : 0;
      store.setAlignment(pair.id, {
        ...pair.alignment,
        tx: pair.alignment.tx + dx,
        ty: pair.alignment.ty + dy,
      });
      afterAlignmentChange();
    });
  }

  els.scaleSlider.addEventListener('input', () => {
    const pair = store.activePair;
    if (!pair) return;
    const step = Number(els.scaleSlider.value) / 1000;
    const pivot = { x: pair.b.width / 2, y: pair.b.height / 2 };
    if (pair.baseScale == null) pair.baseScale = pair.alignment.scale;
    const next = scaleAroundPivot(
      { ...pair.alignment, scale: pair.baseScale },
      pair.baseScale * (1 + step * 2),
      pivot,
    );
    store.setAlignment(pair.id, next, { silent: true });
    queueViewportSync();
    scheduleDiff();
    updateAlignInfo();
    syncAlignInputs();
  });
  els.scaleSlider.addEventListener('change', () => {
    const pair = store.activePair;
    if (pair) delete pair.baseScale;
    els.scaleSlider.value = '0';
    afterAlignmentChange();
  });

  els.rotationSlider.addEventListener('input', () => {
    const pair = store.activePair;
    if (!pair) return;
    const deg = Number(els.rotationSlider.value) / 10;
    if (pair.baseRotation == null) pair.baseRotation = pair.alignment.rotation;
    const pivot = { x: pair.b.width / 2, y: pair.b.height / 2 };
    store.setAlignment(
      pair.id,
      rotateAroundPivot(
        { ...pair.alignment, rotation: pair.baseRotation },
        pair.baseRotation + (deg * Math.PI) / 180,
        pivot,
      ),
      { silent: true },
    );
    queueViewportSync();
    scheduleDiff();
    updateAlignInfo();
    syncAlignInputs();
  });
  els.rotationSlider.addEventListener('change', () => {
    const pair = store.activePair;
    if (pair) delete pair.baseRotation;
    els.rotationSlider.value = '0';
    afterAlignmentChange();
  });

  els.btnCenterAlign.addEventListener('click', () => {
    const pair = store.activePair;
    if (!pair) return;
    store.setAlignment(
      pair.id,
      centeredAlignment(pair.a.width, pair.a.height, pair.b.width, pair.b.height),
      { method: 'initial' },
    );
    pair.alignmentMethod = 'initial';
    afterAlignmentChange({ refit: true });
  });
  els.btnFitScale.addEventListener('click', () => {
    const pair = store.activePair;
    if (!pair) return;
    const scale = pair.a.width / Math.max(1, pair.b.width);
    store.setAlignment(pair.id, {
      ...pair.alignment,
      scale,
      tx: (pair.a.width - pair.b.width * scale) / 2,
      ty: (pair.a.height - pair.b.height * scale) / 2,
    });
    afterAlignmentChange({ refit: true });
  });
  els.btnCopyAlign.addEventListener('click', async () => {
    const pair = store.activePair;
    if (!pair) return;
    const d = alignmentDescription(pair.alignment);
    const text = `tx=${d.tx}, ty=${d.ty}, scale=${d.scale}, rotation=${d.rotationDeg}°`;
    try {
      await navigator.clipboard.writeText(text);
      toast('对齐参数已复制到剪贴板', 'ok');
    } catch {
      toast(text, 'info');
    }
  });

  els.btnCornerTool.addEventListener('click', () => setTool('corner'));
  els.btnCornerClear.addEventListener('click', () => {
    const pair = store.activePair;
    if (!pair) return;
    store.clearCornerPoints(pair.id);
    pendingCorner = null;
    fitResultText('');
    queueViewportSync();
  });
  els.btnCornerFit.addEventListener('click', () => {
    const pair = store.activePair;
    if (!pair) return;
    const fit = store.fitCorners(pair.id);
    if (!fit.ok) {
      fitResultText(fit.error, 'warn');
      toast(fit.error, 'warn');
      return;
    }
    fitResultText(
      `拟合完成：${fit.count} 对角点，RMS ${formatNumber(fit.rms, 2)} px，最大残差 ${formatNumber(fit.maxError, 2)} px`,
      'ok',
    );
    afterAlignmentChange({ refit: true });
  });

  els.minAreaRange.addEventListener('input', () => {
    const pair = store.activePair;
    if (!pair) return;
    els.minAreaValue.textContent = els.minAreaRange.value;
    applyMinArea(Number(els.minAreaRange.value));
  });

  els.includeUncovered2.addEventListener('change', () => {
    const pair = store.activePair;
    if (!pair) return;
    els.uncoveredToggle.checked = els.includeUncovered2.checked;
    store.setDiffSettings(pair.id, { includeUncovered: els.includeUncovered2.checked });
    scheduleDiff({ immediate: true });
  });

  els.diffLayerToggle.addEventListener('change', () => {
    viewport.invalidateDiff();
    queueViewportSync();
  });

  els.brushModeSwitch.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-brush]');
    if (!btn) return;
    brushMode = btn.dataset.brush;
    for (const b of els.brushModeSwitch.querySelectorAll('[data-brush]')) {
      b.classList.toggle('is-active', b.dataset.brush === brushMode);
    }
    queueViewportSync();
  });

  els.brushSize.addEventListener('input', () => {
    brushSize = Number(els.brushSize.value);
    els.brushSizeOut.textContent = `${brushSize} px`;
    queueViewportSync();
  });

  els.btnUndoStroke.addEventListener('click', () => {
    const pair = store.activePair;
    if (!pair) return;
    if (store.undoIgnoreStroke(pair.id)) {
      scheduleDiff({ immediate: true });
      toast('已撤销最后一笔忽略', 'info');
    }
  });
  els.btnClearStrokes.addEventListener('click', () => {
    const pair = store.activePair;
    if (!pair || !pair.ignoreStrokes.length) return;
    store.clearIgnoreStrokes(pair.id);
    viewport.invalidateIgnore();
    scheduleDiff({ immediate: true });
    toast('忽略区已清空（原始图片未改动）', 'info');
  });

  els.statusSwitch.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-status]');
    if (!btn) return;
    const pair = store.activePair;
    if (!pair) return;
    store.updatePair(pair.id, { status: btn.dataset.status });
    refreshStatusPanel();
    refreshPairList();
  });

  els.pairName.addEventListener('change', () => {
    const pair = store.activePair;
    if (!pair) return;
    store.updatePair(pair.id, { name: els.pairName.value.trim() || '未命名对比' });
  });
  els.pairNotes.addEventListener('change', () => {
    const pair = store.activePair;
    if (!pair) return;
    store.updatePair(pair.id, { notes: els.pairNotes.value });
  });

  els.btnDeletePair.addEventListener('click', () => {
    const pair = store.activePair;
    if (!pair) return;
    if (!confirm(`删除「${pair.name}」这组对比？（图片若未被其他组使用会一并从本地移除）`)) return;
    store.deletePair(pair.id);
    if (!store.activePair) showEmptyStage();
  });
  els.btnDuplicatePair.addEventListener('click', () => {
    const pair = store.activePair;
    if (!pair) return;
    store.duplicatePair(pair.id);
  });
}

function applySensitivity(value) {
  const pair = store.activePair;
  if (!pair) return;
  store.setDiffSettings(pair.id, { sensitivity: value });
  clearTimeout(sensitivityDebounce);
  sensitivityDebounce = setTimeout(() => scheduleDiff({ immediate: true }), 120);
}

function applyMinArea(value) {
  const pair = store.activePair;
  if (!pair) return;
  store.setDiffSettings(pair.id, { minRegionArea: value });
  clearTimeout(sensitivityDebounce);
  sensitivityDebounce = setTimeout(() => scheduleDiff({ immediate: true }), 120);
}

function onDiffSettingsApplied(pair) {
  // `refreshDiffPanel` writes every control, so only call it when the change
  // came from outside the diff panel (e.g. project restore / pair switch).
  if (!pair) return;
  els.minAreaValue.textContent = String(pair.diffSettings.minRegionArea);
  updateIgnoreCount();
}

function afterAlignmentChange({ refit = false } = {}) {
  const pair = store.activePair;
  if (!pair) return;
  if (refit) {
    viewport.fitView();
    store.resetViewFor(pair.id, { ...store.view });
  }
  refreshAfterAlign();
  scheduleDiff({ immediate: true });
}

function refreshAfterAlign() {
  const pair = store.activePair;
  if (!pair) return;
  els.alignMethodBadge.textContent = alignmentMethodLabel(pair.alignmentMethod);
  syncAlignInputs();
  updateAlignInfo();
  refreshCornerPanel();
  refreshPairList();
  refreshStatusPanel();
  if (inspectorTab === 'notes') refreshNotesPanel(pair);
}

function setInspectorTab(tab) {
  inspectorTab = tab;
  for (const btn of els.inspectorTabs.querySelectorAll('[data-tab]')) {
    const active = btn.dataset.tab === tab;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', String(active));
  }
  for (const panel of els.inspectorBody.querySelectorAll('[data-panel]')) {
    panel.hidden = panel.dataset.panel !== tab;
  }
}

/* --------------------------- canvas interactions ------------------------ */

function handleAlignDrag(start, dx, dy) {
  const pair = store.activePair;
  if (!pair) return;
  // The alignment maps B pixels into single-panel world space, which is
  // exactly what the pointer reports there, so tx/ty shift by the raw delta.
  store.setAlignment(
    pair.id,
    { ...start, tx: start.tx + dx, ty: start.ty + dy },
    { silent: true },
  );
  queueViewportSync();
  syncAlignInputs();
  updateAlignInfo();
}

function handleRotateDrag(start, deltaRadians) {
  const pair = store.activePair;
  if (!pair) return;
  const pivot = { x: pair.b.width / 2, y: pair.b.height / 2 };
  const next = rotateAroundPivot(
    start,
    start.rotation + deltaRadians,
    pivot,
  );
  store.setAlignment(pair.id, next, { silent: true });
  queueViewportSync();
  syncAlignInputs();
  updateAlignInfo();
}

function handleCornerClick({ panelId, image }) {
  const pair = store.activePair;
  if (!pair) return;
  const inSide = currentMode === 'side';
  if (cornerStage === 'a') {
    if (inSide && panelId !== 'a') {
      setStatus('请先在左侧 A 面板点选角点');
      return;
    }
    // In side-by-side the A panel reports A pixels; in single-panel modes the
    // A panel is also the world frame, so the values coincide.
    pendingCorner = { a: { x: image.x, y: image.y } };
    cornerStage = 'b';
    updateCornerBanner();
    queueViewportSync();
    setStatus('已记录 A 图角点，请到右侧 B 面板点击同一位置');
    return;
  }
  if (!pendingCorner?.a) {
    cornerStage = 'a';
    pendingCorner = null;
    updateCornerBanner();
    return;
  }
  if (inSide && panelId !== 'b') {
    setStatus('请在右侧 B 面板点选对应角点（左侧是 A 图）');
    return;
  }
  let bx;
  let by;
  if (inSide) {
    // The B panel shows B natively, so the click is already a B pixel.
    bx = image.x;
    by = image.y;
  } else {
    // Single-panel modes show B through the alignment; invert to B pixels.
    const inv = invertMatrix(matrixFromAlignment(pair.alignment));
    if (!inv) {
      toast('当前对齐参数不可逆，无法记录角点', 'warn');
      return;
    }
    bx = inv.a * image.x + inv.c * image.y + inv.e;
    by = inv.b * image.x + inv.d * image.y + inv.f;
  }
  store.addCornerPoint(pair.id, {
    ax: pendingCorner.a.x,
    ay: pendingCorner.a.y,
    bx,
    by,
  });
  pendingCorner = null;
  cornerStage = 'a';
  updateCornerBanner();
  refreshCornerPanel();
  queueViewportSync();
  setStatus(`已记录第 ${pair.cornerPoints.length} 对角点`);
}

function handleHover(info) {
  if (!info) {
    els.cursorInfo.textContent = '—';
    return;
  }
  const inSide = currentMode === 'side';
  const point = inSide ? info.image : info.world;
  const suffix = inSide ? (info.panelId === 'b' ? ' · B' : ' · A') : '';
  els.cursorInfo.textContent = `x ${formatNumber(point.x, 0)} · y ${formatNumber(point.y, 0)}${suffix}`;
}

/* --------------------------------- diff --------------------------------- */

function scheduleDiff({ immediate = false } = {}) {
  const pair = store.activePair;
  if (!pair) return;
  clearTimeout(scheduleDiff.timer);
  const delay = immediate ? 0 : 160;
  scheduleDiff.timer = setTimeout(() => runDiff(pair.id), delay);
}

async function runDiff(pairId) {
  const pair = store.getPair(pairId);
  if (!pair) return;
  const imageA = store.imageRecord(pair.a.imageId);
  const imageB = store.imageRecord(pair.b.imageId);
  if (!imageA || !imageB) return;
  const token = ++diffBusyToken;
  setDiffBadge('running', '计算中…');
  try {
    const result = await diffService.compute({
      pairId: pair.id,
      imgA: imageA.img,
      imgB: imageB.img,
      alignment: pair.alignment,
      settings: pair.diffSettings,
      strokes: pair.ignoreStrokes,
      strokesRevision: pair.ignoreRevision,
    });
    if (token !== diffBusyToken) return;
    store.setDiff(pair.id, result);
    setDiffBadge('ready', '已生成');
    viewport.invalidateDiff();
    updateDiffPanel(result);
    refreshPairList();
    if (currentMode === 'diff') queueViewportSync();
  } catch (error) {
    if (token !== diffBusyToken) return;
    console.error(error);
    setDiffBadge('error', '计算失败');
    toast(`差异计算失败：${error.message}`, 'error');
  }
}

function updateDiffPanel(result) {
  if (!result) return;
  els.diffChangedArea.textContent = formatArea(result.stats.changedArea);
  els.diffChangedPct.textContent = formatPercent(result.stats.changedPct);
  els.diffRegionCount.textContent = `${result.stats.regionCount} 处`;
  els.diffIgnoredArea.textContent = formatArea(result.stats.ignoredArea);
  refreshRegionList(result);
  updateStatsRail();
}

function refreshRegionList(result) {
  const list = els.regionList;
  if (!result) {
    list.innerHTML = '<p class="panel-note">尚未生成差异。</p>';
    els.regionListCount.textContent = '0';
    return;
  }
  const regions = result.regions.slice(0, 120);
  els.regionListCount.textContent = String(result.regions.length);
  if (!regions.length) {
    list.innerHTML =
      '<p class="panel-note">没有超过阈值的差异区域。可以尝试提高敏感度，或降低最小区域面积。</p>';
    return;
  }
  const maxArea = Math.max(...regions.map((r) => r.area), 1);
  list.innerHTML = regions
    .map(
      (region) => `
      <button class="region-item" type="button" data-region="${region.index}">
        <span class="region-index">${region.index}</span>
        <span class="region-main">
          <span class="region-title">${regionTypeLabel(region.type)} · ${formatArea(region.area)}</span>
          <span class="region-sub">${formatNumber(region.bbox.x, 0)}, ${formatNumber(region.bbox.y, 0)} · ${formatNumber(region.bbox.width, 0)}×${formatNumber(region.bbox.height, 0)} px</span>
          <span class="region-bar"><i style="width:${Math.max(3, (region.area / maxArea) * 100)}%"></i></span>
        </span>
      </button>`,
    )
    .join('');
  for (const btn of list.querySelectorAll('[data-region]')) {
    btn.addEventListener('click', () => {
      const region = result.regions.find((r) => String(r.index) === btn.dataset.region);
      if (!region) return;
      focusRegion(region);
    });
  }
}

function focusRegion(region) {
  const panel = viewport.panels()[0];
  const s = viewport.getState();
  if (!s) return;
  if (s.mode === 'side') {
    setStatus('差异区域定位在「差异」或「叠加」模式中可用');
    return;
  }
  const fitScale = Math.min(
    (panel.width * 0.5) / Math.max(1, region.bbox.width),
    (panel.height * 0.5) / Math.max(1, region.bbox.height),
  );
  const scale = Math.max(s.view.scale, Math.min(6, fitScale));
  const cx = region.bbox.x + region.bbox.width / 2;
  const cy = region.bbox.y + region.bbox.height / 2;
  // The panel base centres A; solve pan so the region centre lands mid-stage.
  const base = viewport.baseFor(panel, scale);
  store.setView({
    scale,
    panX: panel.x + panel.width / 2 - base.x - cx * scale,
    panY: panel.y + panel.height / 2 - base.y - cy * scale,
  });
  setStatus(`已定位到区域 #${region.index}`);
}

function updateStatsRail() {
  const stats = store.stats();
  els.statPairs.textContent = String(stats.pairCount);
  els.statRegions.textContent = String(stats.regionTotal);
  els.statArea.textContent = formatArea(stats.changedTotal);
  els.pairCount.textContent = String(store.project.pairs.length);
}

/* --------------------------------- render -------------------------------- */

function refreshAllUI() {
  const pair = store.activePair;
  if (document.activeElement !== els.projectName) {
    els.projectName.value = store.project.name;
  }
  refreshPairList();
  refreshStatsRail();
  refreshProjectPanel();
  if (!pair) {
    showEmptyStage();
    return;
  }
  els.emptyStage.hidden = true;
  els.viewport.hidden = false;
  refreshAlignPanel();
  refreshDiffPanel(pair);
  refreshNotesPanel(pair);
  refreshStatusPanel();
  syncViewportState();
}

function refreshPairList() {
  const list = els.pairList;
  const pairs = store.project.pairs;
  els.pairCount.textContent = String(pairs.length);
  if (!pairs.length) {
    list.innerHTML = '<p class="rail-empty">还没有对比组。<br>点击下方按钮添加第一对图片。</p>';
    return;
  }
  list.innerHTML = pairs
    .map((pair, index) => {
      const active = pair.id === store.activePairId;
      const diff = store.getDiff(pair.id);
      const status = PAIR_STATUSES.find((s) => s.id === pair.status);
      const changed = diff ? formatArea(diff.stats.changedArea) : '未计算';
      return `
        <button class="pair-item${active ? ' is-active' : ''}" type="button" role="option" aria-selected="${active}" data-pair="${pair.id}">
          <span class="pair-num">${String(index + 1).padStart(2, '0')}</span>
          <span class="pair-body">
            <span class="pair-name">${escapeText(pair.name)}</span>
            <span class="pair-sub">${escapeText(pair.a.version || pair.a.name)} → ${escapeText(pair.b.version || pair.b.name)}</span>
            <span class="pair-foot">
              <span class="status-dot ${status?.tone || ''}"></span>
              <span>${escapeText(pairStatusLabel(pair.status))}</span>
              <span class="pair-diff">${changed}</span>
            </span>
          </span>
        </button>`;
    })
    .join('');
  for (const btn of list.querySelectorAll('[data-pair]')) {
    btn.addEventListener('click', () => {
      const id = btn.dataset.pair;
      if (id === store.activePairId) return;
      store.setActivePair(id);
      pendingCorner = null;
      cornerStage = 'a';
      queueViewportSync();
      if (store.getDiff(id)) {
        updateDiffPanel(store.getDiff(id));
      } else {
        scheduleDiff({ immediate: true });
      }
    });
  }
}

function refreshAlignPanel() {
  const pair = store.activePair;
  if (!pair) return;
  els.alignMethodBadge.textContent = alignmentMethodLabel(pair.alignmentMethod);
  syncAlignInputs();
  refreshCornerPanel();
  updateAlignInfo();
}

function syncAlignInputs() {
  const pair = store.activePair;
  if (!pair) return;
  const d = alignmentDescription(pair.alignment);
  if (document.activeElement !== els.alignTx) els.alignTx.value = String(d.tx);
  if (document.activeElement !== els.alignTy) els.alignTy.value = String(d.ty);
  if (document.activeElement !== els.alignScale) els.alignScale.value = String(d.scale);
  if (document.activeElement !== els.alignRotation) els.alignRotation.value = String(d.rotationDeg);
}

function refreshCornerPanel() {
  const pair = store.activePair;
  if (!pair) return;
  const points = pair.cornerPoints;
  els.cornerCount.textContent = `${points.length} 对`;
  els.btnCornerFit.disabled = points.length < 2;
  if (!points.length) {
    els.cornerList.innerHTML = '<p class="panel-note small">尚未标点。</p>';
  } else {
    els.cornerList.innerHTML = points
      .map(
        (p, i) => `
        <div class="corner-row">
          <span class="corner-num">${i + 1}</span>
          <span class="corner-coords">A ${formatNumber(p.ax, 0)}, ${formatNumber(p.ay, 0)}<br>B ${formatNumber(p.bx, 0)}, ${formatNumber(p.by, 0)}</span>
          <button class="icon-btn tiny" type="button" data-remove-corner="${p.id}" title="删除这对角点" aria-label="删除角点">×</button>
        </div>`,
      )
      .join('');
    for (const btn of els.cornerList.querySelectorAll('[data-remove-corner]')) {
      btn.addEventListener('click', () => {
        store.removeCornerPoint(pair.id, btn.dataset.removeCorner);
        refreshCornerPanel();
        queueViewportSync();
      });
    }
  }
  if (pair.cornerFit) {
    fitResultText(
      `上次拟合：${pair.cornerFit.count} 对，RMS ${formatNumber(pair.cornerFit.rms, 2)} px，最大 ${formatNumber(pair.cornerFit.maxError, 2)} px`,
      'ok',
    );
  } else {
    fitResultText('');
  }
}

function fitResultText(text, tone = '') {
  els.fitResult.textContent = text;
  els.fitResult.dataset.tone = tone;
}

function refreshDiffPanel(pair) {
  if (!pair) return;
  const settings = pair.diffSettings;
  els.sensitivityRange.value = String(settings.sensitivity);
  els.sensitivityOut.textContent = String(settings.sensitivity);
  els.sensRange2.value = String(settings.sensitivity);
  els.sensValue.textContent = String(settings.sensitivity);
  els.minAreaRange.value = String(settings.minRegionArea);
  els.minAreaValue.textContent = String(settings.minRegionArea);
  els.uncoveredToggle.checked = settings.includeUncovered;
  els.includeUncovered2.checked = settings.includeUncovered;
  updateIgnoreCount();
  const result = store.getDiff(pair.id);
  if (result) {
    updateDiffPanel(result);
    setDiffBadge('ready', '已生成');
  } else {
    setDiffBadge('idle', '待生成');
    els.diffChangedArea.textContent = '—';
    els.diffChangedPct.textContent = '—';
    els.diffRegionCount.textContent = '—';
    els.diffIgnoredArea.textContent = '—';
    refreshRegionList(null);
  }
}

function updateIgnoreCount() {
  const pair = store.activePair;
  const count = pair ? pair.ignoreStrokes.length : 0;
  els.ignoreCount.textContent = `${count} 笔`;
}

function refreshNotesPanel(pair) {
  if (!pair) return;
  els.pairName.value = pair.name;
  els.pairNotes.value = pair.notes || '';
  els.imageFields.innerHTML = ['a', 'b']
    .map((side) => {
      const ref = pair[side];
      return `
        <div class="image-field">
          <div class="image-field-head">
            <span class="side-tag">${side.toUpperCase()}</span>
            <span class="image-field-name" title="${escapeText(ref.name)}">${escapeText(ref.name)}</span>
          </div>
          <div class="image-field-meta">${ref.width} × ${ref.height} px</div>
          <label class="field tiny">
            <span>版本名称</span>
            <input type="text" data-version="${side}" value="${escapeText(ref.version || '')}" placeholder="如 v4.0 · 03-21">
          </label>
        </div>`;
    })
    .join('');
  for (const input of els.imageFields.querySelectorAll('[data-version]')) {
    input.addEventListener('change', () => {
      const side = input.dataset.version;
      store.setPairImageMeta(pair.id, side, { version: input.value.trim() });
      refreshPairList();
      queueViewportSync();
    });
  }
  const summary = document.createElement('div');
  summary.innerHTML = summaryHtml(pair);
  els.pairSummary.innerHTML = summary.innerHTML;
}

function summaryHtml(pair) {
  const diff = store.getDiff(pair.id);
  const d = alignmentDescription(pair.alignment);
  return `
    <dl class="meta-list compact">
      <div><dt>对齐</dt><dd>${escapeText(alignmentMethodLabel(pair.alignmentMethod))}</dd></div>
      <div><dt>参数</dt><dd>${formatScale(d.scale)} · ${formatDegrees(pair.alignment.rotation)} · (${formatNumber(d.tx, 1)}, ${formatNumber(d.ty, 1)})</dd></div>
      <div><dt>角点</dt><dd>${pair.cornerPoints.length ? `${pair.cornerPoints.length} 对` : '未使用'}</dd></div>
      <div><dt>差异</dt><dd>${diff ? `${formatArea(diff.stats.changedArea)} · ${diff.stats.regionCount} 处` : '未生成'}</dd></div>
      <div><dt>忽略</dt><dd>${pair.ignoreStrokes.length} 笔${diff ? ` · ${formatArea(diff.stats.ignoredArea)}` : ''}</dd></div>
    </dl>`;
}

function refreshStatusPanel() {
  const pair = store.activePair;
  if (!pair) return;
  els.pairStatusBadge.textContent = pairStatusLabel(pair.status);
  els.pairStatusBadge.dataset.status = pair.status;
  for (const btn of els.statusSwitch.querySelectorAll('[data-status]')) {
    btn.classList.toggle('is-active', btn.dataset.status === pair.status);
  }
}

function refreshProjectPanel() {
  const project = store.project;
  els.projId.textContent = project.id;
  els.projCreated.textContent = formatDate(project.createdAt);
  els.projUpdated.textContent = formatDate(project.updatedAt);
  els.projImages.textContent = `${store.images.size} 张`;
  els.projectMeta.textContent = `${project.pairs.length} 组 · ${store.images.size} 张图 · 更新于 ${formatShortDate(project.updatedAt)}`;
}

function showEmptyStage() {
  els.emptyStage.hidden = false;
  els.viewport.hidden = true;
  els.cornerBanner.hidden = true;
  els.alignInfo.textContent = '对齐 —';
  els.cursorInfo.textContent = '—';
  refreshPairList();
  refreshStatsRail();
  refreshProjectPanel();
}

function updateZoomLabel() {
  const scale = store.view.scale;
  els.zoomLabel.textContent = `${Math.round(scale * 100)}%`;
}

function updateAlignInfo() {
  const pair = store.activePair;
  if (!pair) return;
  const d = alignmentDescription(pair.alignment);
  els.alignInfo.textContent = `对齐 ${formatScale(d.scale)} · ${d.rotationDeg.toFixed(2)}° · (${formatNumber(d.tx, 1)}, ${formatNumber(d.ty, 1)})`;
}

function updateCornerBanner() {
  if (currentTool !== 'corner') {
    els.cornerBanner.hidden = true;
    return;
  }
  els.cornerBanner.hidden = false;
  if (currentMode === 'side') {
    els.cornerBannerText.textContent =
      cornerStage === 'a'
        ? '在左侧 A 图点选角点（1/2）'
        : '再到右侧 B 图点选同一角点（2/2）';
  } else {
    els.cornerBannerText.textContent =
      cornerStage === 'a'
        ? '请在 A 图上点击角点（1/2）'
        : '请在 B 图上点击同一角点（2/2）';
  }
}

function setDiffBadge(state, text) {
  els.diffBadge.textContent = text;
  els.diffBadge.dataset.state = state;
}

function setStatus(text) {
  els.statusLeft.textContent = text;
}

/* ----------------------------- save / toast ----------------------------- */

function syncSaveBadge(state, error) {
  const map = {
    idle: '本机自动保存',
    dirty: '待保存…',
    saving: '保存中…',
    saved: '已保存到本机',
    error: '保存失败',
  };
  els.saveBadge.textContent = map[state] || '本机自动保存';
  els.saveBadge.dataset.state = state;
  if (error) console.warn('save failed', error);
}

function toast(message, tone = 'info', duration = 3200) {
  const el = document.createElement('div');
  el.className = `toast ${tone}`;
  el.textContent = message;
  els.toastStack.appendChild(el);
  requestAnimationFrame(() => el.classList.add('in'));
  setTimeout(() => {
    el.classList.remove('in');
    setTimeout(() => el.remove(), 260);
  }, duration);
}

function setBusy(busy, text = '处理中…') {
  els.busy.hidden = !busy;
  els.busyText.textContent = text;
}

/* ------------------------------ new pair -------------------------------- */

function wireNewPairDialog() {
  for (const side of ['a', 'b']) {
    const drop = side === 'a' ? els.dropA : els.dropB;
    const input = side === 'a' ? els.fileA : els.fileB;
    drop.addEventListener('click', (event) => {
      // Clicks on the version input / its label must not open the file picker,
      // and the programmatic input.click() must not bounce back here.
      if (event.target === input) return;
      if (event.target.closest('label, input, button')) return;
      input.click();
    });
    drop.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        input.click();
      }
    });
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      input.value = '';
      if (file) await assignNewPairImage(side, file);
    });
    drop.addEventListener('dragover', (event) => {
      event.preventDefault();
      drop.classList.add('is-over');
    });
    drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
    drop.addEventListener('drop', async (event) => {
      event.preventDefault();
      drop.classList.remove('is-over');
      const file = [...(event.dataTransfer?.files || [])].find((f) =>
        f.type.startsWith('image/'),
      );
      if (file) await assignNewPairImage(side, file);
    });
  }
  els.newPairForm.addEventListener('submit', (event) => {
    if (event.submitter?.value !== 'create') return;
    event.preventDefault();
    createPairFromDialog();
  });
}

function openNewPairDialog(initialA = null) {
  newPairImages = { a: null, b: null };
  els.newPairName.value = '';
  els.versionA.value = '';
  els.versionB.value = '';
  els.previewA.innerHTML = '<span>A · 基准版本</span>';
  els.previewB.innerHTML = '<span>B · 对比版本</span>';
  els.previewA.classList.remove('has-image');
  els.previewB.classList.remove('has-image');
  els.metaA.textContent = '点击或拖入图片';
  els.metaB.textContent = '点击或拖入图片';
  els.dialogHint.textContent = '两张图片可以尺寸不同，创建后再配准对齐。';
  els.dialogHint.dataset.tone = '';
  els.btnCreatePair.disabled = true;
  els.newPairDialog.showModal();
  if (initialA) {
    // inspectImageBlob expects a File-like; the dialog only needs its blob.
    assignNewPairImage('a', initialA).catch(() => {});
  }
}

async function assignNewPairImage(side, file) {
  try {
    const inspected = await inspectImageBlob(file, file.name);
    newPairImages[side] = inspected;
    const preview = side === 'a' ? els.previewA : els.previewB;
    const meta = side === 'a' ? els.metaA : els.metaB;
    preview.innerHTML = '';
    const img = document.createElement('img');
    img.src = inspected.img.src;
    img.alt = file.name;
    preview.appendChild(img);
    preview.classList.add('has-image');
    meta.textContent = `${file.name} · ${inspected.width} × ${inspected.height} px`;
    if (side === 'a' && !els.versionA.value) els.versionA.value = 'A 版本';
    if (side === 'b' && !els.versionB.value) els.versionB.value = 'B 版本';
    els.btnCreatePair.disabled = !(newPairImages.a && newPairImages.b);
    if (newPairImages.a && newPairImages.b) {
      const sameSize =
        newPairImages.a.width === newPairImages.b.width &&
        newPairImages.a.height === newPairImages.b.height;
      els.dialogHint.textContent = sameSize
        ? '两张图片尺寸相同，建议先直接比较；如有位移可用对齐工具微调。'
        : `尺寸不同（${newPairImages.a.width}×${newPairImages.a.height} vs ${newPairImages.b.width}×${newPairImages.b.height}），已按居中放置，可再用角点拟合。`;
      els.dialogHint.dataset.tone = 'ok';
    }
  } catch (error) {
    toast(error.message || '图片读取失败', 'error');
  }
}

async function createPairFromDialog() {
  if (!newPairImages.a || !newPairImages.b) return;
  els.btnCreatePair.disabled = true;
  setBusy(true, '正在创建对比…');
  try {
    const imageA = await store.addImage(newPairImages.a.blob, newPairImages.a.name);
    const imageB = await store.addImage(newPairImages.b.blob, newPairImages.b.name);
    const pair = store.createPair({
      imageA,
      imageB,
      name: els.newPairName.value.trim(),
      versionA: els.versionA.value.trim(),
      versionB: els.versionB.value.trim(),
    });
    els.newPairDialog.close();
    setActivePairFromStore();
    refreshAllUI();
    scheduleDiff({ immediate: true });
    toast(`已创建对比「${pair.name}」`, 'ok');
  } catch (error) {
    toast(error.message || '创建失败', 'error');
  } finally {
    setBusy(false);
    els.btnCreatePair.disabled = false;
  }
}

/* ------------------------------- export --------------------------------- */

function wireExportDialog() {
  els.btnDoExport.addEventListener('click', (event) => {
    event.preventDefault();
    runExport();
  });
}

function openExportDialog() {
  if (!store.project.pairs.length) {
    toast('还没有可导出的对比组', 'warn');
    return;
  }
  els.exportName.value = store.project.name;
  els.exportDialog.showModal();
}

async function runExport() {
  const options = {
    diffImages: els.exportDiffImages.checked,
    overlays: els.exportOverlays.checked,
    reportHtml: els.exportReportHtml.checked,
    reportMarkdown: els.exportReportMarkdown.checked,
    reportJson: els.exportReportJson.checked,
    projectFile: els.exportProjectFile.checked,
    name: els.exportName.value.trim() || store.project.name,
  };
  if (!Object.values(options).some((v) => v === true)) {
    toast('请至少选择一项导出内容', 'warn');
    return;
  }
  setBusy(true, '正在生成导出文件…');
  try {
    const { fileCount } = await exportResults({
      store,
      options,
      diffService,
    });
    els.exportDialog.close();
    toast(`已导出 ${fileCount} 个文件（差异图 + 报告）`, 'ok', 4200);
  } catch (error) {
    console.error(error);
    toast(error.message || '导出失败', 'error');
  } finally {
    setBusy(false);
  }
}

/* ------------------------------- keyboard ------------------------------- */

function wireKeyboard() {
  window.addEventListener('keydown', (event) => {
    if (isTypingTarget(event.target)) return;
    // Let open dialogs own their own keyboard interaction.
    if (document.querySelector('dialog[open]')) return;
    if (event.metaKey || event.ctrlKey) {
      if (event.key.toLowerCase() === 's') {
        event.preventDefault();
        store.save().then(() => toast('项目已保存到本机浏览器', 'ok'));
      }
      if (event.key.toLowerCase() === 'o') {
        event.preventDefault();
        els.projectFileInput.click();
      }
      return;
    }
    const key = event.key.toLowerCase();
    if (key === '1') setMode('overlay');
    else if (key === '2') setMode('blink');
    else if (key === '3') setMode('side');
    else if (key === '4') setMode('diff');
    else if (key === 'v') setTool('hand');
    else if (key === 'h') setTool('align');
    else if (key === 'c') setTool('corner');
    else if (key === 'i') setTool('ignore');
    else if (key === 'n') openNewPairDialog();
    else if (key === 'r') {
      viewport.fitView();
      const pair = store.activePair;
      if (pair) store.resetViewFor(pair.id, { ...store.view });
    } else if (key === '+' || key === '=') viewport.zoomCenter(1.25);
    else if (key === '-') viewport.zoomCenter(0.8);
    else if (key === ' ') {
      event.preventDefault();
      spacePeek = true;
      queueViewportSync();
    }
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
      const pair = store.activePair;
      if (!pair) return;
      event.preventDefault();
      const step = event.shiftKey ? 10 : 1;
      const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
      const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
      store.setAlignment(pair.id, {
        ...pair.alignment,
        tx: pair.alignment.tx + dx,
        ty: pair.alignment.ty + dy,
      });
      afterAlignmentChange();
    }
  });
  window.addEventListener('keyup', (event) => {
    if (event.key === ' ') {
      spacePeek = false;
      queueViewportSync();
    }
  });
}

/* --------------------------- drag & drop images ------------------------- */

function wireDragAndDrop() {
  let dragDepth = 0;
  const stage = els.stageBody;
  stage.addEventListener('dragenter', (event) => {
    if (![...(event.dataTransfer?.types || [])].includes('Files')) return;
    dragDepth += 1;
    els.dropHint.hidden = false;
    els.dropHint.classList.add('in');
  });
  stage.addEventListener('dragover', (event) => {
    if (![...(event.dataTransfer?.types || [])].includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  stage.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) {
      els.dropHint.classList.remove('in');
      els.dropHint.hidden = true;
    }
  });
  stage.addEventListener('drop', async (event) => {
    event.preventDefault();
    dragDepth = 0;
    els.dropHint.classList.remove('in');
    els.dropHint.hidden = true;
    const files = [...(event.dataTransfer?.files || [])].filter((f) =>
      f.type.startsWith('image/'),
    );
    if (!files.length) return;
    if (files.length >= 2) {
      await createPairFromFiles(files[0], files[1]);
      return;
    }
    // A single file starts a new comparison with it as the A (baseline) image.
    openNewPairDialog(files[0]);
  });
}

async function createPairFromFiles(fileA, fileB) {
  setBusy(true, '正在创建对比…');
  try {
    const imageA = await store.addImage(fileA, fileA.name);
    const imageB = await store.addImage(fileB, fileB.name);
    const pair = store.createPair({ imageA, imageB });
    setActivePairFromStore();
    refreshAllUI();
    scheduleDiff({ immediate: true });
    toast(`已创建对比「${pair.name}」`, 'ok');
  } catch (error) {
    toast(error.message || '创建失败', 'error');
  } finally {
    setBusy(false);
  }
}

/* -------------------------------- utils --------------------------------- */

function escapeText(text) {
  return String(text ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function round(value, digits) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function regionTypeLabel(type) {
  if (type === 'coverage') return '新增/移除';
  if (type === 'mixed') return '颜色 + 新增';
  return '颜色差异';
}

function isTypingTarget(target) {
  if (!target) return false;
  const tag = target.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    target.isContentEditable
  );
}

init().catch((error) => {
  console.error(error);
  const stack = document.getElementById('toastStack');
  if (stack) {
    const el = document.createElement('div');
    el.className = 'toast error in';
    el.textContent = `启动失败：${error.message}`;
    stack.appendChild(el);
  }
});
