/*
 * 图片编码与候选生成。
 * 关键原则：所有候选的字节数都来自浏览器实际编码后的 Blob.size，
 * 不存在任何“预估大小”。编码失败（回调为 null 或 0 字节）一律标记 fail，
 * 绝不允许以 0 字节混入方案。
 */
(function (global) {
  'use strict';

  const SCALES = [1, 0.75, 0.5, 0.35, 0.25];
  const WEBP_QUALITIES = [0.9, 0.75, 0.6, 0.45, 0.3];
  const ENCODE_TIMEOUT_MS = 20000;

  /* URL 参数注入的故障规则，用于演示“编码失败需重选”：
     ?fail=<名称片段>   该图 WebP 全部编码失败
     ?failall=<名称片段> 该图所有编码失败 */
  const failRules = { webp: [], all: [] };

  function detectWebp() {
    return new Promise((resolve) => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 4;
      canvas.toBlob((b) => !!(b && b.size) ? resolve(true) : resolve(false), 'image/webp', 0.8);
    });
  }

  function loadImageFile(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('无法解码图片：' + file.name)); };
      img.src = url;
    });
  }

  function loadImageFromSrc(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('示例图片生成失败'));
      img.src = src;
    });
  }

  function imageToCanvas(img) {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth || img.width;
    c.height = img.naturalHeight || img.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    return c;
  }

  function canvasHasAlpha(canvas) {
    const ctx = canvas.getContext('2d');
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] < 255) return true;
    }
    return false;
  }

  function scaledCanvas(srcCanvas, w, h, flatten) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    if (flatten) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(srcCanvas, 0, 0, w, h);
    return c;
  }

  function shouldFail(itemId, itemName, format) {
    const hit = (rule) => rule.some((kw) => itemId.includes(kw) || itemName.includes(kw));
    if (hit(failRules.all)) return true;
    if (format === 'image/webp' && hit(failRules.webp)) return true;
    return false;
  }

  /** 真实编码：返回 Blob；失败（含超时、null 回调、0 字节）返回 null */
  function encodeCanvas(canvas, type, quality, item) {
    if (item && shouldFail(item.id, item.name, type)) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) { settled = true; resolve(null); }
      }, ENCODE_TIMEOUT_MS);
      try {
        canvas.toBlob((blob) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          // 0 字节不算成功
          resolve(blob && blob.size > 0 ? blob : null);
        }, type, quality);
      } catch (e) {
        if (!settled) { settled = true; clearTimeout(timer); resolve(null); }
      }
    });
  }

  async function blobToCanvas(blob) {
    if ('createImageBitmap' in window) {
      const bmp = await createImageBitmap(blob);
      const c = document.createElement('canvas');
      c.width = bmp.width;
      c.height = bmp.height;
      c.getContext('2d').drawImage(bmp, 0, 0);
      bmp.close && bmp.close();
      return c;
    }
    const url = URL.createObjectURL(blob);
    try {
      const img = await loadImageFromSrc(url);
      return imageToCanvas(img);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /**
   * PSNR：把候选解码后与“同尺寸下的参考渲染”逐像素对比。
   * 这样缩放损失与编码损失都计入画质差异，而不是只比编码噪声。
   */
  function computePsnr(refCanvas, candCanvas) {
    const w = refCanvas.width;
    const h = refCanvas.height;
    const ref = refCanvas.getContext('2d').getImageData(0, 0, w, h).data;
    const cand = candCanvas.getContext('2d').getImageData(0, 0, w, h).data;
    let sumSq = 0;
    const n = w * h * 4;
    for (let i = 0; i < n; i++) {
      const d = ref[i] - cand[i];
      sumSq += d * d;
    }
    if (sumSq === 0) return Infinity;
    const mse = sumSq / n;
    return 10 * Math.log10((255 * 255) / mse);
  }

  function psnrLabel(psnr) {
    if (!isFinite(psnr)) return '无差异';
    return psnr.toFixed(1) + ' dB';
  }

  function psnrGrade(psnr) {
    if (!isFinite(psnr) || psnr >= 45) return { text: '几乎无损', color: 'var(--good)' };
    if (psnr >= 38) return { text: '轻微差异', color: 'var(--good)' };
    if (psnr >= 32) return { text: '可见但可接受', color: 'var(--warn)' };
    if (psnr >= 26) return { text: '明显压缩感', color: 'var(--warn)' };
    return { text: '压糊', color: 'var(--bad)' };
  }

  function candidateViolations(item, width, height, flattened) {
    const v = [];
    if (width < item.minW || height < item.minH) {
      v.push('低于最小尺寸 ' + item.minW + '×' + item.minH + 'px');
    }
    if (item.keepAlpha && flattened) {
      v.push('透明通道被移除（该图要求保留透明）');
    }
    return v;
  }

  /**
   * 为一张图生成完整候选矩阵。
   * @param {object} item {id,name,sourceCanvas,hasAlpha,minW,minH,keepAlpha}
   * @param {(done:number,total:number,label:string)=>void} onProgress
   */
  async function buildCandidates(item, onProgress) {
    const src = item.sourceCanvas;
    const jobs = [];
    const seenDims = new Set();

    SCALES.forEach((scale) => {
      const w = Math.max(1, Math.round(src.width * scale));
      const h = Math.max(1, Math.round(src.height * scale));
      const dimKey = w + 'x' + h;
      if (seenDims.has(dimKey)) return;
      seenDims.add(dimKey);

      // 同尺寸参考渲染（用于 PSNR）
      const refCanvas = scaledCanvas(src, w, h, false);

      jobs.push({ kind: 'png', scale, w, h, flatten: false, refCanvas,
        label: 'PNG 无损 · ' + Math.round(scale * 100) + '% 尺寸' });
      WEBP_QUALITIES.forEach((q) => {
        jobs.push({ kind: 'webp', quality: q, scale, w, h, flatten: false, refCanvas,
          label: 'WebP q' + q + ' · ' + Math.round(scale * 100) + '% 尺寸' });
      });
      if (item.hasAlpha) {
        const flatRef = scaledCanvas(src, w, h, true);
        jobs.push({ kind: 'png', scale, w, h, flatten: true, refCanvas: flatRef,
          label: 'PNG 白底无透明 · ' + Math.round(scale * 100) + '% 尺寸' });
        jobs.push({ kind: 'webp', quality: 0.8, scale, w, h, flatten: true, refCanvas: flatRef,
          label: 'WebP q0.8 白底无透明 · ' + Math.round(scale * 100) + '% 尺寸' });
      }
    });

    const candidates = [];
    let done = 0;
    for (const job of jobs) {
      const canvas = scaledCanvas(src, job.w, job.h, job.flatten);
      const type = job.kind === 'png' ? 'image/png' : 'image/webp';
      const blob = await encodeCanvas(canvas, type, job.quality, item);
      done++;
      onProgress && onProgress(done, jobs.length, job.label);

      const base = {
        id: item.id + '__c' + candidates.length,
        label: job.label,
        format: job.kind === 'png' ? 'PNG' : 'WebP',
        quality: job.quality === undefined ? null : job.quality,
        scale: job.scale,
        width: job.w,
        height: job.h,
        flattened: job.flatten,
        hasOutputAlpha: item.hasAlpha && !job.flatten
      };

      if (!blob) {
        candidates.push({ ...base, status: 'fail', bytes: null, psnr: null, blob: null,
          violations: candidateViolations(item, job.w, job.h, job.flatten),
          failReason: '编码器未返回有效数据（失败或 0 字节），请改选其他候选' });
        continue;
      }

      let psnr = null;
      try {
        const decoded = await blobToCanvas(blob);
        psnr = computePsnr(job.refCanvas, decoded);
      } catch (e) {
        candidates.push({ ...base, status: 'fail', bytes: blob.size, blob: null, psnr: null,
          violations: candidateViolations(item, job.w, job.h, job.flatten),
          failReason: '编码结果无法解码，判定为失败，请改选其他候选' });
        continue;
      }

      candidates.push({ ...base, status: 'ok', bytes: blob.size, blob, psnr,
        violations: candidateViolations(item, job.w, job.h, job.flatten) });
    }

    // 字节从小到大排，方便查看；失败候选沉底
    candidates.sort((a, b) => {
      if (a.status !== b.status) return a.status === 'fail' ? 1 : -1;
      return a.bytes - b.bytes;
    });
    return candidates;
  }

  /** 每个可行候选的“质量分”，分配器据此选择每张图的最优档 */
  function qualityScore(cand) {
    // 无损优先；同分时大尺寸、高 PSNR 优先
    const lossless = cand.format === 'PNG' && !cand.flatten ? 100 : 0;
    return lossless + cand.scale * 10 + (isFinite(cand.psnr) ? Math.min(cand.psnr, 60) / 10 : 6);
  }

  global.ImgEncoding = {
    SCALES, WEBP_QUALITIES, failRules,
    detectWebp, loadImageFile, loadImageFromSrc, imageToCanvas, canvasHasAlpha,
    scaledCanvas, encodeCanvas, blobToCanvas, computePsnr,
    psnrLabel, psnrGrade, buildCandidates, qualityScore
  };
})(window);
