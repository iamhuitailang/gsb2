/*
 * encoder.js — 程序化 GIF 编码器（LZW 压缩）与测试样例生成。
 * 用于在应用内生成“同等示例”：局部帧、透明边缘、画布恢复、零时长帧、截断文件。
 * 浏览器（window.GifEncoder）与 Node（module.exports）通用。
 */
(function (global) {
  'use strict';

  // ---------------------------------------------------------------- LZW 压缩

  function lzwEncode(minCodeSize, indices) {
    const clearCode = 1 << minCodeSize;
    const eoiCode = clearCode + 1;
    const bytes = [];
    let cur = 0, curBits = 0;
    let codeSize, nextCode, dict;
    function emit(code) {
      cur |= code << curBits;
      curBits += codeSize;
      while (curBits >= 8) { bytes.push(cur & 255); cur >>= 8; curBits -= 8; }
    }
    function reset() { dict = new Map(); nextCode = eoiCode + 1; codeSize = minCodeSize + 1; }
    reset();
    emit(clearCode);
    let prefix = indices[0];
    for (let i = 1; i < indices.length; i++) {
      const k = indices[i];
      const key = prefix * 256 + k;
      const found = dict.get(key);
      if (found !== undefined) { prefix = found; continue; }
      emit(prefix);
      dict.set(key, nextCode++);
      // 编码器比解码器“领先一个词条”：nextCode 超过当前位宽时才升位
      if (nextCode > (1 << codeSize) && codeSize < 12) codeSize++;
      if (nextCode >= 4096) { emit(clearCode); reset(); }
      prefix = k;
    }
    emit(prefix);
    emit(eoiCode);
    if (curBits > 0) bytes.push(cur & 255);
    return new Uint8Array(bytes);
  }

  // ---------------------------------------------------------------- GIF 写出

  function minCodeSizeFor(paletteSize) {
    let bits = 1;
    while ((1 << bits) < paletteSize) bits++;
    return Math.max(2, bits); // GIF 规定最小为 2
  }

  /*
   * spec: {
   *   width, height, palette: [[r,g,b],...], backgroundIndex?,
   *   loop: null | 0(无限) | n,
   *   frames: [{ left, top, width, height, indices: Uint8Array,
   *              delayCs, disposal, transparentIndex: null|n, interlaced? }]
   * }
   */
  function encodeGif(spec) {
    const out = [];
    const push = function () { for (let i = 0; i < arguments.length; i++) out.push(arguments[i]); };
    const pushStr = function (s) { for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i)); };
    const push16 = function (v) { out.push(v & 255, (v >> 8) & 255); };
    const pushSubBlocks = function (data) {
      for (let o = 0; o < data.length; o += 255) {
        const n = Math.min(255, data.length - o);
        out.push(n);
        for (let i = 0; i < n; i++) out.push(data[o + i]);
      }
      out.push(0);
    };

    const pal = spec.palette;
    const palBits = minCodeSizeFor(pal.length);
    const palSize = 1 << palBits; // 调色板需补齐到 2 的幂
    const mcs = minCodeSizeFor(pal.length);

    pushStr('GIF89a');
    push16(spec.width); push16(spec.height);
    out.push(0x80 | 0x70 | (palBits - 1)); // GCT 标志 + 色深 + GCT 大小
    out.push(spec.backgroundIndex || 0, 0);
    for (let i = 0; i < palSize; i++) {
      const c = pal[i] || [0, 0, 0];
      push(c[0], c[1], c[2]);
    }
    if (spec.loop !== null && spec.loop !== undefined) {
      push(0x21, 0xFF, 11);
      pushStr('NETSCAPE2.0');
      push(3, 1); push16(spec.loop); push(0);
    }
    for (const f of spec.frames) {
      // 图形控制扩展
      push(0x21, 0xF9, 4);
      out.push(((f.disposal & 7) << 2) | (f.transparentIndex !== null && f.transparentIndex !== undefined ? 1 : 0));
      push16(f.delayCs || 0);
      out.push(f.transparentIndex || 0, 0);
      // 图像描述符
      out.push(0x2C);
      push16(f.left || 0); push16(f.top || 0);
      push16(f.width); push16(f.height);
      out.push(f.interlaced ? 0x40 : 0);
      // 图像数据
      out.push(mcs);
      pushSubBlocks(lzwEncode(mcs, f.indices));
    }
    out.push(0x3B);
    return new Uint8Array(out);
  }

  // ---------------------------------------------------------------- 样例

  const PALETTE = [
    [32, 36, 44],    // 0 深底
    [58, 123, 213],  // 1 蓝
    [231, 76, 60],   // 2 红
    [46, 204, 113],  // 3 绿
    [241, 196, 15],  // 4 黄
    [255, 255, 255], // 5 白
    [155, 89, 182],  // 6 紫
    [0, 188, 212],   // 7 青（兼作透明色槽位）
  ];
  const TRANSPARENT_SLOT = 7;

  function fill(w, h, fn) {
    const a = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) a[y * w + x] = fn(x, y);
    return a;
  }

  // 带透明圆角的方块局部帧
  function spriteIndices(size, colorIdx) {
    return fill(size, size, function (x, y) {
      const r = 3;
      const inCorner =
        (x < r && y < r && (x - r) * (x - r) + (y - r) * (y - r) > r * r) ||
        (x >= size - r && y < r && (x - (size - 1 - r)) * (x - (size - 1 - r)) + (y - r) * (y - r) > r * r) ||
        (x < r && y >= size - r && (x - r) * (x - r) + (y - (size - 1 - r)) * (y - (size - 1 - r)) > r * r) ||
        (x >= size - r && y >= size - r && (x - (size - 1 - r)) * (x - (size - 1 - r)) + (y - (size - 1 - r)) * (y - (size - 1 - r)) > r * r);
      return inCorner ? TRANSPARENT_SLOT : colorIdx;
    });
  }

  // 样例 1：局部帧 + 三种处置方式 + 零时长帧 + 无限循环
  function buildSampleDisposalMix() {
    const W = 64, H = 64;
    const frames = [
      { // 0：全帧底图（带斜线，便于观察残影）
        left: 0, top: 0, width: W, height: H,
        indices: fill(W, H, function (x, y) { return ((x + y) % 16 === 0) ? 5 : 0; }),
        delayCs: 50, disposal: 1, transparentIndex: null,
      },
      { // 1：绿色局部块，透明圆角，保留叠加
        left: 8, top: 8, width: 16, height: 16,
        indices: spriteIndices(16, 3),
        delayCs: 20, disposal: 1, transparentIndex: TRANSPARENT_SLOT,
      },
      { // 2：红色局部块，结束后“恢复为背景”——帧 1 的区域应被清掉
        left: 36, top: 12, width: 16, height: 16,
        indices: spriteIndices(16, 2),
        delayCs: 20, disposal: 2, transparentIndex: TRANSPARENT_SLOT,
      },
      { // 3：黄色局部块，结束后“恢复为此前画面”
        left: 20, top: 38, width: 16, height: 16,
        indices: spriteIndices(16, 4),
        delayCs: 20, disposal: 3, transparentIndex: TRANSPARENT_SLOT,
      },
      { // 4：零时长小帧（浏览器实际按 100ms 播放）
        left: 44, top: 44, width: 8, height: 8,
        indices: fill(8, 8, function () { return 6; }),
        delayCs: 0, disposal: 1, transparentIndex: null,
      },
      { // 5：全帧蓝色闪屏，结束后恢复背景
        left: 0, top: 0, width: W, height: H,
        indices: fill(W, H, function (x, y) { return ((x * y) % 24 === 0) ? 7 : 1; }),
        delayCs: 40, disposal: 2, transparentIndex: null,
      },
    ];
    return {
      name: '样例1-局部帧与三种处置方式.gif',
      desc: '6 帧：局部帧、透明圆角、保留/恢复背景/恢复此前、零时长帧、无限循环',
      bytes: encodeGif({ width: W, height: H, palette: PALETTE, loop: 0, frames: frames }),
    };
  }

  // 样例 2：连续的“恢复为此前画面”叠加链 + 有限循环
  function buildSampleRestoreChain() {
    const W = 48, H = 48;
    const frames = [
      {
        left: 0, top: 0, width: W, height: H,
        indices: fill(W, H, function (x, y) { return x < W / 2 ? 0 : 1; }),
        delayCs: 40, disposal: 1, transparentIndex: null,
      },
      {
        left: 6, top: 6, width: 20, height: 20,
        indices: spriteIndices(20, 7),
        delayCs: 25, disposal: 3, transparentIndex: TRANSPARENT_SLOT,
      },
      {
        left: 22, top: 22, width: 20, height: 20,
        indices: spriteIndices(20, 4),
        delayCs: 25, disposal: 3, transparentIndex: TRANSPARENT_SLOT,
      },
      {
        left: 30, top: 8, width: 10, height: 10,
        indices: fill(10, 10, function () { return 2; }),
        delayCs: 25, disposal: 2, transparentIndex: null,
      },
    ];
    return {
      name: '样例2-画布恢复链.gif',
      desc: '4 帧：两个连续的“恢复为此前画面”局部帧 + 恢复背景，循环 2 次',
      bytes: encodeGif({ width: W, height: H, palette: PALETTE, loop: 2, frames: frames }),
    };
  }

  // 样例 3：故意截断的文件（样例 1 的前 55%）
  function buildSampleTruncated() {
    const full = buildSampleDisposalMix();
    const cut = Math.floor(full.bytes.length * 0.55);
    return {
      name: '样例3-故意截断.gif',
      desc: '样例 1 截断到 55%（' + cut + '/' + full.bytes.length + ' 字节），解析器应容错并保留已读出的帧',
      bytes: full.bytes.slice(0, cut),
    };
  }

  function buildSamples() {
    return [buildSampleDisposalMix(), buildSampleRestoreChain(), buildSampleTruncated()];
  }

  const API = {
    lzwEncode: lzwEncode,
    encodeGif: encodeGif,
    buildSamples: buildSamples,
    buildSampleDisposalMix: buildSampleDisposalMix,
    buildSampleRestoreChain: buildSampleRestoreChain,
    buildSampleTruncated: buildSampleTruncated,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else global.GifEncoder = API;
})(typeof window !== 'undefined' ? window : globalThis);
