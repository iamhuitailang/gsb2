/**
 * 工程模型：材质、来源图片、输出贴图、通道映射的创建与（反）序列化。
 * 不含 DOM，可单测。
 */

import {
  APP_SCHEMA,
  APP_VERSION,
  CHANNEL_IDS,
  FIT_MODE_BY_ID,
  LIMITS,
  OUTPUT_TYPES,
  ROLES,
  getOutputType,
  getSampleMode,
  isSourceRole,
} from "./constants.js";

const ROLE_IDS_FOR_DETECTION = ROLES.filter((r) => r.aliases.length > 0);

/** fitMode 额外允许 "inherit"（跟随材质）。 */
export function normalizeFitMode(value, fallback = "inherit") {
  if (value === "inherit") return "inherit";
  return FIT_MODE_BY_ID[value] ? value : fallback;
}

let sequence = 0;

export function uid(prefix = "id") {
  sequence = (sequence + 1) % 1e6;
  return `${prefix}_${Date.now().toString(36)}_${sequence.toString(36)}`;
}

export function emptyChannel(sourceKind = "constant", role = null, constant = 255) {
  return {
    source: sourceKind === "role" && isSourceRole(role) ? { kind: "role", role } : { kind: "constant" },
    sample: "luminance",
    invert: false,
    strength: 1,
    constant,
  };
}

/** 默认通道配置：不引用来源，全部常量填充，避免空工程即报错。 */
export function defaultChannels() {
  return {
    r: emptyChannel("constant", null, 255),
    g: emptyChannel("constant", null, 255),
    b: emptyChannel("constant", null, 255),
    a: emptyChannel("constant", null, 255),
  };
}

export function createMaterial(name = "未命名材质") {
  return {
    id: uid("mat"),
    name,
    sourceId: null,
    targetWidth: 2048,
    targetHeight: 2048,
    fitMode: "pad",
    images: {},
    outputs: [],
    notes: "",
    createdAt: new Date().toISOString(),
  };
}

export function createOutput(partial = {}) {
  const type = getOutputType(partial.type || "custom").id;
  return {
    id: partial.id || uid("out"),
    name: partial.name || "新输出",
    type,
    width: Number.isInteger(partial.width) && partial.width > 0 ? partial.width : null,
    height: Number.isInteger(partial.height) && partial.height > 0 ? partial.height : null,
    fitMode: normalizeFitMode(partial.fitMode, "inherit"),
    convention: partial.convention === "directx" ? "directx" : "opengl",
    includeAlpha: Boolean(partial.includeAlpha),
    channels: normalizeChannels(partial.channels),
    enabled: partial.enabled !== false,
  };
}

export function normalizeChannels(channels = {}) {
  const out = defaultChannels();
  for (const id of CHANNEL_IDS) {
    const c = channels[id];
    if (!c) continue;
    out[id] = {
      source:
        c.source && c.source.kind === "role" && isSourceRole(c.source.role)
          ? { kind: "role", role: c.source.role }
          : { kind: "constant" },
      sample: getSampleMode(c.sample).id,
      invert: Boolean(c.invert),
      strength: Number.isFinite(Number(c.strength)) ? Math.max(0, Math.min(4, Number(c.strength))) : 1,
      constant: Number.isFinite(Number(c.constant)) ? Math.max(0, Math.min(255, Math.round(Number(c.constant)))) : 255,
    };
  }
  return out;
}

export function createProject(name = "未命名工程") {
  const material = createMaterial("材质 01");
  return {
    schema: APP_SCHEMA,
    appVersion: APP_VERSION,
    name,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    materials: [material],
    activeMaterialId: material.id,
    selectedOutputId: null,
  };
}

/** 输出实际使用的尺寸：优先自身尺寸，其次材质尺寸。 */
export function resolveOutputSize(material, output) {
  return {
    width: output.width || material.targetWidth,
    height: output.height || material.targetHeight,
    fitMode: output.fitMode && output.fitMode !== "inherit" ? output.fitMode : material.fitMode,
  };
}

/** 常用输出预设。 */
export function outputPreset(type, material) {
  const base = {
    width: null,
    height: null,
    fitMode: "inherit",
    convention: "opengl",
    includeAlpha: false,
  };
  switch (type) {
    case "color":
      return createOutput({
        ...base,
        name: "BaseColor",
        type: "color",
        channels: {
          r: { ...emptyChannel("role", "albedo"), sample: "red" },
          g: { ...emptyChannel("role", "albedo"), sample: "green" },
          b: { ...emptyChannel("role", "albedo"), sample: "blue" },
          a: emptyChannel("constant", null, 255),
        },
      });
    case "normal":
      return createOutput({
        ...base,
        name: "Normal",
        type: "normal",
        channels: {
          r: { ...emptyChannel("role", "normal", 128), sample: "red", strength: 1 },
          g: { ...emptyChannel("role", "normal", 128), sample: "green", strength: 1 },
          b: { ...emptyChannel("role", "normal", 255), sample: "blue", strength: 1 },
          a: emptyChannel("constant", null, 255),
        },
      });
    case "orm": {
      const rough = material?.images?.roughness ? "role" : "constant";
      const metal = material?.images?.metallic ? "role" : "constant";
      const ao = material?.images?.ao ? "role" : "constant";
      return createOutput({
        ...base,
        name: "ORM",
        type: "orm",
        channels: {
          r: emptyChannel(ao, "ao", 255),
          g: emptyChannel(rough, "roughness", 200),
          b: emptyChannel(metal, "metallic", 0),
          a: emptyChannel("constant", null, 255),
        },
      });
    }
    default:
      return createOutput({
        ...base,
        name: "自定义输出",
        type: "custom",
        channels: defaultChannels(),
      });
  }
}

export function defaultPresetsFor(material) {
  return OUTPUT_TYPES.filter((t) => t.id !== "custom").map((t) => outputPreset(t.id, material));
}

/* ------------------------------------------------------------------ */
/* 文件名识别                                                          */
/* ------------------------------------------------------------------ */

const SEPARATORS = /[\s._\-@#]+/;

/**
 * 从文件名推断贴图角色与变体名。
 * 例："brick_wall_02_Normal.png" -> { role: "normal", baseName: "brick_wall_02", variant: "" }
 *     "brick_wall_02_albedo.png" -> { role: "albedo", baseName: "brick_wall_02", variant: "" }
 */
export function detectRoleFromFileName(fileName) {
  const clean = String(fileName || "")
    .replace(/^.*[\\/]/, "")
    .replace(/\.[a-z0-9]+$/i, "");
  const tokens = clean.split(SEPARATORS).filter(Boolean);
  const lower = tokens.map((t) => t.toLowerCase());

  // 每个角色取"最靠后"的匹配位置。不能只取第一个：
  // "metal_plate_Metallic" 里的 metal 会先匹配到金属度，但真正的角色标记在末尾。
  let best = null;
  for (const role of ROLE_IDS_FOR_DETECTION) {
    let index = -1;
    for (let i = lower.length - 1; i >= 0; i--) {
      if (role.aliases.includes(lower[i])) {
        index = i;
        break;
      }
    }
    if (index < 0) continue;
    const token = lower[index];
    // 多字符别名优先于单字母别名，避免 "n"/"m" 抢占真正的角色词
    const strong = token.length > 1;
    if (
      !best ||
      index > best.index ||
      (index === best.index && strong && !best.strong)
    ) {
      best = { role: role.id, index, token: tokens[index], strong };
    }
  }

  if (!best) {
    return { role: "other", baseName: clean, variant: "", token: null };
  }
  const baseTokens = tokens.filter((_, i) => i !== best.index);
  return {
    role: best.role,
    baseName: baseTokens.join("_") || clean,
    variant: "",
    token: best.token,
  };
}

/**
 * 按 baseName 将一批文件分组为材质。分组键忽略大小写，
 * 这样 "Brick_Wall_Albedo.png" 与 "brick_wall_normal.png" 会归到同一组。
 * 返回 [{ baseName, key, files:[{fileName, role}] }]
 */
export function groupFilesByMaterial(fileNames) {
  const groups = new Map();
  for (const fileName of fileNames) {
    const info = detectRoleFromFileName(fileName);
    const baseName = info.baseName || fileName;
    const key = baseName.toLowerCase();
    if (!groups.has(key)) groups.set(key, { baseName, key, files: [] });
    groups.get(key).files.push({ fileName, role: info.role });
  }
  return [...groups.values()];
}

/* ------------------------------------------------------------------ */
/* 序列化                                                              */
/* ------------------------------------------------------------------ */

/**
 * 序列化工程。
 *
 * 默认只保存来源图片的文件名、相对 url 与尺寸；重新打开工程时用「重新指认来源贴图」
 * 匹配同批文件（需求 5：保存后恢复通道映射）。
 * options.embedImages = true 时把来源图以 dataURL 内嵌进工程，文件会变大，但可完全自包含。
 */
export function serializeProject(project, options = {}) {
  const { embedImages = false } = options;
  const materials = project.materials.map((m) => ({
    id: m.id,
    name: m.name,
    sourceId: m.sourceId || null,
    targetWidth: m.targetWidth,
    targetHeight: m.targetHeight,
    fitMode: m.fitMode,
    notes: m.notes || "",
    images: Object.fromEntries(
      Object.entries(m.images || {}).map(([role, img]) => [
        role,
        {
          role,
          fileName: img.fileName || null,
          url: img.url || null,
          width: img.width || null,
          height: img.height || null,
          bytes: img.bytes || null,
          ...(embedImages && img.dataUrl ? { dataUrl: img.dataUrl } : {}),
        },
      ]),
    ),
    outputs: m.outputs.map(serializeOutput),
  }));
  return {
    schema: APP_SCHEMA,
    appVersion: APP_VERSION,
    name: project.name,
    createdAt: project.createdAt,
    updatedAt: new Date().toISOString(),
    activeMaterialId: project.activeMaterialId,
    selectedOutputId: project.selectedOutputId || null,
    materials,
  };
}

function serializeOutput(o) {
  return {
    id: o.id,
    name: o.name,
    type: getOutputType(o.type).id,
    width: o.width || null,
    height: o.height || null,
    fitMode: normalizeFitMode(o.fitMode, "inherit"),
    convention: o.convention === "directx" ? "directx" : "opengl",
    includeAlpha: Boolean(o.includeAlpha),
    enabled: o.enabled !== false,
    channels: normalizeChannels(o.channels),
  };
}

/** 反序列化并校验。抛出的错误会逐条列出，方便用户修工程文件。 */
export function deserializeProject(raw) {
  let data;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch (err) {
      throw new Error(`工程文件不是合法 JSON：${err.message}`);
    }
  } else {
    data = raw;
  }
  if (!data || typeof data !== "object") throw new Error("工程文件内容为空");
  if (data.schema && data.schema !== APP_SCHEMA) {
    throw new Error(`不支持的工程版本「${data.schema}」，当前支持 ${APP_SCHEMA}`);
  }
  if (!Array.isArray(data.materials) || data.materials.length === 0) {
    throw new Error("工程文件缺少材质列表");
  }

  const errors = [];
  const materials = [];
  data.materials.forEach((m, mi) => {
    const label = m?.name || `第 ${mi + 1} 组`;
    if (!m || typeof m !== "object") {
      errors.push(`${label}：材质数据无效`);
      return;
    }
    const width = Math.round(Number(m.targetWidth));
    const height = Math.round(Number(m.targetHeight));
    if (!(width >= 1 && width <= LIMITS.maxTarget) || !(height >= 1 && height <= LIMITS.maxTarget)) {
      errors.push(`${label}：目标尺寸需在 1~${LIMITS.maxTarget} 之间（读到 ${m.targetWidth}×${m.targetHeight}）`);
    }
    const outputs = [];
    (Array.isArray(m.outputs) ? m.outputs : []).forEach((o, oi) => {
      if (!o || typeof o !== "object") {
        errors.push(`${label}：第 ${oi + 1} 个输出数据无效`);
        return;
      }
      const w = o.width == null ? null : Math.round(Number(o.width));
      const h = o.height == null ? null : Math.round(Number(o.height));
      if ((w != null && !(w >= 1 && w <= LIMITS.maxTarget)) || (h != null && !(h >= 1 && h <= LIMITS.maxTarget))) {
        errors.push(`${label} / ${o.name || `输出 ${oi + 1}`}：尺寸超出 1~${LIMITS.maxTarget}`);
        return;
      }
      outputs.push(createOutput({ ...o, width: w, height: h }));
    });
    const images = {};
    for (const [role, img] of Object.entries(m.images || {})) {
      if (!img || typeof img !== "object") continue;
      const roleId = isSourceRole(role) ? role : null;
      if (!roleId) continue;
      const fileName = typeof img.fileName === "string" ? img.fileName : null;
      const dataUrl = typeof img.dataUrl === "string" ? img.dataUrl : null;
      images[roleId] = {
        role: roleId,
        fileName,
        url: typeof img.url === "string" ? img.url : null,
        width: Number.isFinite(Number(img.width)) ? Number(img.width) : null,
        height: Number.isFinite(Number(img.height)) ? Number(img.height) : null,
        bytes: Number.isFinite(Number(img.bytes)) ? Number(img.bytes) : null,
        dataUrl,
        // 只有结构没有像素：打开工程后需要重新指认（或从 dataUrl 解码）
        needsRebind: !dataUrl && Boolean(fileName),
        restored: false,
      };
    }
    }
    materials.push({
      id: typeof m.id === "string" ? m.id : uid("mat"),
      name: typeof m.name === "string" && m.name.trim() ? m.name : label,
      sourceId: null,
      targetWidth: width,
      targetHeight: height,
      fitMode: normalizeFitMode(m.fitMode, "pad"),
      notes: typeof m.notes === "string" ? m.notes : "",
      images,
      outputs,
      createdAt: new Date().toISOString(),
    });
  });

  if (errors.length) {
    const err = new Error(`工程文件有 ${errors.length} 处问题：\n- ${errors.join("\n- ")}`);
    err.details = errors;
    throw err;
  }

  const activeMaterialId = materials.some((m) => m.id === data.activeMaterialId)
    ? data.activeMaterialId
    : materials[0].id;

  return {
    schema: APP_SCHEMA,
    appVersion: APP_VERSION,
    name: typeof data.name === "string" && data.name.trim() ? data.name : "未命名工程",
    createdAt: typeof data.createdAt === "string" ? data.createdAt : new Date().toISOString(),
    updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : new Date().toISOString(),
    materials,
    activeMaterialId,
    selectedOutputId:
      materials.find((m) => m.id === activeMaterialId)?.outputs.some((o) => o.id === data.selectedOutputId)
        ? data.selectedOutputId
        : null,
    restoredFromFile: true,
  };
}

/**
 * 恢复工程后，按文件名把已加载的图片重新绑定到材质槽位。
 * loadedImages: [{ fileName, width, height, bytes, data }]
 * 返回 { bound: [...], missing: [...], ambiguous: [...] }
 */
export function rebindImages(project, loadedImages) {
  const byName = new Map();
  for (const img of loadedImages) {
    const key = img.fileName;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(img);
  }
  const bound = [];
  const missing = [];
  const ambiguous = [];

  for (const material of project.materials) {
    for (const [role, saved] of Object.entries(material.images || {})) {
      if (!saved?.fileName) {
        missing.push({ materialId: material.id, role, fileName: null });
        continue;
      }
      let candidates = [...(byName.get(saved.fileName) || [])];
      if (candidates.length === 0) {
        // 允许用「基础名 + 角色」匹配（用户可能改了前缀或目录）
        const want = detectRoleFromFileName(saved.fileName);
        const wantRole = want.role === "other" ? role : want.role;
        candidates = loadedImages.filter((img) => {
          const got = detectRoleFromFileName(img.fileName);
          return got.role === wantRole && got.baseName === want.baseName;
        });
      }
      if (candidates.length === 1) {
        material.images[role] = { ...candidates[0], role, restored: true, needsRebind: false };
        bound.push({ materialId: material.id, role, fileName: candidates[0].fileName });
      } else if (candidates.length > 1) {
        // 有多张同名/同基础名候选时不猜，交给用户单独指定
        ambiguous.push({
          materialId: material.id,
          materialName: material.name,
          role,
          fileName: saved.fileName,
          count: candidates.length,
        });
      } else {
        missing.push({ materialId: material.id, materialName: material.name, role, fileName: saved.fileName });
      }
    }
  }
  return { bound, missing, ambiguous };
}
