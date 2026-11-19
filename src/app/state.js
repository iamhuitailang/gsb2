/**
 * 应用状态与命令层。
 *
 * 所有会修改工程的入口都集中在这里：先开历史事务，再改动 project，
 * 最后提交。UI 只调用命令、监听事件，不直接写 project。
 */
import {
  LIMITS,
  addLayer as addLayerModel,
  addPaletteColor,
  compositeFrame,
  createProject,
  deleteFrame as deleteFrameModel,
  deleteLayer as deleteLayerModel,
  deserializeProject,
  frameIndexById,
  getCel,
  getFrame,
  getLayer,
  insertFrame as insertFrameModel,
  layerIndexById,
  moveFrame as moveFrameModel,
  moveLayer as moveLayerModel,
  paletteColor,
  projectToDocument,
  removePaletteColor,
  renameLayer as renameLayerModel,
  replaceColorInProject,
  restoreProject,
  setFrameDuration,
  snapshotProject,
  totalLoopDuration,
} from '../core/project.js';
import { History } from '../core/history.js';
import { LoopClock } from '../core/player.js';
import {
  clamp,
  hexToRgb,
  rgbToHex,
  uid,
} from '../core/util.js';
import {
  cloneBuffer,
  createBuffer,
  drawLine,
  floodFill,
  getPixel,
  stamp,
} from '../core/raster.js';
import { createMosslingProject } from '../samples/mossling.js';

const ERASE_COLOR = [0, 0, 0, 0];

function colorForHex(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) throw new Error(`无效颜色：${hex}`);
  return [rgb.r, rgb.g, rgb.b, 255];
}

const TOOL_LABEL = {
  brush: '画笔',
  eraser: '橡皮',
  fill: '填充',
  eyedropper: '取色',
};

export class AppState {
  constructor(project = createProject()) {
    this.project = project;
    this.history = new History(project, { limit: LIMITS.maxHistory });
    this.selection = {
      frameId: project.frames[0]?.id ?? null,
      layerId: project.layers[0]?.id ?? null,
    };
    const firstColor = project.palette[0]?.hex ?? '#1a1c2c';
    this.tool = 'brush';
    this.brushSize = 1;
    this.colorId = project.palette[0]?.id ?? null;
    this.color = firstColor;
    this.zoom = 8;
    this.autoFit = true;
    this.showGrid = false;
    this.onion = { enabled: false, prev: 1, next: 1 };
    this.diff = false;
    this.stroke = null;
    this.frameVersions = new Map();
    this.compositeCache = new Map();
    this.revision = 0;
    this.listeners = new Set();
    this.status = '';
    this.clock = new LoopClock(project.frames);
    this.clock.onChange(() => this.emit('playback'));

    this.history.setCurrentSelection(this.selection);
    this.history.onChange(() => this.emit('history'));
    this.bumpAllFrames();
  }

  /* ---------------------------------------------------------------- */
  /* 事件                                                              */
  /* ---------------------------------------------------------------- */

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(kind, detail = {}) {
    for (const fn of this.listeners) {
      try {
        fn(kind, detail, this);
      } catch (error) {
        console.error('状态监听器出错', error);
      }
    }
  }

  setStatus(message) {
    this.status = message;
    this.emit('status', { message });
  }

  /* ---------------------------------------------------------------- */
  /* 选择与派生状态                                                    */
  /* ---------------------------------------------------------------- */

  get frame() {
    return getFrame(this.project, this.selection.frameId) ?? this.project.frames[0] ?? null;
  }

  get frameIndex() {
    return frameIndexById(this.project, this.selection.frameId);
  }

  get layer() {
    return getLayer(this.project, this.selection.layerId) ?? this.project.layers[0] ?? null;
  }

  get loopDuration() {
    return totalLoopDuration(this.project);
  }

  get canDraw() {
    const layer = this.layer;
    return Boolean(layer && layer.visible && !layer.locked);
  }

  bumpFrame(frameId) {
    this.frameVersions.set(frameId, (this.frameVersions.get(frameId) ?? 0) + 1);
    this.invalidateComposites();
    this.revision += 1;
  }

  bumpAllFrames() {
    for (const frame of this.project.frames) {
      this.frameVersions.set(frame.id, (this.frameVersions.get(frame.id) ?? 0) + 1);
    }
    this.invalidateComposites();
    this.revision += 1;
  }

  frameVersion(frameId) {
    return this.frameVersions.get(frameId) ?? 0;
  }

  /**
   * 合成结果按 {帧版本, 参与合成的图层顺序与可见性} 缓存。
   * 洋葱皮 / 差异 / 预览每次重绘都会请求相邻帧合成，缓存能避免重复计算。
   * 键里带上图层顺序，移动图层后不会命中旧结果。
   */
  compositeCacheKey(frameId, includeHidden) {
    const layers = this.project.layers
      .filter((l) => includeHidden || l.visible)
      .map((l) => l.id)
      .join(',');
    return `${frameId}|${this.frameVersion(frameId)}|${layers}|${includeHidden ? 1 : 0}`;
  }

  compositeOf(frame, { includeHidden = false } = {}) {
    if (!frame) return this.emptyBuffer();
    const key = this.compositeCacheKey(frame.id, includeHidden);
    const cached = this.compositeCache.get(key);
    if (cached) return cached;
    const pixels = compositeFrame(this.project, frame, { includeHidden });
    // 简单上限，防止长时间编辑后无限增长。
    if (this.compositeCache.size > 200) this.compositeCache.clear();
    this.compositeCache.set(key, pixels);
    return pixels;
  }

  invalidateComposites() {
    this.compositeCache.clear();
  }

  /** 前一个帧（循环回绕），用于差异对比与循环接缝检查。 */
  previousFrame() {
    const frames = this.project.frames;
    const index = this.frameIndex;
    if (index < 0 || !frames.length) return null;
    return { frame: frames[(index - 1 + frames.length) % frames.length], index: (index - 1 + frames.length) % frames.length };
  }

  nextFrame() {
    const frames = this.project.frames;
    const index = this.frameIndex;
    if (index < 0 || !frames.length) return null;
    return { frame: frames[(index + 1) % frames.length], index: (index + 1) % frames.length };
  }

  currentComposite() {
    return this.compositeOf(this.frame);
  }

  /* ---------------------------------------------------------------- */
  /* 视图与工具                                                        */
  /* ---------------------------------------------------------------- */

  setTool(tool) {
    if (!TOOL_LABEL[tool]) return;
    this.finishStroke();
    this.tool = tool;
    this.emit('tool', { tool });
  }

  setBrushSize(size) {
    this.brushSize = clamp(Math.round(size), 1, 16);
    this.emit('tool', { brushSize: this.brushSize });
  }

  setZoom(zoom) {
    this.zoom = clamp(Math.round(zoom), 1, 40);
    this.autoFit = false;
    this.emit('view', { zoom: this.zoom });
  }

  setAutoFit(value) {
    this.autoFit = Boolean(value);
    this.emit('view');
  }

  toggleGrid() {
    this.showGrid = !this.showGrid;
    this.emit('view', { showGrid: this.showGrid });
  }

  toggleOnion() {
    this.onion.enabled = !this.onion.enabled;
    if (this.onion.enabled) this.diff = false;
    this.emit('view');
  }

  setOnionRange(part, value) {
    this.onion[part] = clamp(Math.round(value), 0, 3);
    this.emit('view');
  }

  toggleDiff() {
    this.diff = !this.diff;
    if (this.diff) this.onion.enabled = false;
    this.emit('view');
  }

  setColor(hex) {
    const rgb = hexToRgb(hex);
    if (!rgb) return;
    this.color = rgbToHex(rgb.r, rgb.g, rgb.b).toLowerCase();
    const match = this.project.palette.find((c) => c.hex === this.color);
    this.colorId = match ? match.id : null;
    this.emit('tool', { color: this.color, colorId: this.colorId });
  }

  selectPaletteColor(id) {
    const entry = paletteColor(this.project, id);
    if (!entry) return;
    this.colorId = entry.id;
    this.color = entry.hex;
    this.emit('tool', { color: this.color, colorId: this.colorId });
  }

  selectFrame(frameId, { keepSelection = false } = {}) {
    if (!getFrame(this.project, frameId)) return;
    if (!keepSelection) this.finishStroke();
    if (this.selection.frameId === frameId) return;
    this.selection.frameId = frameId;
    this.history.setCurrentSelection(this.selection);
    this.emit('selection', { reason: 'frame' });
  }

  selectFrameByIndex(index) {
    const frame = this.project.frames[index];
    if (frame) this.selectFrame(frame.id);
  }

  selectLayer(layerId) {
    if (!getLayer(this.project, layerId)) return;
    this.finishStroke();
    if (this.selection.layerId === layerId) return;
    this.selection.layerId = layerId;
    this.history.setCurrentSelection(this.selection);
    this.emit('selection', { reason: 'layer' });
  }

  /* ---------------------------------------------------------------- */
  /* 绘制                                                              */
  /* ---------------------------------------------------------------- */

  #beforeEdit(label, key = null) {
    if (this.stroke) this.finishStroke();
    this.history.setCurrentSelection(this.selection);
    this.history.begin(label, this.selection, key);
  }

  #afterEdit(detail = {}) {
    this.history.commit();
    this.emit('history');
    if (detail.frameId) this.bumpFrame(detail.frameId);
    else this.bumpAllFrames();
  }

  #activeCel() {
    return getCel(this.project, this.selection.frameId, this.selection.layerId);
  }

  #strokeColor() {
    if (this.tool === 'eraser') return ERASE_COLOR;
    return colorForHex(this.color);
  }

  pointerDown(x, y) {
    if (!this.project.frames.length) return;
    if (this.tool === 'eyedropper') {
      this.pickColor(x, y);
      return;
    }
    if (!this.canDraw) {
      const layer = this.layer;
      this.setStatus(
        !layer ? '没有可用图层' : layer.locked ? `图层「${layer.name}」已锁定` : `图层「${layer.name}」已隐藏，先显示再绘制`,
      );
      return;
    }
    if (this.tool === 'fill') {
      this.#fillAt(x, y);
      return;
    }
    const cel = this.#activeCel();
    if (!cel) return;
    this.history.setCurrentSelection(this.selection);
    // 一次拖拽只在 pointerDown 开事务、pointerUp 提交，因此整条笔划
    // （含大量 pointermove）天然折叠为一步撤销；两次独立笔划互不合并。
    this.history.begin(TOOL_LABEL[this.tool] ?? '绘制', this.selection);
    this.stroke = {
      frameId: this.selection.frameId,
      layerId: this.selection.layerId,
      tool: this.tool,
      buffer: cloneBuffer(cel),
      lastX: x,
      lastY: y,
      changed: 0,
      label: TOOL_LABEL[this.tool] ?? '绘制',
    };
    this.#applyStrokeTo(x, y, true);
  }

  pointerMove(x, y) {
    if (!this.stroke) return;
    this.#applyStrokeTo(x, y, false);
  }

  pointerUp() {
    this.finishStroke();
  }

  #applyStrokeTo(x, y, first) {
    const stroke = this.stroke;
    if (!stroke) return;
    // 帧/图层在选择改变时已结束笔划；这里再确认一次，防止过期笔划写错帧。
    if (
      stroke.frameId !== this.selection.frameId ||
      stroke.layerId !== this.selection.layerId
    ) {
      this.finishStroke();
      return;
    }
    const color = this.#strokeColor();
    const size = this.brushSize;
    const width = this.project.width;
    const height = this.project.height;
    let changed = 0;
    if (first) {
      changed = stamp(stroke.buffer, width, height, x, y, color, size);
    } else {
      changed = drawLine(stroke.buffer, width, height, stroke.lastX, stroke.lastY, x, y, color, size);
    }
    stroke.lastX = x;
    stroke.lastY = y;
    if (changed > 0) {
      const frame = getFrame(this.project, stroke.frameId);
      if (frame) {
        frame.cels[stroke.layerId] = stroke.buffer;
        stroke.changed += changed;
        this.bumpFrame(stroke.frameId);
      }
    }
    this.emit('pixels', { frameId: stroke.frameId, layerId: stroke.layerId });
  }

  finishStroke() {
    if (!this.stroke) return;
    const stroke = this.stroke;
    this.stroke = null;
    if (stroke.changed === 0) {
      this.history.cancel();
    } else {
      this.history.commit();
    }
    this.emit('history');
    this.emit('pixels', { frameId: stroke.frameId, layerId: stroke.layerId });
  }

  #fillAt(x, y) {
    const cel = this.#activeCel();
    if (!cel) return;
    this.#beforeEdit('填充');
    const working = cloneBuffer(cel);
    const changed = floodFill(
      working,
      this.project.width,
      this.project.height,
      x,
      y,
      this.#strokeColor(),
    );
    if (!changed) {
      this.history.cancel();
      return;
    }
    const frame = getFrame(this.project, this.selection.frameId);
    frame.cels[this.selection.layerId] = working;
    this.#afterEdit({ frameId: frame.id });
    this.emit('pixels', { frameId: frame.id, layerId: this.selection.layerId });
  }

  pickColor(x, y) {
    const cel = this.#activeCel();
    let pixel = cel ? getPixel(cel, this.project.width, this.project.height, x, y) : null;
    if (!pixel || pixel[3] === 0) {
      const composite = this.currentComposite();
      pixel = getPixel(composite, this.project.width, this.project.height, x, y);
    }
    if (!pixel || pixel[3] === 0) {
      this.setStatus('该像素是透明的');
      return;
    }
    const hex = rgbToHex(pixel[0], pixel[1], pixel[2]);
    this.setColor(hex);
    const match = this.project.palette.find((c) => c.hex === hex.toLowerCase());
    this.setStatus(match ? `取色：${hex}（已在调色板中）` : `取色：${hex}`);
  }

  /* ---------------------------------------------------------------- */
  /* 帧操作                                                            */
  /* ---------------------------------------------------------------- */

  addFrame({ duplicate = false } = {}) {
    if (this.project.frames.length >= LIMITS.maxFrames) {
      this.setStatus(`帧数已达上限（${LIMITS.maxFrames}）`);
      return null;
    }
    const label = duplicate ? '复制帧' : '插入帧';
    this.#beforeEdit(label);
    try {
      const index = this.frameIndex;
      const frame = insertFrameModel(this.project, {
        afterIndex: index,
        duplicate,
        duration: this.frame?.duration,
      });
      this.selection.frameId = frame.id;
      this.history.setCurrentSelection(this.selection);
      this.#afterEdit();
      this.clock.setFrames(this.project.frames);
      this.clock.seekToFrame(frameIndexById(this.project, frame.id));
      this.emit('selection', { reason: 'frame' });
      this.setStatus(duplicate ? '已复制当前帧' : '已插入空白帧');
      return frame;
    } catch (error) {
      this.history.cancel();
      this.setStatus(error.message);
      return null;
    }
  }

  deleteFrame(frameId = this.selection.frameId) {
    if (this.project.frames.length <= 1) {
      this.setStatus('工程至少需要保留 1 帧');
      return;
    }
    const index = frameIndexById(this.project, frameId);
    if (index < 0) return;
    const wasSelected = this.selection.frameId === frameId;
    this.#beforeEdit('删除帧');
    try {
      deleteFrameModel(this.project, frameId);
      if (wasSelected) {
        // 只有被删的是当前帧时才移动选择；删除其他帧不应打断当前编辑位置。
        const next = this.project.frames[Math.min(index, this.project.frames.length - 1)];
        this.selection.frameId = next.id;
      }
      this.history.setCurrentSelection(this.selection);
      this.#afterEdit();
      this.clock.setFrames(this.project.frames);
      this.clock.seekToFrame(Math.max(0, frameIndexById(this.project, this.selection.frameId)));
      this.emit('selection', { reason: 'frame' });
      this.setStatus('已删除帧');
    } catch (error) {
      this.history.cancel();
      this.setStatus(error.message);
    }
  }

  moveFrame(frameId, targetIndex) {
    const from = frameIndexById(this.project, frameId);
    if (from < 0 || from === targetIndex) return;
    this.#beforeEdit('调整帧顺序');
    moveFrameModel(this.project, frameId, targetIndex);
    this.history.setCurrentSelection(this.selection);
    this.#afterEdit();
    this.clock.setFrames(this.project.frames);
    this.clock.seekToFrame(frameIndexById(this.project, this.selection.frameId));
    this.setStatus('已调整帧顺序');
  }

  /** step = -1 / +1；循环回绕。 */
  nudgeFrameOrder(frameId, step) {
    const from = frameIndexById(this.project, frameId);
    if (from < 0) return;
    const to = clamp(from + step, 0, this.project.frames.length - 1);
    if (to === from) return;
    this.moveFrame(frameId, to);
  }

  setDuration(ms, frameId = this.selection.frameId) {
    const frame = getFrame(this.project, frameId);
    if (!frame) return;
    this.history.setCurrentSelection(this.selection);
    this.history.begin('修改停留时间', { frameId, layerId: this.selection.layerId }, `duration:${frameId}`);
    const applied = setFrameDuration(this.project, frameId, ms);
    this.history.commit();
    this.clock.setFrames(this.project.frames);
    this.clock.seekToFrame(frameIndexById(this.project, this.selection.frameId));
    this.emit('frame-meta', { frameId });
    this.emit('history');
    return applied;
  }

  applyDurationToAll(ms) {
    this.history.setCurrentSelection(this.selection);
    this.history.begin('统一停留时间', this.selection);
    for (const frame of this.project.frames) {
      setFrameDuration(this.project, frame.id, ms);
    }
    this.history.commit();
    this.clock.setFrames(this.project.frames);
    this.emit('frame-meta', { frameId: null });
    this.emit('history');
  }

  /* ---------------------------------------------------------------- */
  /* 图层操作                                                          */
  /* ---------------------------------------------------------------- */

  addLayer() {
    if (this.project.layers.length >= LIMITS.maxLayers) {
      this.setStatus(`图层数已达上限（${LIMITS.maxLayers}）`);
      return;
    }
    this.#beforeEdit('新增图层');
    try {
      const layer = addLayerModel(this.project, { aboveLayerId: this.selection.layerId });
      this.selection.layerId = layer.id;
      this.history.setCurrentSelection(this.selection);
      this.#afterEdit();
      this.emit('selection', { reason: 'layer' });
      this.setStatus(`已新增图层「${layer.name}」`);
    } catch (error) {
      this.history.cancel();
      this.setStatus(error.message);
    }
  }

  deleteLayer(layerId = this.selection.layerId) {
    if (this.project.layers.length <= 1) {
      this.setStatus('工程至少需要保留 1 个图层');
      return;
    }
    const index = layerIndexById(this.project, layerId);
    if (index < 0) return;
    const wasSelected = this.selection.layerId === layerId;
    this.#beforeEdit('删除图层');
    try {
      deleteLayerModel(this.project, layerId);
      if (wasSelected) {
        // 与删帧一致：只有删掉当前图层时才移动选择。
        const next = this.project.layers[Math.min(index, this.project.layers.length - 1)];
        this.selection.layerId = next.id;
      }
      this.history.setCurrentSelection(this.selection);
      this.#afterEdit();
      this.emit('selection', { reason: 'layer' });
      this.setStatus('已删除图层');
    } catch (error) {
      this.history.cancel();
      this.setStatus(error.message);
    }
  }

  moveLayer(layerId, targetIndex) {
    const from = layerIndexById(this.project, layerId);
    if (from < 0 || from === targetIndex) return;
    this.#beforeEdit('调整图层顺序');
    moveLayerModel(this.project, layerId, targetIndex);
    this.history.setCurrentSelection(this.selection);
    this.#afterEdit();
  }

  toggleLayerVisible(layerId) {
    const layer = getLayer(this.project, layerId);
    if (!layer) return;
    this.#beforeEdit(layer.visible ? '隐藏图层' : '显示图层');
    layer.visible = !layer.visible;
    this.#afterEdit();
    this.setStatus(`图层「${layer.name}」${layer.visible ? '已显示' : '已隐藏'}（导出时不包含隐藏图层）`);
  }

  toggleLayerLocked(layerId) {
    const layer = getLayer(this.project, layerId);
    if (!layer) return;
    this.#beforeEdit(layer.locked ? '解锁图层' : '锁定图层');
    layer.locked = !layer.locked;
    this.#afterEdit();
  }

  renameLayer(layerId, name) {
    const layer = getLayer(this.project, layerId);
    if (!layer) return;
    const clean = String(name ?? '').trim().slice(0, 40);
    if (!clean || clean === layer.name) return;
    this.#beforeEdit('重命名图层');
    renameLayerModel(this.project, layerId, clean);
    this.#afterEdit();
  }

  /* ---------------------------------------------------------------- */
  /* 调色板                                                            */
  /* ---------------------------------------------------------------- */

  addPaletteColor(hex = this.color) {
    try {
      this.#beforeEdit('添加颜色');
      const entry = addPaletteColor(this.project, hex);
      this.colorId = entry.id;
      this.color = entry.hex;
      this.#afterEdit();
      this.emit('tool', { color: this.color, colorId: this.colorId });
      this.setStatus(`已添加颜色 ${entry.hex}`);
      return entry;
    } catch (error) {
      this.history.cancel();
      this.setStatus(error.message);
      return null;
    }
  }

  /**
   * 修改调色板颜色；replaceExisting 为 true 时同步替换所有帧、所有图层
   * （包括隐藏图层）中完全相同的 RGB。
   */
  editPaletteColor(colorId, nextHex, { replaceExisting = false } = {}) {
    const entry = paletteColor(this.project, colorId);
    const rgb = hexToRgb(nextHex);
    if (!entry || !rgb) return null;
    const next = rgbToHex(rgb.r, rgb.g, rgb.b).toLowerCase();
    if (next === entry.hex && !replaceExisting) return null;
    const previousHex = entry.hex;
    this.#beforeEdit('修改调色板颜色');
    let pixels = 0;
    if (replaceExisting && next !== previousHex) {
      pixels = replaceColorInProject(this.project, previousHex, next);
    }
    entry.hex = next;
    this.history.setCurrentSelection(this.selection);
    this.#afterEdit();
    if (this.colorId === colorId || this.color === previousHex) {
      this.colorId = colorId;
      this.color = next;
      this.emit('tool', { color: this.color, colorId: this.colorId });
    }
    this.setStatus(
      replaceExisting
        ? `已把 ${previousHex} 改为 ${next}，并替换 ${pixels} 个像素`
        : `已把 ${previousHex} 改为 ${next}（画布未改动）`,
    );
    return { previousHex, next, pixels, replaced: replaceExisting };
  }

  removePaletteColor(colorId) {
    try {
      this.#beforeEdit('删除颜色');
      removePaletteColor(this.project, colorId);
      if (this.colorId === colorId) {
        const fallback = this.project.palette[0];
        this.colorId = fallback?.id ?? null;
        this.color = fallback?.hex ?? '#000000';
        this.emit('tool', { color: this.color, colorId: this.colorId });
      }
      this.#afterEdit();
      this.setStatus('已从调色板移除颜色（画布像素不变）');
    } catch (error) {
      this.history.cancel();
      this.setStatus(error.message);
    }
  }

  countColorPixels(hex) {
    const rgb = hexToRgb(hex);
    if (!rgb) return 0;
    let count = 0;
    for (const frame of this.project.frames) {
      for (const layer of this.project.layers) {
        const cel = frame.cels[layer.id];
        if (!cel) continue;
        for (let i = 0; i < cel.length; i += 4) {
          if (cel[i + 3] === 0) continue;
          if (cel[i] === rgb.r && cel[i + 1] === rgb.g && cel[i + 2] === rgb.b) count += 1;
        }
      }
    }
    return count;
  }

  /* ---------------------------------------------------------------- */
  /* 工程级操作                                                        */
  /* ---------------------------------------------------------------- */

  #adoptProject(project) {
    this.finishStroke();
    this.project = project;
    this.history.reset(project);
    this.selection = {
      frameId: project.frames[0]?.id ?? null,
      layerId: project.layers[0]?.id ?? null,
    };
    this.history.setCurrentSelection(this.selection);
    this.frameVersions.clear();
    this.compositeCache.clear();
    this.bumpAllFrames();
    this.colorId = project.palette[0]?.id ?? null;
    this.color = project.palette[0]?.hex ?? '#000000';
    this.clock.setFrames(project.frames);
    this.clock.seekToFrame(0);
    this.emit('project');
    this.emit('tool');
    this.emit('selection');
  }

  newProject(options = {}) {
    this.#adoptProject(createProject(options));
    this.setStatus('已新建工程');
  }

  loadSample() {
    this.#adoptProject(createMosslingProject());
    this.setStatus('已载入样例：苔灯蘑菇 · 呼吸循环');
  }

  loadProjectText(text) {
    const project = deserializeProject(text);
    this.#adoptProject(project);
    this.setStatus(`已打开工程「${project.name}」`);
    return project;
  }

  renameProject(name) {
    const clean = String(name ?? '').trim().slice(0, 60);
    if (!clean || clean === this.project.name) return;
    this.history.setCurrentSelection(this.selection);
    this.history.begin('重命名工程', this.selection);
    this.project.name = clean;
    this.history.commit();
    this.emit('project');
  }

  undo() {
    this.stroke = null;
    this.history.setCurrentSelection(this.selection);
    const result = this.history.undo();
    if (!result) {
      this.setStatus('没有可撤销的操作');
      return false;
    }
    this.#afterHistory(result, '撤销', '重做');
    return true;
  }

  redo() {
    this.finishStroke();
    this.history.setCurrentSelection(this.selection);
    const result = this.history.redo();
    if (!result) {
      this.setStatus('没有可重做的操作');
      return false;
    }
    this.#afterHistory(result, '重做', '撤销');
    return true;
  }

  #afterHistory(result, verb, opposite) {
    this.#reconcileSelection(result.selection);
    this.frameVersions.clear();
    this.bumpAllFrames();
    this.clock.setFrames(this.project.frames);
    this.clock.seekToFrame(Math.max(0, this.frameIndex));
    this.emit('restore', { reason: verb });
    this.emit('selection');
    this.emit('history');
    this.setStatus(`${verb}：${result.label ?? '操作'}（可${opposite}）`);
  }

  #reconcileSelection(selection) {
    const frames = this.project.frames;
    const layers = this.project.layers;
    const frameId =
      selection?.frameId && getFrame(this.project, selection.frameId)
        ? selection.frameId
        : frames[0]?.id ?? null;
    const layerId =
      selection?.layerId && getLayer(this.project, selection.layerId)
        ? selection.layerId
        : layers[0]?.id ?? null;
    this.selection = { frameId, layerId };
    this.history.setCurrentSelection(this.selection);
  }

  /** 当前工程快照，供外部只读使用（导出预览）。 */
  snapshot() {
    return snapshotProject(this.project);
  }

  currentDocument() {
    return projectToDocument(this.project);
  }

  bufferFor(layerId, frameId = this.selection.frameId) {
    return getCel(this.project, frameId, layerId);
  }

  /** 空图层帧的占位缓冲（调用方只读）。 */
  emptyBuffer() {
    return createBuffer(this.project.width, this.project.height);
  }

  /** 撤销/重做后保持选中帧在可视区域内时需要的索引。 */
  get frameCount() {
    return this.project.frames.length;
  }

  /** 给外部（导出对话框）直接用的合成结果。 */
  composites() {
    return this.project.frames.map((frame) => ({
      data: this.compositeOf(frame),
      duration: frame.duration,
      id: frame.id,
    }));
  }

  restoreFromSnapshot(snapshot) {
    restoreProject(this.project, snapshot);
  }

  newId(prefix) {
    return uid(prefix);
  }
}
