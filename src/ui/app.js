/**
 * 主界面绑定。UI 只读 AppState、只调命令，不直接改工程数据。
 */
import {
  LIMITS,
  diffBuffers,
  getLayer,
  serializeProject,
  totalLoopDuration,
} from '../core/project.js';
import { gifTimingReport, encodeGif } from '../core/gif.js';
import {
  buildSpriteSheet,
  scaleSheet,
  spriteSheetMetadata,
} from '../core/spritesheet.js';
import { frameStarts, totalDuration } from '../core/player.js';
import { clamp, formatMs, hexToRgb, rgbToHex, slugify } from '../core/util.js';
import {
  drawBorder,
  drawCheckerboard,
  drawGrid,
  drawPixels,
  fitZoomFor,
  pixelFromClient,
  tintPixels,
} from './render.js';
import {
  downloadBlob,
  downloadText,
  rgbaToPngBlob,
  readFileText,
  saveProjectWithPicker,
} from './download.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const ONION_PREV_TINT = [255, 120, 150];
const ONION_NEXT_TINT = [90, 190, 255];
const DIFF_TINT = [255, 255, 255];
const PRIMARY_COLOR_FALLBACK = '#1a1c2c';

const LAYER_VISIBLE_ICON = '👁';
const LAYER_HIDDEN_ICON = '🚫';
const LAYER_LOCK_ICON = '🔒';
const LAYER_UNLOCK_ICON = '🔓';

export function mountApp(state) {
  const canvas = $('#stage-canvas');
  const ctx = canvas.getContext('2d');
  const previewCanvas = $('#preview-canvas');
  const previewCtx = previewCanvas.getContext('2d');
  const brushPreview = $('#brush-preview');
  const brushCtx = brushPreview.getContext('2d');

  let hoveringPixel = null;
  let draggingFrameId = null;
  let editingLayerId = null;
  let toastTimer = null;
  let renderQueued = false;
  let previewQueued = false;
  let editingColorId = null;

  /* -------------------------------------------------------------- */
  /* 渲染                                                              */
  /* -------------------------------------------------------------- */

  function scheduleStageRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      renderStage();
    });
  }

  function schedulePreviewRender() {
    if (previewQueued) return;
    previewQueued = true;
    requestAnimationFrame(() => {
      previewQueued = false;
      renderPreview();
    });
  }

  function stageZoom() {
    const project = state.project;
    if (state.autoFit) {
      const scroll = $('#canvas-scroll');
      const rect = scroll.getBoundingClientRect();
      return fitZoomFor({ width: rect.width, height: rect.height }, project);
    }
    return state.zoom;
  }

  function renderStage() {
    if (!projectSafe()) return;
    const project = state.project;
    const zoom = stageZoom();
    state.zoom = state.autoFit ? zoom : state.zoom;
    const cssWidth = project.width * zoom;
    const cssHeight = project.height * zoom;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);

    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    const view = composeStageView();
    drawCheckerboard(ctx, cssWidth, cssHeight, Math.max(4, Math.round(zoom * 0.5)));
    if (view.background) {
      ctx.save();
      ctx.globalAlpha = view.backgroundAlpha ?? 1;
      drawPixels(ctx, view.background, project.width, project.height, zoom);
      ctx.restore();
    }
    if (view.overlay) {
      ctx.save();
      ctx.globalAlpha = view.overlayAlpha ?? 1;
      drawPixels(ctx, view.overlay, project.width, project.height, zoom);
      ctx.restore();
    }
    if (state.showGrid) drawGrid(ctx, project.width, project.height, zoom, { major: 8 });
    drawBorder(ctx, cssWidth, cssHeight);

    if (hoveringPixel && !state.clock.playing) {
      const size = state.tool === 'fill' || state.tool === 'eyedropper' ? 1 : state.brushSize;
      drawCursorCell(ctx, hoveringPixel.x, hoveringPixel.y, zoom, size);
    }
  }

  /**
   * 舞台的合成视图：
   *  - 正常模式：当前帧合成（隐藏图层被排除）
   *  - 洋葱皮：前/后帧着色叠加在当前帧下方
   *  - 差异：上一帧合成 vs 当前帧合成
   */
  function composeStageView() {
    const project = state.project;
    const frame = state.frame;
    if (!frame) return { background: null };
    if (state.diff) {
      const prev = state.previousFrame();
      const prevComposite = prev
        ? state.compositeOf(prev.frame)
        : new Uint8ClampedArray(project.width * project.height * 4);
      const currComposite = state.compositeOf(frame);
      const { overlay } = diffBuffers(prevComposite, currComposite);
      // 当前帧以 35% 灰化显示，差异图叠在上面，便于定位。
      const base = tintPixels(currComposite, DIFF_TINT, 0.35);
      return { background: base, overlay, overlayAlpha: 1 };
    }

    const layers = [];
    if (state.onion.enabled) {
      const frames = project.frames;
      const index = state.frameIndex;
      const prevFrames = [];
      const nextFrames = [];
      for (let i = 1; i <= state.onion.prev; i += 1) {
        const idx = (index - i + frames.length * (i + 1)) % frames.length;
        if (idx === index) continue;
        prevFrames.push({ frame: frames[idx], depth: i });
      }
      for (let i = 1; i <= state.onion.next; i += 1) {
        const idx = (index + i) % frames.length;
        if (idx === index) continue;
        nextFrames.push({ frame: frames[idx], depth: i });
      }
      // 更远的帧更淡：先铺远的，再铺近的。
      for (const { frame: f, depth } of prevFrames.sort((a, b) => b.depth - a.depth)) {
        layers.push({
          pixels: tintPixels(state.compositeOf(f), ONION_PREV_TINT, 0.42 / depth),
          alpha: 1,
        });
      }
      for (const { frame: f, depth } of nextFrames.sort((a, b) => b.depth - a.depth)) {
        layers.push({
          pixels: tintPixels(state.compositeOf(f), ONION_NEXT_TINT, 0.42 / depth),
          alpha: 1,
        });
      }
    }

    layers.push({ pixels: state.compositeOf(frame), isCurrent: true });

    if (layers.length === 1) {
      return { background: layers[0].pixels };
    }
    // 把多层依次铺成一张缓冲：先画洋葱皮，再画当前帧。
    const out = new Uint8ClampedArray(project.width * project.height * 4);
    for (const layer of layers) {
      const src = layer.pixels;
      if (layer.isCurrent) {
        blendOver(out, src, 1);
      } else {
        blendOver(out, src, 0.85);
      }
    }
    return { background: out };
  }

  function blendOver(dst, src, opacity) {
    const op = clamp(opacity, 0, 1);
    for (let i = 0; i < dst.length; i += 4) {
      const sa = (src[i + 3] / 255) * op;
      if (sa <= 0) continue;
      const da = dst[i + 3] / 255;
      const outA = sa + da * (1 - sa);
      if (outA <= 0) continue;
      dst[i] = (src[i] * sa + dst[i] * da * (1 - sa)) / outA;
      dst[i + 1] = (src[i + 1] * sa + dst[i + 1] * da * (1 - sa)) / outA;
      dst[i + 2] = (src[i + 2] * sa + dst[i + 2] * da * (1 - sa)) / outA;
      dst[i + 3] = outA * 255;
    }
  }

  function projectSafe() {
    return Boolean(state.project && state.project.width > 0);
  }

  function renderPreview() {
    const project = state.project;
    const clock = state.clock;
    const frameIndex = clock.playing ? clock.currentFrame : state.frameIndex;
    const frame = project.frames[frameIndex] ?? project.frames[0];
    if (!frame) return;

    const box = previewCanvas.parentElement.getBoundingClientRect();
    const maxW = Math.max(60, box.width - 28);
    const maxH = 190;
    const raw = Math.min(maxW / project.width, maxH / project.height);
    const zoom = Math.max(1, Math.floor(raw));
    const cssW = project.width * zoom;
    const cssH = project.height * zoom;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    previewCanvas.width = Math.round(cssW * dpr);
    previewCanvas.height = Math.round(cssH * dpr);
    previewCanvas.style.width = `${cssW}px`;
    previewCanvas.style.height = `${cssH}px`;
    previewCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    previewCtx.imageSmoothingEnabled = false;
    previewCtx.clearRect(0, 0, cssW, cssH);
    const pixels = state.compositeOf(frame);
    drawPixels(previewCtx, pixels, project.width, project.height, zoom);

    $('#preview-frame').textContent = `${frameIndex + 1} / ${project.frames.length}`;
    const total = totalLoopDuration(project);
    $('#loop-duration').textContent =
      total > 0
        ? `${project.frames.length} 帧 / ${formatMs(total)}`
        : '—';
    const starts = frameStarts(project.frames);
    const elapsed = clock.playing ? clock.timeMs : starts[state.frameIndex] ?? 0;
    const pct = total > 0 ? clamp((elapsed / total) * 100, 0, 100) : 0;
    $('#loop-bar-fill').style.width = `${pct}%`;
    $('#timeline-progress-fill').style.width = `${pct}%`;
    const durations = new Set(project.frames.map((f) => f.duration));
    $('#loop-hint').textContent =
      durations.size > 1
        ? `每帧停留时间不同（${Math.min(...durations)}–${Math.max(...durations)} ms），预览按各自时长播放。`
        : '';
  }

  /* -------------------------------------------------------------- */
  /* 侧栏 / 时间轴 / 状态栏                                            */
  /* -------------------------------------------------------------- */

  function renderProjectMeta() {
    const project = state.project;
    $('#project-info').textContent = `${project.width} × ${project.height} · ${project.frames.length} 帧`;
    if (document.activeElement !== $('#project-name')) {
      $('#project-name').value = project.name;
    }
    document.title = `${project.name} · Pixanim`;
  }

  function renderToolbar() {
    $$('.tool').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tool === state.tool);
    });
    canvas.classList.toggle('tool-fill', state.tool === 'fill');
    canvas.classList.toggle('tool-eyedropper', state.tool === 'eyedropper');
    canvas.classList.toggle('no-draw', !state.canDraw && state.tool !== 'eyedropper');
    $('#brush-size').value = String(state.brushSize);
    $('#brush-size-value').textContent = `${state.brushSize} px`;
    $('#zoom-value').textContent = `${Math.round((stageZoom() / 1) * 100)}%`;
    $('#toggle-grid').checked = state.showGrid;
    $('#toggle-onion').checked = state.onion.enabled;
    $('#toggle-diff').checked = state.diff;
    $('#onion-prev').value = String(state.onion.prev);
    $('#onion-next').value = String(state.onion.next);
    $('#onion-range').classList.toggle('disabled', !state.onion.enabled);
    renderBrushPreview();
    const undo = $('#undo-btn');
    const redo = $('#redo-btn');
    undo.disabled = !state.history.canUndo;
    redo.disabled = !state.history.canRedo;
    undo.title = state.history.undoLabel ? `撤销：${state.history.undoLabel}` : '没有可撤销的操作';
    redo.title = state.history.redoLabel ? `重做：${state.history.redoLabel}` : '没有可重做的操作';
  }

  function renderBrushPreview() {
    const size = 48;
    brushCtx.clearRect(0, 0, size, size);
    brushCtx.fillStyle = '#101119';
    brushCtx.fillRect(0, 0, size, size);
    const px = Math.max(3, Math.floor(size / 16));
    const brush = state.brushSize;
    const cell = Math.min(px * 2, Math.floor(size / Math.max(brush, 4)));
    const total = cell * brush;
    const startX = Math.floor((size - total) / 2);
    const startY = Math.floor((size - total) / 2);
    const color = state.tool === 'eraser' ? 'rgba(255,255,255,0.25)' : state.color;
    brushCtx.fillStyle = color;
    brushCtx.fillRect(startX, startY, total, total);
    if (state.tool === 'eraser') {
      brushCtx.strokeStyle = 'rgba(255,255,255,0.5)';
      brushCtx.strokeRect(startX + 0.5, startY + 0.5, total - 1, total - 1);
    }
    brushCtx.strokeStyle = 'rgba(255,255,255,0.12)';
    brushCtx.strokeRect(0.5, 0.5, size - 1, size - 1);
  }

  function renderPalette() {
    const host = $('#palette');
    host.textContent = '';
    $('#palette-count').textContent = `${state.project.palette.length} 色`;
    state.project.palette.forEach((entry) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'swatch';
      btn.style.setProperty('--swatch', entry.hex);
      btn.dataset.colorId = entry.id;
      btn.title = `${entry.hex} · 左键选择，双击编辑`;
      btn.setAttribute('role', 'option');
      btn.setAttribute('aria-selected', String(entry.id === state.colorId));
      if (entry.id === state.colorId) btn.classList.add('active');
      btn.addEventListener('click', () => {
        state.selectPaletteColor(entry.id);
      });
      btn.addEventListener('dblclick', (event) => {
        event.preventDefault();
        openColorDialog(entry.id);
      });
      host.appendChild(btn);
    });
    const active = host.querySelector('.swatch.active');
    if (active && host.scrollHeight > host.clientHeight) {
      // 仅在调色板自身可滚动时把活动色滚到可见区域，避免整块侧栏跳动。
      const top = active.offsetTop;
      const bottom = top + active.offsetHeight;
      if (top < host.scrollTop || bottom > host.scrollTop + host.clientHeight) {
        host.scrollTop = Math.max(0, top - host.clientHeight + active.offsetHeight);
      }
    }
    $('#current-swatch').style.setProperty('--swatch', state.color);
    if (document.activeElement !== $('#hex-input')) {
      $('#hex-input').value = state.color;
    }
    $('#color-input').value = normalizeHex(state.color);
    $('#tool-grid').dataset.color = state.color;
    const selected = state.project.palette.find((c) => c.id === state.colorId);
    if (selected) {
      $('#hex-input').classList.remove('invalid');
    }
  }

  function normalizeHex(hex) {
    const rgb = hexToRgb(hex);
    if (!rgb) return PRIMARY_COLOR_FALLBACK;
    return rgbToHex(rgb.r, rgb.g, rgb.b);
  }

  function renderLayers() {
    const host = $('#layer-list');
    host.textContent = '';
    const layers = [...state.project.layers].reverse();
    const active = state.layer;
    for (const layer of layers) {
      const li = document.createElement('li');
      li.className = 'layer-item';
      li.dataset.layerId = layer.id;
      if (layer.id === active?.id) li.classList.add('active');
      if (!layer.visible) li.classList.add('hidden-layer');

      const vis = document.createElement('button');
      vis.type = 'button';
      vis.className = 'layer-visibility';
      vis.title = layer.visible ? '隐藏图层' : '显示图层';
      vis.textContent = layer.visible ? LAYER_VISIBLE_ICON : LAYER_HIDDEN_ICON;
      vis.addEventListener('click', (event) => {
        event.stopPropagation();
        state.toggleLayerVisible(layer.id);
        renderAll();
      });

      const lock = document.createElement('button');
      lock.type = 'button';
      lock.className = `layer-lock${layer.locked ? ' locked' : ''}`;
      lock.title = layer.locked ? '解锁图层' : '锁定图层';
      lock.textContent = layer.locked ? LAYER_LOCK_ICON : LAYER_UNLOCK_ICON;
      lock.addEventListener('click', (event) => {
        event.stopPropagation();
        state.toggleLayerLocked(layer.id);
        renderAll();
      });

      const thumb = document.createElement('canvas');
      thumb.className = 'layer-thumb';
      thumb.width = state.project.width;
      thumb.height = state.project.height;
      drawLayerThumb(thumb, layer);

      const name = document.createElement('span');
      name.className = 'layer-name';
      name.textContent = layer.name;
      name.title = '双击重命名';
      name.addEventListener('dblclick', (event) => {
        event.stopPropagation();
        beginRenameLayer(layer, name);
      });

      li.append(vis, lock, thumb, name);
      li.addEventListener('click', () => state.selectLayer(layer.id));
      host.appendChild(li);
    }
    updateLayerButtons();
  }

  function drawLayerThumb(canvasEl, layer) {
    const frame = state.frame;
    const cel = frame?.cels[layer.id];
    const ictx = canvasEl.getContext('2d');
    ictx.clearRect(0, 0, canvasEl.width, canvasEl.height);
    if (!cel) return;
    const image = new ImageData(new Uint8ClampedArray(cel), canvasEl.width, canvasEl.height);
    ictx.putImageData(image, 0, 0);
  }

  function beginRenameLayer(layer, labelEl) {
    if (editingLayerId) return;
    editingLayerId = layer.id;
    const input = document.createElement('input');
    input.className = 'layer-name-input';
    input.value = layer.name;
    input.maxLength = 40;
    labelEl.replaceWith(input);
    input.focus();
    input.select();
    const commit = () => {
      if (!editingLayerId) return;
      editingLayerId = null;
      state.renameLayer(layer.id, input.value);
      renderLayers();
      renderAll();
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        input.blur();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        editingLayerId = null;
        renderLayers();
      }
    });
  }

  function updateLayerButtons() {
    const index = state.project.layers.findIndex((l) => l.id === state.selection.layerId);
    $('[data-action="layer-up"]').disabled = index >= state.project.layers.length - 1;
    $('[data-action="layer-down"]').disabled = index <= 0;
    $('[data-action="layer-delete"]').disabled = state.project.layers.length <= 1;
  }

  function renderFacts() {
    const project = state.project;
    const frame = state.frame;
    const index = state.frameIndex;
    $('#fact-frame').textContent = frame ? `${index + 1} / ${project.frames.length}` : '—';
    $('#fact-duration').textContent = frame ? `${frame.duration} ms` : '—';
    $('#fact-total').textContent = formatMs(totalLoopDuration(project));
    if (state.diff) {
      const prev = state.previousFrame();
      const prevComposite = prev
        ? state.compositeOf(prev.frame)
        : new Uint8ClampedArray(project.width * project.height * 4);
      const info = diffBuffers(prevComposite, state.compositeOf(frame));
      $('#fact-diff').textContent = `+${info.added} −${info.removed} ~${info.changed}`;
    } else {
      $('#fact-diff').textContent = '未开启';
    }
    if (document.activeElement !== $('#frame-duration') && frame) {
      $('#frame-duration').value = String(frame.duration);
    }
  }

  function renderTimeline() {
    const host = $('#timeline-strip');
    host.textContent = '';
    const project = state.project;
    const starts = frameStarts(project.frames);
    const total = totalLoopDuration(project);
    const currentId = state.selection.frameId;
    project.frames.forEach((frame, index) => {
      const card = document.createElement('div');
      card.className = 'frame-card';
      card.dataset.frameId = frame.id;
      card.dataset.index = String(index);
      card.draggable = true;
      card.setAttribute('role', 'option');
      card.setAttribute('aria-selected', String(frame.id === currentId));
      card.title = `第 ${index + 1} 帧 · ${frame.duration} ms · 起始 ${starts[index]} ms\n拖动可调整顺序`;
      if (frame.id === currentId) card.classList.add('active');

      const thumb = document.createElement('canvas');
      thumb.className = 'frame-thumb';
      thumb.width = project.width;
      thumb.height = project.height;
      drawFrameThumb(thumb, frame);
      thumb.draggable = false;

      const footer = document.createElement('div');
      footer.className = 'frame-card-footer';
      const idx = document.createElement('span');
      idx.className = 'frame-index';
      idx.textContent = `#${index + 1}`;
      const badge = document.createElement('span');
      badge.className = 'frame-duration-badge';
      badge.textContent = `${frame.duration}ms`;
      const durations = new Set(project.frames.map((f) => f.duration));
      if (durations.size > 1) badge.classList.add('odd');
      footer.append(idx, badge);

      const grip = document.createElement('span');
      grip.className = 'frame-grip';
      grip.textContent = '⠿';
      grip.title = '拖动调整顺序';

      card.append(thumb, footer, grip);
      card.addEventListener('click', () => state.selectFrame(frame.id));
      card.addEventListener('dblclick', () => {
        const value = window.prompt(`第 ${index + 1} 帧停留时间（毫秒，${LIMITS.minDuration}–${LIMITS.maxDuration}）`, String(frame.duration));
        if (value == null) return;
        const ms = Number(value);
        if (!Number.isFinite(ms)) {
          showToast('请输入数字');
          return;
        }
        if (ms < LIMITS.minDuration || ms > LIMITS.maxDuration) {
          showToast(`停留时间需在 ${LIMITS.minDuration}–${LIMITS.maxDuration} ms`);
          return;
        }
        state.setDuration(ms, frame.id);
        renderAll();
      });
      uploadDragHandlers(card, frame, index);
      host.appendChild(card);
    });

    const addCard = document.createElement('button');
    addCard.type = 'button';
    addCard.className = 'frame-card add-card';
    addCard.textContent = '＋';
    addCard.title = '在当前帧后插入空白帧';
    addCard.addEventListener('click', () => {
      state.addFrame({ duplicate: false });
      renderAll();
    });
    host.appendChild(addCard);

    const weighted = total > 0;
    $('#timeline-meta').textContent = `${project.frames.length} 帧 · ${weighted ? formatMs(total) : '—'}${weighted ? ' 循环' : ''}`;
    $('#stage-hint').textContent = state.canDraw
      ? '左键绘制 · 右键取色 · 空格播放 · Ctrl/Cmd+Z 撤销'
      : '当前图层不可绘制：请显示并解锁图层，或切换到其他图层';

    const activeCard = host.querySelector('.frame-card.active');
    if (activeCard) activeCard.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function drawFrameThumb(canvasEl, frame) {
    const ictx = canvasEl.getContext('2d');
    ictx.clearRect(0, 0, canvasEl.width, canvasEl.height);
    const data = state.compositeOf(frame);
    ictx.putImageData(new ImageData(new Uint8ClampedArray(data), canvasEl.width, canvasEl.height), 0, 0);
  }

  function uploadDragHandlers(card, frame, index) {
    card.addEventListener('dragstart', (event) => {
      draggingFrameId = frame.id;
      card.classList.add('dragging');
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', frame.id);
      }
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      draggingFrameId = null;
      clearDragMarkers();
    });
    card.addEventListener('dragover', (event) => {
      if (!draggingFrameId) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      const rect = card.getBoundingClientRect();
      const after = event.clientX > rect.left + rect.width / 2;
      clearDragMarkers();
      card.classList.add(after ? 'drag-over-after' : 'drag-over-before');
    });
    card.addEventListener('dragleave', () => {
      card.classList.remove('drag-over-before', 'drag-over-after');
    });
    card.addEventListener('drop', (event) => {
      if (!draggingFrameId) return;
      event.preventDefault();
      const rect = card.getBoundingClientRect();
      const after = event.clientX > rect.left + rect.width / 2;
      let targetIndex = index + (after ? 1 : 0);
      const fromIndex = state.project.frames.findIndex((f) => f.id === draggingFrameId);
      if (fromIndex < targetIndex) targetIndex -= 1;
      targetIndex = clamp(targetIndex, 0, state.project.frames.length - 1);
      clearDragMarkers();
      if (fromIndex !== targetIndex) {
        state.moveFrame(draggingFrameId, targetIndex);
        renderAll();
      }
      draggingFrameId = null;
    });
  }

  function clearDragMarkers() {
    $$('.frame-card').forEach((el) => el.classList.remove('drag-over-before', 'drag-over-after'));
  }

  function renderStatusBar() {
    const total = totalLoopDuration(state.project);
    const bytes = state.history.bytes;
    const mem = bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
    const parts = [
      `${state.project.frames.length} 帧`,
      `${state.project.layers.length} 层`,
      `循环 ${formatMs(total)}`,
      `历史 ${state.history.depth} 步 (${mem})`,
    ];
    $('#status-right').textContent = parts.join(' · ');
  }

  function renderAll() {
    renderProjectMeta();
    renderToolbar();
    renderPalette();
    renderLayers();
    renderFacts();
    renderTimeline();
    renderStatusBar();
    scheduleStageRender();
    schedulePreviewRender();
  }

  /* -------------------------------------------------------------- */
  /* Toast / 状态                                                      */
  /* -------------------------------------------------------------- */

  function showToast(message) {
    const el = $('#toast');
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  function setStatus(message) {
    $('#status-text').textContent = message;
  }

  /* -------------------------------------------------------------- */
  /* 画布指针                                                          */
  /* -------------------------------------------------------------- */

  function pointerPos(event) {
    const project = state.project;
    return pixelFromClient(
      event.clientX,
      event.clientY,
      canvas.getBoundingClientRect(),
      project.width,
      project.height,
    );
  }

  function handlePointerDown(event) {
    if (event.button !== 0) return;
    if (state.clock.playing) state.clock.pause();
    canvas.focus({ preventScroll: true });
    const pos = pointerPos(event);
    if (!pos) return;
    canvas.setPointerCapture?.(event.pointerId);
    event.preventDefault();
    state.pointerDown(pos.x, pos.y);
    hoveringPixel = pos;
    updatePixelInfo(pos);
    afterPixelChange();
  }

  function handlePointerMove(event) {
    const pos = pointerPos(event);
    hoveringPixel = pos;
    if (pos) updatePixelInfo(pos);
    if (!pos) {
      $('#pixel-info').textContent = '—';
      return;
    }
    if (state.stroke) {
      // 指针快速移动跨越多个像素时，状态层用 Bresenham 补齐中间像素。
      state.pointerMove(pos.x, pos.y);
      afterPixelChange();
    } else {
      scheduleStageRender();
    }
  }

  function handlePointerUp(event) {
    if (state.stroke) {
      state.pointerUp();
      afterPixelChange();
    }
    try {
      canvas.releasePointerCapture?.(event.pointerId);
    } catch {
      /* 已释放 */
    }
    renderAll();
  }

  function handlePointerLeave() {
    hoveringPixel = null;
    $('#pixel-info').textContent = '—';
    scheduleStageRender();
  }

  function updatePixelInfo(pos) {
    const frame = state.frame;
    const layer = state.layer;
    let text = `x ${pos.x} · y ${pos.y}`;
    if (frame && layer) {
      const cel = frame.cels[layer.id];
      if (cel) {
        const i = (pos.y * state.project.width + pos.x) * 4;
        const alpha = cel[i + 3];
        if (alpha === 0) {
          text += ' · 透明';
        } else {
          text += ` · ${rgbToHex(cel[i], cel[i + 1], cel[i + 2])}${alpha < 255 ? ` α${alpha}` : ''}`;
        }
      }
    }
    $('#pixel-info').textContent = text;
  }

  function afterPixelChange() {
    scheduleStageRender();
    renderFacts();
    schedulePreviewRender();
    const activeIndex = state.frameIndex;
    const cards = $$('.frame-card[data-frame-id]');
    const card = cards.find((el) => el.dataset.frameId === state.selection.frameId);
    if (card) {
      const thumb = card.querySelector('.frame-thumb');
      if (thumb && state.frame) drawFrameThumb(thumb, state.frame);
    }
    const layerItem = $(`.layer-item[data-layer-id="${state.selection.layerId}"]`);
    if (layerItem && state.layer) {
      const thumb = layerItem.querySelector('.layer-thumb');
      if (thumb) drawLayerThumb(thumb, state.layer);
    }
    const activeItem = $('.layer-item.active .layer-thumb');
    if (activeItem) {
      const layer = getLayer(state.project, state.selection.layerId);
      if (layer) drawLayerThumb(activeItem, layer);
    }
    renderStatusBar();
    renderToolbarHistoryOnly();
    if (activeIndex >= 0) {
      // 保持帧序号显示同步
      $('#fact-frame').textContent = `${activeIndex + 1} / ${state.project.frames.length}`;
    }
  }

  function renderToolbarHistoryOnly() {
    const undo = $('#undo-btn');
    const redo = $('#redo-btn');
    undo.disabled = !state.history.canUndo;
    redo.disabled = !state.history.canRedo;
  }

  /* -------------------------------------------------------------- */
  /* 调色板编辑                                                        */
  /* -------------------------------------------------------------- */

  function openColorDialog(colorId) {
    const entry = state.project.palette.find((c) => c.id === colorId);
    if (!entry) return;
    editingColorId = colorId;
    $('#color-edit-old').style.setProperty('--swatch', entry.hex);
    $('#color-edit-new').style.setProperty('--swatch', entry.hex);
    $('#color-edit-input').value = entry.hex;
    $('#color-edit-hex').value = entry.hex;
    $('#color-edit-replace').checked = false;
    updateColorEditCount(entry.hex);
    const dialog = $('#color-dialog');
    dialog.showModal();
    $('#color-edit-input').focus();
  }

  function updateColorEditCount(hex) {
    const count = state.countColorPixels(hex);
    $('#color-edit-count').textContent =
      count > 0
        ? `画布上（含隐藏图层）共有 ${count} 个像素使用 ${hex}。勾选后会一并替换，可撤销。`
        : `画布上没有像素使用 ${hex}。`;
  }

  function setColorEditHex(hex) {
    const rgb = hexToRgb(hex);
    if (!rgb) return;
    const normalized = rgbToHex(rgb.r, rgb.g, rgb.b).toLowerCase();
    $('#color-edit-input').value = normalized;
    $('#color-edit-hex').value = normalized;
    $('#color-edit-new').style.setProperty('--swatch', normalized);
    const entry = state.project.palette.find((c) => c.id === editingColorId);
    updateColorEditCount(entry?.hex ?? normalized);
  }

  function applyColorEdit() {
    if (!editingColorId) return;
    const next = $('#color-edit-hex').value.trim();
    if (!hexToRgb(next)) {
      showToast('颜色格式应为 #rrggbb');
      return;
    }
    const replace = $('#color-edit-replace').checked;
    const result = state.editPaletteColor(editingColorId, next, { replaceExisting: replace });
    $('#color-dialog').close();
    editingColorId = null;
    renderAll();
    if (result) {
      showToast(
        result.replaced
          ? `已更新颜色并替换 ${result.pixels} 个像素`
          : '已更新调色板颜色',
      );
      setStatus(state.status);
    }
  }

  /* -------------------------------------------------------------- */
  /* 导出                                                              */
  /* -------------------------------------------------------------- */

  function openExportDialog() {
    refreshExportReports();
    const dialog = $('#export-dialog');
    if (!dialog.open) dialog.showModal();
  }

  function activeExportTab() {
    return $('.tab.active[data-export-tab]')?.dataset.exportTab ?? 'gif';
  }

  function setExportTab(tab) {
    $$('.tab[data-export-tab]').forEach((el) => {
      el.classList.toggle('active', el.dataset.exportTab === tab);
    });
    $$('[data-export-pane]').forEach((el) => {
      el.classList.toggle('hidden', el.dataset.exportPane !== tab);
    });
    refreshExportReports();
  }

  function refreshExportReports() {
    const project = state.project;
    const frames = state.composites();
    const total = totalLoopDuration(project);
    const report = gifTimingReport(frames);
    const clipped = report.filter((r) => r.clipped);
    const lines = [
      `尺寸 ${project.width} × ${project.height} · ${frames.length} 帧 · 循环 ${total} ms`,
      `帧时长：${project.frames.map((f) => `${f.duration}ms`).join(' / ')}`,
      `导出帧数：${frames.length}（${project.layers.filter((l) => !l.visible).length} 个隐藏图层已排除）`,
    ];
    if (clipped.length) {
      lines.push(
        `⚠ ${clipped.length} 帧的时长不是 10ms 整数倍：${clipped
          .map((r) => `#${r.index + 1} ${r.requestedMs}→${r.actualMs}ms`)
          .join('，')}`,
      );
    } else {
      lines.push('所有帧时长均为 10ms 整数倍，可精确还原。');
    }
    const gifReportEl = $('#gif-report');
    gifReportEl.textContent = lines.join('\n');
    gifReportEl.classList.toggle('warn', clipped.length > 0);

    const layout = $('#sheet-layout').value;
    const columns =
      layout === 'horizontal'
        ? frames.length
        : clamp(Number($('#sheet-columns').value) || 4, 1, frames.length);
    const gap = clamp(Number($('#sheet-gap').value) || 0, 0, 16);
    try {
      const sheet = buildSpriteSheet({
        width: project.width,
        height: project.height,
        frames,
        columns,
        cellGap: gap,
      });
      $('#sheet-report').textContent = [
        `精灵表 ${sheet.width} × ${sheet.height}（${sheet.columns} 列 × ${sheet.rows} 行）`,
        `单元格 ${project.width} × ${project.height} · 间距 ${gap}px · ${frames.length} 帧`,
        `每帧时长：${project.frames.map((f) => `${f.duration}ms`).join(' / ')}`,
        `隐藏图层已排除；PNG 保留透明背景。`,
      ].join('\n');
      $('#sheet-report').classList.remove('warn');
    } catch (error) {
      $('#sheet-report').textContent = `⚠ ${error.message}`;
      $('#sheet-report').classList.add('warn');
    }
  }

  async function exportGif() {
    const project = state.project;
    const scale = clamp(Number($('#gif-scale').value) || 1, 1, 8);
    const loop = $('#gif-loop').checked;
    try {
      const frames = state.composites().map((frame) => ({
        data: scalePixelsForExport(frame.data, project, scale),
        duration: frame.duration,
      }));
      const gif = encodeGif({
        width: project.width * scale,
        height: project.height * scale,
        frames,
        loop,
      });
      const name = `${slugify(project.name)}-${project.width * scale}x${project.height * scale}.gif`;
      downloadBlob(new Blob([gif], { type: 'image/gif' }), name);
      setStatus(`已导出 ${name}（${project.frames.length} 帧，${formatMs(totalLoopDuration(project))} 循环）`);
      showToast(`已导出 ${name}`);
      $('#export-dialog').close();
    } catch (error) {
      console.error(error);
      showToast(`导出失败：${error.message}`);
    }
  }

  function scalePixelsForExport(data, project, scale) {
    if (scale === 1) return new Uint8ClampedArray(data);
    const outW = project.width * scale;
    const outH = project.height * scale;
    const out = new Uint8ClampedArray(outW * outH * 4);
    for (let y = 0; y < outH; y += 1) {
      const srcY = Math.floor(y / scale);
      for (let x = 0; x < outW; x += 1) {
        const src = (srcY * project.width + Math.floor(x / scale)) * 4;
        const dst = (y * outW + x) * 4;
        out[dst] = data[src];
        out[dst + 1] = data[src + 1];
        out[dst + 2] = data[src + 2];
        out[dst + 3] = data[src + 3];
      }
    }
    return out;
  }

  async function exportSpriteSheet() {
    const project = state.project;
    const layout = $('#sheet-layout').value;
    const frames = state.composites();
    const columns =
      layout === 'horizontal'
        ? frames.length
        : clamp(Number($('#sheet-columns').value) || 4, 1, frames.length);
    const gap = clamp(Number($('#sheet-gap').value) || 0, 0, 16);
    const scale = clamp(Number($('#sheet-scale').value) || 1, 1, 8);
    try {
      let sheet = buildSpriteSheet({
        width: project.width,
        height: project.height,
        frames,
        columns,
        cellGap: gap,
      });
      sheet = scaleSheet(sheet, scale);
      const base = slugify(project.name);
      const pngName = `${base}-sheet-${sheet.width}x${sheet.height}.png`;
      const blob = await rgbaToPngBlob(sheet);
      downloadBlob(blob, pngName);
      const meta = spriteSheetMetadata(project, sheet, {
        name: project.name,
        imageFile: pngName,
      });
      downloadText(
        JSON.stringify(meta, null, 2),
        `${base}-sheet.json`,
        'application/json',
      );
      setStatus(`已导出 ${pngName} 与配套 JSON 元数据`);
      showToast(`已导出精灵表 ${sheet.width}×${sheet.height}`);
      $('#export-dialog').close();
    } catch (error) {
      console.error(error);
      showToast(`导出失败：${error.message}`);
    }
  }

  /* -------------------------------------------------------------- */
  /* 工程读写                                                          */
  /* -------------------------------------------------------------- */

  async function saveProject() {
    state.finishStroke();
    const text = serializeCurrentProject();
    const filename = `${slugify(state.project.name)}.pixanim.json`;
    try {
      const result = await saveProjectWithPicker(text, filename);
      if (result.aborted) return;
      setStatus(`已保存工程：${result.name ?? filename}`);
      showToast(`已保存 ${result.name ?? filename}`);
    } catch (error) {
      console.error(error);
      showToast(`保存失败：${error.message}`);
    }
  }

  function serializeCurrentProject() {
    return serializeProject(state.project);
  }

  async function openProjectFile(file) {
    try {
      const text = await readFileText(file);
      state.loadProjectText(text);
      renderAll();
      setStatus(state.status);
      showToast(`已打开 ${file.name}`);
    } catch (error) {
      console.error(error);
      showToast(`打开失败：${error.message}`);
    }
  }

  /* -------------------------------------------------------------- */
  /* 对话框                                                            */
  /* -------------------------------------------------------------- */

  function closeDialogs() {
    $$('dialog[open]').forEach((dialog) => dialog.close());
  }

  /* -------------------------------------------------------------- */
  /* 事件绑定                                                          */
  /* -------------------------------------------------------------- */

  function bind() {
    // 工具
    $('#tool-grid').addEventListener('click', (event) => {
      const btn = event.target.closest('.tool');
      if (!btn) return;
      state.setTool(btn.dataset.tool);
    });

    $('#brush-size').addEventListener('input', (event) => {
      state.setBrushSize(Number(event.target.value));
    });

    // 颜色
    $('#color-input').addEventListener('input', (event) => {
      state.setColor(event.target.value);
      renderPalette();
      renderBrushPreview();
      scheduleStageRender();
    });
    $('#hex-input').addEventListener('change', (event) => {
      const value = event.target.value.trim();
      if (!hexToRgb(value)) {
        event.target.value = state.color;
        showToast('颜色格式应为 #rrggbb');
        return;
      }
      state.setColor(value);
      renderPalette();
      renderBrushPreview();
      scheduleStageRender();
    });
    $('#hex-input').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') event.target.blur();
    });

    $('#palette').addEventListener('contextmenu', (event) => {
      event.preventDefault();
    });

    // 调色板操作
    $('[data-action="palette-add"]').addEventListener('click', () => {
      state.addPaletteColor(state.color);
      renderAll();
    });
    $('[data-action="palette-remove"]').addEventListener('click', () => {
      if (!state.colorId) {
        showToast('当前颜色不在调色板中');
        return;
      }
      state.removePaletteColor(state.colorId);
      renderAll();
    });
    $('[data-action="palette-edit"]').addEventListener('click', () => {
      if (!state.colorId) {
        showToast('当前颜色不在调色板中');
        return;
      }
      openColorDialog(state.colorId);
    });

    // 画布事件
    canvas.addEventListener('pointerdown', handlePointerDown);
    canvas.addEventListener('pointermove', handlePointerMove);
    canvas.addEventListener('pointerup', handlePointerUp);
    canvas.addEventListener('pointercancel', handlePointerUp);
    canvas.addEventListener('pointerleave', handlePointerLeave);
    canvas.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      const pos = pointerPos(event);
      if (pos) state.pickColor(pos.x, pos.y);
      renderPalette();
      renderBrushPreview();
    });

    // 视图
    $('[data-action="zoom-in"]').addEventListener('click', () => {
      state.setZoom(stageZoom() + (stageZoom() >= 16 ? 4 : 1));
      renderToolbar();
      scheduleStageRender();
    });
    $('[data-action="zoom-out"]').addEventListener('click', () => {
      state.setZoom(stageZoom() - (stageZoom() > 16 ? 4 : 1));
      renderToolbar();
      scheduleStageRender();
    });
    $('[data-action="zoom-fit"]').addEventListener('click', () => {
      state.setAutoFit(true);
      renderToolbar();
      scheduleStageRender();
    });
    $('#toggle-grid').addEventListener('change', () => {
      state.toggleGrid();
      renderToolbar();
      scheduleStageRender();
    });
    $('#toggle-onion').addEventListener('change', () => {
      state.toggleOnion();
      renderToolbar();
      renderFacts();
      scheduleStageRender();
    });
    $('#toggle-diff').addEventListener('change', () => {
      state.toggleDiff();
      renderToolbar();
      renderFacts();
      scheduleStageRender();
    });
    $('#onion-prev').addEventListener('change', (event) => {
      state.setOnionRange('prev', Number(event.target.value));
      scheduleStageRender();
    });
    $('#onion-next').addEventListener('change', (event) => {
      state.setOnionRange('next', Number(event.target.value));
      scheduleStageRender();
    });

    // 历史
    $('[data-action="undo"]').addEventListener('click', () => {
      state.undo();
      renderAll();
    });
    $('[data-action="redo"]').addEventListener('click', () => {
      state.redo();
      renderAll();
    });

    // 帧操作
    $('[data-action="frame-add"]').addEventListener('click', () => {
      state.addFrame({ duplicate: false });
      renderAll();
    });
    $('[data-action="frame-duplicate"]').addEventListener('click', () => {
      state.addFrame({ duplicate: true });
      renderAll();
    });
    $('[data-action="frame-delete"]').addEventListener('click', () => {
      state.deleteFrame();
      renderAll();
    });
    $('[data-action="frame-left"]').addEventListener('click', () => {
      state.nudgeFrameOrder(state.selection.frameId, -1);
      renderAll();
    });
    $('[data-action="frame-right"]').addEventListener('click', () => {
      state.nudgeFrameOrder(state.selection.frameId, 1);
      renderAll();
    });
    $('#frame-duration').addEventListener('change', (event) => {
      const ms = Number(event.target.value);
      if (!Number.isFinite(ms) || ms < LIMITS.minDuration || ms > LIMITS.maxDuration) {
        showToast(`停留时间需在 ${LIMITS.minDuration}–${LIMITS.maxDuration} ms`);
        const frame = state.frame;
        event.target.value = String(frame?.duration ?? 120);
        return;
      }
      state.setDuration(ms);
      renderAll();
    });
    $('[data-action="duration-apply-all"]').addEventListener('click', () => {
      const frame = state.frame;
      if (!frame) return;
      state.applyDurationToAll(frame.duration);
      renderAll();
      showToast(`已把所有帧设为 ${frame.duration} ms`);
    });

    // 图层
    $('[data-action="layer-add"]').addEventListener('click', () => {
      state.addLayer();
      renderAll();
    });
    $('[data-action="layer-delete"]').addEventListener('click', () => {
      state.deleteLayer();
      renderAll();
    });
    $('[data-action="layer-up"]').addEventListener('click', () => {
      const index = state.project.layers.findIndex((l) => l.id === state.selection.layerId);
      state.moveLayer(state.selection.layerId, index + 1);
      renderAll();
    });
    $('[data-action="layer-down"]').addEventListener('click', () => {
      const index = state.project.layers.findIndex((l) => l.id === state.selection.layerId);
      state.moveLayer(state.selection.layerId, index - 1);
      renderAll();
    });

    // 预览
    $('#preview-toggle').addEventListener('click', () => {
      state.clock.toggle();
      updatePreviewButton();
    });
    $('#preview-loop').addEventListener('change', (event) => {
      state.clock.loop = event.target.checked;
    });

    // 顶栏
    $('[data-action="save-project"]').addEventListener('click', saveProject);
    $('[data-action="open-project"]').addEventListener('click', () => $('#file-input').click());
    $('[data-action="open-export"]').addEventListener('click', openExportDialog);
    $('[data-action="load-sample"]').addEventListener('click', () => {
      state.loadSample();
      renderAll();
      showToast('已载入样例：苔灯蘑菇');
    });
    $('[data-action="new-project"]').addEventListener('click', () => {
      $('#new-dialog').showModal();
    });
    $('[data-action="create-project"]').addEventListener('click', () => {
      const width = Number($('#new-width').value);
      const height = Number($('#new-height').value);
      const name = $('#new-name').value.trim() || '未命名工程';
      if (
        !Number.isFinite(width) ||
        !Number.isFinite(height) ||
        width < LIMITS.minSize ||
        width > LIMITS.maxSize ||
        height < LIMITS.minSize ||
        height > LIMITS.maxSize
      ) {
        showToast(`尺寸需在 ${LIMITS.minSize}–${LIMITS.maxSize} 之间`);
        return;
      }
      state.newProject({ width, height, name });
      $('#new-dialog').close();
      renderAll();
      showToast('已新建工程');
    });

    $('#project-name').addEventListener('change', (event) => {
      state.renameProject(event.target.value);
      renderProjectMeta();
    });
    $('#project-name').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') event.target.blur();
    });

    $('#file-input').addEventListener('change', async (event) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (file) await openProjectFile(file);
    });

    // 导出对话框
    $$('.tab[data-export-tab]').forEach((tab) => {
      tab.addEventListener('click', () => setExportTab(tab.dataset.exportTab));
    });
    $('#sheet-layout').addEventListener('change', () => {
      const horizontal = $('#sheet-layout').value === 'horizontal';
      $('#sheet-columns-field').classList.toggle('hidden', horizontal);
      refreshExportReports();
    });
    ['#gif-scale', '#gif-loop', '#sheet-columns', '#sheet-gap', '#sheet-scale'].forEach((sel) => {
      $(sel).addEventListener('input', refreshExportReports);
      $(sel).addEventListener('change', refreshExportReports);
    });
    $('[data-action="export-gif"]').addEventListener('click', exportGif);
    $('[data-action="export-sheet"]').addEventListener('click', exportSpriteSheet);

    // 调色板编辑对话框
    $('#color-edit-input').addEventListener('input', (event) => {
      setColorEditHex(event.target.value);
    });
    $('#color-edit-hex').addEventListener('change', (event) => {
      if (!hexToRgb(event.target.value)) {
        const entry = state.project.palette.find((c) => c.id === editingColorId);
        event.target.value = entry?.hex ?? PRIMARY_COLOR_FALLBACK;
        showToast('颜色格式应为 #rrggbb');
        return;
      }
      setColorEditHex(event.target.value);
    });
    $('[data-action="apply-color-edit"]').addEventListener('click', applyColorEdit);

    // 通用关闭对话框
    $$('[data-close-dialog]').forEach((btn) => {
      btn.addEventListener('click', () => btn.closest('dialog')?.close());
    });

    // 表单里的回车不应直接提交并关闭对话框，而是交给对应按钮处理。
    $$('form[data-prevent-submit]').forEach((form) => {
      form.addEventListener('submit', (event) => event.preventDefault());
    });
    $('#export-dialog').addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      const target = event.target;
      if (!(target instanceof HTMLInputElement)) return;
      event.preventDefault();
      const tab = activeExportTab();
      if (tab === 'gif') exportGif();
      else exportSpriteSheet();
    });
    $('#color-dialog').addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
        event.preventDefault();
        applyColorEdit();
      }
    });
    $('#new-dialog').addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
        event.preventDefault();
        $('[data-action="create-project"]').click();
      }
    });

    $('#color-dialog').addEventListener('close', () => {
      editingColorId = null;
    });

    // 窗口尺寸变化
    window.addEventListener('resize', () => {
      if (state.autoFit) {
        scheduleStageRender();
        renderToolbar();
      }
      schedulePreviewRender();
    });

    // 键盘
    window.addEventListener('keydown', handleKeyDown);

    // 播放时钟
    let last = performance.now();
    const loop = (now) => {
      const delta = now - last;
      last = now;
      if (state.clock.playing) {
        const before = state.clock.currentFrame;
        const result = state.clock.tick(delta);
        if (result.frameChanged || result.looped) {
          schedulePreviewRender();
          renderPreviewProgressOnly(before);
        } else {
          renderPreviewProgressOnly();
        }
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);

    // 状态事件
    state.on((kind, detail) => {
      if (kind === 'status') setStatus(detail.message ?? state.status);
      if (kind === 'playback') {
        updatePreviewButton();
      }
      if (kind === 'restore') {
        scheduleStageRender();
      }
    });

    state.on((kind) => {
      if (kind === 'selection') {
        renderAll();
      } else if (kind === 'tool') {
        renderToolbar();
        renderPalette();
        scheduleStageRender();
      } else if (kind === 'view') {
        renderToolbar();
        renderFacts();
        scheduleStageRender();
      } else if (kind === 'history') {
        renderToolbarHistoryOnly();
        renderStatusBar();
      } else if (kind === 'frame-meta') {
        renderFacts();
        renderTimeline();
        renderStatusBar();
        schedulePreviewRender();
      } else if (kind === 'project') {
        renderAll();
      }
    });

    // 退出前提示（有未保存改动时）
    window.addEventListener('beforeunload', (event) => {
      if (state.history.canUndo) {
        event.preventDefault();
        event.returnValue = '';
      }
    });
  }

  function updatePreviewButton() {
    const btn = $('#preview-toggle');
    const playing = state.clock.playing;
    btn.textContent = playing ? '⏸ 暂停' : '▶ 播放';
    btn.classList.toggle('primary', playing);
  }

  let lastProgressAt = 0;
  function renderPreviewProgressOnly() {
    const now = performance.now();
    if (now - lastProgressAt < 40) return;
    lastProgressAt = now;
    const total = totalDuration(state.project.frames);
    const pct = total > 0 ? clamp((state.clock.timeMs / total) * 100, 0, 100) : 0;
    $('#loop-bar-fill').style.width = `${pct}%`;
    $('#timeline-progress-fill').style.width = `${pct}%`;
  }

  function handleKeyDown(event) {
    const target = event.target;
    const typing =
      target instanceof HTMLElement &&
      (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
    const mod = event.metaKey || event.ctrlKey;

    if (mod && event.key.toLowerCase() === 's') {
      event.preventDefault();
      saveProject();
      return;
    }
    if (mod && event.key.toLowerCase() === 'o') {
      event.preventDefault();
      $('#file-input').click();
      return;
    }
    if (mod && event.key.toLowerCase() === 'e') {
      event.preventDefault();
      openExportDialog();
      return;
    }
    if (typing) return;

    if (mod && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) state.redo();
      else state.undo();
      renderAll();
      return;
    }
    if (mod && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      state.redo();
      renderAll();
      return;
    }
    if (mod && event.key.toLowerCase() === 'd') {
      event.preventDefault();
      state.addFrame({ duplicate: true });
      renderAll();
      return;
    }
    if (event.key === ' ') {
      event.preventDefault();
      state.clock.toggle();
      updatePreviewButton();
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      if ($('dialog[open]')) return;
      event.preventDefault();
      state.deleteFrame();
      renderAll();
      return;
    }
    if (event.key === 'Escape') {
      closeDialogs();
      return;
    }

    switch (event.key.toLowerCase()) {
      case 'b':
        state.setTool('brush');
        break;
      case 'e':
        state.setTool('eraser');
        break;
      case 'g':
        state.setTool('fill');
        break;
      case 'i':
        state.setTool('eyedropper');
        break;
      case '[':
        state.setBrushSize(state.brushSize - 1);
        break;
      case ']':
        state.setBrushSize(state.brushSize + 1);
        break;
      case '+':
      case '=':
        state.setZoom(stageZoom() + 1);
        scheduleStageRender();
        break;
      case '-':
        state.setZoom(stageZoom() - 1);
        scheduleStageRender();
        break;
      case 'o':
        state.toggleOnion();
        renderFacts();
        scheduleStageRender();
        break;
      case 'd':
        state.toggleDiff();
        renderFacts();
        scheduleStageRender();
        break;
      case ',':
        state.selectFrameByIndex((state.frameIndex - 1 + state.project.frames.length) % state.project.frames.length);
        break;
      case '.':
        state.selectFrameByIndex((state.frameIndex + 1) % state.project.frames.length);
        break;
      default:
        if (event.key === 'ArrowLeft') {
          if (event.altKey) {
            state.nudgeFrameOrder(state.selection.frameId, -1);
            renderAll();
          } else {
            state.selectFrameByIndex(Math.max(0, state.frameIndex - 1));
          }
        } else if (event.key === 'ArrowRight') {
          if (event.altKey) {
            state.nudgeFrameOrder(state.selection.frameId, 1);
            renderAll();
          } else {
            state.selectFrameByIndex(Math.min(state.project.frames.length - 1, state.frameIndex + 1));
          }
        } else if (event.key === 'ArrowUp') {
          const index = state.project.layers.findIndex((l) => l.id === state.selection.layerId);
          const next = state.project.layers[Math.min(index + 1, state.project.layers.length - 1)];
          if (next) state.selectLayer(next.id);
        } else if (event.key === 'ArrowDown') {
          const index = state.project.layers.findIndex((l) => l.id === state.selection.layerId);
          const next = state.project.layers[Math.max(index - 1, 0)];
          if (next) state.selectLayer(next.id);
        } else {
          return;
        }
        renderAll();
        return;
    }
    renderToolbar();
    renderBrushPreview();
    scheduleStageRender();
    renderFacts();
  }

  bind();
  renderAll();
  updatePreviewButton();

  // 首次进入时自动适应一次（布局完成后再算）。
  requestAnimationFrame(() => {
    renderAll();
  });

  return { renderAll, openExportDialog };
}
