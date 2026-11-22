/* correction.js — 边缘区域局部平滑修正
 *
 * 原理（以竖向接缝为例，逐行、逐通道）：
 *   设左边缘像素 L = I[0]，右边缘像素 R = I[W-1]，接缝电平差 d = R − L。
 *   宽度 w 内做环绕式 feather，权重 ramp(k) = smoothstep(1 − k/w)：
 *     左侧（距左边缘 k 列）:  I'[x] = I[x] + d/2 · ramp(k)
 *     右侧（距右边缘 k 列）:  I'[x] = I[x] − d/2 · ramp(k)
 *   · k=0（接缝边缘）权重 1：强度 100% 时 I'[0] = (L+R)/2 = I'[W-1]，严格相等
 *   · k=w（宽度边界）权重 0：边界处与内部像素逐像素一致，不产生台阶
 *   · smoothstep 在接缝点导数为 0 且两侧对称：环绕拼接点的二阶亮度差分
 *     与纹理内部噪声同级，修正本身不会引入新的“走势缝”
 * 保护区 mask：0=保护（不改动），255=可修正，作为每像素强度系数。
 */
(function (global) {
  'use strict';
  const C = (typeof module !== 'undefined' && module.exports)
    ? require('./core.js')
    : global.SeamCore;

  /**
   * @param buf      原始/当前像素缓冲
   * @param opts     { axis:'v'|'h', strength:0..1, width:像素,
   *                   mask:Uint8Array|null（与图像素数相同，255=可改，0=保护） }
   * @returns 新缓冲
   */
  function featherEdge(buf, opts) {
    const { data, width: W, height: H } = buf;
    const out = C.makeBuffer(W, H);
    out.data.set(data);
    const strength = C.clamp(opts.strength || 0, 0, 1);
    if (strength === 0) return out;
    const mask = opts.mask || null;
    const od = out.data;

    if (opts.axis === 'v') {
      const w = Math.min(opts.width || 1, Math.floor(W / 2));
      for (let y = 0; y < H; y++) {
        for (let c = 0; c < 3; c++) {
          const iL = C.idx(0, y, W) + c;
          const iR = C.idx(W - 1, y, W) + c;
          // d 必须在修改前从原始输入固定，否则每轮读到被改过的边缘值会让修正量衰减
          const d = data[iR] - data[iL];
          const half = d * 0.5 * strength;
          for (let k = 0; k < w; k++) {
            // smoothstep ramp：接缝边缘权重 1，k=w 处精确归零（无内部台阶）
            const s = C.smoothstep(1 - k / w);
            const pL = C.idx(k, y, W) + c;
            const pR = C.idx(W - 1 - k, y, W) + c;
            // mask 为每像素单字节（长度 W*H），需用像素索引而非 RGBA 偏移
            const mL = mask ? mask[y * W + k] / 255 : 1;
            const mR = mask ? mask[y * W + (W - 1 - k)] / 255 : 1;
            const targetL = data[pL] + half * s * mL;
            const targetR = data[pR] - half * s * mR;
            od[pL] = C.clamp(Math.round(targetL), 0, 255);
            od[pR] = C.clamp(Math.round(targetR), 0, 255);
          }
        }
      }
    } else {
      const w = Math.min(opts.width || 1, Math.floor(H / 2));
      for (let x = 0; x < W; x++) {
        for (let c = 0; c < 3; c++) {
          const iT = C.idx(x, 0, W) + c;
          const iB = C.idx(x, H - 1, W) + c;
          const d = data[iB] - data[iT];
          const half = d * 0.5 * strength;
          for (let k = 0; k < w; k++) {
            const s = C.smoothstep(1 - k / w);
            const pT = C.idx(x, k, W) + c;
            const pB = C.idx(x, H - 1 - k, W) + c;
            const mT = mask ? mask[k * W + x] / 255 : 1;
            const mB = mask ? mask[(H - 1 - k) * W + x] / 255 : 1;
            const targetT = data[pT] + half * s * mT;
            const targetB = data[pB] - half * s * mB;
            od[pT] = C.clamp(Math.round(targetT), 0, 255);
            od[pB] = C.clamp(Math.round(targetB), 0, 255);
          }
        }
      }
    }
    return out;
  }

  /**
   * 依次应用竖向、横向修正。
   * @param baseBuf  原始缓冲
   * @param params   { vStrength,vWidth,hStrength,hWidth }
   * @param mask     保护 mask（Uint8ClampedArray，W*H，255=可改，0=保护）
   */
  function applyCorrection(baseBuf, params, mask) {
    let buf = baseBuf;
    if (params.vStrength > 0 && params.vWidth > 0) {
      buf = featherEdge(buf, {
        axis: 'v', strength: params.vStrength, width: params.vWidth, mask,
      });
    }
    if (params.hStrength > 0 && params.hWidth > 0) {
      buf = featherEdge(buf, {
        axis: 'h', strength: params.hStrength, width: params.hWidth, mask,
      });
    }
    return buf === baseBuf ? C.copyBuffer(baseBuf) : buf;
  }

  const api = { featherEdge, applyCorrection };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.SeamCorrection = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
