/*
 * image.js —— 图像层：加载、按策略重采样、单通道提取与变换、输出合成、PNG 编码。
 * 依赖浏览器 DOM/Canvas；纯算法部分都放在 core.js 以便单测。
 */
(function (global) {
  "use strict";
  const MT = global.MT || (global.MT = {});
  const core = MT.core;

  // ------------------------------------------------------------------ //
  // 加载
  // ------------------------------------------------------------------ //

  function loadImageElement(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("图片解码失败: " + src.slice(0, 64)));
      img.src = src;
    });
  }

  /** File -> {name, dataUrl, image, width, height} */
  async function readImageFile(file) {
    const dataUrl = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(new Error("文件读取失败: " + file.name));
      fr.readAsDataURL(file);
    });
    const image = await loadImageElement(dataUrl);
    return {
      id: core.uid("img"),
      name: file.name,
      dataUrl,
      image,
      width: image.naturalWidth,
      height: image.naturalHeight,
    };
  }

  function getPixels(image) {
    const c = document.createElement("canvas");
    c.width = image.naturalWidth || image.width;
    c.height = image.naturalHeight || image.height;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(image, 0, 0);
    return ctx.getImageData(0, 0, c.width, c.height);
  }

  // ------------------------------------------------------------------ //
  // 尺寸策略：把源 ImageData 重采样为 tw x th 的 ImageData
  // ------------------------------------------------------------------ //

  function resizedPixels(srcImageData, tw, th, policy, padColor) {
    const rect = core.resizeRect(srcImageData.width, srcImageData.height, tw, th, policy);
    const out = document.createElement("canvas");
    out.width = tw;
    out.height = th;
    const ctx = out.getContext("2d", { willReadFrequently: true });
    if (policy === "pad") {
      ctx.fillStyle = `rgba(${padColor.r},${padColor.g},${padColor.b},${padColor.a / 255})`;
      ctx.fillRect(0, 0, tw, th);
    }
    const srcCanvas = document.createElement("canvas");
    srcCanvas.width = srcImageData.width;
    srcCanvas.height = srcImageData.height;
    srcCanvas.getContext("2d").putImageData(srcImageData, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(
      srcCanvas,
      rect.sx, rect.sy, rect.sw, rect.sh,
      rect.dx, rect.dy, rect.dw, rect.dh
    );
    const pixels = ctx.getImageData(0, 0, tw, th);
    return { pixels, rect };
  }

  // ------------------------------------------------------------------ //
  // 单通道处理
  // ------------------------------------------------------------------ //

  /**
   * 按通道规格生成该通道的 0..255 结果（长度 tw*th 的普通数组），
   * 同时返回灰度预览 ImageData 和来源说明。
   * pixelCache: 同一输出内按角色缓存重采样结果，避免同源多通道重复处理、
   * 以及后处理通道覆盖留边区的问题。
   */
  function buildChannelData(spec, group, settings, pixelCache) {
    const tw = settings.outputWidth;
    const th = settings.outputHeight;
    const note = { channel: spec.channel, source: "", detail: "", usedFallback: false };
    let values = new Array(tw * th);
    let resizeInfo = null;

    if (spec.source.type === "constant" || !group.files[spec.source.role]) {
      const fallback =
        spec.source.type === "constant"
          ? core.clamp8(spec.source.value)
          : core.clamp8(spec.constant);
      values.fill(fallback);
      note.source = "常量补齐";
      note.usedFallback = true;
      note.detail =
        spec.source.type === "constant"
          ? `固定值 ${fallback}`
          : `缺少来源「${core.ROLE_LABELS[spec.source.role] || spec.source.role}」，用常量 ${fallback} 补齐`;
    } else {
      const file = group.files[spec.source.role];
      if (!pixelCache.has(file.id)) {
        const src = getPixels(file.image);
        const mismatch = src.width !== tw || src.height !== th;
        const { pixels, rect } = resizedPixels(src, tw, th, settings.resizePolicy, settings.padColor);
        pixelCache.set(file.id, {
          pixels,
          resizeInfo: {
            sourceWidth: src.width,
            sourceHeight: src.height,
            mismatch,
            rect,
            policy: settings.resizePolicy,
          },
        });
      }
      const cached = pixelCache.get(file.id);
      resizeInfo = cached.resizeInfo;
      const d = cached.pixels.data;
      for (let i = 0; i < tw * th; i++) {
        const raw = core.pickChannelValue(spec.mode, d[i * 4], d[i * 4 + 1], d[i * 4 + 2], d[i * 4 + 3]);
        values[i] = core.applyChannelTransform(raw, spec.invert, spec.strength);
      }
      note.source = file.name;
      note.detail =
        `取色：${core.PICK_MODE_LABELS[spec.mode]}` +
        (spec.invert ? "；已反转" : "") +
        (spec.strength !== 1 ? `；强度 ×${spec.strength}` : "") +
        (resizeInfo.mismatch
          ? `；源尺寸 ${resizeInfo.sourceWidth}×${resizeInfo.sourceHeight}，按「${core.RESIZE_POLICY_LABELS[settings.resizePolicy].split("（")[0]}」处理为 ${tw}×${th}`
          : `；尺寸 ${tw}×${th}`);
    }

    const gray = new ImageData(tw, th);
    for (let i = 0; i < tw * th; i++) {
      gray.data[i * 4] = gray.data[i * 4 + 1] = gray.data[i * 4 + 2] = values[i];
      gray.data[i * 4 + 3] = 255;
    }
    return { values, gray, note, resizeInfo };
  }

  // ------------------------------------------------------------------ //
  // 法线变换：G 翻转（OpenGL <-> DirectX）+ 法线强度
  // ------------------------------------------------------------------ //

  function transformNormal(pixels, orientation, strength) {
    const d = pixels.data;
    const s = strength == null ? 1 : strength;
    for (let i = 0; i < d.length; i += 4) {
      let nx = d[i] / 255 * 2 - 1;
      let ny = d[i + 1] / 255 * 2 - 1;
      let nz = d[i + 2] / 255 * 2 - 1;
      nx *= s;
      ny *= s;
      if (orientation === "directx") ny = -ny;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
      d[i] = core.clamp8((nx * inv * 0.5 + 0.5) * 255);
      d[i + 1] = core.clamp8((ny * inv * 0.5 + 0.5) * 255);
      d[i + 2] = core.clamp8((nz * inv * 0.5 + 0.5) * 255);
      d[i + 3] = 255;
    }
  }

  /**
   * 合成一个输出。返回 {imageData, channelPreviews:[{spec,gray}], notes, resizeInfos}
   * 缺来源按常量补齐（不抛错）；真正的失败由 batch 层根据输出需求判断。
   */
  function composeOutput(group, output, settings) {
    const tw = settings.outputWidth;
    const th = settings.outputHeight;
    const imageData = new ImageData(tw, th);
    const channelPreviews = [];
    const notes = [];
    const resizeInfos = [];
    const pixelCache = new Map();
    const seenResize = new Set();

    output.channels.forEach((spec) => {
      const built = buildChannelData(spec, group, settings, pixelCache);
      channelPreviews.push({ spec, gray: built.gray, note: built.note });
      notes.push(built.note);
      if (built.resizeInfo) {
        const key = built.resizeInfo.sourceWidth + "x" + built.resizeInfo.sourceHeight;
        if (!seenResize.has(key)) {
          seenResize.add(key);
          resizeInfos.push(built.resizeInfo);
        }
      }
      const ci = { r: 0, g: 1, b: 2, a: 3 }[spec.channel];
      for (let i = 0; i < tw * th; i++) imageData.data[i * 4 + ci] = built.values[i];
    });

    // 未显式配置的通道：RGB 补 0，Alpha 补 255
    const configured = new Set(output.channels.map((c) => c.channel));
    for (let i = 0; i < tw * th; i++) {
      if (!configured.has("a")) imageData.data[i * 4 + 3] = 255;
    }

    if (output.isNormal) {
      transformNormal(imageData, settings.normalOrientation, settings.normalStrength);
    }
    return { imageData, channelPreviews, notes, resizeInfos };
  }

  // ------------------------------------------------------------------ //
  // PNG 编码（自实现，保证与测试一致；不支持时回退 canvas.toBlob）
  // ------------------------------------------------------------------ //

  async function _deflate(bytes) {
    if (typeof CompressionStream !== "undefined") {
      const cs = new CompressionStream("deflate");
      const stream = new Blob([bytes]).stream().pipeThrough(cs);
      return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    return null;
  }

  function _chunk(tag, data) {
    const len = data.length;
    const out = new Uint8Array(12 + len);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, len);
    out.set(tag, 4);
    out.set(data, 8);
    dv.setUint32(8 + len, core.crc32(out.subarray(4, 8 + len)));
    return out;
  }

  async function encodePNG(imageData) {
    const { width: w, height: h, data } = imageData;
    const stride = w * 4;
    const raw = new Uint8Array((stride + 1) * h);
    for (let y = 0; y < h; y++) {
      raw[y * (stride + 1)] = 0;
      raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
    }
    const deflated = await _deflate(raw);
    if (deflated) {
      const ihdr = new Uint8Array(13);
      const dv = new DataView(ihdr.buffer);
      dv.setUint32(0, w);
      dv.setUint32(4, h);
      ihdr[8] = 8;   // bit depth
      ihdr[9] = 6;   // color type RGBA
      const parts = [
        Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        _chunk(Uint8Array.from([0x49, 0x48, 0x44, 0x52]), ihdr),
        _chunk(Uint8Array.from([0x49, 0x44, 0x41, 0x54]), deflated),
        _chunk(Uint8Array.from([0x49, 0x45, 0x4e, 0x44]), new Uint8Array(0)),
      ];
      const total = parts.reduce((s, p) => s + p.length, 0);
      const out = new Uint8Array(total);
      let pos = 0;
      for (const p of parts) {
        out.set(p, pos);
        pos += p.length;
      }
      return out;
    }
    // 回退：浏览器原生编码
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d").putImageData(imageData, 0, 0);
    const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
    return new Uint8Array(await blob.arrayBuffer());
  }

  MT.image = {
    readImageFile, loadImageElement, getPixels,
    resizedPixels, buildChannelData, composeOutput,
    transformNormal, encodePNG,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = MT.image;
})(typeof globalThis !== "undefined" ? globalThis : this);
