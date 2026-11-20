/* 导出：机器可读 JSON / CSV，以及给剪辑同事的带缩略图 HTML 审片报告。 */
'use strict';

const Exporter = {
  baseName(store) {
    return (store.state.name || 'review-project').replace(/[\\/:*?"<>|\s]+/g, '_');
  },

  exportJSON(store) {
    const payload = {
      ...store.toJSON(true),
      exportedAt: new Date().toISOString(),
      exporter: 'video-review-station',
    };
    download(`${this.baseName(store)}.vrs.json`, JSON.stringify(payload, null, 2), 'application/json');
  },

  exportCSV(store) {
    const fps = store.state.fps;
    const header = ['id', 'seq', 'startFrame', 'startTimecode', 'endFrame', 'endTimecode', 'type',
      'status', 'text', 'author', 'rectX', 'rectY', 'rectW', 'rectH', 'createdAt', 'updatedAt'];
    const rows = store.sortedComments().map((c, i) => [
      c.id,
      i + 1,
      c.startFrame,
      Timecode.framesToTc(c.startFrame, fps),
      c.endFrame ?? '',
      c.endFrame != null ? Timecode.framesToTc(c.endFrame, fps) : '',
      c.endFrame != null ? 'range' : 'point',
      c.status,
      c.text,
      c.author,
      c.rect?.x ?? '', c.rect?.y ?? '', c.rect?.w ?? '', c.rect?.h ?? '',
      new Date(c.createdAt).toISOString(),
      new Date(c.updatedAt).toISOString(),
    ].map(escapeCsv).join(','));
    const csv = '﻿' + header.join(',') + '\n' + rows.join('\n');
    download(`${this.baseName(store)}_comments.csv`, csv, 'text/csv;charset=utf-8');
  },

  exportHTML(store, player) {
    const fps = store.state.fps;
    const s = store.state;
    const media = s.media;
    const comments = store.sortedComments();
    const done = comments.filter((c) => c.status === 'done').length;
    const confirm = comments.filter((c) => c.status === 'needs-confirm').length;

    const rows = comments.map((c, i) => {
      const isRange = c.endFrame != null;
      const statusBadge = {
        open: '<span class="b b-open">未完成</span>',
        done: '<span class="b b-done">已完成</span>',
        'needs-confirm': '<span class="b b-confirm">待人工确认</span>',
      }[c.status];
      const rect = c.rect
        ? `<div class="rect-info">矩形标记（归一化）x=${c.rect.x} y=${c.rect.y} w=${c.rect.w} h=${c.rect.h}</div>` : '';
      const thumb = c.thumbnail?.dataUrl
        ? `<div class="thumb-wrap"><img src="${c.thumbnail.dataUrl}" alt="">${
          c.thumbnail.stale ? '<span class="stale">修订前截图，位置待确认</span>' : ''
        }</div>`
        : '<div class="thumb-wrap no-thumb">无截图</div>';
      const warn = c.status === 'needs-confirm'
        ? '<div class="warn">⚠ 修订版时长/画面变化，此意见位置需要人工确认</div>' : '';
      return `<section class="card status-${c.status}">
        <div class="card-index">#${i + 1}</div>
        ${thumb}
        <div class="card-body">
          <div class="card-head">
            <code>${escapeHtml(Timecode.rangeLabel(c.startFrame, c.endFrame, fps))}</code>
            <span class="tag">${isRange ? '时间段' : '点意见'}${c.rect ? ' + 矩形' : ''}</span>
            ${statusBadge}
          </div>
          <p class="card-text">${escapeHtml(c.text) || '<em>（无文字内容）</em>'}</p>
          ${rect}
          ${warn}
          <div class="card-meta">${escapeHtml(c.author)} · 更新于 ${formatDateTime(c.updatedAt)} · 帧号 ${c.startFrame}${c.endFrame != null ? `–${c.endFrame}` : ''}</div>
        </div>
      </section>`;
    }).join('\n');

    const versions = s.revisions.map((r) => `
      <li>${formatDateTime(r.createdAt)}：${escapeHtml(r.from?.name || '?')}（${r.from?.frameCount ?? '?'} 帧）→
      ${escapeHtml(r.to?.name || '?')}（${r.to?.frameCount ?? '?'} 帧）<small>${escapeHtml(r.method || '')}</small></li>`).join('');

    const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<title>审片报告 - ${escapeHtml(s.name)}</title>
<style>
  body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; margin: 0; background: #f4f5f7; color: #1d2129; }
  header { background: #1f232b; color: #fff; padding: 28px 36px; }
  header h1 { margin: 0 0 8px; font-size: 22px; }
  header .meta { color: #aeb6c2; font-size: 13px; line-height: 1.9; }
  main { max-width: 980px; margin: 24px auto; padding: 0 20px; }
  .summary { display: flex; gap: 12px; margin-bottom: 20px; }
  .summary div { flex: 1; background: #fff; border-radius: 10px; padding: 16px; text-align: center; box-shadow: 0 1px 4px rgba(0,0,0,.08); }
  .summary .n { font-size: 26px; font-weight: 700; }
  .summary .l { color: #6b7280; font-size: 12px; }
  .card { display: flex; gap: 16px; background: #fff; border-radius: 10px; padding: 16px; margin-bottom: 14px;
    box-shadow: 0 1px 4px rgba(0,0,0,.08); border-left: 4px solid #4da3ff; }
  .card.status-done { border-left-color: #3ecf8e; }
  .card.status-needs-confirm { border-left-color: #f5b942; }
  .card-index { font-weight: 700; color: #9aa3b2; font-size: 15px; }
  .thumb-wrap { position: relative; flex: 0 0 256px; }
  .thumb-wrap img { width: 256px; border-radius: 6px; border: 1px solid #dde0e5; display: block; }
  .thumb-wrap.no-thumb { width: 256px; height: 144px; background: #eceef1; border-radius: 6px; display: flex; align-items: center; justify-content: center; color: #9aa3b2; font-size: 12px; }
  .stale { position: absolute; bottom: 6px; left: 6px; background: rgba(180,120,10,.92); color: #fff; font-size: 11px; padding: 2px 7px; border-radius: 4px; }
  .card-body { flex: 1; min-width: 0; }
  .card-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; flex-wrap: wrap; }
  code { background: #eef2f7; padding: 3px 8px; border-radius: 5px; font-size: 13px; font-weight: 700; }
  .tag { font-size: 11px; background: #ede9fe; color: #6d4bc4; padding: 2px 8px; border-radius: 999px; }
  .b { font-size: 11px; padding: 2px 9px; border-radius: 999px; }
  .b-open { background: #e3efff; color: #2f6fdb; }
  .b-done { background: #dcf7ec; color: #187a4e; }
  .b-confirm { background: #fff1d2; color: #a86f08; }
  .card-text { margin: 6px 0; white-space: pre-wrap; word-break: break-word; }
  .rect-info { font-size: 12px; color: #555; background: #f7f8fa; border: 1px solid #e5e7eb; border-radius: 5px; padding: 5px 9px; display: inline-block; }
  .warn { margin-top: 8px; font-size: 12px; color: #a86f08; background: #fff7e6; border: 1px solid #ffe1a8; border-radius: 5px; padding: 5px 9px; }
  .card-meta { margin-top: 10px; font-size: 11px; color: #8a919e; }
  h2 { font-size: 15px; margin: 26px 0 10px; }
  ul.versions { font-size: 12px; color: #4b5563; line-height: 2; }
  ul.versions small { color: #8a919e; }
  footer { text-align: center; color: #9aa3b2; font-size: 11px; padding: 24px; }
  @media print { body { background: #fff; } .card { break-inside: avoid; box-shadow: none; border: 1px solid #ddd; } header { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
</style></head>
<body>
<header>
  <h1>审片报告：${escapeHtml(s.name)}</h1>
  <div class="meta">
    素材：${escapeHtml(media?.name || '未关联')}（${media?.width ?? '?'}×${media?.height ?? '?'}，${fps} fps，${media?.frameCount ?? '?'} 帧）<br>
    导出时间：${formatDateTime(Date.now())} · 共 ${comments.length} 条意见 · 已完成 ${done} 条 · 待确认 ${confirm} 条
  </div>
</header>
<main>
  <div class="summary">
    <div><div class="n">${comments.length}</div><div class="l">意见总数</div></div>
    <div><div class="n">${done}</div><div class="l">已完成</div></div>
    <div><div class="n">${comments.length - done - confirm}</div><div class="l">未完成</div></div>
    <div><div class="n">${confirm}</div><div class="l">待人工确认</div></div>
  </div>
  ${rows || '<p>暂无意见。</p>'}
  ${versions ? `<h2>版本历史</h2><ul class="versions">${versions}</ul>` : ''}
</main>
<footer>由本地视频审片台生成 · 视频仅保存在本机，本报告内嵌的为帧截图而非视频</footer>
</body></html>`;

    download(`${this.baseName(store)}_review_report.html`, html, 'text/html;charset=utf-8');
  },
};
