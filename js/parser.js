/*
 * 标记解析器（容错）。
 *
 * 支持的标记：
 *   样式：[b] [/b]  [i] [/i]  [u] [/u]
 *         [color=red|#rgb|#rrggbb]…[/color]   [size=18]…[/size]
 *   停顿：[pause]（默认时长）  [wait=500]（毫秒）
 *   换行：[br] 或直接敲入真实换行
 *   分页：[page]
 *   转义：[[ 表示字面量 [
 *
 * 设计原则：任何错误都不会中断解析，错误片段按普通文本保留，
 * 因此「正常文字仍可预览」，错误列表同时给出 1-based 行/列定位。
 */
(function (global) {
  'use strict';

  const STYLE_TAGS = { b: 'bold', i: 'italic', u: 'underline' };
  const NAMED_COLORS = new Set([
    'red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple',
    'pink', 'white', 'black', 'gray', 'grey', 'brown', 'gold', 'silver'
  ]);
  const COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
  const TAG_RE = /^\[([^\]\n]{0,80})\]/;

  function baseStyle() {
    return { bold: false, italic: false, underline: false, color: null, size: null };
  }

  // 计算 1-based 行列号，并返回所在行文本，便于错误面板定位。
  function positionAt(src, pos) {
    let line = 1;
    let lineStart = 0;
    for (let i = 0; i < pos && i < src.length; i++) {
      if (src[i] === '\n') {
        line++;
        lineStart = i + 1;
      }
    }
    let lineEnd = src.indexOf('\n', lineStart);
    if (lineEnd === -1) lineEnd = src.length;
    return {
      line,
      col: pos - lineStart + 1,
      lineText: src.slice(lineStart, lineEnd),
      colInLine: pos - lineStart
    };
  }

  function parse(rawText) {
    const src = rawText.replace(/\r\n?/g, '\n');
    const units = [];
    const errors = [];
    const stack = []; // {tag, frame, srcStart}
    let pos = 0;

    function currentStyle() {
      const s = baseStyle();
      for (const f of stack) {
        if (f.frame.bold) s.bold = true;
        if (f.frame.italic) s.italic = true;
        if (f.frame.underline) s.underline = true;
        if (f.frame.color) s.color = f.frame.color;
        if (f.frame.size) s.size = f.frame.size;
      }
      return s;
    }

    function addError(message, start, end) {
      const p = positionAt(src, start);
      errors.push({
        pos: start,
        end: end,
        line: p.line,
        col: p.col,
        colInLine: p.colInLine,
        lineText: p.lineText,
        message
      });
    }

    function emitLiteral(text, start) {
      const gs = global.TT.grapheme.split(text);
      let p = start;
      for (const g of gs) {
        units.push({ type: 'char', text: g, style: currentStyle(), srcStart: p, srcEnd: p + g.length });
        p += g.length;
      }
    }

    function emitControl(type, start, end, extra) {
      units.push(Object.assign({
        type,
        style: currentStyle(),
        srcStart: start,
        srcEnd: end
      }, extra || {}));
    }

    function openStyle(tag, frame, start) {
      stack.push({ tag, frame, srcStart: start });
    }

    function closeStyle(tag, closeStart, closeEnd) {
      let idx = -1;
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k].tag === tag) { idx = k; break; }
      }
      if (idx === -1) {
        addError('存在多余的闭合标记 [/' + tag + ']，没有对应的开始标记', closeStart, closeEnd);
        emitLiteral(src.slice(closeStart, closeEnd), closeStart);
        return;
      }
      // 夹在中间未闭合的标记：报错并自动闭合
      for (let k = stack.length - 1; k > idx; k--) {
        const f = stack[k];
        const fEnd = src.indexOf(']', f.srcStart);
        addError('标记 [' + f.tag + '] 缺少闭合，已在 [/' + tag + '] 处自动闭合', f.srcStart, fEnd === -1 ? f.srcStart + 1 : fEnd + 1);
      }
      stack.length = idx;
    }

    while (pos < src.length) {
      const ch = src[pos];

      if (ch === '\n') {
        emitControl('newline', pos, pos + 1);
        pos++;
        continue;
      }

      if (ch !== '[') {
        // 普通文本：取到下一个 [ 或换行前
        let next = pos + 1;
        while (next < src.length && src[next] !== '[' && src[next] !== '\n') next++;
        emitLiteral(src.slice(pos, next), pos);
        pos = next;
        continue;
      }

      // ch === '['
      if (src[pos + 1] === '[') {
        units.push({ type: 'char', text: '[', style: currentStyle(), srcStart: pos, srcEnd: pos + 2 });
        pos += 2;
        continue;
      }

      const m = TAG_RE.exec(src.slice(pos));
      if (!m) {
        // 行尾未闭合的 [，按字面量处理
        let next = pos + 1;
        while (next < src.length && src[next] !== '\n') next++;
        addError('未闭合的 "["，缺少配对的 "]"', pos, next);
        emitLiteral(src.slice(pos, next), pos);
        pos = next;
        continue;
      }

      const inner = m[1].trim();
      const tagStart = pos;
      const tagEnd = pos + m[0].length;

      // 真实换行
      if (inner.toLowerCase() === 'br') {
        emitControl('newline', tagStart, tagEnd);
        pos = tagEnd;
        continue;
      }
      // 分页
      if (inner.toLowerCase() === 'page') {
        emitControl('page', tagStart, tagEnd);
        pos = tagEnd;
        continue;
      }
      // 停顿
      if (inner.toLowerCase() === 'pause') {
        emitControl('wait', tagStart, tagEnd, { duration: null });
        pos = tagEnd;
        continue;
      }
      const waitM = /^wait(?:\s*=\s*(\d+))?$/i.exec(inner);
      if (waitM) {
        if (waitM[1] === undefined) {
          addError('[wait] 缺少时长，写法应为 [wait=500]（单位毫秒）', tagStart, tagEnd);
          emitLiteral(m[0], tagStart);
        } else {
          const dur = parseInt(waitM[1], 10);
          if (dur <= 0 || dur > 600000) {
            addError('[wait] 时长需在 1–600000 毫秒之间，当前为 ' + dur, tagStart, tagEnd);
            emitLiteral(m[0], tagStart);
          } else {
            emitControl('wait', tagStart, tagEnd, { duration: dur });
          }
        }
        pos = tagEnd;
        continue;
      }

      // 样式开标记
      const simple = STYLE_TAGS[inner.toLowerCase()];
      if (simple) {
        openStyle(inner.toLowerCase(), { [simple]: true }, tagStart);
        pos = tagEnd;
        continue;
      }
      const closeM = /^\/\s*([a-z]+)$/i.exec(inner);
      if (closeM) {
        const name = closeM[1].toLowerCase();
        if (!STYLE_TAGS[name] && name !== 'color' && name !== 'size') {
          addError('未知标记 [/' + name + ']', tagStart, tagEnd);
          emitLiteral(m[0], tagStart);
        } else {
          closeStyle(name, tagStart, tagEnd);
        }
        pos = tagEnd;
        continue;
      }
      const colorM = /^color\s*=\s*([^\s]+)$/i.exec(inner);
      if (colorM) {
        const val = colorM[1];
        if (NAMED_COLORS.has(val.toLowerCase()) || COLOR_RE.test(val)) {
          openStyle('color', { color: val }, tagStart);
        } else {
          addError('颜色值 "' + val + '" 无效，支持命名颜色（如 red）或 #rgb / #rrggbb', tagStart, tagEnd);
          emitLiteral(m[0], tagStart);
        }
        pos = tagEnd;
        continue;
      }
      const sizeM = /^size\s*=\s*(\d+)$/i.exec(inner);
      if (sizeM) {
        const sz = parseInt(sizeM[1], 10);
        if (sz < 8 || sz > 200) {
          addError('字号需在 8–200px 之间，当前为 ' + sz, tagStart, tagEnd);
          emitLiteral(m[0], tagStart);
        } else {
          openStyle('size', { size: sz });
        }
        pos = tagEnd;
        continue;
      }

      addError('无法识别的标记 "' + m[0] + '"', tagStart, tagEnd);
      emitLiteral(m[0], tagStart);
      pos = tagEnd;
    }

    // 未闭合的样式标记
    for (const f of stack) {
      const end = src.indexOf(']', f.srcStart);
      addError('标记 [' + f.tag + '] 未闭合，已在文本末尾自动闭合', f.srcStart, end === -1 ? f.srcStart + 1 : end + 1);
    }

    // 给每个字形单元编号（可见字符序号，从 0 开始；控制单元不占编号）
    let ordinal = 0;
    for (const u of units) {
      if (u.type === 'char') {
        u.charIndex = ordinal++;
      } else {
        u.charIndex = -1;
      }
    }

    // 收集停顿/分页标记，供时间轴与导出使用
    const markers = [];
    units.forEach((u, i) => {
      if (u.type === 'wait' || u.type === 'page') {
        markers.push({ unitIndex: i, type: u.type, duration: u.duration || null, srcStart: u.srcStart, srcEnd: u.srcEnd });
      }
    });

    return {
      src,
      units,
      errors,
      markers,
      charCount: ordinal,
      positionAt: (p) => positionAt(src, p)
    };
  }

  global.TT = global.TT || {};
  global.TT.parser = { parse, positionAt };
})(typeof window !== 'undefined' ? window : globalThis);
