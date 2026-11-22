/*
 * 边缘去底色核心算法（无 DOM 依赖，浏览器 <script> 与 Node require 均可加载）。
 *
 * 事故模型：半透明图标被合成到纯色底 Mat 后，又按原 alpha 抠出，
 *   观测色 C_obs = C_true * a + Mat * (1 - a)
 * 因而逆推：
 *   C_true = (C_obs - (1 - a) * Mat) / a
 *
 * 安全约束（对应需求）：
 *   - 只处理 0 < alpha < 255 的像素；alpha=255 的真实白/高光一律不动
 *   - alpha=0 的全透明像素原样保留（仍然透明）
 *   - 保护区像素完全跳过
 *   - 逆推值裁剪到 [0,255]，避免出现反色/溢出
 *   - 接近全透明（alpha 低于阈值）时除法不可靠，默认改用周围不透明/
 *     高可信像素的颜色填充，并在结果中标记为低可信
 */
(function (global) {
  "use strict";

  function clamp255(v) {
    return v < 0 ? 0 : v > 255 ? 255 : v;
  }

  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
    if (!m) throw new Error("颜色格式应为 #rrggbb：" + hex);
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function rgbToHex(r, g, b) {
    const h = (v) => clamp255(Math.round(v)).toString(16).padStart(2, "0");
    return "#" + h(r) + h(g) + h(b);
  }

  function defaultSettings() {
    return {
      matColor: "#ffffff", // 过去导出时使用的底色
      strength: 1.0, // 边缘强度 0..1，1 = 完全去底色
      lowAlphaThreshold: 40, // alpha 低于该值视为颜色不可可靠恢复
      lowAlphaMode: "neighbor", // neighbor=邻色填充 / keep=保留观测色
    };
  }

  // 低可信位标记
  const FLAG_LOW_ALPHA = 1;
  const FLAG_CLIPPED = 2;
  const FLAG_NO_REFERENCE = 4;

  /**
   * @param {object} opts
   *   width,height: 图像尺寸
   *   src: 原始 RGBA（Uint8ClampedArray，不会被修改）
   *   mask: Uint8Array(w*h)，255=保护区；可为 null
   *   settings: defaultSettings() 同结构
   * @returns {{data:Uint8ClampedArray, flags:Uint8Array, stats:object}}
   */
  function unmixEdges(opts) {
    const { width: w, height: h, src } = opts;
    const settings = Object.assign(defaultSettings(), opts.settings || {});
    const mask = opts.mask || new Uint8Array(w * h);
    const [mr, mg, mb] = hexToRgb(settings.matColor);
    const k = clamp255(settings.strength * 255) / 255;
    const thr = Math.max(1, Math.min(254, settings.lowAlphaThreshold | 0));

    const out = new Uint8ClampedArray(src.length);
    const flags = new Uint8Array(w * h);
    const stats = {
      width: w,
      height: h,
      fullyTransparent: 0,
      opaque: 0,
      semiTransparent: 0,
      processed: 0,
      protectedPixels: 0,
      lowConfidence: 0,
      clipped: 0,
      lowAlphaFilled: 0,
      lowAlphaKept: 0,
    };

    // ---- 第一遍：常规逆推（跳过全透明、不透明、保护区）----
    for (let p = 0; p < w * h; p++) {
      const i = p * 4;
      const a = src[i + 3];

      if (a === 0) {
        out[i] = src[i];
        out[i + 1] = src[i + 1];
        out[i + 2] = src[i + 2];
        out[i + 3] = 0;
        stats.fullyTransparent++;
        continue;
      }
      if (a === 255) {
        out[i] = src[i];
        out[i + 1] = src[i + 1];
        out[i + 2] = src[i + 2];
        out[i + 3] = 255;
        stats.opaque++;
        continue;
      }

      stats.semiTransparent++;

      if (mask[p] === 255) {
        out[i] = src[i];
        out[i + 1] = src[i + 1];
        out[i + 2] = src[i + 2];
        out[i + 3] = a;
        stats.protectedPixels++;
        continue;
      }

      // 接近全透明时，除法把量化误差放大到不可接受，颜色无法可靠恢复：
      // 这里只标记并原样保留，交给第二遍按策略处理（邻色填充 / 保留观测色）
      if (a < thr) {
        flags[p] = FLAG_LOW_ALPHA;
        stats.lowConfidence++;
        out[i] = src[i];
        out[i + 1] = src[i + 1];
        out[i + 2] = src[i + 2];
        out[i + 3] = a;
        continue;
      }

      const af = a / 255;
      const inv = 1 - af;
      // 未裁剪的原始逆推值，用于判断假设是否成立
      const ur = (src[i] - inv * mr) / af;
      const ug = (src[i + 1] - inv * mg) / af;
      const ub = (src[i + 2] - inv * mb) / af;
      if (ur < 0 || ur > 255 || ug < 0 || ug > 255 || ub < 0 || ub > 255) {
        flags[p] = FLAG_CLIPPED;
        stats.clipped++;
        stats.lowConfidence++;
      }

      // 裁剪后按边缘强度在“观测色 ↔ 完全校正色”之间插值
      out[i] = src[i] + (clamp255(ur) - src[i]) * k;
      out[i + 1] = src[i + 1] + (clamp255(ug) - src[i + 1]) * k;
      out[i + 2] = src[i + 2] + (clamp255(ub) - src[i + 2]) * k;
      out[i + 3] = a; // alpha 永远不变
      stats.processed++;
    }

    // ---- 第二遍：低透明像素无法靠除法可靠恢复 ----
    if (settings.lowAlphaMode === "neighbor") {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const p = y * w + x;
          const i = p * 4;
          const a = src[i + 3];
          if (a === 0 || a === 255 || a >= thr || mask[p] === 255) continue;

          let rs = 0,
            gs = 0,
            bs = 0,
            cnt = 0;
          for (let dy = -1; dy <= 1; dy++) {
            const ny = y + dy;
            if (ny < 0 || ny >= h) continue;
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dy === 0) continue;
              const nx = x + dx;
              if (nx < 0 || nx >= w) continue;
              const q = ny * w + nx;
              if (mask[q] === 255) continue;
              if (src[q * 4 + 3] < thr) continue; // 只信高可信邻居
              const j = q * 4;
              rs += out[j];
              gs += out[j + 1];
              bs += out[j + 2];
              cnt++;
            }
          }

          if (cnt > 0) {
            const ar = rs / cnt,
              ag = gs / cnt,
              ab = bs / cnt;
            // 同样受边缘强度控制，强度 0 时等于不动
            out[i] = out[i] + (ar - out[i]) * k;
            out[i + 1] = out[i + 1] + (ag - out[i + 1]) * k;
            out[i + 2] = out[i + 2] + (ab - out[i + 2]) * k;
            stats.lowAlphaFilled++;
          } else {
            flags[p] |= FLAG_NO_REFERENCE;
            stats.lowAlphaKept++;
          }
        }
      }
    } else {
      for (let p = 0; p < w * h; p++) {
        const a = src[p * 4 + 3];
        if (a > 0 && a < thr && mask[p] !== 255) {
          flags[p] |= FLAG_LOW_ALPHA;
          stats.lowAlphaKept++;
        }
      }
    }

    return { data: out, flags, stats };
  }

  const api = {
    unmixEdges,
    hexToRgb,
    rgbToHex,
    clamp255,
    defaultSettings,
    FLAG_LOW_ALPHA,
    FLAG_CLIPPED,
    FLAG_NO_REFERENCE,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    global.EdgeUnmix = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
