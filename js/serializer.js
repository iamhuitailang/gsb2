/*
 * serializer.js — SRT / WebVTT 导出与 WebVTT 实体处理
 *
 * 特殊字符策略（保证“导出后再导入”一致）：
 *  - WebVTT：导入时把 &amp; &lt; &gt; &lrm; 等实体反转义为字面字符供编辑，
 *    导出时重新转义 & < >，时间轴与文字逐字往返一致；
 *  - SRT：没有官方转义规则，文字原样写入、原样读回。
 * 时间一律由内部整数毫秒生成，不参与帧率换算，因此不会整体漂移。
 */
(function (root) {
  'use strict';

  const Time = root.Time;

  const VttEntities = {
    escape(text) {
      return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    },
    unescape(text) {
      return String(text)
        .replace(/&(amp|lt|gt|quot|apos|lrm|rlm|nbsp);/gi, (m, name) => {
          switch (name.toLowerCase()) {
            case 'amp': return '&';
            case 'lt': return '<';
            case 'gt': return '>';
            case 'quot': return '"';
            case 'apos': return "'";
            case 'lrm': return '​';
            case 'rlm': return '‏';
            case 'nbsp': return ' ';
            default: return m;
          }
        })
        .replace(/&#(\d+);/g, (m, code) => String.fromCodePoint(+code))
        .replace(/&#x([0-9a-f]+);/gi, (m, hex) => String.fromCodePoint(parseInt(hex, 16)));
    },
  };

  function toSrt(cues) {
    const parts = cues.map((cue, i) => {
      const body = String(cue.text || '').replace(/\r\n?/g, '\n');
      return (i + 1) + '\n' +
        Time.msToSrt(cue.start) + ' --> ' + Time.msToSrt(cue.end) + '\n' +
        body;
    });
    // SRT 以空行分隔条目，文件末尾保留一个换行
    return parts.join('\n\n') + '\n';
  }

  function toVtt(cues) {
    const parts = ['WEBVTT'];
    cues.forEach((cue) => {
      const head = Time.msToVtt(cue.start) + ' --> ' + Time.msToVtt(cue.end) +
        (cue.settings ? ' ' + cue.settings : '');
      const body = VttEntities.escape(String(cue.text || '').replace(/\r\n?/g, '\n'));
      // 有原始 cue id 时保留（空 id 不写，避免与文字行混淆）
      parts.push(cue.cueId ? cue.cueId + '\n' + head + '\n' + body : head + '\n' + body);
    });
    return parts.join('\n\n') + '\n';
  }

  function serialize(cues, format) {
    return format === 'vtt' ? toVtt(cues) : toSrt(cues);
  }

  // 触发浏览器下载（纯前端，无网络请求）
  function download(cues, format, filename) {
    const content = serialize(cues, format);
    const blob = new Blob(['﻿' + content], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename || ('subtitles.' + (format === 'vtt' ? 'vtt' : 'srt'));
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }

  const api = { serialize, toSrt, toVtt, download, VttEntities };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Serializer = api;
  root.VttEntities = VttEntities;
})(typeof window !== 'undefined' ? window : globalThis);
