/**
 * color.js — 核心色彩科学算法（无第三方依赖）
 *
 * 同时挂到浏览器 window.C 与 Node module.exports，便于在 Node 下做单测。
 * 所有像素入参统一为 sRGB 0-255；分析计算时先转线性光再转 Lab。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.C = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- 基础工具 ----------
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function clamp255(v) { return clamp(Math.round(v), 0, 255); }

  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(String(hex).trim());
    if (!m) throw new Error('颜色格式应为 #rrggbb: ' + hex);
    let h = m[1];
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
    };
  }
  function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(v => clamp255(v).toString(16).padStart(2, '0')).join('');
  }

  // ---------- sRGB 线性化 / 编码 ----------
  function srgbToLinear(c) {
    const cs = c / 255;
    return cs <= 0.04045 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4);
  }
  function linearToSrgb(c) {
    const cs = clamp(c, 0, 1);
    return (cs <= 0.0031308 ? cs * 12.92 : 1.055 * Math.pow(cs, 1 / 2.4) - 0.055) * 255;
  }

  // ---------- XYZ / Lab（D65） ----------
  function rgbToXyz(r, g, b) {
    const R = srgbToLinear(r), G = srgbToLinear(g), B = srgbToLinear(b);
    // sRGB D65 矩阵
    return {
      x: (R * 0.4124564 + G * 0.3575761 + B * 0.1804375) * 100,
      y: (R * 0.2126729 + G * 0.7151522 + B * 0.0721750) * 100,
      z: (R * 0.0193339 + G * 0.1191920 + B * 0.9503041) * 100,
    };
  }
  const Xn = 95.047, Yn = 100, Zn = 108.883;
  const EPS = 216 / 24389;   // (6/29)^3
  const KAPPA = 24389 / 27;  // (29/3)^3
  function fLab(t) { return t > EPS ? Math.cbrt(t) : (KAPPA * t + 16) / 116; }
  function fInv(t) { return t > 6 / 29 ? t * t * t : (116 * t - 16) / KAPPA; }

  function xyzToLab(x, y, z) {
    const fx = fLab(x / Xn), fy = fLab(y / Yn), fz = fLab(z / Zn);
    return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
  }
  function labToXyz(L, a, b) {
    const fy = (L + 16) / 116, fx = a / 500 + fy, fz = fy - b / 200;
    return { x: fInv(fx) * Xn, y: fInv(fy) * Yn, z: fInv(fz) * Zn };
  }
  function xyzToRgb(x, y, z) {
    const R = (x * 3.2404542 + y * -1.5371385 + z * -0.4985314) / 100;
    const G = (x * -0.9692660 + y * 1.8760108 + z * 0.0415560) / 100;
    const B = (x * 0.0556434 + y * -0.2040259 + z * 1.0572252) / 100;
    return { r: linearToSrgb(R), g: linearToSrgb(G), b: linearToSrgb(B) };
  }
  function rgbToLab(r, g, b) {
    const xyz = rgbToXyz(r, g, b);
    return xyzToLab(xyz.x, xyz.y, xyz.z);
  }
  function labToRgb(L, a, b) {
    const xyz = labToXyz(L, a, b);
    return xyzToRgb(xyz.x, xyz.y, xyz.z);
  }

  // ---------- 色差 ----------
  /** CIEDE2000 色差（Sharma 参考实现，单位 ΔE00） */
  function deltaE2000(lab1, lab2) {
    const { L: L1, a: a1, b: b1 } = lab1;
    const { L: L2, a: a2, b: b2 } = lab2;
    const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2);
    const Cbar = (C1 + C2) / 2;
    const Cbar7 = Math.pow(Cbar, 7);
    const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + Math.pow(25, 7))));
    const ap1 = (1 + G) * a1, ap2 = (1 + G) * a2;
    const Cp1 = Math.hypot(ap1, b1), Cp2 = Math.hypot(ap2, b2);
    const hp1 = Cp1 === 0 ? 0 : ((Math.atan2(b1, ap1) * 180 / Math.PI) + 360) % 360;
    const hp2 = Cp2 === 0 ? 0 : ((Math.atan2(b2, ap2) * 180 / Math.PI) + 360) % 360;

    const dLp = L2 - L1;
    const dCp = Cp2 - Cp1;
    let dhp = 0;
    if (Cp1 !== 0 && Cp2 !== 0) {
      const d = hp2 - hp1;
      dhp = Math.abs(d) <= 180 ? d : d > 180 ? d - 360 : d + 360;
    }
    const dHp = 2 * Math.sqrt(Cp1 * Cp2) * Math.sin((dhp / 2) * Math.PI / 180);

    const Lbp = (L1 + L2) / 2;
    const Cbp = (Cp1 + Cp2) / 2;
    let hbp = hp1 + hp2;
    if (Cp1 !== 0 && Cp2 !== 0) {
      if (Math.abs(hp1 - hp2) > 180) {
        hbp = (hp1 + hp2 < 360 ? hbp + 360 : hbp - 360) / 2;
      } else {
        hbp /= 2;
      }
    }
    const T = 1
      - 0.17 * Math.cos((hbp - 30) * Math.PI / 180)
      + 0.24 * Math.cos((2 * hbp) * Math.PI / 180)
      + 0.32 * Math.cos((3 * hbp + 6) * Math.PI / 180)
      - 0.20 * Math.cos((4 * hbp - 63) * Math.PI / 180);
    const dTheta = 30 * Math.exp(-Math.pow((hbp - 275) / 25, 2));
    const Cbp7 = Math.pow(Cbp, 7);
    const Rc = 2 * Math.sqrt(Cbp7 / (Cbp7 + Math.pow(25, 7)));
    const Sl = 1 + (0.015 * Math.pow(Lbp - 50, 2)) / Math.sqrt(20 + Math.pow(Lbp - 50, 2));
    const Sc = 1 + 0.045 * Cbp;
    const Sh = 1 + 0.015 * Cbp * T;
    const Rt = -Math.sin((2 * dTheta) * Math.PI / 180) * Rc;
    const kL = 1, kC = 1, kH = 1;
    return Math.sqrt(
      Math.pow(dLp / (kL * Sl), 2) +
      Math.pow(dCp / (kC * Sc), 2) +
      Math.pow(dHp / (kH * Sh), 2) +
      Rt * (dCp / (kC * Sc)) * (dHp / (kH * Sh))
    );
  }
  /** CIELAB 欧氏距离，扫描阶段的快速近似指标 */
  function deltaE76(lab1, lab2) {
    return Math.hypot(lab1.L - lab2.L, lab1.a - lab2.a, lab1.b - lab2.b);
  }

  // ---------- WCAG 亮度与对比度（补充指标，仅用于不透明像素） ----------
  function luminanceWCAG(r, g, b) {
    const R = srgbToLinear(r), G = srgbToLinear(g), B = srgbToLinear(b);
    return 0.2126 * R + 0.7152 * G + 0.0722 * B;
  }
  function contrastRatio(rgb1, rgb2) {
    const L1 = luminanceWCAG(rgb1.r, rgb1.g, rgb1.b);
    const L2 = luminanceWCAG(rgb2.r, rgb2.g, rgb2.b);
    const hi = Math.max(L1, L2), lo = Math.min(L1, L2);
    return (hi + 0.05) / (lo + 0.05);
  }

  // ---------- 色觉模拟 ----------
  // Machado, Oliveira & Fernandes (2009)，严重度 1.0，作用于 gamma sRGB（标准用法）
  const CVD_MATRICES = {
    protan: [
      [0.152286, 1.052583, -0.204868],
      [0.114503, 0.786281, 0.099216],
      [-0.003882, -0.048116, 1.051998],
    ],
    deutan: [
      [0.367322, 0.860646, -0.227968],
      [0.280085, 0.672501, 0.047413],
      [-0.011820, 0.042940, 0.968881],
    ],
    tritan: [
      [1.255528, -0.076749, -0.178779],
      [-0.078411, 0.930809, 0.147602],
      [0.004733, 0.691367, 0.303900],
    ],
  };
  /** 返回浮点 sRGB（不四舍五入，供分析用） */
  function simulateCVD(r, g, b, type) {
    const M = CVD_MATRICES[type];
    if (!M) throw new Error('未知色觉类型: ' + type);
    return {
      r: M[0][0] * r + M[0][1] * g + M[0][2] * b,
      g: M[1][0] * r + M[1][1] * g + M[1][2] * b,
      b: M[2][0] * r + M[2][1] * g + M[2][2] * b,
    };
  }
  /** 灰度：线性光 Rec.709 亮度后重新编码 sRGB，三通道相同 */
  function grayscale(r, g, b) {
    const y = srgbToLinear(r) * 0.2126 + srgbToLinear(g) * 0.7152 + srgbToLinear(b) * 0.0722;
    const v = linearToSrgb(y);
    return { r: v, g: v, b: v };
  }

  /** 对整帧 RGBA 应用视图模式（alpha 保持不变），返回新的 Uint8ClampedArray */
  function transformFrame(data, mode) {
    const out = new Uint8ClampedArray(data.length);
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3];
      let r = data[i], g = data[i + 1], b = data[i + 2];
      if (mode !== 'normal') {
        const c = mode === 'gray' ? grayscale(r, g, b) : simulateCVD(r, g, b, mode);
        r = c.r; g = c.g; b = c.b;
      }
      out[i] = clamp255(r);
      out[i + 1] = clamp255(g);
      out[i + 2] = clamp255(b);
      out[i + 3] = a;
    }
    return out;
  }

  // ---------- 改色：Lab LCh 色相旋转（保留明度与明暗造型） ----------
  function rotateHueRGBA(r, g, b, hueDeg, satScale) {
    const lab = rgbToLab(r, g, b);
    const C = Math.hypot(lab.a, lab.b) * (satScale == null ? 1 : satScale);
    let h = Math.atan2(lab.b, lab.a) * 180 / Math.PI;
    h = ((h + hueDeg) % 360 + 360) % 360;
    const hr = h * Math.PI / 180;
    const rgb = labToRgb(lab.L, C * Math.cos(hr), C * Math.sin(hr));
    return { r: rgb.r, g: rgb.g, b: rgb.b };
  }

  return {
    clamp, clamp255, hexToRgb, rgbToHex,
    srgbToLinear, linearToSrgb,
    rgbToXyz, xyzToLab, rgbToLab, labToRgb,
    deltaE2000, deltaE76,
    luminanceWCAG, contrastRatio,
    CVD_MATRICES, simulateCVD, grayscale, transformFrame,
    rotateHueRGBA,
  };
});
