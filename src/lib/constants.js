/**
 * 共享常量：角色、取色方式、尺寸策略、输出类型。
 * 纯数据模块，浏览器与 Node 测试均可直接导入。
 */

export const APP_SCHEMA = "texture-channel-packer/1";
export const APP_NAME = "Texture Channel Packer";
export const APP_VERSION = "1.0.0";

/** 贴图角色。文件名自动识别会使用 aliases。 */
export const ROLES = [
  {
    id: "albedo",
    label: "颜色",
    en: "Albedo",
    aliases: ["albedo", "basecolor", "base_color", "base-color", "diffuse", "diff", "color", "colour", "col"],
    accent: "#f0a35e",
  },
  {
    id: "normal",
    label: "法线",
    en: "Normal",
    aliases: ["normal", "normalmap", "normal_map", "nor", "nrm", "n"],
    accent: "#8aa4ff",
  },
  {
    id: "roughness",
    label: "粗糙度",
    en: "Roughness",
    aliases: ["roughness", "rough", "rgh", "glossiness", "gloss", "smoothness"],
    accent: "#c8d0d8",
  },
  {
    id: "metallic",
    label: "金属度",
    en: "Metallic",
    aliases: ["metallic", "metalness", "metal", "mtl", "m"],
    accent: "#73d2c4",
  },
  {
    id: "ao",
    label: "环境光遮蔽",
    en: "AO",
    aliases: ["ao", "ambientocclusion", "ambient_occlusion", "occlusion", "occ"],
    accent: "#d6c37a",
  },
  {
    id: "height",
    label: "高度",
    en: "Height",
    aliases: ["height", "heightmap", "height_map", "displacement", "disp", "bump", "h"],
    accent: "#b79be8",
  },
  {
    id: "opacity",
    label: "透明度",
    en: "Opacity",
    aliases: ["opacity", "alpha", "mask", "transparency"],
    accent: "#ef8fb0",
  },
  {
    id: "emissive",
    label: "自发光",
    en: "Emissive",
    aliases: ["emissive", "emission", "emit", "glow"],
    accent: "#ffcf6b",
  },
  {
    id: "other",
    label: "其他",
    en: "Other",
    aliases: [],
    accent: "#9aa7b4",
  },
];

export const ROLE_BY_ID = Object.fromEntries(ROLES.map((r) => [r.id, r]));

export function getRole(id) {
  return ROLE_BY_ID[id] || ROLE_BY_ID.other;
}

/** 是否是能作为来源的有效角色（"other" 只用于识别失败时的兜底）。 */
export function isSourceRole(id) {
  return Boolean(id) && id !== "other" && Boolean(ROLE_BY_ID[id]);
}

/** 从一张图片中提取标量的方式。 */
export const SAMPLE_MODES = [
  { id: "red", label: "红通道 R", short: "R" },
  { id: "green", label: "绿通道 G", short: "G" },
  { id: "blue", label: "蓝通道 B", short: "B" },
  { id: "alpha", label: "Alpha 通道", short: "A" },
  { id: "luminance", label: "亮度 Rec.709", short: "L" },
  { id: "average", label: "RGB 平均", short: "Avg" },
  { id: "max", label: "RGB 最大值", short: "Max" },
  { id: "min", label: "RGB 最小值", short: "Min" },
];

export const SAMPLE_MODE_BY_ID = Object.fromEntries(SAMPLE_MODES.map((m) => [m.id, m]));

export function getSampleMode(id) {
  return SAMPLE_MODE_BY_ID[id] || SAMPLE_MODE_BY_ID.luminance;
}

/** 尺寸不一致时的处理方式。 */
export const FIT_MODES = [
  {
    id: "pad",
    label: "等比留边",
    short: "留边",
    description: "等比缩放到完整可见，四周用通道常量值补齐。",
  },
  {
    id: "crop",
    label: "缩放裁切",
    short: "裁切",
    description: "等比放大铺满目标尺寸，居中裁掉超出部分。",
  },
  {
    id: "scale",
    label: "拉伸缩放",
    short: "拉伸",
    description: "直接缩放到目标尺寸，宽高比不同时会变形。",
  },
];

export const FIT_MODE_BY_ID = Object.fromEntries(FIT_MODES.map((m) => [m.id, m]));

export function getFitMode(id) {
  return FIT_MODE_BY_ID[id] || FIT_MODE_BY_ID.pad;
}

/** 输出类型（预设）。 */
export const OUTPUT_TYPES = [
  { id: "color", label: "颜色贴图", short: "Color" },
  { id: "normal", label: "法线贴图", short: "Normal" },
  { id: "orm", label: "ORM 打包", short: "ORM" },
  { id: "custom", label: "自定义", short: "Custom" },
];

export const OUTPUT_TYPE_BY_ID = Object.fromEntries(OUTPUT_TYPES.map((t) => [t.id, t]));

export function getOutputType(id) {
  return OUTPUT_TYPE_BY_ID[id] || OUTPUT_TYPE_BY_ID.custom;
}

/** 通道顺序，打包时固定写 R/G/B/A。 */
export const CHANNELS = [
  { id: "r", label: "R", name: "红", color: "#ff6b6b" },
  { id: "g", label: "G", name: "绿", color: "#7bd88f" },
  { id: "b", label: "B", name: "蓝", color: "#6ca8ff" },
  { id: "a", label: "A", name: "透明", color: "#d8c27a" },
];

export const CHANNEL_IDS = CHANNELS.map((c) => c.id);

export const NORMAL_CONVENTIONS = [
  {
    id: "opengl",
    label: "OpenGL (+Y 向上)",
    hint: "不翻转绿通道，适用于 Unity / Blender / OpenGL 管线",
    flipGreen: false,
  },
  {
    id: "directx",
    label: "DirectX (-Y 向下)",
    hint: "翻转绿通道，适用于 Unreal / DirectX 管线",
    flipGreen: true,
  },
];

export const LIMITS = {
  maxTarget: 8192,
  maxPreview: 1024,
  maxFileSize: 64 * 1024 * 1024,
  constantMax: 255,
  strengthMin: 0,
  strengthMax: 2,
};

export const MESSAGES = {
  noMaterial: "请先在左侧选择或导入一组材质。",
  noOutput: "请先创建一个输出贴图。",
};
