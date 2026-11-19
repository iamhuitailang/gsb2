/**
 * 导入模块：把粘贴/导入的多行文本拆成逐行解析结果。
 * 不丢弃任何输入：解析失败的行保留行号与可理解的原因，但不回显原文到错误信息中。
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = mod;
  } else {
    root.SanLog = root.SanLog || {};
    Object.assign(root.SanLog, mod);
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * 按行解析文本（支持 \n / \r\n）。
   * @param {string} text 原始多行文本
   * @returns {{records: Array, failures: Array, blankLines: number, totalLines: number}}
   *   records:  {line, value} 可处理记录（含上次导出的失败包装对象）
   *   failures: {line, reason, rawLength} 解析失败行；raw 仅在内存对象中保留用于界面回显，
   *             导出时走 buildFailureEntry，绝不写入审计报告
   */
  function parseInput(text) {
    const lines = String(text).split(/\r?\n/);
    const records = [];
    const failures = [];
    let blankLines = 0;

    lines.forEach((rawLine, idx) => {
      const line = idx + 1;
      const trimmed = rawLine.trim();
      if (trimmed === '') {
        blankLines += 1;
        return;
      }
      let value;
      try {
        value = JSON.parse(trimmed);
      } catch (e) {
        failures.push({
          line,
          reason: `JSON 解析失败：${safeJsonError(e)}`,
          raw: trimmed,
          rawLength: trimmed.length,
        });
        return;
      }      // 上次导出的“失败行包装”重新导入：还原为失败项，不计入可处理记录
      if (isFailureEntry(value)) {
        failures.push({
          line: value.line,
          reason: value.reason,
          raw: null,
          rawLength: value.rawLength,
          reimported: true,
        });
        return;
      }
      records.push({ line, value });
    });

    return {
      records,
      failures,
      blankLines,
      totalLines: lines.length,
    };
  }

  /**
   * 生成不含原文的解析错误原因。
   * V8 的 JSON 错误消息可能回显输入片段（如 "not json" is not valid JSON），
   * 这里只保留错误类型与位置，任何引号包裹的原文片段都不进入 reason。
   */
  function safeJsonError(e) {
    const raw = e && typeof e.message === 'string' ? e.message : '未知解析错误';
    // 位置信息（position N / line N column M）是安全的，先提取
    const posMatch = raw.match(/position \d+|line \d+ column \d+/i);
    const pos = posMatch ? `（${posMatch[0]}）` : '';
    // 按已知错误类型归类，类型未知时给出固定通用文案，绝不回显原文
    const typeMap = [
      [/Unexpected token|Unexpected non-whitespace/, '存在意外的字符或结构'],
      [/Expected property name|Expected double-quoted property/, '对象属性名格式错误'],
      [/Unterminated string/, '字符串未闭合'],
      [/Unterminated/, '结构未闭合'],
      [/Bad control character|Bad escaped character|Bad Unicode escape/, '字符串转义非法'],
      [/Unexpected number|Unexpected string|Unexpected end of data|Unexpected end of JSON input/, 'JSON 结构不完整'],
      [/is not valid JSON/, '不是合法 JSON'],
      [/Cannot use 'in' operator|Cannot read|Cannot parse/, 'JSON 结构无法解析'],
    ];
    for (const [re, label] of typeMap) {
      if (re.test(raw)) return `${label}${pos}`;
    }
    return `语法错误${pos}`;
  }

  /** 失败行在导出 jsonl 中的包装形态：可重新导入并还原，且不含原文 */
  function isFailureEntry(v) {
    return (
      v !== null &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      v.__sanlog_unprocessable__ === true &&
      Number.isInteger(v.line) &&
      typeof v.reason === 'string'
    );
  }

  function buildFailureEntry(failure) {
    return {
      __sanlog_unprocessable__: true,
      line: failure.line,
      reason: failure.reason,
      rawLength: failure.rawLength || 0,
    };
  }

  return { parseInput, buildFailureEntry, isFailureEntry };
});
