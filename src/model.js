/**
 * 项目模型：标签、图片、标注及其纯函数式操作。
 * 不依赖 DOM，可单元测试；坐标始终为图像像素坐标。
 */

import {
  MIN_RECT_SIZE,
  normalizePoint,
  normalizeRect,
  pointsBounds,
  rectToPoints,
  roundTo,
} from './geometry.js';

export const DRAFT_FORMAT = 'local-image-annotator/draft';
export const DRAFT_VERSION = 1;
export const EXPORT_FORMAT = 'local-image-annotator/annotations';
export const EXPORT_VERSION = '1.0';

export const DEFAULT_COLORS = [
  '#e5484d',
  '#f5a623',
  '#f2e14c',
  '#46a758',
  '#12a594',
  '#0090ff',
  '#6e56cf',
  '#d6409f',
  '#8d4e2a',
  '#8b8d98',
];

/** 只接受 #rgb / #rrggbb / #rrggbbaa，避免外部草稿注入奇怪的颜色值。 */
export function normalizeColor(color, fallback = DEFAULT_COLORS[0]) {
  const value = String(color ?? '').trim();
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value) ? value : fallback;
}

/** 标签索引从 1 开始，0 固定表示背景。 */
export const BACKGROUND_INDEX = 0;

export function createId(prefix) {
  const random = globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}_${random}`;
}

export function createProject() {
  return {
    version: DRAFT_VERSION,
    labels: [],
    images: [],
    activeImageId: null,
  };
}

export function findLabel(project, labelId) {
  return project.labels.find((label) => label.id === labelId) ?? null;
}

export function findImage(project, imageId) {
  return project.images.find((image) => image.id === imageId) ?? null;
}

export function findAnnotation(project, imageId, annotationId) {
  const image = findImage(project, imageId);
  return image?.annotations.find((annotation) => annotation.id === annotationId) ?? null;
}

export function activeImage(project) {
  return findImage(project, project.activeImageId) ?? project.images[0] ?? null;
}

export function nextLabelColor(project) {
  const used = new Set(project.labels.map((label) => label.color));
  return DEFAULT_COLORS.find((color) => !used.has(color))
    ?? DEFAULT_COLORS[project.labels.length % DEFAULT_COLORS.length];
}

export function validateLabelName(project, name, ignoreLabelId = null) {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) return { ok: false, error: '标签名不能为空' };
  const duplicate = project.labels.some(
    (label) => label.id !== ignoreLabelId && label.name.toLowerCase() === trimmed.toLowerCase(),
  );
  if (duplicate) return { ok: false, error: `标签 “${trimmed}” 已存在` };
  return { ok: true, name: trimmed };
}

/* ---------------- 标签 ---------------- */

export function addLabel(project, name, color = nextLabelColor(project)) {
  const checked = validateLabelName(project, name);
  if (!checked.ok) return { project, error: checked.error, label: null };
  const label = { id: createId('lbl'), name: checked.name, color: normalizeColor(color) };
  return {
    project: { ...project, labels: [...project.labels, label] },
    label,
    error: null,
  };
}

/**
 * 改名只改标签本身；标注通过 labelId 引用，因此所有已有标注（包括其他图片）
 * 自动同步，不会产生悬空名称。
 */
export function renameLabel(project, labelId, name) {
  const label = findLabel(project, labelId);
  if (!label) return { project, error: '标签不存在' };
  const checked = validateLabelName(project, name, labelId);
  if (!checked.ok) return { project, error: checked.error };
  const labels = project.labels.map((item) => (
    item.id === labelId ? { ...item, name: checked.name } : item
  ));
  return { project: { ...project, labels }, error: null };
}

export function setLabelColor(project, labelId, color) {
  const labels = project.labels.map((item) => (
    item.id === labelId ? { ...item, color: normalizeColor(color, item.color) } : item
  ));
  return { ...project, labels };
}

/** 按数组顺序决定导出时的类别索引；direction 为 -1 上移、1 下移。 */
export function moveLabel(project, labelId, direction) {
  const index = project.labels.findIndex((label) => label.id === labelId);
  if (index < 0) return project;
  const target = index + direction;
  if (target < 0 || target >= project.labels.length) return project;
  const labels = [...project.labels];
  [labels[index], labels[target]] = [labels[target], labels[index]];
  return { ...project, labels };
}

/** 删除标签前的影响范围统计。 */
export function labelUsage(project, labelId) {
  let annotations = 0;
  let images = 0;
  const imageNames = [];
  for (const image of project.images) {
    const count = image.annotations.filter((annotation) => annotation.labelId === labelId).length;
    if (count > 0) {
      images += 1;
      annotations += count;
      imageNames.push(image.name);
    }
  }
  return { annotations, images, imageNames };
}

/**
 * 删除标签。
 * mode='delete'：同时删除所有使用该标签的标注；
 * mode='reassign'：把标注转移到 targetLabelId。
 */
export function deleteLabel(project, labelId, { mode = 'delete', targetLabelId = null } = {}) {
  const label = findLabel(project, labelId);
  if (!label) return { project, error: '标签不存在' };
  if (mode === 'reassign') {
    if (!findLabel(project, targetLabelId) || targetLabelId === labelId) {
      return { project, error: '请选择有效的目标标签' };
    }
  }
  const labels = project.labels.filter((item) => item.id !== labelId);
  const images = project.images.map((image) => {
    if (!image.annotations.some((annotation) => annotation.labelId === labelId)) return image;
    let annotations;
    if (mode === 'reassign') {
      annotations = image.annotations.map((annotation) => (
        annotation.labelId === labelId ? { ...annotation, labelId: targetLabelId } : annotation
      ));
    } else {
      annotations = image.annotations.filter((annotation) => annotation.labelId !== labelId);
    }
    return { ...image, annotations };
  });
  return { project: { ...project, labels, images }, error: null };
}

/* ---------------- 图片 ---------------- */

export function addImage(project, {
  id = createId('img'),
  name,
  width,
  height,
  source = { kind: 'local' },
}) {
  if (!name) throw new Error('图片缺少文件名');
  const w = Math.round(Number(width));
  const h = Math.round(Number(height));
  if (!(w > 0 && h > 0)) throw new Error(`图片尺寸无效：${width}×${height}`);
  if (project.images.some((image) => image.id === id)) {
    return project;
  }
  const image = {
    id,
    name,
    width: w,
    height: h,
    source,
    annotations: [],
  };
  return {
    ...project,
    images: [...project.images, image],
    activeImageId: project.activeImageId ?? image.id,
  };
}

export function removeImage(project, imageId) {
  const images = project.images.filter((image) => image.id !== imageId);
  const activeImageId = project.activeImageId === imageId
    ? (images[0]?.id ?? null)
    : project.activeImageId;
  return { ...project, images, activeImageId };
}

export function setActiveImage(project, imageId) {
  if (!findImage(project, imageId)) return project;
  return { ...project, activeImageId: imageId };
}

/**
 * 更新图片来源（用于“重新导入同名图片”把草稿里的占位图片重新绑定到本地文件）。
 * 尺寸不一致时拒绝，避免标注坐标错位。
 */
export function updateImageSource(project, imageId, source, { width, height } = {}) {
  const image = findImage(project, imageId);
  if (!image) return project;
  if (width != null && Math.round(width) !== image.width) return project;
  if (height != null && Math.round(height) !== image.height) return project;
  const images = project.images.map((item) => (
    item.id === imageId ? { ...item, source: { ...source } } : item
  ));
  return { ...project, images };
}

/* ---------------- 标注 ---------------- */

function sanitizePoints(points, width, height) {
  const clean = [];
  for (const point of points ?? []) {
    if (!Array.isArray(point) || point.length < 2) continue;
    const [x, y] = normalizePoint(point, width, height);
    const last = clean[clean.length - 1];
    if (last && Math.abs(last[0] - x) < 0.01 && Math.abs(last[1] - y) < 0.01) continue;
    clean.push([x, y]);
  }
  if (clean.length > 2) {
    const first = clean[0];
    const last = clean[clean.length - 1];
    if (Math.abs(first[0] - last[0]) < 0.01 && Math.abs(first[1] - last[1]) < 0.01) {
      clean.pop();
    }
  }
  return clean;
}

/** 把一条标注规范化为合法数据；非法时返回 null。 */
export function normalizeAnnotation(annotation, image, labelIds) {
  if (!annotation || !labelIds.has(annotation.labelId)) return null;
  const base = {
    id: String(annotation.id || createId('ann')),
    labelId: annotation.labelId,
    hidden: Boolean(annotation.hidden),
    locked: Boolean(annotation.locked),
  };
  if (annotation.type === 'polygon') {
    const points = sanitizePoints(annotation.points, image.width, image.height);
    if (points.length < 3) return null;
    // 退化（共线/零面积）的多边形没有可导出的区域
    if (polygonArea(points) < 0.5) return null;
    return { ...base, type: 'polygon', points };
  }
  if (annotation.type === 'rect') {
    const source = annotation.rect ?? {};
    const rect = normalizeRect(
      [source.x ?? 0, source.y ?? 0],
      [(source.x ?? 0) + (source.width ?? 0), (source.y ?? 0) + (source.height ?? 0)],
      image.width,
      image.height,
    );
    if (rect.width < MIN_RECT_SIZE || rect.height < MIN_RECT_SIZE) return null;
    return { ...base, type: 'rect', rect };
  }
  return null;
}

/**
 * 新增标注。points / rect 会被夹到图像范围内并四舍五入到两位小数。
 * 返回 { project, annotation, error }。
 */
export function addAnnotation(project, imageId, annotation) {
  const image = findImage(project, imageId);
  if (!image) return { project, annotation: null, error: '图片不存在' };
  const labelIds = new Set(project.labels.map((label) => label.id));
  const normalized = normalizeAnnotation(annotation, image, labelIds);
  if (!normalized) {
    return {
      project,
      annotation: null,
      error: annotation?.type === 'polygon' ? '多边形至少需要 3 个不同顶点' : '标注无效或尺寸过小',
    };
  }
  if (image.annotations.some((item) => item.id === normalized.id)) {
    return { project, annotation: null, error: '标注 ID 重复' };
  }
  const images = project.images.map((item) => (
    item.id === imageId ? { ...item, annotations: [...item.annotations, normalized] } : item
  ));
  return { project: { ...project, images }, annotation: normalized, error: null };
}

export function updateAnnotation(project, imageId, annotationId, patch) {
  const image = findImage(project, imageId);
  if (!image) return project;
  const images = project.images.map((item) => {
    if (item.id !== imageId) return item;
    return {
      ...item,
      annotations: item.annotations.map((annotation) => {
        if (annotation.id !== annotationId) return annotation;
        const next = { ...annotation, ...patch };
        if (patch.type && patch.type !== annotation.type) return annotation;
        return next;
      }),
    };
  });
  return { ...project, images };
}

/** 更新几何数据（移动/缩放），会重新夹到图像边界内。 */
export function updateAnnotationGeometry(project, imageId, annotationId, geometry) {
  const image = findImage(project, imageId);
  if (!image) return project;
  const labelIds = new Set(project.labels.map((label) => label.id));
  const images = project.images.map((item) => {
    if (item.id !== imageId) return item;
    return {
      ...item,
      annotations: item.annotations.map((annotation) => {
        if (annotation.id !== annotationId) return annotation;
        const candidate = { ...annotation, ...geometry };
        const normalized = normalizeAnnotation(candidate, image, labelIds);
        if (!normalized) return annotation;
        return { ...normalized, hidden: annotation.hidden, locked: annotation.locked };
      }),
    };
  });
  return { ...project, images };
}

export function deleteAnnotation(project, imageId, annotationId) {
  const images = project.images.map((image) => {
    if (image.id !== imageId) return image;
    return {
      ...image,
      annotations: image.annotations.filter((annotation) => annotation.id !== annotationId),
    };
  });
  return { ...project, images };
}

export function setAnnotationFlag(project, imageId, annotationId, flag, value) {
  return updateAnnotation(project, imageId, annotationId, { [flag]: Boolean(value) });
}

/* ---------------- 统计 ---------------- */

export function imageProgress(image) {
  const total = image.annotations.length;
  const hidden = image.annotations.filter((annotation) => annotation.hidden).length;
  const locked = image.annotations.filter((annotation) => annotation.locked).length;
  return {
    total,
    hidden,
    locked,
    exported: total - hidden,
    annotated: total > 0,
  };
}

export function projectProgress(project) {
  let total = 0;
  let annotated = 0;
  let annotations = 0;
  for (const image of project.images) {
    total += 1;
    annotations += image.annotations.length;
    if (image.annotations.length > 0) annotated += 1;
  }
  return { total, annotated, annotations, remaining: total - annotated };
}

export function annotationBounds(annotation) {
  if (annotation.type === 'polygon') {
    return pointsBounds(annotation.points);
  }
  return {
    x: annotation.rect.x,
    y: annotation.rect.y,
    width: annotation.rect.width,
    height: annotation.rect.height,
  };
}

export function polygonArea(points) {
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area) / 2;
}

export function annotationArea(annotation) {
  if (annotation.type === 'rect') return annotation.rect.width * annotation.rect.height;
  return polygonArea(annotation.points);
}

/* ---------------- 导出 ---------------- */

export function maskFileName(imageName) {
  const base = String(imageName).replace(/\.[^./\\]+$/, '');
  const safe = base.replace(/[^\w一-龥.-]+/g, '_');
  return `${safe}.mask.png`;
}

export function buildExport(project, { exportedAt = new Date().toISOString() } = {}) {
  const categories = project.labels.map((label, index) => ({
    id: label.id,
    name: label.name,
    color: label.color,
    index: index + BACKGROUND_INDEX + 1,
  }));
  const categoryById = new Map(categories.map((category) => [category.id, category]));

  // 同名不同扩展名（如 a.png / a.jpg）的图片会产生相同的掩码文件名，这里统一去重。
  const usedMaskNames = new Set();
  const maskPaths = project.images.map((image) => {
    const base = maskFileName(image.name);
    let candidate = base;
    let suffix = 2;
    while (usedMaskNames.has(candidate.toLowerCase())) {
      candidate = base.replace(/(\.mask\.png)$/, `-${suffix}$1`);
      suffix += 1;
    }
    usedMaskNames.add(candidate.toLowerCase());
    return `masks/${candidate}`;
  });

  const images = project.images.map((image, imageIndex) => {
    const annotations = image.annotations
      .filter((annotation) => !annotation.hidden)
      .filter((annotation) => categoryById.has(annotation.labelId))
      .map((annotation) => {
        const category = categoryById.get(annotation.labelId);
        const bounds = annotationBounds(annotation);
        return {
          id: annotation.id,
          type: annotation.type,
          category: category.name,
          categoryId: category.id,
          categoryIndex: category.index,
          ...(annotation.type === 'polygon'
            ? { points: annotation.points.map(([x, y]) => [roundTo(x), roundTo(y)]) }
            : { rect: { ...annotation.rect }, points: rectToPoints(annotation.rect) }),
          bbox: [
            roundTo(bounds.x),
            roundTo(bounds.y),
            roundTo(bounds.width),
            roundTo(bounds.height),
          ],
          area: roundTo(annotationArea(annotation)),
        };
      });
    return {
      file: image.name,
      imageId: image.id,
      width: image.width,
      height: image.height,
      mask: maskPaths[imageIndex],
      annotationCount: annotations.length,
      annotations,
    };
  });

  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt,
    imageCount: images.length,
    annotationCount: images.reduce((sum, image) => sum + image.annotations.length, 0),
    categories,
    labelMap: Object.fromEntries(
      categories.map((category) => [category.name, category.index]),
    ),
    images,
  };
}

/* ---------------- 草稿序列化 ---------------- */

export function serializeDraft(project) {
  return {
    format: DRAFT_FORMAT,
    version: DRAFT_VERSION,
    savedAt: new Date().toISOString(),
    labels: project.labels.map((label) => ({ ...label })),
    images: project.images.map((image) => ({
      id: image.id,
      name: image.name,
      width: image.width,
      height: image.height,
      source: { ...image.source },
      annotations: image.annotations.map((annotation) => {
        if (annotation.type === 'polygon') {
          return {
            ...annotation,
            points: annotation.points.map(([x, y]) => [roundTo(x), roundTo(y)]),
          };
        }
        const { x, y, width, height } = annotation.rect;
        return {
          ...annotation,
          rect: {
            x: roundTo(x),
            y: roundTo(y),
            width: roundTo(width),
            height: roundTo(height),
          },
        };
      }),
    })),
    activeImageId: project.activeImageId,
  };
}

/**
 * 解析草稿（也接受导出的 annotations.json 中的 categories/images，只要含尺寸）。
 * 会丢弃无效标注、悬空标签引用与超出图像范围的坐标。
 */
export function parseDraft(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('草稿内容不是有效对象');
  const isExport = raw.format === EXPORT_FORMAT;
  const labelSource = Array.isArray(raw.labels)
    ? raw.labels
    : Array.isArray(raw.categories)
      ? raw.categories
      : [];
  const labels = [];
  const seenNames = new Set();
  for (const item of labelSource) {
    const name = String(item?.name ?? '').trim();
    if (!name || seenNames.has(name.toLowerCase())) continue;
    seenNames.add(name.toLowerCase());
    labels.push({
      id: String(item.id || createId('lbl')),
      name,
      color: normalizeColor(item.color, DEFAULT_COLORS[labels.length % DEFAULT_COLORS.length]),
    });
  }
  const labelIds = new Set(labels.map((label) => label.id));

  // 导出的 annotations.json 用 category / categoryId 表示类别，这里建立到 labelId 的映射，
  // 使得“打开草稿”也能直接载入导出文件。
  const categoryToLabel = new Map();
  if (isExport) {
    for (const item of labelSource) {
      const label = labels.find((candidate) => candidate.name === String(item?.name ?? '').trim());
      if (!label) continue;
      if (item.id) categoryToLabel.set(`id:${item.id}`, label.id);
      categoryToLabel.set(`name:${label.name}`, label.id);
    }
  }
  const resolveLabelId = (annotation) => {
    if (labelIds.has(annotation?.labelId)) return annotation.labelId;
    if (annotation?.categoryId && categoryToLabel.has(`id:${annotation.categoryId}`)) {
      return categoryToLabel.get(`id:${annotation.categoryId}`);
    }
    if (annotation?.category && categoryToLabel.has(`name:${annotation.category}`)) {
      return categoryToLabel.get(`name:${annotation.category}`);
    }
    return null;
  };

  const images = [];
  const seenImageIds = new Set();
  for (const item of Array.isArray(raw.images) ? raw.images : []) {
    const width = Math.round(Number(item?.width));
    const height = Math.round(Number(item?.height));
    const name = String(item?.name ?? item?.file ?? '').trim();
    if (!(width > 0 && height > 0) || !name) continue;
    const id = String(item.id || item.imageId || createId('img'));
    if (seenImageIds.has(id)) continue;
    seenImageIds.add(id);
    const image = {
      id,
      name,
      width,
      height,
      source: item.source ?? { kind: 'sample' },
      annotations: [],
    };
    const seenAnnIds = new Set();
    for (const annotation of Array.isArray(item.annotations) ? item.annotations : []) {
      const labelId = resolveLabelId(annotation);
      if (!labelId) continue;
      const normalized = normalizeAnnotation({ ...annotation, labelId }, image, labelIds);
      if (!normalized || seenAnnIds.has(normalized.id)) continue;
      seenAnnIds.add(normalized.id);
      image.annotations.push(normalized);
    }
    images.push(image);
  }

  const activeImageId = images.some((image) => image.id === raw.activeImageId)
    ? raw.activeImageId
    : (images[0]?.id ?? null);

  return { version: DRAFT_VERSION, labels, images, activeImageId };
}

/** 把示例草稿 / 导入的标注合并进当前项目（按图片名去重，重复标注 ID 跳过）。 */
export function mergeProject(project, incoming) {
  let result = project;
  const labelNameToId = new Map(result.labels.map((label) => [label.name.toLowerCase(), label.id]));
  const labelIdMap = new Map();

  for (const label of incoming.labels) {
    const existingId = labelNameToId.get(label.name.toLowerCase());
    if (existingId) {
      labelIdMap.set(label.id, existingId);
      continue;
    }
    const added = addLabel(result, label.name, label.color);
    if (added.label) {
      result = added.project;
      labelNameToId.set(label.name.toLowerCase(), added.label.id);
      labelIdMap.set(label.id, added.label.id);
    }
  }

  for (const image of incoming.images) {
    let imageId = image.id;
    let existing = result.images.find((item) => item.name === image.name);
    if (!existing && result.images.some((item) => item.id === imageId)) {
      imageId = createId('img');
    }
    if (!existing) {
      try {
        result = addImage(result, {
          id: imageId,
          name: image.name,
          width: image.width,
          height: image.height,
          source: image.source ?? { kind: 'sample' },
        });
      } catch {
        continue;
      }
      existing = result.images.find((item) => item.id === imageId);
    }
    if (!existing) continue;

    const existingAnnIds = new Set(existing.annotations.map((annotation) => annotation.id));
    const additions = image.annotations
      .filter((annotation) => labelIdMap.has(annotation.labelId))
      .filter((annotation) => !existingAnnIds.has(annotation.id))
      .map((annotation) => ({
        ...annotation,
        labelId: labelIdMap.get(annotation.labelId),
      }));
    if (additions.length > 0) {
      result = {
        ...result,
        images: result.images.map((item) => (
          item.id === existing.id
            ? { ...item, annotations: [...item.annotations, ...additions] }
            : item
        )),
      };
    }
  }

  if (incoming.activeImageId) {
    const incomingActive = incoming.images.find((image) => image.id === incoming.activeImageId);
    const matched = incomingActive
      ? result.images.find((image) => image.name === incomingActive.name)
      : null;
    if (matched) result = { ...result, activeImageId: matched.id };
  }

  return { project: result };
}

