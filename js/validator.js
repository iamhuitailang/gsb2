/*
 * validator.js — 字幕质量检查
 *
 * 检查四类问题：
 *  - inverted 时间倒置（含零时长）
 *  - overlap  字幕重叠（可通过 ignoredOverlaps 标记为“有意重叠”，校对后保留说明）
 *  - empty    空文本
 *  - overflow 超出视频时长（视频时长未知时跳过该项）
 * 每个问题带稳定 key（cueId + 类型 + 关联 cueId），用于忽略状态的持久化。
 */
(function (root) {
  'use strict';

  function validate(cues, videoDuration, ignoredOverlaps) {
    const ignored = ignoredOverlaps || new Set();
    const issues = [];
    const byCue = new Map();

    function add(issue) {
      issues.push(issue);
      if (!byCue.has(issue.cueId)) byCue.set(issue.cueId, []);
      byCue.get(issue.cueId).push(issue);
    }

    cues.forEach((cue) => {
      if (!Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.start < 0 || cue.end < 0) {
        add({ key: cue.id + ':inverted', type: 'inverted', level: 'error',
          cueId: cue.id, message: '时间值无效或为负数' });
      } else if (cue.start > cue.end) {
        add({ key: cue.id + ':inverted', type: 'inverted', level: 'error',
          cueId: cue.id, message: `时间倒置：开始晚于结束（${cue.start} > ${cue.end} ms）` });
      } else if (cue.start === cue.end) {
        add({ key: cue.id + ':inverted', type: 'inverted', level: 'error',
          cueId: cue.id, message: '零时长条目：开始与结束时间相同' });
      }

      if (String(cue.text || '').trim() === '') {
        add({ key: cue.id + ':empty', type: 'empty', level: 'error',
          cueId: cue.id, message: '字幕文本为空' });
      }

      if (Number.isFinite(videoDuration) && videoDuration > 0) {
        const durMs = videoDuration * 1000;
        if (cue.end > durMs || cue.start > durMs) {
          add({ key: cue.id + ':overflow', type: 'overflow', level: 'warning',
            cueId: cue.id, message: `超出视频时长（视频 ${Math.round(durMs)} ms，条目结束 ${cue.end} ms）` });
        }
      }
    });

    // 重叠：按开始时间排序后两两比较（首尾相接 end === start 不算重叠）
    const ordered = cues
      .filter((c) => Number.isFinite(c.start) && Number.isFinite(c.end) && c.start <= c.end)
      .slice()
      .sort((a, b) => a.start - b.start || a.end - b.end);

    for (let i = 0; i < ordered.length; i++) {
      for (let j = i + 1; j < ordered.length; j++) {
        const a = ordered[i];
        const b = ordered[j];
        if (b.start >= a.end) break; // 已排序，后面的不可能再与 a 相交
        if (b.end <= a.start) continue;
        const key = [a.id, b.id].sort().join('~') + ':overlap';
        const isIgnored = ignored.has(key);
        add({
          key, type: 'overlap', level: isIgnored ? 'ignored' : 'error',
          cueId: a.id, otherCueId: b.id, ignored: isIgnored,
          message: `与下一条字幕重叠（${Math.min(a.end, b.end) - b.start} ms）` +
            (isIgnored ? ' — 已标记为有意重叠' : ''),
        });
        // 让两条字幕都能在列表中看到该问题
        if (!byCue.has(b.id)) byCue.set(b.id, []);
        byCue.get(b.id).push(issues[issues.length - 1]);
      }
    }

    const counts = { error: 0, warning: 0, ignored: 0 };
    issues.forEach((iss) => { counts[iss.level] = (counts[iss.level] || 0) + 1; });
    return { issues, byCue, counts };
  }

  const api = { validate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Validator = api;
})(typeof window !== 'undefined' ? window : globalThis);
