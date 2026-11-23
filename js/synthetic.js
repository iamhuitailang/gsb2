/*
 * 内置演示：程序化生成一张规则等距角度标记的罐体环绕纹理，
 * 再用正交投影 + cosθ 光照渲染两个有重叠的视角。
 * 与 tools/cyl_tool.py generate 使用同一套纹理约定：
 * 每 10° 一条竖刻度，每 30° 一条粗刻度并标角度数字，
 * 展开后相邻细刻度间距 = 纹理宽 / 36 像素。
 */
(function (global) {
  'use strict';

  const DEG = Math.PI / 180;

  /** 生成环绕纹理（equirectangular，x=角度 0..360，y=轴向） */
  function makeTexture(W = 1440, H = 720) {
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#f2ead8'); g.addColorStop(0.5, '#e8dcc2'); g.addColorStop(1, '#d9c9a8');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // 模拟标签上“同样大小的字”：每 30° 放一个等宽文字块，验证展开后宽度一致
    ctx.fillStyle = '#1c3d6e';
    ctx.font = `bold ${Math.round(H * 0.11)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let a = 0; a < 360; a += 30) {
      const x = a / 360 * W;
      ctx.fillText(String(a), x, H * 0.28);
      ctx.fillText('LABEL', x, H * 0.72);
    }
    // 等距刻度：每 10° 细线，每 30° 粗线
    for (let a = 0; a < 360; a += 10) {
      const x = a / 360 * W;
      const major = a % 30 === 0;
      ctx.fillStyle = major ? '#b3261e' : '#555';
      ctx.fillRect(x - (major ? 2 : 1), H * 0.42, major ? 4 : 2, H * 0.16);
    }
    // 上下缘边框
    ctx.fillStyle = '#1c3d6e';
    ctx.fillRect(0, H * 0.06, W, 6);
    ctx.fillRect(0, H * 0.94 - 6, W, 6);
    return cv;
  }

  /**
   * 渲染单个视角。
   * @param texCanvas 环绕纹理
   * @param centerDeg 视角中心正对的角度
   * @param fovDeg    可见半角（正交投影下画面覆盖 ±fov）
   * @param R 圆柱半径（像素），L 轴向半高
   * @param brightness 视角整体亮度系数（模拟两视角曝光差异）
   */
  function renderView(texCanvas, centerDeg, fovDeg = 80, R = 260, L = 300, brightness = 1, tiltDeg = 0) {
    const pad = 40;
    const w = Math.round(2 * (R * Math.sin(fovDeg * DEG)) + pad * 2);
    const h = Math.round(2 * L + pad * 2);
    const cx = w / 2, cy = h / 2;
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#20242b';
    ctx.fillRect(0, 0, w, h);

    const tctx = texCanvas.getContext('2d', { willReadFrequently: true });
    const tex = tctx.getImageData(0, 0, texCanvas.width, texCanvas.height);
    const out = ctx.getImageData(0, 0, w, h);
    const TW = texCanvas.width, TH = texCanvas.height;
    const cRad = centerDeg * DEG;

    for (let py = 0; py < h; py++) {
      for (let px = 0; px < w; px++) {
        const dx = px - cx, dy = py - cy;
        const xn = dx / R;
        if (Math.abs(xn) > 1 || Math.abs(dy) > L) continue;
        const theta = Math.asin(xn);                 // 该像素对应中心角
        if (Math.abs(theta) > fovDeg * DEG) continue;
        const surf = Math.cos(theta);                // 朝向因子
        const worldA = cRad + theta;
        let tx = ((worldA % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) / (2 * Math.PI) * TW;
        const ty = (dy / L + 1) / 2 * TH;
        const i0 = (Math.min(TH - 1, Math.floor(ty)) * TW + Math.min(TW - 1, Math.floor(tx))) * 4;
        const shade = (0.35 + 0.65 * surf) * brightness;
        const o = (py * w + px) * 4;
        out.data[o] = Math.min(255, tex.data[i0] * shade);
        out.data[o + 1] = Math.min(255, tex.data[i0 + 1] * shade);
        out.data[o + 2] = Math.min(255, tex.data[i0 + 2] * shade);
        out.data[o + 3] = 255;
      }
    }
    ctx.putImageData(out, 0, 0);

    if (tiltDeg) {
      const rot = document.createElement('canvas');
      rot.width = w; rot.height = h;
      const rctx = rot.getContext('2d');
      rctx.fillStyle = '#20242b';
      rctx.fillRect(0, 0, w, h);
      rctx.translate(w / 2, h / 2);
      rctx.rotate(tiltDeg * DEG);
      rctx.drawImage(cv, -w / 2, -h / 2);
      return rot;
    }
    return cv;
  }

  /**
   * 生成演示工程：两个 80° 半角视角，中心相差 140°，
   * 重合区 = 20°，未拍到背面 = 360-300 = 60°。
   * B 视角压暗 15%，用于亮度分歧演示。
   */
  function buildDemo() {
    const tex = makeTexture();
    const viewA = renderView(tex, 0, 80, 260, 300, 1.0, 0);
    const viewB = renderView(tex, 140, 80, 260, 300, 0.85, 0);
    return {
      texture: tex,
      views: [
        { canvas: viewA, centerDeg: 0, fovDeg: 80, R: 260, L: 300 },
        { canvas: viewB, centerDeg: 140, fovDeg: 80, R: 260, L: 300 },
      ],
    };
  }

  global.CylSynthetic = { makeTexture, renderView, buildDemo, DEG };
})(typeof window !== 'undefined' ? window : globalThis);
