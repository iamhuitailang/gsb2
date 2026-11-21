/*
 * gif.js — GIF 二进制解析、LZW 解码、按处置方式(disposal)重建画面的合成器。
 * 同时可在浏览器（window.GifCore）与 Node（module.exports）下使用，便于自动化测试。
 *
 * 关键设计：
 * - 解析器对截断文件容错：已解析出的帧保留，truncated 标记置位。
 * - 合成器是纯函数式的：renderFrame(n) 的结果只取决于解析数据，
 *   随机跳帧与顺序播放必然一致（内部用缓存加速，但缓存值同样由重放得出）。
 */
(function (global) {
  'use strict';

  class GifTruncated extends Error {
    constructor(msg) { super(msg); this.name = 'GifTruncated'; }
  }

  const DISPOSAL_NAMES = {
    0: '未指定(按保留处理)',
    1: '保留 / 覆盖叠加',
    2: '恢复为背景',
    3: '恢复为此前画面',
  };

  // ---------------------------------------------------------------- 解析

  function parseGif(buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const out = {
      header: '', width: 0, height: 0,
      globalColorTable: null, bgColorIndex: 0,
      loopCount: null, // null=未声明(只播一次) 0=无限循环 n=循环次数
      frames: [], warnings: [], truncated: false, bytesLength: bytes.length,
    };
    let pos = 0;
    let hitTruncation = false;

    function need(n) {
      if (pos + n > bytes.length) {
        throw new GifTruncated('数据在偏移 0x' + pos.toString(16) + ' 处截断（文件共 ' + bytes.length + ' 字节）');
      }
    }
    function u8() { need(1); return bytes[pos++]; }
    function u16() { need(2); const v = bytes[pos] | (bytes[pos + 1] << 8); pos += 2; return v; }
    function readColorTable(n) {
      need(3 * n);
      const t = new Array(n);
      for (let i = 0; i < n; i++) { t[i] = [bytes[pos], bytes[pos + 1], bytes[pos + 2]]; pos += 3; }
      return t;
    }
    // 子块序列；容错：截断时返回已读到的部分并置标志
    function subBlocks() {
      const chunks = [];
      let total = 0;
      for (;;) {
        let n;
        try { n = u8(); } catch (e) { hitTruncation = true; break; }
        if (n === 0) break;
        if (pos + n > bytes.length) {
          chunks.push(bytes.subarray(pos)); total += bytes.length - pos;
          pos = bytes.length; hitTruncation = true; break;
        }
        chunks.push(bytes.subarray(pos, pos + n)); pos += n; total += n;
      }
      const r = new Uint8Array(total);
      let o = 0;
      for (const c of chunks) { r.set(c, o); o += c.length; }
      return r;
    }

    try {
      need(6);
      out.header = String.fromCharCode.apply(null, bytes.subarray(0, 6));
      pos = 6;
      if (!/^GIF8[79]a$/.test(out.header)) throw new Error('不是有效的 GIF 文件头: ' + JSON.stringify(out.header));

      out.width = u16(); out.height = u16();
      const packed = u8();
      out.bgColorIndex = u8();
      u8(); // 像素宽高比，忽略
      if (packed & 0x80) out.globalColorTable = readColorTable(1 << ((packed & 7) + 1));

      let gce = null; // 待消费的图形控制扩展
      for (;;) {
        const b = u8();
        if (b === 0x3B) break; // Trailer
        if (b === 0x21) { // 扩展块
          const label = u8();
          if (label === 0xF9) { // 图形控制扩展
            const size = u8();
            need(size);
            const p = bytes[pos];
            const delay = bytes[pos + 1] | (bytes[pos + 2] << 8);
            const tIdx = bytes[pos + 3];
            pos += size;
            try { u8(); } catch (e) { hitTruncation = true; } // 块终结符
            gce = {
              disposal: (p >> 2) & 7,
              userInput: !!(p & 2),
              transparentFlag: !!(p & 1),
              delayCs: delay,
              transparentIndex: tIdx,
            };
          } else if (label === 0xFF) { // 应用扩展（NETSCAPE 循环）
            const size = u8(); need(size);
            const appId = String.fromCharCode.apply(null, bytes.subarray(pos, pos + size));
            pos += size;
            const data = subBlocks();
            if (appId.indexOf('NETSCAPE') === 0 && data.length >= 3 && data[0] === 1) {
              out.loopCount = data[1] | (data[2] << 8);
            }
          } else if (label === 0x01) { // 明文扩展：固定 12 字节头 + 子块
            need(12); pos += 12; subBlocks();
          } else { // 注释扩展 0xFE 及其他：跳过子块
            subBlocks();
          }
        } else if (b === 0x2C) { // 图像描述符 + 图像数据
          const left = u16(), top = u16(), w = u16(), h = u16();
          const p = u8();
          const lct = (p & 0x80) ? readColorTable(1 << ((p & 7) + 1)) : null;
          const interlaced = !!(p & 0x40);
          const minCodeSize = u8();
          const data = subBlocks();
          const g = gce || { disposal: 0, delayCs: 0, transparentFlag: false, transparentIndex: 0 };
          gce = null;
          const frame = {
            index: out.frames.length,
            left: left, top: top, width: w, height: h,
            interlaced: interlaced,
            localColorTable: lct,
            minCodeSize: minCodeSize,
            disposal: g.disposal,
            delayCs: g.delayCs,
            transparentFlag: !!g.transparentFlag,
            transparentIndex: g.transparentIndex,
            pixels: null, palette: lct || out.globalColorTable,
            decodeComplete: true,
          };
          const expected = w * h;
          const dec = lzwDecode(minCodeSize, data, expected);
          frame.pixels = dec.indices;
          reorderInterlaced(frame); // 交错帧按 4 趟顺序重排为正常行序
          if (!dec.complete) {
            frame.decodeComplete = false;
            out.warnings.push('帧 ' + frame.index + ' 的像素数据不完整（' + dec.pixelsWritten + '/' + expected + '），其余像素按索引 0 填充');
          }
          if (!frame.palette) out.warnings.push('帧 ' + frame.index + ' 没有可用调色板');
          out.frames.push(frame);
          if (hitTruncation) throw new GifTruncated('文件尾部不完整，最后一帧可能残缺');
        } else {
          out.warnings.push('跳过未知块 0x' + b.toString(16) + '（偏移 0x' + (pos - 1).toString(16) + '），解析终止');
          break;
        }
      }
    } catch (e) {
      if (e instanceof GifTruncated || hitTruncation) {
        out.truncated = true;
        out.warnings.push(e.message || '文件被截断');
      } else {
        throw e;
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- LZW 解码

  function lzwDecode(minCodeSize, data, expectedCount) {
    const clearCode = 1 << minCodeSize;
    const eoiCode = clearCode + 1;
    const linear = new Uint8Array(expectedCount);
    let outPos = 0;
    let codeSize, nextCode, dict, prev;
    function resetDict() {
      dict = new Array(eoiCode + 1);
      for (let i = 0; i < clearCode; i++) dict[i] = [i];
      dict[clearCode] = null; dict[eoiCode] = null;
      nextCode = eoiCode + 1;
      codeSize = minCodeSize + 1;
      prev = null;
    }
    resetDict();
    let bitPos = 0;
    const totalBits = data.length * 8;
    function readCode() {
      if (bitPos + codeSize > totalBits) return -1;
      let v = 0;
      for (let i = 0; i < codeSize; i++) {
        const bp = bitPos + i;
        if (data[bp >> 3] & (1 << (bp & 7))) v |= 1 << i;
      }
      bitPos += codeSize;
      return v;
    }
    let complete = false;
    for (;;) {
      const code = readCode();
      if (code === -1) break; // 数据耗尽（截断）
      if (code === clearCode) { resetDict(); continue; }
      if (code === eoiCode) { complete = true; break; }
      let entry;
      if (code < nextCode && dict[code]) {
        entry = dict[code];
      } else if (code === nextCode && prev) {
        entry = prev.concat(prev[0]); // KwKwK 情形
      } else {
        throw new Error('LZW 码流损坏：code=' + code + '，nextCode=' + nextCode);
      }
      for (let i = 0; i < entry.length && outPos < expectedCount; i++) linear[outPos++] = entry[i];
      if (prev) {
        dict[nextCode++] = prev.concat(entry[0]);
        if (nextCode === (1 << codeSize) && codeSize < 12) codeSize++;
      }
      prev = entry;
      if (outPos >= expectedCount) { complete = true; break; } // 容忍缺失的 EOI
    }
    return { indices: linear, complete: complete && outPos >= expectedCount, pixelsWritten: outPos };
  }

  // GIF 交错：行顺序为 0,8,16… / 4,12… / 2,6… / 1,3…，重排为正常行序
  function reorderInterlaced(frame) {
    if (!frame.interlaced || !frame.pixels) return;
    const w = frame.width, h = frame.height;
    const src = frame.pixels;
    const dst = new Uint8Array(src.length);
    const starts = [0, 4, 2, 1], steps = [8, 8, 4, 2];
    let srcRow = 0;
    for (let p = 0; p < 4; p++) {
      for (let y = starts[p]; y < h; y += steps[p]) {
        dst.set(src.subarray(srcRow * w, (srcRow + 1) * w), y * w);
        srcRow++;
      }
    }
    frame.pixels = dst;
  }

  // ---------------------------------------------------------------- 合成器

  function createCompositor(parsed) {
    const W = parsed.width, H = parsed.height;
    const canvas = new Uint8ClampedArray(W * H * 4);
    const cache = new Map(); // index -> {pre, out}（均为画布副本）
    let savedForRestore = null; // 处置方式 3 使用的快照

    function bgFill() {
      const gct = parsed.globalColorTable;
      if (gct && parsed.bgColorIndex < gct.length) {
        const c = gct[parsed.bgColorIndex];
        return [c[0], c[1], c[2], 255];
      }
      return [0, 0, 0, 0];
    }

    // 在绘制下一帧之前，应用第 i 帧的处置方式
    function applyDisposal(i) {
      const f = parsed.frames[i];
      if (!f) return;
      if (f.disposal === 2) {
        // 与主流查看器一致：该帧若使用了透明色则清为透明，否则填逻辑屏幕背景色
        const fill = f.transparentFlag ? [0, 0, 0, 0] : bgFill();
        for (let y = 0; y < f.height; y++) {
          for (let x = 0; x < f.width; x++) {
            const o = ((f.top + y) * W + f.left + x) * 4;
            canvas[o] = fill[0]; canvas[o + 1] = fill[1];
            canvas[o + 2] = fill[2]; canvas[o + 3] = fill[3];
          }
        }
      } else if (f.disposal === 3) {
        if (savedForRestore) canvas.set(savedForRestore);
      }
      // 0/1：保留画布（覆盖叠加）
    }

    function drawFrame(i) {
      const f = parsed.frames[i];
      const pal = f.palette;
      if (!pal || !f.pixels) return;
      const tIdx = f.transparentFlag ? f.transparentIndex : -1;
      for (let y = 0; y < f.height; y++) {
        const rowBase = y * f.width;
        const outBase = (f.top + y) * W + f.left;
        for (let x = 0; x < f.width; x++) {
          const idx = f.pixels[rowBase + x];
          if (idx === tIdx) continue; // 透明色：保留下层画面
          const c = pal[idx] || [0, 0, 0];
          const o = (outBase + x) * 4;
          canvas[o] = c[0]; canvas[o + 1] = c[1]; canvas[o + 2] = c[2]; canvas[o + 3] = 255;
        }
      }
    }

    // 渲染第 n 帧合成结果；结果确定，与访问顺序无关
    function renderFrame(n) {
      if (n < 0 || n >= parsed.frames.length) throw new RangeError('帧序号越界: ' + n);
      const hit0 = cache.get(n);
      if (hit0) return hit0.out;

      let start = 0, m = -1;
      for (let k = n - 1; k >= 0; k--) { if (cache.has(k)) { m = k; break; } }
      if (m >= 0) {
        canvas.set(cache.get(m).out);
        // 若第 m 帧自身是“恢复为此前画面”，其快照就是 cache[m].pre
        savedForRestore = parsed.frames[m].disposal === 3 ? cache.get(m).pre : null;
        start = m + 1;
        applyDisposal(m);
      } else {
        canvas.fill(0);
        savedForRestore = null;
        start = 0;
      }
      for (let i = start; i <= n; i++) {
        const pre = canvas.slice();
        if (parsed.frames[i].disposal === 3) savedForRestore = pre;
        drawFrame(i);
        cache.set(i, { pre: pre, out: canvas.slice() });
        if (i < n) applyDisposal(i);
      }
      return cache.get(n).out;
    }

    // 本帧局部数据（未合成）：调色板展开为 RGBA，透明色 -> alpha 0
    function rawFrameRGBA(i) {
      const f = parsed.frames[i];
      const out = new Uint8ClampedArray(f.width * f.height * 4);
      const pal = f.palette;
      if (!pal || !f.pixels) return out;
      const tIdx = f.transparentFlag ? f.transparentIndex : -1;
      for (let p = 0; p < f.width * f.height; p++) {
        const idx = f.pixels[p];
        if (idx === tIdx) continue;
        const c = pal[idx] || [0, 0, 0];
        const o = p * 4;
        out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = 255;
      }
      return out;
    }

    function invalidate() { cache.clear(); }

    return { renderFrame: renderFrame, rawFrameRGBA: rawFrameRGBA, invalidate: invalidate, width: W, height: H };
  }

  // ---------------------------------------------------------------- 时间轴模型

  // 浏览器惯例：小于 2cs（20ms）的帧延迟按 100ms 播放
  function normalizeDelayCs(cs) { return cs < 2 ? 10 : cs; }

  function buildTimeline(parsed) {
    let playMs = 0, fileMs = 0;
    const frames = parsed.frames.map(function (f) {
      const rawMs = f.delayCs * 10;
      const normCs = normalizeDelayCs(f.delayCs);
      const item = {
        index: f.index,
        left: f.left, top: f.top, width: f.width, height: f.height,
        delayCs: f.delayCs,
        delayMsRaw: rawMs,          // 文件原始时间（导出/检查结果用它）
        playMs: normCs * 10,        // 浏览预览实际使用的播放时长
        normalized: normCs !== f.delayCs,
        zeroDelay: f.delayCs === 0,
        disposal: f.disposal,
        disposalName: DISPOSAL_NAMES[f.disposal] || ('未知(' + f.disposal + ')'),
        transparent: f.transparentFlag,
        transparentIndex: f.transparentFlag ? f.transparentIndex : null,
        interlaced: f.interlaced,
        decodeComplete: f.decodeComplete,
        startMsPlay: playMs,
        startMsFile: fileMs,
      };
      playMs += normCs * 10;
      fileMs += rawMs;
      return item;
    });
    const loopCount = parsed.loopCount;
    const loops = loopCount === null ? 1 : (loopCount === 0 ? Infinity : loopCount);
    return {
      frames: frames,
      loopCount: loopCount,
      loops: loops,
      hasLoopSeam: loops !== 1 && frames.length > 0, // 末帧 -> 首帧的接缝
      totalPlayMs: playMs,
      totalFileMs: fileMs,
    };
  }

  // 导出用时间清单（保留原文件时间信息，单位同时给出 cs 与 ms）
  function buildTimingManifest(parsed, sourceName) {
    const tl = buildTimeline(parsed);
    return {
      source: sourceName || null,
      format: 'gif-frame-timing/v1',
      canvas: { width: parsed.width, height: parsed.height },
      loopCount: parsed.loopCount,
      truncated: parsed.truncated,
      warnings: parsed.warnings.slice(),
      totalFileMs: tl.totalFileMs,
      frames: tl.frames.map(function (f) {
        return {
          index: f.index,
          file: 'frame_' + String(f.index).padStart(3, '0') + '.png',
          rect: { left: f.left, top: f.top, width: f.width, height: f.height },
          delayCs: f.delayCs,          // 原文件值，未做浏览器归一化
          delayMs: f.delayMsRaw,
          previewPlayMs: f.playMs,     // 预览实际使用的播放时长
          zeroDelay: f.zeroDelay,
          disposal: f.disposal,
          disposalName: f.disposalName,
          transparent: f.transparent,
          transparentIndex: f.transparentIndex,
          interlaced: f.interlaced,
          startMsFile: f.startMsFile,
        };
      }),
    };
  }

  function manifestToCSV(manifest) {
    const head = 'index,file,left,top,width,height,delayCs,delayMs,previewPlayMs,zeroDelay,disposal,transparent,transparentIndex,interlaced,startMsFile';
    const rows = manifest.frames.map(function (f) {
      return [f.index, f.file, f.rect.left, f.rect.top, f.rect.width, f.rect.height,
        f.delayCs, f.delayMs, f.previewPlayMs, f.zeroDelay ? 1 : 0,
        f.disposal, f.transparent ? 1 : 0,
        f.transparentIndex === null ? '' : f.transparentIndex,
        f.interlaced ? 1 : 0, f.startMsFile].join(',');
    });
    return head + '\n' + rows.join('\n') + '\n';
  }

  const API = {
    parseGif: parseGif,
    createCompositor: createCompositor,
    buildTimeline: buildTimeline,
    buildTimingManifest: buildTimingManifest,
    manifestToCSV: manifestToCSV,
    normalizeDelayCs: normalizeDelayCs,
    reorderInterlaced: reorderInterlaced,
    DISPOSAL_NAMES: DISPOSAL_NAMES,
    GifTruncated: GifTruncated,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else global.GifCore = API;
})(typeof window !== 'undefined' ? window : globalThis);
