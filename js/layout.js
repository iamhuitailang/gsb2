/*
 * 排版引擎：在固定宽度内做贪心换行。
 *
 * 关键点：
 *  - 每个字形（组合字符 / emoji 整体）是不可拆分的最小单位
 *  - 拉丁词整体搬运，CJK 可逐字断行，半角空格允许且优先断行
 *  - 避头尾（kinsoku）：行首禁则标点不允许出现在行首，会把前一个字一起拉到下一行
 *  - 任何放不下的单元都记录 overflow（带原文位置），可在预览中定位
 *  - wait / page 标记不占宽度，锚定到它前面最近的字形，导出与播放共用同一份结果
 */
(function (global) {
  'use strict';

  const DEFAULTS = {
    fontFamily: '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Segoe UI Emoji", sans-serif',
    fontSize: 18,          // px
    lineWidth: 420,        // px，排版区域宽度
    lineHeight: 1.6,       // 倍数
    letterSpacing: 1,      // px，作用于每个字形之后
    cjkAsIdeographic: true
  };

  const LONG_WORD_GRAPHEMES = 18; // 连续不断行的拉丁词超过该长度给出 warning

  // ---- 字符分类 ----
  function isSpace(g) {
    return /^\s$/u.test(g) && g !== '\n';
  }
  function isCJK(g) {
    return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(g);
  }
  const NO_LINE_START = new Set(
    ('、。，．！？；：）】》」』〉”’…—·～%‰℃｝〉），．。！？：；］｝').split('')
  );
  function noLineStart(g) {
    if (g === '…' || g === '—') return true;
    return NO_LINE_START.has(g);
  }
  const NO_LINE_END = new Set(('（【《「『〈“‘｛［（').split(''));
  function noLineEnd(g) {
    return NO_LINE_END.has(g);
  }
  // 拉丁/数字/连字符组成的连续串视为一个词
  function isWordChar(g) {
    return /^[A-Za-z0-9\-'’.]$/.test(g);
  }

  // ---- 宽度测量 ----
  function createMeasurer(config, canvas) {
    const cache = new Map();
    const ctx = canvas.getContext('2d');
    const fontOf = (size, style) => {
      const parts = [];
      if (style.italic) parts.push('italic');
      if (style.bold) parts.push('bold');
      parts.push(size + 'px');
      parts.push(config.fontFamily);
      return parts.join(' ');
    };
    return function measure(g, style) {
      const size = style.size || config.fontSize;
      const font = fontOf(size, style);
      const key = font + '|' + g;
      let w = cache.get(key);
      if (w === undefined) {
        ctx.font = font;
        // 只测量字形本身宽度；字间距统一由 x 步进累加，避免与 CSS letter-spacing 双重计算
        try { ctx.letterSpacing = '0px'; } catch (e) { /* 旧浏览器忽略 */ }
        w = ctx.measureText(g).width;
        if (w <= 0 || Number.isNaN(w)) w = size; // 防御性回退
        cache.set(key, w);
      }
      return w;
    };
  }

  // 把解析单元流分成排版 item：word（拉丁连续串）/ char（单字形）/ space / 控制符
  function buildItems(parsed) {
    const items = [];
    const { units } = parsed;
    let i = 0;
    while (i < units.length) {
      const u = units[i];
      if (u.type === 'newline' || u.type === 'page' || u.type === 'wait') {
        items.push({ kind: u.type, unit: u, unitIndex: i });
        i++;
        continue;
      }
      if (isSpace(u.text)) {
        items.push({ kind: 'space', units: [u], unitIndex: i });
        i++;
        continue;
      }
      if (isWordChar(u.text) && !isCJK(u.text)) {
        const group = [u];
        let j = i + 1;
        while (j < units.length && units[j].type === 'char' && isWordChar(units[j].text) && !isCJK(units[j].text)) {
          group.push(units[j]);
          j++;
        }
        items.push({ kind: 'word', units: group, unitIndex: i });
        i = j;
        continue;
      }
      items.push({ kind: 'char', units: [u], unitIndex: i });
      i++;
    }
    return items;
  }

  /**
   * 主排版函数
   * @param {object} parsed parser.parse 的结果
   * @param {object} cfg 排版配置（与 DEFAULTS 合并）
   * @param {HTMLCanvasElement} canvas 用于测量
   */
  function layout(parsed, cfg, canvas) {
    const config = Object.assign({}, DEFAULTS, cfg || {});
    const measure = createMeasurer(config, canvas);
    const items = buildItems(parsed);
    const lineHeightPx = config.fontSize * config.lineHeight;
    const spacing = config.letterSpacing;

    const pages = [];
    const overflows = [];
    const warnings = [];
    const placements = []; // 每个字形一个 placement（含空格），按出现顺序
    const markerAt = new Map(); // marker unitIndex -> {charIndex, line, page, x, y}

    let line = null;
    let page = null;
    let lineIndexInPage = 0;
    let globalLineIndex = 0;
    let x = 0;
    let y = 0;
    let lastPlacedCharIndex = -1;

    function newPage() {
      page = { index: pages.length, lines: [], height: 0 };
      pages.push(page);
      lineIndexInPage = 0;
      y = 0;
      line = null;
    }

    function newLine() {
      line = {
        index: globalLineIndex++,
        indexInPage: lineIndexInPage++,
        page: page.index,
        x: 0,
        width: 0,
        units: [],
        height: lineHeightPx
      };
      x = 0;
      page.lines.push(line);
    }

    function placeGrapheme(u, width) {
      const p = {
        charIndex: u.charIndex,
        x,
        y,
        width,
        line: line.index,
        page: page.index,
        style: u.style,
        text: u.text,
        srcStart: u.srcStart,
        srcEnd: u.srcEnd
      };
      placements.push(p);
      line.units.push(u);
      line.width = Math.max(line.width, x + width);
      x += width;
      lastPlacedCharIndex = u.charIndex;
      return p;
    }

    function recordOverflow(u, width, reason) {
      overflows.push({
        reason,
        width,
        lineWidth: config.lineWidth,
        line: line ? line.index : 0,
        page: page.index,
        srcStart: u.srcStart,
        srcEnd: u.srcEnd,
        text: u.text,
        charIndex: u.charIndex
      });
      // 溢出字形仍然放置（超出容器），预览里用红色框标出，保证可见可定位
      return placeGrapheme(u, width);
    }

    function attachMarker(unitIndex) {
      let anchor = null;
      if (lastPlacedCharIndex >= 0) {
        anchor = placements.find((p) => p.charIndex === lastPlacedCharIndex);
      }
      markerAt.set(unitIndex, anchor
        ? { charIndex: anchor.charIndex, line: anchor.line, page: anchor.page, x: anchor.x, y: anchor.y }
        : { charIndex: -1, line: line ? line.index : 0, page: page.index, x: 0, y: y });
    }

    function breakLine() {
      page.height = Math.max(page.height, (line.indexInPage) * lineHeightPx);
      y += lineHeightPx;
      newLine();
    }

    newPage();

    for (let ii = 0; ii < items.length; ii++) {
      const item = items[ii];

      if (item.kind === 'page') {
        attachMarker(item.unitIndex);
        if (line) page.height = Math.max(page.height, line.indexInPage * lineHeightPx);
        newPage();
        continue;
      }
      if (item.kind === 'newline') {
        if (!line) newLine();
        page.height = Math.max(page.height, line.indexInPage * lineHeightPx);
        y += lineHeightPx;
        newLine();
        continue;
      }
      if (item.kind === 'wait') {
        attachMarker(item.unitIndex);
        continue;
      }

      if (!line) newLine();

      if (item.kind === 'space') {
        const u = item.units[0];
        const w = measure(u.text, u.style) + spacing;
        if (x === 0) {
          // 行首空格折叠为零宽，但仍生成 placement，保证 charIndex 连续可播放
          placeGrapheme(u, 0);
        } else {
          placeGrapheme(u, w);
        }
        continue;
      }

      if (item.kind === 'word') {
        const ws = item.units.map((u) => ({ u, w: measure(u.text, u.style) + spacing }));
        const total = ws.reduce((s, z) => s + z.w, 0);

        if (item.units.length >= LONG_WORD_GRAPHEMES) {
          warnings.push({
            type: 'long-word',
            message: '连续拉丁词 "' + item.units.map((u) => u.text).join('').slice(0, 24) +
              (item.units.length > 24 ? '…' : '') + '" 长达 ' + item.units.length + ' 个字符，可能影响版面',
            width: total,
            lineWidth: config.lineWidth,
            srcStart: item.units[0].srcStart,
            srcEnd: item.units[item.units.length - 1].srcEnd
          });
        }

        if (total <= config.lineWidth && x + total <= config.lineWidth) {
          for (const z of ws) placeGrapheme(z.u, z.w);
          continue;
        }
        if (total <= config.lineWidth) {
          // 整词换行
          breakLine();
          for (const z of ws) placeGrapheme(z.u, z.w);
          continue;
        }
        // 词比整行还宽：先尝试整体换行，再逐字硬排并记录每个溢出字
        if (x > 0) breakLine();
        for (const z of ws) {
          if (x + z.w > config.lineWidth) {
            recordOverflow(z.u, z.w, 'grapheme-wider-than-line');
            breakLine();
          } else {
            placeGrapheme(z.u, z.w);
          }
        }
        continue;
      }

      // item.kind === 'char'（CJK、emoji、标点等单字形）
      const u = item.units[0];
      const w = measure(u.text, u.style) + spacing;

      if (w - spacing > config.lineWidth) {
        recordOverflow(u, w, 'grapheme-wider-than-line');
        continue;
      }

      if (x + w <= config.lineWidth) {
        placeGrapheme(u, w);
        continue;
      }

      // 当前行放不下
      if (noLineEnd(u.text)) {
        // 开引号等不允许落在行尾：压缩字间距硬挤，仍标记 warning 级问题
        overflows.push({
          reason: 'kinsoku-no-line-end',
          width: w,
          lineWidth: config.lineWidth,
          line: line.index,
          page: page.index,
          srcStart: u.srcStart,
          srcEnd: u.srcEnd,
          text: u.text,
          charIndex: u.charIndex
        });
        placeGrapheme(u, w);
        continue;
      }

      if (noLineStart(u.text) && line.units.length > 0) {
        // 避头尾：把行内最后一个字形一起拉到新行
        const pulled = line.units.pop();
        const pulledPlacement = placements[placements.length - 1];
        placements.pop();
        x -= pulledPlacement.width;
        line.width = x;
        breakLine();
        placeGrapheme(pulled, pulledPlacement.width);
        if (x + w > config.lineWidth) {
          recordOverflow(u, w, 'kinsoku-pull-overflow');
        } else {
          placeGrapheme(u, w);
        }
        continue;
      }

      // 普通换行
      breakLine();
      placeGrapheme(u, w);
    }

    if (line) page.height = Math.max(page.height, line.indexInPage * lineHeightPx);
    if (page && page.lines.length === 0) page.height = lineHeightPx;

    const gap = lineHeightPx;
    const totalHeight = pages.reduce((s, p) => s + p.height, 0) + (pages.length - 1) * gap;

    return {
      config,
      pages,
      placements,
      markerAt,
      overflows,
      warnings,
      totalHeight,
      lineHeightPx
    };
  }

  global.TT = global.TT || {};
  global.TT.layout = { layout, DEFAULTS, createMeasurer, buildItems };
})(typeof window !== 'undefined' ? window : globalThis);
