/* 帧号 ↔ 时间码 ↔ 秒 的换算。
 * 采用非丢帧（non-drop-frame）SMPTE 时间码 HH:MM:SS:FF，
 * 界面上所有时间位置都以「帧」为唯一事实来源，避免浮点 currentTime 与实际帧错位。 */
'use strict';

const Timecode = {
  frameToTime(frame, fps) {
    return frame / fps;
  },

  timeToFrame(t, fps) {
    return Math.max(0, Math.round(t * fps));
  },

  framesToTc(frame, fps) {
    frame = Math.max(0, Math.round(frame));
    const ff = frame % fps;
    const totalSec = Math.floor(frame / fps);
    const ss = totalSec % 60;
    const mm = Math.floor(totalSec / 60) % 60;
    const hh = Math.floor(totalSec / 3600);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(hh)}:${p(mm)}:${p(ss)}:${p(ff)}`;
  },

  /** 支持 "HH:MM:SS:FF"、"MM:SS.FF"、纯秒数、纯帧号（由调用方区分） */
  parseTc(str, fps) {
    const s = String(str).trim();
    if (/^\d+(\.\d+)?$/.test(s)) {
      // 纯数字：带小数点按秒处理，纯整数按帧号处理
      return s.includes('.') ? this.timeToFrame(parseFloat(s), fps) : parseInt(s, 10);
    }
    const m = s.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?::(\d{1,2})|\.(\d{1,2}))?$/);
    if (!m) return null;
    const h = parseInt(m[1] || '0', 10);
    const min = parseInt(m[2], 10);
    const sec = parseInt(m[3], 10);
    const ff = parseInt(m[4] ?? m[5] ?? '0', 10);
    if (sec >= 60 || min >= 60 || ff >= fps) return null;
    return (h * 3600 + min * 60 + sec) * fps + ff;
  },

  /** 把一段帧范围描述成文字，用于意见卡片 */
  rangeLabel(startFrame, endFrame, fps) {
    if (endFrame == null || endFrame === startFrame) {
      return this.framesToTc(startFrame, fps);
    }
    return `${this.framesToTc(startFrame, fps)} → ${this.framesToTc(endFrame, fps)}`;
  },
};
