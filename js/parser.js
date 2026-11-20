/*
 * parser.js — SRT / WebVTT 导入解析
 *
 * 返回 { format, cues, errors }：
 *  - cues 中每个条目保留原始顺序与原文，解析失败的块只进 errors、不产生空条目；
 *  - errors 为 [{ level: 'error'|'warning', line, message }]，line 为文件中的 1 基行号；
 *  - 即使整份文件格式异常，也尽量逐条抢救，不会整体返回空白。
 */
(function (root) {
  'use strict';

  const Time = root.Time;

  const TIME_LINE_RE = /^(.+?)\s*-->\s*(.+?)(?:\s+(.*))?$/;

  function detectFormat(text, filename) {
    const head = text.replace(/^﻿/, '').trimStart().slice(0, 32).toUpperCase();
    if (head.startsWith('WEBVTT')) return 'vtt';
    const name = (filename || '').toLowerCase();
    if (name.endsWith('.vtt')) return 'vtt';
    if (name.endsWith('.srt')) return 'srt';
    // 无扩展名信息时：出现 WEBVTT 头即 VTT，否则按 SRT 处理
    return head.startsWith('WEBVTT') ? 'vtt' : 'srt';
  }

  // 拆 cue 块，同时记录每个块起始行号（1 基）
  function splitBlocks(lines) {
    const blocks = [];
    let cur = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === '') {
        if (cur) { blocks.push(cur); cur = null; }
        continue;
      }
      if (!cur) cur = { startLine: i + 1, lines: [] };
      cur.lines.push({ no: i + 1, text: line });
    }
    if (cur) blocks.push(cur);
    return blocks;
  }

  function makeCue(seq, start, end, textLines, settings, id, startLine) {
    return {
      id: 'c' + seq,
      start,
      end,
      text: textLines.join('\n'),
      settings: settings || '',
      cueId: id || '',
      sourceLine: startLine,
    };
  }

  function parseSrt(text, errors) {
    const cues = [];
    const blocks = splitBlocks(text.split(/\r\n|\n|\r/));
    let seq = 1;

    blocks.forEach((block) => {
      const bl = block.lines;
      // 可选的序号行
      let idx = 0;
      if (idx < bl.length && /^\d+\s*$/.test(bl[idx].text.trim())) idx++;

      if (idx >= bl.length) {
        errors.push({ level: 'error', line: block.startLine, message: '该字幕块缺少时间轴行，已跳过' });
        return;
      }
      const tl = TIME_LINE_RE.exec(bl[idx].text.trim());
      if (!tl) {
        // SRT 序号之后必须紧跟时间轴；若后续行里存在时间轴，说明本行结构错乱
        const later = bl.slice(idx).some((l) => TIME_LINE_RE.test(l.text.trim()));
        const msg = later
          ? `时间轴行位置错误，期望在序号之后：“${bl[idx].text.trim()}”，该字幕块已跳过`
          : `无法识别的时间轴行：“${bl[idx].text.trim()}”，该字幕块已跳过`;
        errors.push({ level: 'error', line: bl[idx].no, message: msg });
        return;
      }
      if (tl[3]) {
        errors.push({ level: 'warning', line: bl[idx].no, message: 'SRT 不支持 cue 设置，已忽略行尾设置内容' });
      }
      const start = Time.parseTime(tl[1]);
      const end = Time.parseTime(tl[2]);
      if (start === null || end === null) {
        errors.push({ level: 'error', line: bl[idx].no, message: `时间戳无法解析：“${bl[idx].text.trim()}”，该字幕块已跳过` });
        return;
      }
      if (/[.]/.test(tl[1]) || /[.]/.test(tl[2])) {
        errors.push({ level: 'warning', line: bl[idx].no, message: 'SRT 时间戳使用了句点分隔（VTT 风格），已按毫秒正常解析' });
      }
      idx++;
      const textLines = bl.slice(idx).map((l) => l.text);
      if (textLines.join('').trim() === '') {
        errors.push({ level: 'warning', line: block.startLine, message: '该字幕块文本为空，已导入并标记为空文本条目' });
      }
      cues.push(makeCue(seq++, start, end, textLines, '', '', block.startLine));
    });
    return cues;
  }

  function parseVtt(text, errors) {
    const cues = [];
    const lines = text.split(/\r\n|\n|\r/);
    // 头部校验
    if (!lines[0] || !lines[0].replace(/^﻿/, '').trim().toUpperCase().startsWith('WEBVTT')) {
      errors.push({ level: 'warning', line: 1, message: '缺少 WEBVTT 文件头，仍按 WebVTT 语法继续解析' });
    }
    const blocks = splitBlocks(lines);
    let seq = 1;

    blocks.forEach((block) => {
      const bl = block.lines;
      // 跳过 NOTE / REGION / STYLE 块
      const first = bl[0].text.trim();
      if (/^(NOTE|REGION|STYLE)(\s|$)/.test(first)) return;
      if (first.toUpperCase().startsWith('WEBVTT')) return;

      let idx = 0;
      let cueId = '';
      // 非时间轴行视为 cue id（VTT 允许给 cue 命名）
      if (!TIME_LINE_RE.test(bl[idx].text.trim())) {
        cueId = bl[idx].text.trim();
        idx++;
        if (idx >= bl.length) {
          errors.push({ level: 'error', line: block.startLine, message: '该字幕块只有 cue id、缺少时间轴，已跳过' });
          return;
        }
      }
      const tl = TIME_LINE_RE.exec(bl[idx].text.trim());
      if (!tl) {
        errors.push({ level: 'error', line: bl[idx].no, message: `无法识别的时间轴行：“${bl[idx].text.trim()}”，该字幕块已跳过` });
        return;
      }
      const start = Time.parseTime(tl[1]);
      const end = Time.parseTime(tl[2]);
      if (start === null || end === null) {
        errors.push({ level: 'error', line: bl[idx].no, message: `时间戳无法解析：“${bl[idx].text.trim()}”，该字幕块已跳过` });
        return;
      }
      idx++;
      // VTT 实体（&amp; 等）反转义为字面字符，编辑所见即所得；导出时由 serializer 重新转义
      const unescape = root.VttEntities ? (s) => root.VttEntities.unescape(s) : (s) => s;
      const textLines = bl.slice(idx).map((l) => unescape(l.text));
      if (textLines.join('').trim() === '') {
        errors.push({ level: 'warning', line: block.startLine, message: '该字幕块文本为空，已导入并标记为空文本条目' });
      }
      cues.push(makeCue(seq++, start, end, textLines, (tl[3] || '').trim(), cueId, block.startLine));
    });
    return cues;
  }

  function parse(text, filename) {
    const clean = String(text).replace(/^﻿/, '');
    const format = detectFormat(clean, filename);
    const errors = [];
    const cues = format === 'vtt' ? parseVtt(clean, errors) : parseSrt(clean, errors);
    if (cues.length === 0 && errors.length === 0) {
      errors.push({ level: 'error', line: 1, message: '文件中没有解析出任何字幕条目' });
    }
    return { format, cues, errors };
  }

  const api = { parse, detectFormat };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Parser = api;
})(typeof window !== 'undefined' ? window : globalThis);
