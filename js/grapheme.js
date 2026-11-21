/*
 * 字形切分：把字符串切成「用户感知的一个可见字符」。
 * 组合字符序列（e + 重音）、ZWJ emoji 家族、带肤色修饰的 emoji、旗帜等都算一个单位。
 * 优先使用 Intl.Segmenter，缺失时用 Unicode 属性转义回退。
 */
(function (global) {
  'use strict';

  let segmenter = null;
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    try {
      segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
    } catch (e) {
      segmenter = null;
    }
  }

  // 回退方案：覆盖 CR/LF、prepend（RI 序列）、扩展字符、ZWJ、emoji 组合、间距标记等常见情况。
  // 参考 Unicode 标准附录 #29 的简化版。
  const FALLBACK_RE = /\r\n|(?:\p{Regional_Indicator}(?:\p{Regional_Indicator})?)|(?:\p{Extended_Pictographic}(?:\p{Emoji_Modifier})?(?:‍\p{Extended_Pictographic}(?:\p{Emoji_Modifier})?)*)|(?:[^\p{Control}\r\n](?:\p{Grapheme_Extend}|‍\p{Extended_Pictographic}(?:\p{Emoji_Modifier})?)*)/gu;

  function splitGraphemes(str) {
    if (segmenter) {
      const out = [];
      for (const seg of segmenter.segment(str)) out.push(seg.segment);
      return out;
    }
    const out = [];
    let m;
    FALLBACK_RE.lastIndex = 0;
    while ((m = FALLBACK_RE.exec(str)) !== null) {
      if (m[0].length > 0) out.push(m[0]);
    }
    return out;
  }

  // 统计字形数量（等价于 splitGraphemes(str).length，避免一次分配）
  function graphemeLength(str) {
    if (segmenter) {
      let n = 0;
      for (const _ of segmenter.segment(str)) n++;
      return n;
    }
    return splitGraphemes(str).length;
  }

  global.TT = global.TT || {};
  global.TT.grapheme = { split: splitGraphemes, length: graphemeLength };
})(typeof window !== 'undefined' ? window : globalThis);
