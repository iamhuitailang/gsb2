/*
 * time.js — 时间表示与转换
 *
 * 设计原则：内部所有时间一律使用整数毫秒存储，帧仅在“按帧率显示/编辑”时
 * 做视图层换算，编辑结果立刻换算回毫秒。导出始终基于毫秒，因此反复切换
 * 帧率或导出再导入都不会产生累积漂移。
 */
(function (root) {
  'use strict';

  function pad(n, len) {
    return String(Math.max(0, Math.floor(n))).padStart(len || 2, '0');
  }

  // 毫秒 -> SRT 时间戳（逗号分隔）：HH:MM:SS,mmm
  function msToSrt(ms) {
    if (!Number.isFinite(ms) || ms < 0) ms = 0;
    ms = Math.round(ms);
    return (
      pad(ms / 3600000) + ':' +
      pad((ms % 3600000) / 60000) + ':' +
      pad((ms % 60000) / 1000) + ',' +
      pad(ms % 1000, 3)
    );
  }

  // 毫秒 -> WebVTT 时间戳（句点分隔）：HH:MM:SS.mmm
  function msToVtt(ms) {
    return msToSrt(ms).replace(',', '.');
  }

  // 解析 SRT/VTT 时间戳，返回毫秒；无法解析时返回 null
  // 接受 HH:MM:SS(.|,)mmm / MM:SS(.|,)mmm
  function parseTime(str) {
    if (str == null) return null;
    const m = String(str).trim()
      .match(/^(\d{1,2}):(\d{1,2}):(\d{1,2})[.,](\d{1,3})$|^(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/);
    if (!m) return null;
    let h, min, s, frac;
    if (m[1] !== undefined) {
      h = +m[1]; min = +m[2]; s = +m[3]; frac = m[4];
    } else {
      h = 0; min = +m[5]; s = +m[6]; frac = m[7];
    }
    const ms = +(frac + '000').slice(0, 3);
    return ((h * 60 + min) * 60 + s) * 1000 + ms;
  }

  // 毫秒 -> 帧（按给定帧率，四舍五入）
  function msToFrame(ms, fps) {
    if (!fps || fps <= 0) return 0;
    return Math.round(ms / 1000 * fps);
  }

  // 帧 -> 毫秒（四舍五入到整数毫秒）
  function frameToMs(frame, fps) {
    if (!fps || fps <= 0) return 0;
    return Math.round(frame / fps * 1000);
  }

  // 毫秒 -> 帧显示 HH:MM:SS:FF
  function msToFrameCode(ms, fps) {
    if (!fps || fps <= 0) return '00:00:00:00';
    const totalFrames = msToFrame(ms, fps);
    const f = totalFrames % fps;
    const totalSec = Math.floor(totalFrames / fps);
    return (
      pad(totalSec / 3600) + ':' +
      pad((totalSec % 3600) / 60) + ':' +
      pad(totalSec % 60) + ':' +
      pad(f)
    );
  }

  // 解析 HH:MM:SS:FF 帧码，返回毫秒
  function parseFrameCode(str, fps) {
    const m = String(str).trim().match(/^(\d+):([0-5]?\d):([0-5]?\d):(\d+)$/);
    if (!m) return null;
    const totalFrames = ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * fps + +m[4];
    return frameToMs(totalFrames, fps);
  }

  // 列表/输入框使用的展示字符串（随当前显示模式切换）
  function formatDisplay(ms, mode, fps) {
    return mode === 'frame' ? msToFrameCode(ms, fps) : msToSrt(ms);
  }

  // 输入框通用解析：帧模式下先按帧码解析，失败再退回普通时间戳；毫秒模式只接受时间戳
  function parseInput(str, mode, fps) {
    if (mode === 'frame') {
      const frameMs = parseFrameCode(str, fps);
      if (frameMs !== null) return frameMs;
    }
    return parseTime(str);
  }

  // 秒 -> mm:ss（时间轴刻度用），digits 控制秒的小数位数
  function secondsToLabel(sec, digits) {
    sec = Math.max(0, sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const ss = digits ? s.toFixed(digits) : pad(s);
    return (h ? pad(h) + ':' : '') + pad(m) + ':' + ss;
  }

  const api = {
    pad, msToSrt, msToVtt, parseTime,
    msToFrame, frameToMs, msToFrameCode, parseFrameCode,
    formatDisplay, parseInput, secondsToLabel,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Time = api;
})(typeof window !== 'undefined' ? window : globalThis);
