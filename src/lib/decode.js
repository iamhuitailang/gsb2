/**
 * 浏览器端图片解码：优先 createImageBitmap（支持浏览器原生格式），
 * 失败时回退到自带的 PNG / TGA 解码器。
 */

import { decodePng } from "./pngDecode.js";
import { decodeTga, isTga } from "./tga.js";
import { SUPPORTED_FORMATS } from "./formats.js";

const MAX_PIXELS = 8192 * 8192;

function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ""));
  return m ? m[1].toLowerCase() : "";
}

function isSupportedExt(ext) {
  return ["png", "jpg", "jpeg", "webp", "bmp", "gif", "tga", "svg"].includes(ext);
}

export function extensionList() {
  return SUPPORTED_FORMATS.join(" / ");
}

function blobTypeOf(ext) {
  switch (ext) {
    case "svg":
      return "image/svg+xml";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "bmp":
      return "image/bmp";
    case "gif":
      return "image/gif";
    default:
      return "image/png";
  }
}

/**
 * SVG 通过 <img> + canvas 栅格化。createImageBitmap 对 SVG 的支持并不一致，
 * 而 <img src=blob:...> 在所有现代浏览器里都能渲染。
 */
async function decodeSvgViaImage(buffer, name, size) {
  if (typeof document === "undefined" || typeof Image === "undefined") {
    throw new Error("当前环境无法渲染 SVG；请改用 PNG / TGA");
  }
  const text = new TextDecoder().decode(buffer);
  if (!/<svg[\s>]/i.test(text)) throw new Error("不是有效的 SVG（缺少 <svg> 根元素）");
  const blob = new Blob([buffer], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  try {
    const image = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("浏览器无法渲染该 SVG"));
      img.src = url;
    });
    // 没有显式 width/height 的 SVG 在部分浏览器里是 0×0，回退到 viewBox
    let width = image.naturalWidth || image.width;
    let height = image.naturalHeight || image.height;
    if (!width || !height) {
      const vb = /viewBox\s*=\s*["']([^"']+)["']/i.exec(text);
      const nums = vb ? vb[1].trim().split(/[\s,]+/).map(Number) : [];
      if (nums.length === 4 && nums[2] > 0 && nums[3] > 0) {
        width = Math.round(nums[2]);
        height = Math.round(nums[3]);
      }
    }
    if (!width || !height) throw new Error("SVG 缺少有效尺寸");
    if (width * height > MAX_PIXELS) throw new Error(`尺寸 ${width}×${height} 过大`);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(image, 0, 0, width, height);
    const imageData = ctx.getImageData(0, 0, width, height);
    return { width, height, data: new Uint8ClampedArray(imageData.data), fileName: name, bytes: size };
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

/**
 * 解码一个 File/Blob。
 * @returns {Promise<{width,height,data:Uint8ClampedArray,fileName,bytes}>}
 */
export async function decodeFile(file) {
  if (!file) throw new Error("文件为空");
  const name = file.name || "未命名";
  const ext = extOf(name);
  if (!isSupportedExt(ext)) {
    throw new Error(`不支持的格式 .${ext || "(无扩展名)"}；支持 ${extensionList()}`);
  }
  if (file.size === 0) throw new Error("文件为空（0 字节）");
  if (file.size > 64 * 1024 * 1024) throw new Error("文件超过 64 MB，请先压缩或裁剪");

  const buffer = new Uint8Array(await file.arrayBuffer());

  // 先按文件头嗅探，避免"扩展名与实际内容不符"的情况被错误分支吃掉
  // （例如「保存（含贴图）」会把 SVG 来源重编码为 PNG，但仍然沿用原文件名）。
  const looksPng = buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
  const looksTga = isTga(buffer, name);

  // SVG 走 <img> 渲染：createImageBitmap 对 SVG 的尺寸处理在各浏览器不一致
  // （缺少 width/height 时会退成 300×150），因此直接跳过它。
  if (ext === "svg" && !looksPng && !looksTga) {
    try {
      return await decodeSvgViaImage(buffer, name, file.size);
    } catch (err) {
      throw new Error(`${name} 解码失败：${err.message}`);
    }
  }

  if (looksTga) {
    try {
      const img = decodeTga(buffer);
      return { ...img, fileName: name, bytes: file.size };
    } catch (err) {
      throw new Error(`${name} 解码失败：${err.message}`);
    }
  }

  // 浏览器原生解码
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(new Blob([buffer], { type: blobTypeOf(ext) }));
      const { width, height } = bitmap;
      if (width * height > MAX_PIXELS) {
        bitmap.close?.();
        throw new Error(`尺寸 ${width}×${height} 过大`);
      }
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close?.();
      const imageData = ctx.getImageData(0, 0, width, height);
      return { width, height, data: new Uint8ClampedArray(imageData.data), fileName: name, bytes: file.size };
    } catch (err) {
      // 继续尝试自带解码器
    }
  }

  if (ext === "png" || looksPng) {
    try {
      const img = await decodePng(buffer, async (data) => {
        if (typeof DecompressionStream === "undefined") throw new Error("当前环境不支持解压 PNG");
        const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate"));
        return new Uint8Array(await new Response(stream).arrayBuffer());
      });
      if (img.width * img.height > MAX_PIXELS) throw new Error(`尺寸 ${img.width}×${img.height} 过大`);
      return { ...img, fileName: name, bytes: file.size };
    } catch (err) {
      throw new Error(`${name} 解码失败：${err.message}`);
    }
  }

  throw new Error(`${name} 无法解码：浏览器不支持该格式，且不是 PNG / TGA / SVG`);
}

/** 从 URL 载入（用于仓库内样例）。 */
export async function decodeUrl(url, fileName) {
  let response;
  try {
    response = await fetch(url, { cache: "no-cache" });
  } catch (err) {
    throw new Error(`无法读取 ${url}：${err.message}`);
  }
  if (!response.ok) throw new Error(`无法读取 ${url}：HTTP ${response.status}`);
  const blob = await response.blob();
  const name = fileName || url.split("/").pop();
  const file = new File([blob], name, { type: blob.type });
  return decodeFile(file);
}

/**
 * 为来源图片生成缩略图 dataURL。
 * 走一次 drawImage 缩放，比直接截取像素更平滑；失败时由调用方处理。
 */
export function imageToThumbnail(image, max = 96) {
  const scale = Math.min(1, max / Math.max(image.width, image.height));
  const w = Math.max(1, Math.round(image.width * scale));
  const h = Math.max(1, Math.round(image.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  const tmp = document.createElement("canvas");
  tmp.width = image.width;
  tmp.height = image.height;
  tmp.getContext("2d").putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(tmp, 0, 0, w, h);
  return canvas.toDataURL("image/png");
}

/** 将打包结果画到 canvas（自动缩放到画布尺寸，保持像素清晰）。 */
export function drawImageToCanvas(canvas, image) {
  const ctx = canvas.getContext("2d");
  canvas.width = image.width;
  canvas.height = image.height;
  const imageData = new ImageData(new Uint8ClampedArray(image.data), image.width, image.height);
  ctx.putImageData(imageData, 0, 0);
}
