/**
 * 工程模型、合成与帧/图层结构操作。
 *
 * 数据结构（运行时）：
 *   project.layers 从底到顶排列
 *   project.frames[i].cels[layerId] = Uint8ClampedArray(w*h*4)
 */
import {
  base64ToBytes,
  bytesToBase64,
  clamp,
  hexToRgb,
  rgbToHex,
  uid,
} from './util.js';
import {
  cloneBuffer,
  createBuffer,
  getPixel,
  replaceRgb,
} from './raster.js';

export const PROJECT_FORMAT = 'pixanim-project';
export const PROJECT_VERSION = 1;

export const LIMITS = {
  minSize: 8,
  maxSize: 256,
  maxFrames: 240,
  maxLayers: 16,
  maxPalette: 64,
  minDuration: 10,
  maxDuration: 60000,
  maxHistory: 80,
};

export const DEFAULT_PALETTE = [
  '#1a1c2c',
  '#5d275d',
  '#b13e53',
  '#ef7d57',
  '#ffcd75',
  '#a7f070',
  '#38b764',
  '#257179',
  '#29366f',
  '#3b5dc9',
  '#41a6f6',
  '#73eff7',
  '#f4f4f4',
  '#94b0c2',
  '#566c86',
  '#333c57',
];

export const DEFAULT_DURATION = 120;

function makePalette(colors = DEFAULT_PALETTE) {
  return colors.map((hex) => ({ id: uid('color'), hex: hex.toLowerCase() }));
}

export function createProject({
  width = 48,
  height = 48,
  name = '未命名工程',
  palette = DEFAULT_PALETTE,
  layerName = '图层 1',
} = {}) {
  const w = clamp(Math.round(width), LIMITS.minSize, LIMITS.maxSize);
  const h = clamp(Math.round(height), LIMITS.minSize, LIMITS.maxSize);
  const layer = {
    id: uid('layer'),
    name: layerName,
    visible: true,
    locked: false,
  };
  const frame = {
    id: uid('frame'),
    duration: DEFAULT_DURATION,
    cels: { [layer.id]: createBuffer(w, h) },
  };
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    name,
    width: w,
    height: h,
    loop: true,
    palette: makePalette(palette),
    layers: [layer],
    frames: [frame],
  };
}

export function frameIndexById(project, frameId) {
  return project.frames.findIndex((f) => f.id === frameId);
}

export function layerIndexById(project, layerId) {
  return project.layers.findIndex((l) => l.id === layerId);
}

export function getFrame(project, frameId) {
  return project.frames.find((f) => f.id === frameId) ?? null;
}

export function getLayer(project, layerId) {
  return project.layers.find((l) => l.id === layerId) ?? null;
}

export function getCel(project, frameId, layerId) {
  const frame = getFrame(project, frameId);
  if (!frame) return null;
  return frame.cels[layerId] ?? null;
}

export function totalLoopDuration(project) {
  return project.frames.reduce((sum, frame) => sum + frame.duration, 0);
}

/* ------------------------------------------------------------------ */
/* 合成                                                                */
/* ------------------------------------------------------------------ */

function sourceOver(dst, src) {
  for (let i = 0; i < dst.length; i += 4) {
    const sa = src[i + 3];
    if (sa === 0) continue;
    const da = dst[i + 3];
    if (sa === 255 || da === 0) {
      dst[i] = src[i];
      dst[i + 1] = src[i + 1];
      dst[i + 2] = src[i + 2];
      dst[i + 3] = sa;
      continue;
    }
    const s = sa / 255;
    const d = (da / 255) * (1 - s);
    const outA = s + d;
    dst[i] = (src[i] * s + dst[i] * d) / outA;
    dst[i + 1] = (src[i + 1] * s + dst[i + 1] * d) / outA;
    dst[i + 2] = (src[i + 2] * s + dst[i + 2] * d) / outA;
    dst[i + 3] = outA * 255;
  }
}

/**
 * 合成一帧。默认跳过隐藏图层 —— 预览与导出共用此逻辑，保证隐藏图层
 * 不会出现在导出的 GIF / 精灵表里。
 */
export function compositeFrame(project, frame, { includeHidden = false } = {}) {
  const out = createBuffer(project.width, project.height);
  if (!frame) return out;
  for (const layer of project.layers) {
    if (!includeHidden && !layer.visible) continue;
    const cel = frame.cels[layer.id];
    if (!cel) continue;
    sourceOver(out, cel);
  }
  return out;
}

export function compositeFrameById(project, frameId, options) {
  return compositeFrame(project, getFrame(project, frameId), options);
}

export function compositeAllFrames(project, options) {
  return project.frames.map((frame) => compositeFrame(project, frame, options));
}

/* ------------------------------------------------------------------ */
/* 帧结构操作（就地修改）                                              */
/* ------------------------------------------------------------------ */

export function insertFrame(project, { afterIndex = null, duplicate = false, duration } = {}) {
  if (project.frames.length >= LIMITS.maxFrames) {
    throw new Error(`帧数已达上限（${LIMITS.maxFrames}）`);
  }
  const at = afterIndex == null ? project.frames.length - 1 : afterIndex;
  const source = project.frames[at] ?? project.frames[project.frames.length - 1];
  const frame = {
    id: uid('frame'),
    duration: clamp(
      Math.round(duration ?? source?.duration ?? DEFAULT_DURATION),
      LIMITS.minDuration,
      LIMITS.maxDuration,
    ),
    cels: {},
  };
  for (const layer of project.layers) {
    const sourceCel = duplicate ? source?.cels[layer.id] : null;
    frame.cels[layer.id] = sourceCel
      ? cloneBuffer(sourceCel)
      : createBuffer(project.width, project.height);
  }
  project.frames.splice(at + 1, 0, frame);
  return frame;
}

export function deleteFrame(project, frameId) {
  if (project.frames.length <= 1) {
    throw new Error('工程至少需要保留 1 帧');
  }
  const index = frameIndexById(project, frameId);
  if (index < 0) throw new Error('帧不存在');
  const [removed] = project.frames.splice(index, 1);
  return { removed, index };
}

export function moveFrame(project, frameId, targetIndex) {
  const from = frameIndexById(project, frameId);
  if (from < 0) throw new Error('帧不存在');
  const to = clamp(Math.round(targetIndex), 0, project.frames.length - 1);
  if (from === to) return from;
  const [frame] = project.frames.splice(from, 1);
  project.frames.splice(to, 0, frame);
  return to;
}

export function setFrameDuration(project, frameId, duration) {
  const frame = getFrame(project, frameId);
  if (!frame) throw new Error('帧不存在');
  frame.duration = clamp(
    Math.round(duration),
    LIMITS.minDuration,
    LIMITS.maxDuration,
  );
  return frame.duration;
}

/* ------------------------------------------------------------------ */
/* 图层结构操作                                                        */
/* ------------------------------------------------------------------ */

export function addLayer(project, { name, aboveLayerId = null } = {}) {
  if (project.layers.length >= LIMITS.maxLayers) {
    throw new Error(`图层数已达上限（${LIMITS.maxLayers}）`);
  }
  const base = aboveLayerId ? layerIndexById(project, aboveLayerId) : -1;
  const index = base >= 0 ? base + 1 : project.layers.length;
  const layer = {
    id: uid('layer'),
    name: name || `图层 ${project.layers.length + 1}`,
    visible: true,
    locked: false,
  };
  project.layers.splice(index, 0, layer);
  for (const frame of project.frames) {
    frame.cels[layer.id] = createBuffer(project.width, project.height);
  }
  return layer;
}

export function deleteLayer(project, layerId) {
  if (project.layers.length <= 1) {
    throw new Error('工程至少需要保留 1 个图层');
  }
  const index = layerIndexById(project, layerId);
  if (index < 0) throw new Error('图层不存在');
  project.layers.splice(index, 1);
  for (const frame of project.frames) {
    delete frame.cels[layerId];
  }
  return index;
}

export function moveLayer(project, layerId, targetIndex) {
  const from = layerIndexById(project, layerId);
  if (from < 0) throw new Error('图层不存在');
  const to = clamp(Math.round(targetIndex), 0, project.layers.length - 1);
  if (from === to) return from;
  const [layer] = project.layers.splice(from, 1);
  project.layers.splice(to, 0, layer);
  return to;
}

export function renameLayer(project, layerId, name) {
  const layer = getLayer(project, layerId);
  if (!layer) throw new Error('图层不存在');
  const clean = String(name || '').trim().slice(0, 40);
  layer.name = clean || layer.name;
  return layer;
}

/* ------------------------------------------------------------------ */
/* 调色板                                                              */
/* ------------------------------------------------------------------ */

export function paletteColor(project, colorId) {
  return project.palette.find((c) => c.id === colorId) ?? null;
}

export function addPaletteColor(project, hex) {
  if (project.palette.length >= LIMITS.maxPalette) {
    throw new Error(`调色板最多 ${LIMITS.maxPalette} 色`);
  }
  const rgb = hexToRgb(hex);
  if (!rgb) throw new Error('无效颜色');
  const entry = { id: uid('color'), hex: rgbToHex(rgb.r, rgb.g, rgb.b) };
  project.palette.push(entry);
  return entry;
}

export function removePaletteColor(project, colorId) {
  if (project.palette.length <= 1) throw new Error('调色板至少保留 1 色');
  const index = project.palette.findIndex((c) => c.id === colorId);
  if (index < 0) throw new Error('颜色不存在');
  const [removed] = project.palette.splice(index, 1);
  return removed;
}

/**
 * 在所有帧、所有图层（含隐藏图层）中把 oldHex 精确替换为 newHex。
 * 先克隆再替换，保证历史快照里共享的旧缓冲区不被就地改写。
 */
export function replaceColorInProject(project, oldHex, newHex) {
  const oldRgb = hexToRgb(oldHex);
  const newRgb = hexToRgb(newHex);
  if (!oldRgb || !newRgb) throw new Error('无效颜色');
  const a = [oldRgb.r, oldRgb.g, oldRgb.b];
  const b = [newRgb.r, newRgb.g, newRgb.b];
  let pixels = 0;
  for (const frame of project.frames) {
    for (const layer of project.layers) {
      const cel = frame.cels[layer.id];
      if (!cel) continue;
      const copy = cloneBuffer(cel);
      const count = replaceRgb(copy, a, b);
      if (count > 0) {
        frame.cels[layer.id] = copy;
        pixels += count;
      }
    }
  }
  return pixels;
}

/* ------------------------------------------------------------------ */
/* 差异分析                                                            */
/* ------------------------------------------------------------------ */

const DIFF_ADDED = [70, 240, 122, 230];
const DIFF_REMOVED = [255, 77, 157, 230];
const DIFF_CHANGED = [255, 209, 102, 230];

/**
 * 对比两帧合成结果，产出可叠加的差异图：
 *   绿 = 当前帧新增，品红 = 当前帧移除，黄 = 同位置颜色改变
 */
export function diffBuffers(prev, curr) {
  const overlay = new Uint8ClampedArray(curr.length);
  let added = 0;
  let removed = 0;
  let changed = 0;
  for (let i = 0; i < curr.length; i += 4) {
    const prevOn = prev[i + 3] > 0;
    const currOn = curr[i + 3] > 0;
    if (!prevOn && !currOn) continue;
    const same =
      prevOn === currOn &&
      prev[i] === curr[i] &&
      prev[i + 1] === curr[i + 1] &&
      prev[i + 2] === curr[i + 2] &&
      prev[i + 3] === curr[i + 3];
    if (same) continue;
    let color;
    if (!prevOn && currOn) {
      added += 1;
      color = DIFF_ADDED;
    } else if (prevOn && !currOn) {
      removed += 1;
      color = DIFF_REMOVED;
    } else {
      changed += 1;
      color = DIFF_CHANGED;
    }
    overlay[i] = color[0];
    overlay[i + 1] = color[1];
    overlay[i + 2] = color[2];
    overlay[i + 3] = color[3];
  }
  return { overlay, added, removed, changed, total: added + removed + changed };
}

/* ------------------------------------------------------------------ */
/* 快照 / 序列化                                                       */
/* ------------------------------------------------------------------ */

/**
 * 像素缓冲区约定为“不可变”：任何绘制都先克隆、再整体替换 cel，
 * 历史快照因此可以共享底层缓冲区，只花结构元数据的内存。
 */
function shareCels(cels) {
  return { ...cels };
}

export function snapshotProject(project) {
  return {
    format: project.format,
    version: project.version,
    name: project.name,
    width: project.width,
    height: project.height,
    loop: project.loop,
    palette: project.palette.map((c) => ({ ...c })),
    layers: project.layers.map((l) => ({ ...l })),
    frames: project.frames.map((f) => ({
      id: f.id,
      duration: f.duration,
      cels: shareCels(f.cels),
    })),
  };
}

/** 就地恢复快照，保持 project 对象引用不变。 */
export function restoreProject(project, snapshot) {
  project.format = snapshot.format;
  project.version = snapshot.version;
  project.name = snapshot.name;
  project.width = snapshot.width;
  project.height = snapshot.height;
  project.loop = snapshot.loop;
  project.palette = snapshot.palette.map((c) => ({ ...c }));
  project.layers = snapshot.layers.map((l) => ({ ...l }));
  project.frames = snapshot.frames.map((f) => ({
    id: f.id,
    duration: f.duration,
    cels: shareCels(f.cels),
  }));
  return project;
}

/** 用一个新缓冲区替换某个 cel；绘制流程唯一允许的写入方式。 */
export function commitCel(project, frameId, layerId, buffer) {
  const frame = getFrame(project, frameId);
  if (!frame) throw new Error('帧不存在');
  if (!getLayer(project, layerId)) throw new Error('图层不存在');
  const expected = project.width * project.height * 4;
  if (!buffer || buffer.length !== expected) {
    throw new Error(`像素缓冲区长度应为 ${expected}`);
  }
  frame.cels[layerId] = buffer;
  return buffer;
}

/** 用于替换整帧所有图层的 cel（导入、尺寸变更等）。 */
export function commitFrameCels(project, frameId, cels) {
  const frame = getFrame(project, frameId);
  if (!frame) throw new Error('帧不存在');
  frame.cels = { ...cels };
  return frame;
}

/** 粗略估算快照独占的像素内存：只统计 after 中已不存在的 cel。 */
export function estimateSnapshotCost(before, after) {
  const afterCels = new Set();
  for (const frame of after.frames) {
    for (const layerId of Object.keys(frame.cels)) {
      afterCels.add(frame.cels[layerId]);
    }
  }
  let bytes = 0;
  for (const frame of before.frames) {
    for (const cel of Object.values(frame.cels)) {
      if (!afterCels.has(cel)) bytes += cel.byteLength;
    }
  }
  return bytes + 512;
}

export function projectToDocument(project) {
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    name: project.name,
    width: project.width,
    height: project.height,
    loop: Boolean(project.loop),
    palette: project.palette.map((c) => ({ id: c.id, hex: c.hex })),
    layers: project.layers.map((l) => ({
      id: l.id,
      name: l.name,
      visible: Boolean(l.visible),
      locked: Boolean(l.locked),
    })),
    frames: project.frames.map((f) => ({
      id: f.id,
      duration: f.duration,
      cels: Object.fromEntries(
        project.layers.map((l) => [
          l.id,
          bytesToBase64(f.cels[l.id] ?? createBuffer(project.width, project.height)),
        ]),
      ),
    })),
  };
}

export function serializeProject(project) {
  return JSON.stringify(projectToDocument(project), null, 2);
}

function fail(message) {
  throw new Error(`工程文件无效：${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 80;
}

export function projectFromDocument(doc) {
  assert(isPlainObject(doc), '顶层必须是对象');
  assert(doc.format === PROJECT_FORMAT, `不支持的格式 ${String(doc.format)}`);
  assert(
    Number.isInteger(doc.version) && doc.version >= 1 && doc.version <= PROJECT_VERSION,
    `不支持的版本 ${String(doc.version)}`,
  );
  assert(
    Number.isInteger(doc.width) &&
      doc.width >= LIMITS.minSize &&
      doc.width <= LIMITS.maxSize,
    `宽度需在 ${LIMITS.minSize}-${LIMITS.maxSize} 之间`,
  );
  assert(
    Number.isInteger(doc.height) &&
      doc.height >= LIMITS.minSize &&
      doc.height <= LIMITS.maxSize,
    `高度需在 ${LIMITS.minSize}-${LIMITS.maxSize} 之间`,
  );
  const width = doc.width;
  const height = doc.height;
  const name = typeof doc.name === 'string' && doc.name.trim() ? doc.name.trim().slice(0, 60) : '导入工程';

  assert(Array.isArray(doc.palette) && doc.palette.length >= 1, '调色板为空');
  assert(doc.palette.length <= LIMITS.maxPalette, `调色板最多 ${LIMITS.maxPalette} 色`);
  const palette = doc.palette.map((entry, index) => {
    assert(isPlainObject(entry), `调色板第 ${index + 1} 项不是对象`);
    assert(validId(entry.id), `调色板第 ${index + 1} 项缺少 id`);
    assert(
      typeof entry.hex === 'string' && /^#[0-9a-fA-F]{6}$/.test(entry.hex),
      `调色板第 ${index + 1} 项颜色不合法`,
    );
    return { id: entry.id, hex: entry.hex.toLowerCase() };
  });
  assert(new Set(palette.map((c) => c.id)).size === palette.length, '调色板 id 重复');

  assert(Array.isArray(doc.layers) && doc.layers.length >= 1, '至少需要 1 个图层');
  assert(doc.layers.length <= LIMITS.maxLayers, `图层数最多 ${LIMITS.maxLayers}`);
  const layers = doc.layers.map((entry, index) => {
    assert(isPlainObject(entry), `图层第 ${index + 1} 项不是对象`);
    assert(validId(entry.id), `图层第 ${index + 1} 项缺少 id`);
    return {
      id: entry.id,
      name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim().slice(0, 40) : `图层 ${index + 1}`,
      visible: entry.visible !== false,
      locked: entry.locked === true,
    };
  });
  assert(new Set(layers.map((l) => l.id)).size === layers.length, '图层 id 重复');

  assert(Array.isArray(doc.frames) && doc.frames.length >= 1, '至少需要 1 帧');
  assert(doc.frames.length <= LIMITS.maxFrames, `帧数最多 ${LIMITS.maxFrames}`);
  const frameIds = new Set();
  const frames = doc.frames.map((entry, index) => {
    assert(isPlainObject(entry), `帧第 ${index + 1} 项不是对象`);
    assert(validId(entry.id), `帧第 ${index + 1} 项缺少 id`);
    assert(!frameIds.has(entry.id), `帧 id 重复：${entry.id}`);
    frameIds.add(entry.id);
    const duration = Number(entry.duration);
    assert(
      Number.isFinite(duration) &&
        duration >= LIMITS.minDuration &&
        duration <= LIMITS.maxDuration,
      `帧第 ${index + 1} 的停留时间需在 ${LIMITS.minDuration}-${LIMITS.maxDuration} ms`,
    );
    assert(isPlainObject(entry.cels), `帧第 ${index + 1} 缺少 cels`);
    const cels = {};
    const byteLength = width * height * 4;
    for (const layer of layers) {
      const encoded = entry.cels[layer.id];
      assert(typeof encoded === 'string', `帧第 ${index + 1} 缺少图层 ${layer.name} 的像素数据`);
      let bytes;
      try {
        bytes = base64ToBytes(encoded);
      } catch {
        fail(`帧第 ${index + 1} 的像素数据不是合法 base64`);
      }
      assert(
        bytes.length === byteLength,
        `帧第 ${index + 1} 图层 ${layer.name} 像素长度应为 ${byteLength}，实际 ${bytes.length}`,
      );
      cels[layer.id] = new Uint8ClampedArray(bytes);
    }
    return { id: entry.id, duration: Math.round(duration), cels };
  });

  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    name,
    width,
    height,
    loop: doc.loop !== false,
    palette,
    layers,
    frames,
  };
}

export function deserializeProject(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    fail('不是合法 JSON');
  }
  return projectFromDocument(doc);
}

/* ------------------------------------------------------------------ */
/* 一些只读辅助                                                        */
/* ------------------------------------------------------------------ */

export function frameBounds(project, frame, layerId = null) {
  const composites = layerId
    ? { [layerId]: frame?.cels[layerId] }
    : frame?.cels;
  let minX = project.width;
  let minY = project.height;
  let maxX = -1;
  let maxY = -1;
  for (const [id, cel] of Object.entries(composites || {})) {
    const layer = getLayer(project, id);
    if (!layer || !layer.visible) continue;
    for (let y = 0; y < project.height; y += 1) {
      for (let x = 0; x < project.width; x += 1) {
        if (cel[(y * project.width + x) * 4 + 3] === 0) continue;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

export function pixelAt(project, frameId, layerId, x, y) {
  const cel = getCel(project, frameId, layerId);
  if (!cel) return null;
  return getPixel(cel, project.width, project.height, x, y);
}
