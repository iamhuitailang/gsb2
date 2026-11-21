/*
 * 导出：把解析结果与排版结果合并为游戏可读取的 JSON。
 * 每个 page 包含：纯文本、字形序列（含样式与原文位置）、行位置、停顿标记、分页标记。
 */
(function (global) {
  'use strict';

  function buildExport(parsed, lay, options) {
    const opts = Object.assign({
      includeStyle: true,
      includeSrcPosition: true
    }, options || {});

    // placement 按 charIndex 建索引，便于按页/按行取用
    const byChar = new Map();
    for (const p of lay.placements) byChar.set(p.charIndex, p);

    const pages = lay.pages.map((page) => {
      const lineData = page.lines.map((ln) => ({
        index: ln.index,
        indexInPage: ln.indexInPage,
        top: ln.indexInPage * lay.lineHeightPx,
        width: Math.round(ln.width * 100) / 100,
        height: lay.lineHeightPx,
        chars: ln.units.map((u) => {
          const p = byChar.get(u.charIndex);
          const out = {
            charIndex: u.charIndex,
            text: u.text,
            x: Math.round(p.x * 100) / 100,
            y: Math.round(p.y * 100) / 100,
            width: Math.round(p.width * 100) / 100
          };
          if (opts.includeStyle) out.style = u.style;
          if (opts.includeSrcPosition) {
            out.srcStart = u.srcStart;
            out.srcEnd = u.srcEnd;
          }
          return out;
        })
      }));

      const text = page.lines
        .map((ln) => ln.units.map((u) => u.text).join(''))
        .join('\n');

      return {
        page: page.index,
        height: page.height,
        text,
        lines: lineData
      };
    });

    // 停顿 / 分页标记：锚定到排版位置
    const markers = parsed.markers.map((m) => {
      const anchor = lay.markerAt.get(m.unitIndex) || { charIndex: -1, line: -1, page: -1, x: 0, y: 0 };
      return {
        type: m.type,                 // 'wait' | 'page'
        durationMs: m.duration,       // wait 时长；null 表示默认停顿
        afterCharIndex: anchor.charIndex,
        position: { page: anchor.page, line: anchor.line, x: anchor.x, y: anchor.y },
        srcStart: m.srcStart,
        srcEnd: m.srcEnd
      };
    });

    return {
      version: 1,
      generatedAt: new Date().toISOString(),
      layout: {
        fontFamily: lay.config.fontFamily,
        fontSize: lay.config.fontSize,
        lineWidth: lay.config.lineWidth,
        lineHeight: lay.config.lineHeight,
        letterSpacing: lay.config.letterSpacing
      },
      summary: {
        pages: pages.length,
        chars: parsed.charCount,
        waits: parsed.markers.filter((m) => m.type === 'wait').length,
        overflowCount: lay.overflows.length,
        warningCount: lay.warnings.length,
        totalHeight: Math.round(lay.totalHeight * 100) / 100
      },
      errors: parsed.errors.map((e) => ({
        line: e.line,
        col: e.col,
        message: e.message,
        srcStart: e.pos,
        srcEnd: e.end
      })),
      overflows: lay.overflows,
      warnings: lay.warnings,
      pages,
      markers
    };
  }

  global.TT = global.TT || {};
  global.TT.exporter = { buildExport };
})(typeof window !== 'undefined' ? window : globalThis);
