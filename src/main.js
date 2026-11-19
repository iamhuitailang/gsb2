import {
  DEFAULT_COLORS,
  addAnnotation,
  addImage,
  addLabel,
  activeImage as getActiveImage,
  annotationBounds,
  buildExport,
  createProject,
  deleteAnnotation,
  deleteLabel,
  findImage,
  findLabel,
  imageProgress,
  labelUsage,
  mergeProject,
  moveLabel,
  parseDraft,
  projectProgress,
  removeImage,
  renameLabel,
  serializeDraft,
  setActiveImage,
  setAnnotationFlag,
  setLabelColor,
  updateAnnotationGeometry,
  updateImageSource,
} from './model.js';
import { CanvasEditor } from './canvas.js';
import { createCanvasBuffer } from './paint.js';
import {
  SAMPLE_SCENES,
  buildSampleProject,
  drawScene,
} from './samples.js';
import { rasterizeImageMask } from './raster.js';
import { encodePngAsync } from './png.js';
import { createZip, downloadBlob, downloadJson } from './zip.js';
import {
  clearImageBlobs,
  clearProjectLocal,
  deleteImageBlob,
  getImageBlob,
  loadProjectLocal,
  putImageBlob,
  saveProjectLocal,
} from './storage.js';

/* ---------------- DOM ---------------- */

const $ = (id) => document.getElementById(id);

const els = {
  imageList: $('image-list'),
  labelList: $('label-list'),
  labelEmpty: $('label-empty'),
  labelForm: $('label-form'),
  labelNameInput: $('label-name-input'),
  labelError: $('label-error'),
  annotationList: $('annotation-list'),
  annotationEmpty: $('annotation-empty'),
  annotationCount: $('annotation-count'),
  annotationSubtitle: $('annotation-subtitle'),
  projectProgress: $('project-progress'),
  projectProgressBar: $('project-progress-bar'),
  statusImage: $('status-image'),
  statusCursor: $('status-cursor'),
  statusSelection: $('status-selection'),
  statusMessage: $('status-message'),
  zoomLabel: $('zoom-label'),
  emptyState: $('empty-state'),
  canvas: $('canvas'),
  draftActions: $('draft-actions'),
  draftHint: $('draft-hint'),
  toast: $('toast'),
  labelDeleteDialog: $('label-delete-dialog'),
  deleteLabelMessage: $('delete-label-message'),
  deleteLabelOptions: $('delete-label-options'),
  reassignTarget: $('reassign-target'),
  confirmDialog: $('confirm-dialog'),
  confirmTitle: $('confirm-title'),
  confirmMessage: $('confirm-message'),
  fileImages: $('file-images'),
  fileDraft: $('file-draft'),
};

/* ---------------- state ---------------- */

const state = {
  project: createProject(),
  tool: 'select',
  selectedAnnotationId: null,
  activeLabelId: null,
  editingLabelId: null,
  pendingLabelDeleteId: null,
  busy: false,
};

/** imageId -> drawable（Canvas 或 ImageBitmap） */
const bitmaps = new Map();
/** imageId -> 缩略图 dataURL */
const thumbnails = new Map();
/** 防止异步加载旧图片覆盖新图片 */
const loadTokens = new Map();

let saveTimer = 0;
let toastTimer = 0;
let pendingConfirmResolve = null;

const editor = new CanvasEditor(els.canvas, {
  onSelect: (id) => selectAnnotation(id, { fromCanvas: true }),
  onCreate: handleCreateAnnotation,
  onUpdateGeometry: handleUpdateGeometry,
  onMessage: (message, isError) => toast(message, isError),
  onCursor: handleCursor,
  onViewChange: (view) => {
    els.zoomLabel.textContent = `${Math.round(view.scale * 100)}%`;
  },
  onDraftChange: renderDraftBar,
});

/* ---------------- helpers ---------------- */

function currentImage() {
  return getActiveImage(state.project);
}

function selectedAnnotation() {
  const image = currentImage();
  if (!image) return null;
  return image.annotations.find((item) => item.id === state.selectedAnnotationId) ?? null;
}

function selectedLabel() {
  return findLabel(state.project, state.activeLabelId);
}

function toast(message, isError = false) {
  if (!message) return;
  els.toast.textContent = message;
  els.toast.classList.toggle('is-error', Boolean(isError));
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, isError ? 3600 : 2200);
}

function setStatusMessage(message, isError = false) {
  els.statusMessage.textContent = message ?? '';
  els.statusMessage.classList.toggle('is-error', Boolean(isError));
}

function announce(message, isError = false) {
  setStatusMessage(message, isError);
  toast(message, isError);
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const saved = saveProjectLocal(serializeDraft(state.project));
    if (!saved) toast('自动保存失败：本地存储空间不足', true);
  }, 350);
}

function update(mutator, { save = true } = {}) {
  state.project = mutator(state.project);
  validateSelection();
  renderAll();
  if (save) scheduleSave();
}

function validateSelection() {
  const image = currentImage();
  if (!image) {
    state.selectedAnnotationId = null;
    return;
  }
  if (state.selectedAnnotationId
    && !image.annotations.some((item) => item.id === state.selectedAnnotationId)) {
    state.selectedAnnotationId = null;
  }
  if (state.activeLabelId && !findLabel(state.project, state.activeLabelId)) {
    state.activeLabelId = null;
  }
}

/* ---------------- rendering ---------------- */

function renderAll() {
  renderImages();
  renderLabels();
  renderAnnotations();
  renderCanvas();
  renderStatus();
  renderDraftBar();
}

function renderImages() {
  const progress = projectProgress(state.project);
  els.projectProgress.textContent = `${progress.annotated}/${progress.total} 张已标注 · ${progress.annotations} 个标注`;
  els.projectProgressBar.style.width = progress.total
    ? `${(progress.annotated / progress.total) * 100}%`
    : '0%';
  els.emptyState.hidden = state.project.images.length > 0;
  els.imageList.replaceChildren();
  const active = currentImage();
  for (const image of state.project.images) {
    const info = imageProgress(image);
    const li = document.createElement('li');
    li.className = `image-item${image.id === active?.id ? ' is-active' : ''}`;
    li.dataset.imageId = image.id;
    li.tabIndex = 0;
    li.title = `${image.name} · ${image.width}×${image.height}`;

    const thumb = document.createElement('span');
    thumb.className = 'image-thumb';
    const dataUrl = thumbnails.get(image.id);
    if (dataUrl) thumb.style.backgroundImage = `url("${dataUrl}")`;
    else thumb.style.background = '#0a0c10 center / cover no-repeat';

    const meta = document.createElement('div');
    meta.className = 'image-meta';
    const name = document.createElement('div');
    name.className = 'image-name';
    name.textContent = image.name;
    const sub = document.createElement('div');
    sub.className = 'image-sub';
    const size = document.createElement('span');
    size.textContent = `${image.width}×${image.height}`;
    const badge = document.createElement('span');
    if (info.total === 0) {
      badge.className = 'badge badge-empty';
      badge.textContent = '未标注';
    } else {
      badge.className = 'badge badge-done';
      badge.textContent = `${info.total} 个${info.hidden ? ` · 隐 ${info.hidden}` : ''}`;
    }
    sub.append(size, badge);
    meta.append(name, sub);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'icon-btn image-remove';
    remove.title = '移除该图片（不删除本地文件）';
    remove.textContent = '×';
    remove.addEventListener('click', (event) => {
      event.stopPropagation();
      handleRemoveImage(image.id);
    });

    li.append(thumb, meta, remove);
    li.addEventListener('click', () => {
      if (state.project.activeImageId === image.id) return;
      state.selectedAnnotationId = null;
      update((project) => setActiveImage(project, image.id));
      resetViewAfterImageChange();
    });
    li.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') li.click();
    });
    els.imageList.append(li);
  }
}

function renderLabels() {
  const active = currentImage();
  els.labelList.replaceChildren();
  els.labelEmpty.hidden = state.project.labels.length > 0;

  state.project.labels.forEach((label, index) => {
    const usage = currentImage()
      ? currentImage().annotations.filter((item) => item.labelId === label.id).length
      : 0;
    const totalUsage = labelUsage(state.project, label.id).annotations;
    const li = document.createElement('li');
    li.className = `label-item${label.id === state.activeLabelId ? ' is-active' : ''}`;
    li.dataset.labelId = label.id;
    li.title = `点击设为当前标签；共 ${totalUsage} 个标注`;

    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = label.color;
    swatch.title = '点击更换颜色';
    swatch.addEventListener('click', (event) => {
      event.stopPropagation();
      cycleLabelColor(label.id);
    });

    const main = document.createElement('div');
    main.className = 'label-main';
    const nameRow = document.createElement('div');
    nameRow.className = 'label-name-row';
    const name = document.createElement('span');
    name.className = 'label-name';
    name.textContent = label.name;
    name.title = '双击重命名';
    const indexBadge = document.createElement('span');
    indexBadge.className = 'label-index';
    indexBadge.textContent = `#${index + 1}`;
    nameRow.append(name, indexBadge);
    const count = document.createElement('div');
    count.className = 'label-count';
    count.textContent = active
      ? `本图 ${usage} · 全部 ${totalUsage}`
      : `全部 ${totalUsage}`;
    main.append(nameRow, count);

    if (state.editingLabelId === label.id) {
      const input = document.createElement('input');
      input.className = 'label-rename-input';
      input.value = label.name;
      input.maxLength = 40;
      input.dataset.renameFor = label.id;
      let committed = false;
      const commit = () => {
        if (committed) return;
        committed = true;
        const value = input.value;
        state.editingLabelId = null;
        const result = renameLabel(state.project, label.id, value);
        if (result.error) {
          toast(result.error, true);
          renderLabels();
          return;
        }
        const changed = result.project.labels.find((item) => item.id === label.id)?.name
          !== label.name;
        update(() => result.project);
        if (changed) toast('标签已重命名，所有已有标注同步更新');
      };
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
        } else if (event.key === 'Escape') {
          committed = true; // 取消：不要让随后的 blur 再提交一次
          state.editingLabelId = null;
          renderLabels();
        }
      });
      input.addEventListener('blur', commit);
      main.replaceChildren(input);
      queueMicrotask(() => {
        input.focus();
        input.select();
      });
      // 编辑期间阻止全局快捷键（如 R/P/V）误触发
      input.addEventListener('keydown', (event) => event.stopPropagation());
    } else {
      name.addEventListener('dblclick', (event) => {
        event.stopPropagation();
        state.editingLabelId = label.id;
        renderLabels();
      });
    }

    const actions = document.createElement('div');
    actions.className = 'label-actions';
    const up = iconButton('↑', '上移（导出索引减 1）', () => {
      update((project) => moveLabel(project, label.id, -1));
    });
    up.disabled = index === 0;
    const down = iconButton('↓', '下移（导出索引加 1）', () => {
      update((project) => moveLabel(project, label.id, 1));
    });
    down.disabled = index === state.project.labels.length - 1;
    const rename = iconButton('✎', '重命名', () => {
      state.editingLabelId = label.id;
      renderLabels();
    });
    const del = iconButton('🗑', '删除标签', () => openLabelDelete(label.id));
    actions.append(up, down, rename, del);

    li.append(swatch, main, actions);
    li.addEventListener('click', () => {
      if (state.editingLabelId === label.id) return;
      state.activeLabelId = label.id;
      editor.setActiveLabelId(label.id);
      renderLabels();
      renderStatus();
      setStatusMessage(`当前标签：${label.name}；选择工具后即可绘制`);
    });
    els.labelList.append(li);
  });
}

function iconButton(text, title, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'icon-btn';
  button.title = title;
  button.textContent = text;
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    onClick();
  });
  return button;
}

function renderAnnotations() {
  const image = currentImage();
  const annotations = image?.annotations ?? [];
  const labelById = new Map(state.project.labels.map((label) => [label.id, label]));
  els.annotationCount.textContent = String(annotations.length);
  els.annotationSubtitle.textContent = image
    ? `${image.name} · ${image.width}×${image.height}`
    : '选择一项可在画布中高亮';
  els.annotationEmpty.hidden = annotations.length > 0;
  els.annotationList.replaceChildren();

  annotations.forEach((annotation, index) => {
    const label = labelById.get(annotation.labelId);
    const bounds = annotationBounds(annotation);
    const li = document.createElement('li');
    li.className = [
      'annotation-item',
      annotation.id === state.selectedAnnotationId ? 'is-active' : '',
      annotation.hidden ? 'is-hidden' : '',
      annotation.locked ? 'is-locked' : '',
    ].filter(Boolean).join(' ');
    li.dataset.annotationId = annotation.id;
    li.title = '点击选中并在画布中高亮';

    const shape = document.createElement('span');
    shape.className = 'annotation-shape';
    shape.textContent = annotation.type === 'polygon' ? '⬡' : '▭';

    const main = document.createElement('div');
    main.className = 'annotation-main';
    const nameRow = document.createElement('div');
    nameRow.className = 'annotation-label';
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.cssText += 'display:inline-block;width:8px;height:8px;margin-right:5px;vertical-align:1px;';
    swatch.style.background = label?.color ?? '#8b8d98';
    nameRow.append(swatch, document.createTextNode(`${label?.name ?? '未知标签'} · #${index + 1}`));
    const sub = document.createElement('div');
    sub.className = 'annotation-sub';
    const pointsText = annotation.type === 'polygon' ? ` · ${annotation.points.length} 点` : '';
    sub.textContent = `${Math.round(bounds.x)},${Math.round(bounds.y)} ${Math.round(bounds.width)}×${Math.round(bounds.height)}${pointsText}`;
    main.append(nameRow, sub);

    const actions = document.createElement('div');
    actions.className = 'annotation-actions';
    const hide = iconButton(annotation.hidden ? '◌' : '◉', annotation.hidden ? '显示' : '隐藏（不参与导出）', () => {
      update((project) => setAnnotationFlag(
        project, image.id, annotation.id, 'hidden', !annotation.hidden,
      ));
      toast(annotation.hidden ? '已显示该标注' : '已隐藏该标注（不参与导出）');
    });
    hide.classList.toggle('is-on', annotation.hidden);
    const lock = iconButton(annotation.locked ? '🔒' : '🔓', annotation.locked ? '解锁' : '锁定（禁止编辑，仍然导出）', () => {
      update((project) => setAnnotationFlag(
        project, image.id, annotation.id, 'locked', !annotation.locked,
      ));
      toast(annotation.locked ? '已解锁该标注' : '已锁定该标注');
    });
    lock.classList.toggle('is-on', annotation.locked);
    const del = iconButton('🗑', '删除该标注', () => {
      update((project) => deleteAnnotation(project, image.id, annotation.id));
      if (state.selectedAnnotationId === annotation.id) state.selectedAnnotationId = null;
      renderAll();
      toast('已删除标注');
    });
    actions.append(hide, lock, del);

    li.append(shape, main, actions);
    li.addEventListener('click', () => selectAnnotation(annotation.id));
    els.annotationList.append(li);
  });
  scrollSelectedIntoView();
}

function scrollSelectedIntoView() {
  if (!state.selectedAnnotationId) return;
  const item = els.annotationList.querySelector(
    `[data-annotation-id="${CSS.escape(state.selectedAnnotationId)}"]`,
  );
  item?.scrollIntoView({ block: 'nearest' });
}

function renderCanvas() {
  const image = currentImage();
  editor.setState({
    image,
    annotations: image?.annotations ?? [],
    labels: state.project.labels,
    selectedId: state.selectedAnnotationId,
    imageBitmap: image ? bitmaps.get(image.id) ?? null : null,
    tool: state.tool,
    activeLabelId: state.activeLabelId,
  });
}

function renderStatus() {
  const image = currentImage();
  if (!image) {
    els.statusImage.textContent = '—';
    els.statusSelection.textContent = '未选中';
    return;
  }
  els.statusImage.textContent = `${image.name} · ${image.width} × ${image.height}`;
  const annotation = selectedAnnotation();
  if (!annotation) {
    els.statusSelection.textContent = state.activeLabelId
      ? `当前标签：${selectedLabel()?.name ?? '—'}`
      : '未选中标注';
    return;
  }
  const label = findLabel(state.project, annotation.labelId);
  const bounds = annotationBounds(annotation);
  const extra = [
    annotation.hidden ? '隐藏' : null,
    annotation.locked ? '锁定' : null,
  ].filter(Boolean).join(' · ');
  els.statusSelection.textContent = [
    `选中 #${image.annotations.indexOf(annotation) + 1}`,
    label?.name ?? '未知',
    annotation.type === 'polygon' ? '多边形' : '矩形',
    `${Math.round(bounds.width)}×${Math.round(bounds.height)}`,
    extra || null,
  ].filter(Boolean).join(' · ');
}

function renderDraftBar(draftInfo) {
  const info = draftInfo ?? {
    active: editor.hasDraft(),
    type: editor.draft?.type ?? null,
    pointCount: editor.draft?.type === 'polygon' ? editor.draft.points.length : 0,
  };
  els.draftActions.hidden = !info.active;
  if (!info.active) {
    els.draftHint.textContent = '';
    return;
  }
  if (info.type === 'polygon') {
    els.draftHint.textContent = info.pointCount === 0
      ? '单击添加顶点'
      : `已放置 ${info.pointCount} 个点 · 单击继续，双击/Enter 闭合`;
    $('btn-undo-point').hidden = false;
    $('btn-close-polygon').hidden = false;
    $('btn-undo-point').disabled = info.pointCount === 0;
    $('btn-close-polygon').disabled = info.pointCount < 3;
  } else {
    els.draftHint.textContent = '拖拽绘制矩形，松开鼠标完成';
    $('btn-undo-point').hidden = true;
    $('btn-close-polygon').hidden = true;
  }
}

/* ---------------- selection & tools ---------------- */

function selectAnnotation(id, { fromCanvas = false } = {}) {
  state.selectedAnnotationId = id;
  const annotation = id ? selectedAnnotation() : null;
  if (annotation) {
    // 选中标注时把其标签设为当前标签，右侧标签列表同步高亮
    state.activeLabelId = annotation.labelId;
    editor.setActiveLabelId(annotation.labelId);
  }
  editor.setSelected(id ?? null);
  renderLabels();
  renderAnnotations();
  renderCanvas();
  renderStatus();
  if (annotation) {
    if (!fromCanvas) {
      const image = currentImage();
      const index = image.annotations.findIndex((item) => item.id === id);
      setStatusMessage(`已选中 #${index + 1}；按 Delete 删除，方向键微调，Esc 取消选中`);
    }
  } else {
    setStatusMessage('');
  }
}

function setTool(tool) {
  state.tool = tool;
  editor.setTool(tool);
  for (const button of document.querySelectorAll('[data-tool]')) {
    button.classList.toggle('is-active', button.dataset.tool === tool);
  }
  els.canvas.classList.toggle('is-select', tool === 'select');
  if (tool !== 'select') {
    setStatusMessage(tool === 'polygon'
      ? '多边形：单击逐点绘制，Enter 闭合，Backspace 撤销上一个点'
      : '矩形：按住左键拖拽绘制');
    els.canvas.focus({ preventScroll: true });
  } else {
    setStatusMessage('选择：单击标注选中，拖动移动，拖动顶点/边调整');
  }
}

/* ---------------- annotation actions ---------------- */

function handleCreateAnnotation(shape) {
  const image = currentImage();
  if (!image) return { ok: false, reason: '请先选择图片' };
  const result = addAnnotation(state.project, image.id, shape);
  if (result.error) {
    // 由 CanvasEditor.commitShape 统一提示，避免重复 toast
    return { ok: false, reason: result.error };
  }
  // 先应用项目变更，再设置选中项：update() 里的 validateSelection 会依据当前项目
  // 判断选中是否有效，顺序反了会把刚创建的标注清除掉。
  update(() => result.project);
  state.selectedAnnotationId = result.annotation.id;
  renderAnnotations();
  renderCanvas();
  renderStatus();
  const label = findLabel(state.project, shape.labelId);
  toast(`已添加${shape.type === 'polygon' ? '多边形' : '矩形'}：${label?.name ?? ''}`);
  return { ok: true };
}

function handleUpdateGeometry(annotationId, geometry) {
  const image = currentImage();
  if (!image) return;
  update((project) => updateAnnotationGeometry(project, image.id, annotationId, geometry));
  const annotation = selectedAnnotation();
  if (annotation) {
    const bounds = annotationBounds(annotation);
    setStatusMessage(
      `已调整：${Math.round(bounds.x)}, ${Math.round(bounds.y)} · ${Math.round(bounds.width)}×${Math.round(bounds.height)}`,
    );
  }
}

function handleRemoveImage(imageId) {
  const image = findImage(state.project, imageId);
  if (!image) return;
  confirmDialog({
    title: '移除图片',
    message: `确定从项目中移除 “${image.name}” 及其 ${image.annotations.length} 个标注吗？原始图片文件不会被删除。`,
    confirmText: '移除',
  }).then(async (ok) => {
    if (!ok) return;
    if (image.source?.kind === 'local' && image.source.blobId) {
      deleteImageBlob(image.source.blobId).catch(() => {});
    }
    bitmaps.delete(imageId);
    thumbnails.delete(imageId);
    update((project) => removeImage(project, imageId));
    state.selectedAnnotationId = null;
    resetViewAfterImageChange();
    renderAll();
    toast('已移除图片');
  });
}

function cycleLabelColor(labelId) {
  const label = findLabel(state.project, labelId);
  if (!label) return;
  const index = DEFAULT_COLORS.indexOf(label.color);
  const next = DEFAULT_COLORS[(index + 1) % DEFAULT_COLORS.length];
  update((project) => setLabelColor(project, labelId, next), { save: true });
}

/* ---------------- images ---------------- */

function sceneCanvas(scene) {
  const buffer = drawScene(scene, createCanvasBuffer);
  const canvas = document.createElement('canvas');
  canvas.width = scene.width;
  canvas.height = scene.height;
  const ctx = canvas.getContext('2d');
  const imageData = ctx.createImageData(scene.width, scene.height);
  imageData.data.set(buffer.rgba);
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

function makeThumbnail(source, width, height) {
  const targetW = 92;
  const targetH = 72;
  const scale = Math.min(targetW / width, targetH / height);
  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0a0c10';
  ctx.fillRect(0, 0, targetW, targetH);
  const w = width * scale;
  const h = height * scale;
  ctx.drawImage(source, (targetW - w) / 2, (targetH - h) / 2, w, h);
  return canvas.toDataURL('image/jpeg', 0.72);
}

async function loadImageSource(image) {
  const token = Symbol(image.id);
  loadTokens.set(image.id, token);
  if (image.source?.kind === 'sample') {
    const scene = SAMPLE_SCENES.find((item) => (
      item.id === image.source.sceneId || item.name === image.name
    ));
    if (scene) {
      const canvas = sceneCanvas(scene);
      if (loadTokens.get(image.id) !== token) return;
      bitmaps.set(image.id, canvas);
      thumbnails.set(image.id, makeThumbnail(canvas, scene.width, scene.height));
      renderImages();
      renderCanvas();
      return;
    }
    // 找不到对应示例（例如从导出文件重新打开）：继续按本地图片尝试
  }
  // 依次尝试几种可能的键：草稿记录的 blobId、图片 id、导入时的 blob_<id>
  const candidates = [
    image.source?.blobId,
    image.id,
    `blob_${image.id}`,
  ].filter(Boolean);
  for (const key of candidates) {
    try {
      const blob = await getImageBlob(key);
      if (!blob) continue;
      const bitmap = await createImageBitmap(blob);
      if (loadTokens.get(image.id) !== token) return;
      bitmaps.set(image.id, bitmap);
      thumbnails.set(image.id, makeThumbnail(bitmap, bitmap.width, bitmap.height));
      renderImages();
      renderCanvas();
      return;
    } catch (error) {
      console.warn('加载本地图片失败', key, error);
    }
  }
}

function resetViewAfterImageChange() {
  requestAnimationFrame(() => {
    editor.fit();
  });
}

async function handleImportFiles(files) {
  const list = Array.from(files ?? []).filter((file) => file.type.startsWith('image/'));
  if (list.length === 0) {
    toast('请选择图片文件', true);
    return;
  }
  if (state.busy) return;
  state.busy = true;
  let added = 0;
  let rebound = 0;
  let failed = 0;
  let firstNewImageId = null;
  for (const file of list) {
    try {
      const bitmap = await createImageBitmap(file);
      // IndexedDB 不可用（如隐私模式）时仍允许本次会话标注，只是刷新后需要重新导入
      const storeBlob = async (blobId) => {
        try {
          await putImageBlob(blobId, file);
          return blobId;
        } catch (error) {
          console.warn('图片无法写入本地 IndexedDB，仅保留在内存中', error);
          return null;
        }
      };
      // 同名且尺寸一致：绑定到已有图片并保留标注
      const existing = state.project.images.find((image) => image.name === file.name);
      if (existing && existing.width === bitmap.width && existing.height === bitmap.height) {
        const blobId = await storeBlob(existing.source?.blobId ?? `blob_${existing.id}`);
        bitmaps.set(existing.id, bitmap);
        thumbnails.set(existing.id, makeThumbnail(bitmap, bitmap.width, bitmap.height));
        update((project) => updateImageSource(project, existing.id, {
          kind: 'local', blobId, fileName: file.name, type: file.type,
        }), { save: false });
        rebound += 1;
        continue;
      }
      const id = `img_${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
      const blobId = await storeBlob(`blob_${id}`);
      bitmaps.set(id, bitmap);
      thumbnails.set(id, makeThumbnail(bitmap, bitmap.width, bitmap.height));
      update((project) => addImage(project, {
        id,
        name: file.name,
        width: bitmap.width,
        height: bitmap.height,
        source: { kind: 'local', blobId, fileName: file.name, type: file.type },
      }), { save: false });
      added += 1;
      if (!firstNewImageId) firstNewImageId = id;
    } catch (error) {
      console.warn('导入图片失败', file.name, error);
      failed += 1;
    }
  }
  state.busy = false;
  if (firstNewImageId) {
    update((project) => setActiveImage(project, firstNewImageId), { save: false });
  }
  if (added > 0 || rebound > 0) {
    state.selectedAnnotationId = null;
    resetViewAfterImageChange();
  }
  scheduleSave();
  renderAll();
  const parts = [];
  if (added) parts.push(`新增 ${added} 张`);
  if (rebound) parts.push(`重新绑定 ${rebound} 张同名图片`);
  if (failed) parts.push(`${failed} 张失败`);
  if (parts.length) toast(`已导入：${parts.join('，')}`, failed > 0);
  else toast('导入失败：无法解码所选图片', true);
}

function loadSamples({ quiet = false } = {}) {
  const sampleIds = {
    label: (key) => `lbl_sample_${key}`,
    image: (sceneId) => `img_sample_${sceneId.replace(/^sample-/, '')}`,
    annotation: (sceneId, index) => `ann_sample_${sceneId.replace(/^sample-/, '')}_${index}`,
  };
  const sample = buildSampleProject(sampleIds);
  const wasEmpty = state.project.images.length === 0;
  // 注意：mergeProject 只添加新图片，不会改变已有的 activeImageId
  state.project = mergeProject(state.project, sample).project;
  if (!state.activeLabelId && state.project.labels.length > 0) {
    state.activeLabelId = state.project.labels[0].id;
  }
  validateSelection();
  renderAll();
  scheduleSave();
  for (const image of state.project.images) {
    if (!bitmaps.has(image.id)) loadImageSource(image);
  }
  if (!quiet || wasEmpty) {
    if (wasEmpty && state.project.activeImageId) {
      state.selectedAnnotationId = null;
      resetViewAfterImageChange();
    }
    toast('已载入示例：街景、仓库、航拍各含多边形与重叠矩形');
  }
}

/* ---------------- labels ---------------- */

function handleCreateLabel(event) {
  event.preventDefault();
  const name = els.labelNameInput.value;
  const result = addLabel(state.project, name);
  if (result.error) {
    els.labelError.textContent = result.error;
    els.labelError.hidden = false;
    els.labelNameInput.focus();
    return;
  }
  els.labelError.hidden = true;
  els.labelNameInput.value = '';
  state.activeLabelId = result.label.id;
  update(() => result.project);
  editor.setActiveLabelId(result.label.id);
  renderLabels();
  renderStatus();
  if (state.tool === 'select') setTool('polygon');
  toast(`已新建标签 “${result.label.name}”`);
}

function openLabelDelete(labelId) {
  const label = findLabel(state.project, labelId);
  if (!label) return;
  const usage = labelUsage(state.project, labelId);
  state.pendingLabelDeleteId = labelId;
  const others = state.project.labels.filter((item) => item.id !== labelId);
  if (usage.annotations === 0) {
    els.deleteLabelMessage.textContent = `标签 “${label.name}” 当前没有标注使用，可以直接删除。`;
    els.deleteLabelOptions.hidden = true;
    $('btn-confirm-delete-label').textContent = '删除标签';
  } else {
    const imagePreview = usage.imageNames.slice(0, 4).join('、');
    const more = usage.imageNames.length > 4 ? ' 等' : '';
    els.deleteLabelMessage.textContent = `标签 “${label.name}” 正被 ${usage.images} 张图片中的 ${usage.annotations} 个标注使用（${imagePreview}${more}）。删除前请选择处理方式：`;
    els.deleteLabelOptions.hidden = false;
    const canReassign = others.length > 0;
    els.reassignTarget.replaceChildren();
    for (const item of others) {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = item.name;
      els.reassignTarget.append(option);
    }
    const reassignRadio = els.labelDeleteOptions.querySelector('input[value="reassign"]');
    reassignRadio.disabled = !canReassign;
    if (!canReassign) {
      reassignRadio.checked = false;
      els.labelDeleteOptions.querySelector('input[value="delete"]').checked = true;
    }
    $('btn-confirm-delete-label').textContent = '删除标签';
    $('btn-confirm-delete-label').classList.add('btn-danger');
  }
  els.labelDeleteDialog.returnValue = '';
  els.labelDeleteDialog.showModal();
}

function confirmLabelDelete() {
  const labelId = state.pendingLabelDeleteId;
  state.pendingLabelDeleteId = null;
  if (!labelId) return;
  const mode = els.labelDeleteOptions.hidden
    ? 'delete'
    : els.labelDeleteDialog.querySelector('input[name="delete-mode"]:checked')?.value ?? 'delete';
  const targetLabelId = mode === 'reassign' ? els.reassignTarget.value : null;
  const result = deleteLabel(state.project, labelId, { mode, targetLabelId });
  if (result.error) {
    toast(result.error, true);
    return;
  }
  if (state.activeLabelId === labelId) {
    state.activeLabelId = result.project.labels[0]?.id ?? null;
    editor.setActiveLabelId(state.activeLabelId);
  }
  update(() => result.project);
  renderAll();
  toast(mode === 'reassign' ? '标签已删除，标注已转移到目标标签' : '标签及其标注已删除');
}

/* ---------------- draft / export ---------------- */

function saveDraft() {
  const serialized = serializeDraft(state.project);
  const saved = saveProjectLocal(serialized);
  if (saved) {
    toast('草稿已保存到本机浏览器');
    setStatusMessage(`草稿已保存 · ${new Date(serialized.savedAt).toLocaleTimeString()}`);
  } else {
    toast('保存失败：浏览器本地存储不可用', true);
  }
}

async function openDraftFile(file) {
  try {
    const text = await file.text();
    const raw = JSON.parse(text);
    const incoming = parseDraft(raw);
    if (incoming.images.length === 0 && incoming.labels.length === 0) {
      throw new Error('文件里没有可识别的图片或标签数据');
    }
    const merged = mergeProject(state.project, incoming).project;
    state.project = merged;
    if (!state.activeLabelId && merged.labels.length > 0) {
      state.activeLabelId = merged.labels[0]?.id ?? null;
    }
    state.selectedAnnotationId = null;
    validateSelection();
    renderAll();
    scheduleSave();
    for (const image of merged.images) {
      if (!bitmaps.has(image.id)) loadImageSource(image);
    }
    if (merged.activeImageId) {
      resetViewAfterImageChange();
    }
    announce(`已载入草稿：${merged.images.length} 张图片、${merged.labels.length} 个标签`);
  } catch (error) {
    console.error(error);
    toast(`打开草稿失败：${error.message}`, true);
  }
}

function exportJson() {
  if (state.project.images.length === 0) {
    toast('还没有图片可以导出', true);
    return;
  }
  const payload = buildExport(state.project);
  const stamp = new Date().toISOString().slice(0, 10);
  downloadJson(payload, `annotations-${stamp}.json`);
  announce(`已导出 annotations-${stamp}.json：${payload.annotationCount} 个标注 / ${payload.imageCount} 张图片`);
}

async function exportMasks() {
  if (state.project.images.length === 0) {
    toast('还没有图片可以导出', true);
    return;
  }
  if (state.busy) return;
  state.busy = true;
  setStatusMessage('正在生成掩码…');
  try {
    const files = [];
    const payload = buildExport(state.project);
    files.push({
      name: 'annotations.json',
      data: new TextEncoder().encode(`${JSON.stringify(payload, null, 2)}\n`),
    });
    const labels = state.project.labels;
    for (const [index, image] of state.project.images.entries()) {
      const mask = rasterizeImageMask(image, labels);
      const bytes = await encodePngAsync(
        { width: mask.width, height: mask.height },
        new Uint8Array(mask.data),
        0,
      );
      // 与 annotations.json 中 images[].mask 使用同一份去重后的路径
      files.push({ name: payload.images[index].mask, data: bytes });
    }
    files.push({
      name: 'labels.csv',
      data: new TextEncoder().encode(buildLabelsCsv(labels)),
    });
    files.push({
      name: 'README.txt',
      data: new TextEncoder().encode(buildExportReadme(labels)),
    });
    const zip = createZip(files);
    const stamp = new Date().toISOString().slice(0, 10);
    downloadBlob(zip, `annotation-masks-${stamp}.zip`, 'application/zip');
    const emptyMasks = state.project.images.filter((image) => image.annotations.every((a) => a.hidden));
    announce(
      `已导出 ${state.project.images.length} 张掩码${emptyMasks.length ? `（其中 ${emptyMasks.length} 张仅有隐藏标注，掩码全为背景）` : ''}`,
    );
  } catch (error) {
    console.error(error);
    toast(`导出掩码失败：${error.message}`, true);
  } finally {
    state.busy = false;
  }
}

function buildLabelsCsv(labels) {
  const lines = ['index,name,color'];
  labels.forEach((label, i) => {
    lines.push(`${i + 1},"${label.name.replace(/"/g, '""')}",${label.color}`);
  });
  return `${lines.join('\n')}\n`;
}

function buildExportReadme(labels) {
  return [
    '本地图片标注工具导出包',
    '========================',
    '',
    'annotations.json  — 完整标注与类别映射',
    'masks/<名字>.mask.png — 单通道 8 位灰度掩码，像素值 = 类别索引',
    '  0 = 背景；1..N 对应 annotations.json 中 categories[].index',
    'labels.csv — 类别索引、名称、颜色',
    '',
    '类别映射：',
    '0,背景',
    ...labels.map((label, i) => `${i + 1},${label.name}`),
    '',
    '说明：',
    '- 坐标均为图像像素坐标，原点左上角，x 向右，y 向下；',
    '- 隐藏（hidden=true）的标注不写入 annotations.json，也不绘制到掩码；',
    '- 锁定（locked=true）只限制编辑，仍然正常导出；',
    '- 标注可以重叠，掩码按标注在项目中的先后顺序绘制，后绘制的覆盖先绘制的；',
    '- 所有坐标都已限制在图片范围内。',
    '',
  ].join('\n');
}

function openProjectFileDialog() {
  els.fileDraft.value = '';
  els.fileDraft.click();
}

/* ---------------- dialogs ---------------- */

function confirmDialog({ title, message, confirmText = '确认' }) {
  // 模态框同一时刻只会有一个；若已打开则视为本次请求被取消，
  // 避免 close 事件错配到新的 Promise。
  if (els.confirmDialog.open) return Promise.resolve(false);
  els.confirmTitle.textContent = title;
  els.confirmMessage.textContent = message;
  const confirmButton = els.confirmDialog.querySelector('button[value="confirm"]');
  confirmButton.textContent = confirmText;
  els.confirmDialog.returnValue = '';
  els.confirmDialog.showModal();
  return new Promise((resolve) => {
    pendingConfirmResolve = resolve;
  });
}

function handleClearAll() {
  confirmDialog({
    title: '清空项目',
    message: '将删除当前浏览器中保存的图片、标签与全部标注，且无法撤销。确定继续吗？',
    confirmText: '清空',
  }).then(async (ok) => {
    if (!ok) return;
    bitmaps.clear();
    thumbnails.clear();
    state.project = createProject();
    state.selectedAnnotationId = null;
    state.activeLabelId = null;
    clearProjectLocal();
    try {
      await clearImageBlobs();
    } catch (error) {
      console.warn(error);
    }
    renderAll();
    editor.fit();
    toast('项目已清空');
  });
}

/* ---------------- keyboard ---------------- */

function handleGlobalKeyDown(event) {
  const target = event.target;
  const isText = target && (
    target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'
    || target.tagName === 'SELECT' || target.isContentEditable
  );
  if (isText || els.labelDeleteDialog.open || els.confirmDialog.open) return;

  const modifier = event.metaKey || event.ctrlKey;
  if (modifier && event.key.toLowerCase() === 's') {
    event.preventDefault();
    saveDraft();
    return;
  }
  if (modifier) return;


  const key = event.key;
  if (key === 'v' || key === 'V') { setTool('select'); return; }
  if (key === 'p' || key === 'P') { setTool('polygon'); return; }
  if (key === 'r' || key === 'R') { setTool('rect'); return; }
  if (key === '0') { editor.fit(); return; }
  if (key === '+' || key === '=') { editor.zoomBy(1.2); return; }
  if (key === '-' || key === '_') { editor.zoomBy(1 / 1.2); return; }

  if (key === 'Escape') {
    if (editor.hasDraft()) {
      editor.cancelDraft();
    } else if (state.selectedAnnotationId) {
      selectAnnotation(null);
    }
    return;
  }
  if (editor.hasDraft()) {
    if (key === 'Enter') {
      event.preventDefault();
      const result = editor.closeDraft();
      if (!result.ok && result.reason) toast(result.reason, true);
      return;
    }
    if (key === 'Backspace') {
      event.preventDefault();
      editor.undoDraftPoint();
      return;
    }
  }
  // 只把 Delete 绑定为“删除标注”，避免 Backspace 误删（Backspace 留给撤销顶点）
  if (key === 'Delete' && state.selectedAnnotationId) {
    event.preventDefault();
    const image = currentImage();
    const annotation = selectedAnnotation();
    if (!image || !annotation) return;
    if (annotation.locked) {
      toast('该标注已锁定，无法删除；请先解锁', true);
      return;
    }
    update((project) => deleteAnnotation(project, image.id, annotation.id));
    state.selectedAnnotationId = null;
    renderAll();
    toast('已删除标注');
    return;
  }
  if (state.selectedAnnotationId && key.startsWith('Arrow')) {
    const step = event.shiftKey ? 10 : 1;
    const delta = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    }[key];
    if (delta) {
      event.preventDefault();
      const moved = editor.nudgeSelected(delta[0], delta[1]);
      if (!moved) toast('该标注已锁定，无法移动', true);
    }
  }
}

function handleCursor(bounded) {
  if (!bounded) {
    els.statusCursor.textContent = 'x —, y —';
    return;
  }
  els.statusCursor.textContent = `x ${Math.round(bounded[0])}, y ${Math.round(bounded[1])}`;
}

/* ---------------- wiring ---------------- */

function wireEvents() {
  $('btn-import-images').addEventListener('click', () => els.fileImages.click());
  $('btn-empty-import').addEventListener('click', () => els.fileImages.click());
  $('btn-empty-sample').addEventListener('click', () => loadSamples());
  $('btn-load-sample').addEventListener('click', () => loadSamples());
  els.fileImages.addEventListener('change', (event) => {
    handleImportFiles(event.target.files);
    event.target.value = '';
  });
  $('btn-save-draft').addEventListener('click', saveDraft);
  $('btn-open-draft').addEventListener('click', openProjectFileDialog);
  els.fileDraft.addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    if (file) openDraftFile(file);
    event.target.value = '';
  });
  $('btn-export-json').addEventListener('click', exportJson);
  $('btn-export-masks').addEventListener('click', exportMasks);
  $('btn-clear-all').addEventListener('click', handleClearAll);

  $('btn-fit').addEventListener('click', () => editor.fit());
  $('btn-zoom-fit').addEventListener('click', () => editor.fit());
  $('btn-zoom-in').addEventListener('click', () => editor.zoomBy(1.25));
  $('btn-zoom-out').addEventListener('click', () => editor.zoomBy(1 / 1.25));
  els.zoomLabel.addEventListener('click', () => editor.fit());

  for (const button of document.querySelectorAll('[data-tool]')) {
    button.addEventListener('click', () => setTool(button.dataset.tool));
  }

  els.labelForm.addEventListener('submit', handleCreateLabel);
  els.labelNameInput.addEventListener('input', () => {
    els.labelError.hidden = true;
  });

  $('btn-undo-point').addEventListener('click', () => editor.undoDraftPoint());
  $('btn-close-polygon').addEventListener('click', () => {
    const result = editor.closeDraft();
    if (!result.ok && result.reason) toast(result.reason, true);
  });
  $('btn-cancel-draft').addEventListener('click', () => editor.cancelDraft());

  $('btn-delete-selected').addEventListener('click', () => {
    if (!state.selectedAnnotationId) {
      toast('请先在标注列表中选中一项', true);
      return;
    }
    const image = currentImage();
    const annotation = selectedAnnotation();
    if (!image || !annotation) return;
    if (annotation.locked) {
      toast('该标注已锁定，无法删除', true);
      return;
    }
    update((project) => deleteAnnotation(project, image.id, annotation.id));
    state.selectedAnnotationId = null;
    renderAll();
    toast('已删除标注');
  });

  els.labelDeleteDialog.addEventListener('close', () => {
    if (els.labelDeleteDialog.returnValue === 'confirm') {
      confirmLabelDelete();
    } else {
      state.pendingLabelDeleteId = null;
    }
  });
  els.labelDeleteOptions.addEventListener('change', (event) => {
    if (event.target.name === 'delete-mode') {
      $('btn-confirm-delete-label').classList.toggle('btn-danger', true);
    }
  });

  els.confirmDialog.addEventListener('close', () => {
    const resolve = pendingConfirmResolve;
    pendingConfirmResolve = null;
    resolve?.(els.confirmDialog.returnValue === 'confirm');
  });

  window.addEventListener('keydown', handleGlobalKeyDown);
  window.addEventListener('beforeunload', () => {
    saveProjectLocal(serializeDraft(state.project));
  });
}

/* ---------------- boot ---------------- */

async function boot() {
  wireEvents();
  setTool('select');
  els.zoomLabel.textContent = '100%';

  const local = loadProjectLocal();
  if (local) {
    try {
      const project = parseDraft(local);
      if (project.images.length > 0 || project.labels.length > 0) {
        state.project = project;
        state.activeLabelId = project.labels[0]?.id ?? null;
      }
    } catch (error) {
      console.warn('本地草稿损坏，已忽略', error);
    }
  }

  renderAll();
  if (state.project.images.length === 0) {
    // 首次打开：自动载入示例，便于立即验证
    loadSamples({ quiet: true });
  }
  for (const image of state.project.images) {
    loadImageSource(image);
  }
  requestAnimationFrame(() => editor.fit());

  if (!state.activeLabelId) state.activeLabelId = state.project.labels[0]?.id ?? null;
  editor.setActiveLabelId(state.activeLabelId);
  renderLabels();
  renderStatus();
}

boot();
