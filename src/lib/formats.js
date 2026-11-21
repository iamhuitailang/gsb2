/**
 * 输入 / 输出格式声明。README 与界面提示共用这一份列表。
 *
 * 浏览器内解码路径：
 *   PNG / JPEG / WebP / GIF / BMP / SVG -> createImageBitmap 或 <img>（浏览器原生）
 *   PNG（回退）                          -> 自带解码器
 *   TGA                                  -> 自带解码器
 * Node CLI 解码路径：
 *   PNG / TGA（自带解码器）
 */

export const INPUT_FORMATS = [
  { ext: "png", label: "PNG", detail: "8 位，非隔行；灰度 / 灰度+Alpha / RGB / RGBA / 调色板" },
  { ext: "jpg/jpeg", label: "JPEG", detail: "浏览器原生解码；建议只作颜色贴图来源" },
  { ext: "webp", label: "WebP", detail: "浏览器原生解码（Safari 14+ / Chrome / Firefox）" },
  { ext: "bmp", label: "BMP", detail: "浏览器原生解码" },
  { ext: "gif", label: "GIF", detail: "取第一帧" },
  { ext: "tga", label: "TGA", detail: "未压缩 / RLE，24/32 位真彩、8 位灰度、16 位真彩、调色板" },
  { ext: "svg", label: "SVG", detail: "浏览器原生渲染（仓库内矢量样例即此格式）" },
];

export const OUTPUT_FORMATS = [{ ext: "png", label: "PNG", detail: "RGBA8888，无外部依赖编码器" }];

export const SUPPORTED_FORMATS = ["PNG", "JPEG", "WebP", "BMP", "GIF", "TGA", "SVG"];

export const INPUT_ACCEPT = ".png,.jpg,.jpeg,.webp,.bmp,.gif,.tga,.svg";

