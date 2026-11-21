/**
 * 图像与通道处理核心。
 *
 * 该模块不依赖 DOM，浏览器与 Node 测试共用：
 *   输入图片 -> 取色为 0..1 标量 -> 按尺寸策略重采样 -> 反转 / 强度 -> 写入 RGBA 通道
 *
 * 图片数据格式统一为 { width, height, data: Uint8ClampedArray|Uint8Array }，
 * data 为未预乘的 RGBA8888。
 */

import { FIT_MODE_BY_ID, getFitMode, getRole, getSampleMode, isSourceRole } from "./constants.js";

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function clampByte(v) {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

function assertImage(image, label = "图片") {
  if (!image || !image.width || !image.height || !image.data) {
    throw new Error(`${label}数据无效或尚未加载`);
  }
  const expected = image.width * image.height * 4;
  if (image.data.length < expected) {
    throw new Error(`${label}像素数据不完整（期望 ${expected} 字节，实际 ${image.data.length}）`);
  }
}

/** 单像素标量取色，返回 0..1。 */
export function samplePixel(data, offset, mode = "luminance") {
  const r = data[offset] / 255;
  const g = data[offset + 1] / 255;
  const b = data[offset + 2] / 255;
  const a = data[offset + 3] / 255;
  switch (mode) {
    case "red":
      return r;
    case "green":
      return g;
    case "blue":
      return b;
    case "alpha":
      return a;
    case "average":
      return (r + g + b) / 3;
    case "max":
      return Math.max(r, g, b);
    case "min":
      return Math.min(r, g, b);
    case "luminance":
    default:
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
}

/** 将整张图提取为单通道 0..1 标量。 */
export function extractScalar(image, mode = "luminance") {
  assertImage(image);
  const { width, height, data } = image;
  const out = new Float32Array(width * height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = samplePixel(data, p, mode);
  }
  return out;
}

/**
 * 计算尺寸适配几何。目的地为 dstW × dstH，来源为 srcW × srcH。
 * - pad:   等比放入，四周留边
 * - crop:  等比铺满，居中裁切
 * - scale: 直接拉伸
 */
export function fitGeometry(srcW, srcH, dstW, dstH, mode = "pad") {
  if (!(srcW > 0 && srcH > 0 && dstW > 0 && dstH > 0)) {
    throw new Error("尺寸必须为正数");
  }
  const fit = FIT_MODE_BY_ID[mode] ? mode : "pad";
  if (fit === "scale") {
    return { mode: fit, dx: 0, dy: 0, dw: dstW, dh: dstH, sx: 0, sy: 0, sw: srcW, sh: srcH };
  }
  if (fit === "crop") {
    const scale = Math.max(dstW / srcW, dstH / srcH);
    const sw = Math.min(srcW, dstW / scale);
    const sh = Math.min(srcH, dstH / scale);
    return {
      mode: fit,
      dx: 0,
      dy: 0,
      dw: dstW,
      dh: dstH,
      sx: (srcW - sw) / 2,
      sy: (srcH - sh) / 2,
      sw,
      sh,
    };
  }
  const scale = Math.min(dstW / srcW, dstH / srcH);
  const dw = Math.max(1, Math.min(dstW, Math.round(srcW * scale)));
  const dh = Math.max(1, Math.min(dstH, Math.round(srcH * scale)));
  const dx = Math.floor((dstW - dw) / 2);
  const dy = Math.floor((dstH - dh) / 2);
  return { mode: "pad", dx, dy, dw, dh, sx: 0, sy: 0, sw: srcW, sh: srcH };
}

/** 给用户/清单使用的尺寸处理描述。 */
export function describeFit(srcW, srcH, dstW, dstH, mode = "pad") {
  const g = fitGeometry(srcW, srcH, dstW, dstH, mode);
  if (srcW === dstW && srcH === dstH) return "尺寸一致，直接使用";
  if (g.mode === "scale") {
    return `拉伸缩放 ${srcW}×${srcH} → ${dstW}×${dstH}${srcW / srcH !== dstW / dstH ? "（宽高比不同，会变形）" : ""}`;
  }
  if (g.mode === "crop") {
    return `等比铺满 ${dstW}×${dstH}，居中裁切至 ${Math.round(g.sw)}×${Math.round(g.sh)} 区域`;
  }
  const padX = dstW - g.dw;
  const padY = dstH - g.dh;
  const parts = [];
  if (padX > 0) parts.push(`左右留边 ${padX}px`);
  if (padY > 0) parts.push(`上下留边 ${padY}px`);
  return `等比缩放至 ${g.dw}×${g.dh}${parts.length ? `，${parts.join("、")}` : ""}`;
}

/**
 * 将单通道标量重采样到目标尺寸。pad 模式下矩形外填充 fill。
 * 使用双线性插值；源图与目标完全一致时走快速路径。
 */
export function resampleScalar(src, srcW, srcH, dstW, dstH, mode = "pad", fill = 0) {
  if (!src || src.length < srcW * srcH) throw new Error("单通道数据不完整");
  const g = fitGeometry(srcW, srcH, dstW, dstH, mode);
  const out = new Float32Array(dstW * dstH);

  if (g.mode === "pad") out.fill(fill);

  if (srcW === dstW && srcH === dstH && g.mode !== "crop") {
    out.set(src.subarray(0, srcW * srcH));
    return out;
  }
  // 同尺寸且裁切区域就是整张图：无需插值
  if (g.mode === "crop" && g.sx === 0 && g.sy === 0 && g.sw === srcW && g.sh === srcH) {
    out.set(src.subarray(0, srcW * srcH));
    return out;
  }

  // 目标像素 -> 源坐标的线性映射（像素中心对齐）。
  // region 必须是整数像素边界，否则双线性取样的下标会变成小数。
  let uScale, vScale, region;
  if (g.mode === "crop") {
    uScale = g.sw / dstW;
    vScale = g.sh / dstH;
    region = [g.sx, g.sx + g.sw - 1, g.sy, g.sy + g.sh - 1];
  } else if (g.mode === "scale") {
    uScale = srcW / dstW;
    vScale = srcH / dstH;
    region = [0, srcW - 1, 0, srcH - 1];
  } else {
    uScale = srcW / g.dw;
    vScale = srcH / g.dh;
    region = [0, srcW - 1, 0, srcH - 1];
  }

  const minX = Math.max(0, Math.floor(region[0]));
  const maxX = Math.min(srcW - 1, Math.ceil(region[1]));
  const minY = Math.max(0, Math.floor(region[2]));
  const maxY = Math.min(srcH - 1, Math.ceil(region[3]));

  const startX = g.mode === "pad" ? g.dx : 0;
  const endX = g.mode === "pad" ? g.dx + g.dw : dstW;
  const startY = g.mode === "pad" ? g.dy : 0;
  const endY = g.mode === "pad" ? g.dy + g.dh : dstH;

  for (let y = startY; y < endY; y++) {
    const fy = (y - (g.mode === "pad" ? g.dy : 0) + 0.5) * vScale - 0.5 + (g.mode === "crop" ? g.sy : 0);
    const y0 = Math.max(minY, Math.min(maxY, Math.floor(fy)));
    const y1 = Math.max(minY, Math.min(maxY, y0 + 1));
    const wy = Math.max(0, Math.min(1, fy - y0));
    const row0 = y0 * srcW;
    const row1 = y1 * srcW;
    const outRow = y * dstW;
    for (let x = startX; x < endX; x++) {
      const fx = (x - (g.mode === "pad" ? g.dx : 0) + 0.5) * uScale - 0.5 + (g.mode === "crop" ? g.sx : 0);
      const x0 = Math.max(minX, Math.min(maxX, Math.floor(fx)));
      const x1 = Math.max(minX, Math.min(maxX, x0 + 1));
      const wx = Math.max(0, Math.min(1, fx - x0));
      const top = src[row0 + x0] * (1 - wx) + src[row0 + x1] * wx;
      const bottom = src[row1 + x0] * (1 - wx) + src[row1 + x1] * wx;
      out[outRow + x] = top * (1 - wy) + bottom * wy;
    }
  }
  return out;
}

/**
 * 反转 / 强度。法线来源的强度以中性 0.5 为中心缩放，
 * 其它来源直接乘以强度（0 变黑，1 不变，2 加倍后裁剪）。
 */
export function transformValue(value, { invert = false, strength = 1, normal = false } = {}) {
  let v = clamp01(value);
  if (invert) v = 1 - v;
  const s = Number.isFinite(strength) ? Math.max(0, strength) : 1;
  if (normal) v = 0.5 + (v - 0.5) * s;
  else v *= s;
  return clamp01(v);
}

export function normalizeChannelDef(def = {}) {
  const role = def.source?.kind === "role" ? def.source.role : null;
  const validSource = isSourceRole(role)
    ? { kind: "role", role }
    : { kind: "constant" };
  const strength = Number(def.strength);
  const constant = Number(def.constant);
  return {
    source: validSource,
    sample: getSampleMode(def.sample).id,
    invert: Boolean(def.invert),
    strength: Number.isFinite(strength) ? Math.max(0, Math.min(4, strength)) : 1,
    constant: Number.isFinite(constant) ? Math.max(0, Math.min(255, Math.round(constant))) : 255,
  };
}

/**
 * 将一个输出的四个通道打包为 RGBA。
 *
 * @param {object} config
 * @param {number} config.width 目标宽
 * @param {number} config.height 目标高
 * @param {string} config.fitMode pad|crop|scale
 * @param {string} config.convention opengl|directx（影响法线绿的解读）
 * @param {object} config.channels {r,g,b,a}
 * @param {boolean} config.includeAlpha
 * @param {boolean} [config.warnOnSizeMismatch] 预览用低分辨率渲染时置 false，避免误报尺寸不一致
 * @param {(role:string)=>({width,height,data,fileName?}|null)} config.resolveImage
 * @returns {{width,height,data:Uint8ClampedArray,channels:object[],warnings:string[]}}
 */
export function buildOutput(config) {
  const {
    width,
    height,
    fitMode = "pad",
    convention = "opengl",
    channels = {},
    includeAlpha = false,
    warnOnSizeMismatch = true,
    resolveImage = () => null,
  } = config;

  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error("目标尺寸无效：宽高必须为正整数");
  }

  const data = new Uint8ClampedArray(width * height * 4);
  const warnings = [];
  const warningSet = new Set();
  const stats = [];
  const channelIds = ["r", "g", "b", "a"];

  for (let ci = 0; ci < channelIds.length; ci++) {
    const id = channelIds[ci];
    const def = normalizeChannelDef(channels[id]);
    const isAlphaChannel = id === "a";
    const disabledAlpha = isAlphaChannel && !includeAlpha;

    let image = null;
    let sourceError = null;
    let sourceFileName = null;
    // Alpha 未启用时该通道固定为 255，不去解析来源，也不产生"缺图"或"解码失败"警告
    if (def.source.kind === "role" && !disabledAlpha) {
      try {
        image = resolveImage(def.source.role);
      } catch (err) {
        // MISSING_SOURCE 是"尚未指定来源"，属于可以有常量补齐的正常情况；
        // 其它错误才算解码失败。
        if (err?.code !== "MISSING_SOURCE") sourceError = err?.message || String(err);
        image = null;
      }
    }
    sourceFileName = image?.fileName || null;

    const roleLabel = def.source.kind === "role" ? getRole(def.source.role).label : "常量";
    const sampleLabel = getSampleMode(def.sample).label;
    let missingSource = def.source.kind === "role" && !image && !disabledAlpha;
    let usedConstant = def.source.kind === "constant" || missingSource || disabledAlpha;

    if (image && image.error) {
      // 来源文件存在但解码失败：仍按常量补齐，并保留原始错误信息
      sourceError = image.error;
      sourceFileName = image.fileName || sourceFileName;
      image = null;
      missingSource = false;
      usedConstant = true;
      const msg = `「${roleLabel}」贴图解码失败（${sourceError}），${id.toUpperCase()} 通道已用常量 ${def.constant} 补齐`;
      if (!warningSet.has(msg)) {
        warnings.push(msg);
        warningSet.add(msg);
      }
    }
    if (missingSource) {
      const msg = sourceError
        ? `「${roleLabel}」贴图不可用（${sourceError}），${id.toUpperCase()} 通道已用常量 ${def.constant} 补齐`
        : `缺少「${roleLabel}」贴图，${id.toUpperCase()} 通道已用常量 ${def.constant} 补齐`;
      if (!warningSet.has(msg)) {
        warnings.push(msg);
        warningSet.add(msg);
      }
    }

    let values = null;
    if (!usedConstant && !disabledAlpha) {
      try {
        assertImage(image, `${roleLabel}贴图`);
        values = extractScalar(image, def.sample);
        if (
          getRole(def.source.role).id === "normal" &&
          def.sample === "green" &&
          convention === "directx"
        ) {
          for (let i = 0; i < values.length; i++) values[i] = 1 - values[i];
        }
        if (warnOnSizeMismatch && (image.width !== width || image.height !== height)) {
          const msg = `「${roleLabel}」尺寸 ${image.width}×${image.height} 与目标 ${width}×${height} 不一致，按「${getFitMode(fitMode).short}」处理`;
          if (!warningSet.has(msg)) {
            warnings.push(msg);
            warningSet.add(msg);
          }
        }
      } catch (err) {
        sourceError = err?.message || String(err);
        values = null;
        usedConstant = true;
        const msg = `「${roleLabel}」贴图解码失败（${sourceError}），${id.toUpperCase()} 通道已用常量 ${def.constant} 补齐`;
        if (!warningSet.has(msg)) {
          warnings.push(msg);
          warningSet.add(msg);
        }
      }
    }

    // 反相 / 强度只作用于贴图来源；留边补出来的区域保持常量原值，
    // 否则用户设的反相会把"缺失区域的底色"也一并翻掉，难以预测。
    const isNormalSource = !usedConstant && getRole(def.source.role).id === "normal";
    const applyTransform = def.source.kind === "role" && !usedConstant && !disabledAlpha;
    if (values && applyTransform) {
      for (let i = 0; i < values.length; i++) {
        values[i] = transformValue(values[i], {
          invert: def.invert,
          strength: def.strength,
          normal: isNormalSource,
        });
      }
    }

    const fill = disabledAlpha ? 1 : def.constant / 255;
    let resampled;
    if (values) {
      resampled = resampleScalar(values, image.width, image.height, width, height, fitMode, clamp01(fill));
    } else {
      resampled = new Float32Array(width * height).fill(clamp01(fill));
    }

    let min = 1;
    let max = 0;
    let sum = 0;
    const channelIndex = ci;
    for (let i = 0, p = 0; i < resampled.length; i++, p += 4) {
      const v = clamp01(resampled[i]);
      data[p + channelIndex] = v * 255;
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
    }

    stats.push({
      id,
      label: id.toUpperCase(),
      sourceKind: def.source.kind,
      role: def.source.kind === "role" ? getRole(def.source.role).id : null,
      roleLabel,
      sample: def.sample,
      sampleLabel,
      invert: def.invert,
      strength: def.strength,
      constant: def.constant,
      usedConstant,
      missingSource,
      decodeFailed: Boolean(sourceError),
      sourceError,
      sourceFileName,
      sourceWidth: image?.width || null,
      sourceHeight: image?.height || null,
      min: Math.round(min * 255),
      max: Math.round(max * 255),
      mean: Math.round((sum / Math.max(1, resampled.length)) * 255),
    });
  }

  return { width, height, data, channels: stats, warnings };
}

/**
 * 法线球预览。返回 size×size RGBA 像素。
 * 同时展示贴图细节与球面几何光照，方便对比 OpenGL / DirectX 方向。
 *
 * convention 表示"由哪个引擎来读这张贴图"。引擎不会知道贴图是按哪种约定导出的，
 * 因此这里只按 convention 本身解释绿通道：数据编码与引擎约定一致时球面光照正确，
 * 不一致时会呈现镜像光照。把两个结果并排放，就能直观看出方向设置是否匹配目标引擎。
 */
export function renderNormalSphere({ data, width, height, convention = "opengl", size = 160 }) {
  if (!data || !width || !height) throw new Error("法线数据无效");
  const out = new Uint8ClampedArray(size * size * 4);
  const radius = size / 2 - 1;
  const cx = size / 2 - 0.5;
  const cy = size / 2 - 0.5;
  const flipGreen = convention === "directx";
  const light = normalize3([-0.5, 0.62, 0.72]);
  const half = normalize3([light[0], light[1], light[2] + 1]);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = (x - cx) / radius;
      const py = (y - cy) / radius;
      const r2 = px * px + py * py;
      const p = (y * size + x) * 4;
      if (r2 > 1) {
        out[p + 3] = 0;
        continue;
      }
      const gz = Math.sqrt(1 - r2);
      const geo = [px, -py, gz];
      const u = clamp01(px * 0.5 + 0.5);
      const v = clamp01(-py * 0.5 + 0.5);
      const sx = Math.min(width - 1, Math.max(0, Math.floor(u * width)));
      const sy = Math.min(height - 1, Math.max(0, Math.floor((1 - v) * height)));
      const tp = (sy * width + sx) * 4;
      let nx = (data[tp] / 255) * 2 - 1;
      let ny = (data[tp + 1] / 255) * 2 - 1;
      let nz = (data[tp + 2] / 255) * 2 - 1;
      if (flipGreen) ny = -ny;
      const tangent = normalize3([nx, ny, nz || 0.0001]);
      const n = normalize3([
        tangent[0] + geo[0] * 1.25,
        tangent[1] + geo[1] * 1.25,
        tangent[2] + geo[2] * 0.55,
      ]);
      const diff = Math.max(0, n[0] * light[0] + n[1] * light[1] + n[2] * light[2]);
      const spec = Math.pow(
        Math.max(0, n[0] * half[0] + n[1] * half[1] + n[2] * half[2]),
        28,
      );
      const rim = Math.pow(1 - gz, 2.2) * 0.22;
      const shade = 0.18 + 0.72 * diff + 0.55 * spec + rim;
      const tint = [0.86, 0.9, 0.98];
      out[p] = clampByte(255 * shade * tint[0]);
      out[p + 1] = clampByte(255 * shade * tint[1]);
      out[p + 2] = clampByte(255 * shade * tint[2]);
      out[p + 3] = 255;
    }
  }
  return out;
}

function normalize3(v) {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

/** 从打包结果中抽取灰度通道像素，供通道缩略图使用。 */
export function extractPackedChannel(data, width, height, channel = "r") {
  const index = { r: 0, g: 1, b: 2, a: 3 }[channel] ?? 0;
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, p = 0; i < width * height; i++, p += 4) {
    const v = data[p + index];
    out[p] = v;
    out[p + 1] = v;
    out[p + 2] = v;
    out[p + 3] = 255;
  }
  return out;
}

/** 最近邻缩放 RGBA 数据（仅用于缩略图绘制）。 */
export function scaleNearest(data, srcW, srcH, dstW, dstH) {
  const out = new Uint8ClampedArray(dstW * dstH * 4);
  for (let y = 0; y < dstH; y++) {
    const sy = Math.min(srcH - 1, Math.floor((y + 0.5) * (srcH / dstH)));
    for (let x = 0; x < dstW; x++) {
      const sx = Math.min(srcW - 1, Math.floor((x + 0.5) * (srcW / dstW)));
      const sp = (sy * srcW + sx) * 4;
      const dp = (y * dstW + x) * 4;
      out[dp] = data[sp];
      out[dp + 1] = data[sp + 1];
      out[dp + 2] = data[sp + 2];
      out[dp + 3] = data[sp + 3];
    }
  }
  return out;
}

/**
 * 预览尺寸：保持目标宽高比，最长边不超过 max。
 * 预览使用同一套尺寸策略，因此留边 / 裁切 / 拉伸的效果会如实体现。
 */
export function previewDimensions(width, height, max = 512) {
  if (!(width > 0 && height > 0)) return { width: 1, height: 1, scale: 1 };
  const scale = Math.min(1, max / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scale,
  };
}
