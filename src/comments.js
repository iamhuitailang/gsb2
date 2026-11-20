/* 右侧意见列表：按时间排序、筛选、同帧编号区分、点击跳转。 */
'use strict';

class CommentPanel {
  constructor({ listEl, filterText, filterStatus, filterType, filterCurrentFrame, getStore, getPlayer, onEdit }) {
    this.listEl = listEl;
    this.filterText = filterText;
    this.filterStatus = filterStatus;
    this.filterType = filterType;
    this.filterCurrentFrame = filterCurrentFrame;
    this.getStore = getStore;
    this.getPlayer = getPlayer;
    this.onEdit = onEdit;
    this.selectedId = null;

    [this.filterText, this.filterStatus, this.filterType].forEach((el) =>
      el.addEventListener('input', () => this.render()));
    this.filterCurrentFrame.addEventListener('change', () => this.render());
  }

  setSelected(id) {
    this.selectedId = id;
    this.render();
  }

  /** 同一起始帧的意见序号（从 1 开始），用于区分同一时间的多条意见 */
  static frameSequence(comments, target) {
    return comments.filter((c) => c.startFrame === target.startFrame)
      .sort((a, b) => a.createdAt - b.createdAt)
      .findIndex((c) => c.id === target.id) + 1;
  }

  filtered() {
    const store = this.getStore();
    const fps = store.state.fps;
    const q = this.filterText.value.trim().toLowerCase();
    const status = this.filterStatus.value;
    const type = this.filterType.value;
    const onlyCurrent = this.filterCurrentFrame.checked;
    const cur = this.getPlayer()?.currentFrame ?? -1;

    return store.sortedComments().filter((c) => {
      if (q && !`${c.text} ${c.author}`.toLowerCase().includes(q)) return false;
      if (status !== 'all' && c.status !== status) return false;
      if (type === 'point' && c.endFrame != null) return false;
      if (type === 'range' && c.endFrame == null) return false;
      if (onlyCurrent && !(cur >= c.startFrame && cur <= (c.endFrame ?? c.startFrame))) return false;
      return true;
    });
  }

  render() {
    const store = this.getStore();
    const fps = store.state.fps;
    const all = store.sortedComments();
    const items = this.filtered();

    $('#count-badge').textContent = store.state.comments.length;

    if (!items.length) {
      this.listEl.innerHTML = `<div class="empty-state">${
        store.state.comments.length ? '没有符合筛选条件的意见' : '还没有意见。把播放头停在某一帧，点击「＋ 点意见」或「▭ 矩形标记」开始标注'
      }</div>`;
      return;
    }

    // 按起始帧分组渲染
    const groups = new Map();
    for (const c of items) {
      if (!groups.has(c.startFrame)) groups.set(c.startFrame, []);
      groups.get(c.startFrame).push(c);
    }

    this.listEl.innerHTML = '';
    for (const [frame, group] of groups) {
      const header = document.createElement('div');
      header.className = 'group-header';
      header.innerHTML = `<span class="group-tc">${Timecode.framesToTc(frame, fps)}</span><span class="dim">第 ${frame} 帧 · ${group.length} 条</span>`;
      header.style.cssText = 'display:flex;justify-content:space-between;font-size:11px;color:var(--text-dim);padding:4px 4px 2px;';
      this.listEl.appendChild(header);

      for (const c of group) {
        const seq = CommentPanel.frameSequence(all, c);
        this.listEl.appendChild(this._card(c, seq, fps));
      }
    }
  }

  _card(c, seq, fps) {
    const card = document.createElement('div');
    card.className = `comment-card status-${c.status} ${this.selectedId === c.id ? 'selected' : ''}`;
    card.dataset.id = c.id;

    const isRange = c.endFrame != null;
    const statusLabel = { open: '未完成', done: '已完成', 'needs-confirm': '待人工确认' }[c.status];
    const thumb = c.thumbnail?.dataUrl
      ? `<img class="cc-thumb" src="${c.thumbnail.dataUrl}" alt="" style="${c.thumbnail.stale ? 'opacity:.55' : ''}">`
      : '';
    const warn = c.status === 'needs-confirm'
      ? `<div class="cc-warn">⚠ 修订版时长/画面有变化，此条位置（${Timecode.framesToTc(c.startFrame, fps)}）需要人工确认</div>`
      : '';

    card.innerHTML = `
      ${thumb}
      <div class="cc-head">
        <span class="cc-tc">#${seq} ${Timecode.rangeLabel(c.startFrame, c.endFrame, fps)}</span>
        <span class="cc-type ${isRange ? 'range' : ''}">${isRange ? '时间段' : '点意见'}${c.rect ? ' + 矩形' : ''}</span>
        <span class="cc-status ${c.status}">${statusLabel}</span>
      </div>
      <div class="cc-text">${escapeHtml(c.text) || '<span class="dim">（无文字内容）</span>'}</div>
      <div class="cc-meta">
        <span>${escapeHtml(c.author)}</span>
        <span>更新于 ${formatDateTime(c.updatedAt)}</span>
      </div>
      ${warn}
      <div class="cc-actions">
        <button class="btn small act-jump">跳到该帧</button>
        <button class="btn small act-edit">编辑</button>
        <button class="btn small act-toggle">${c.status === 'done' ? '标为未完成' : '标记完成'}</button>
      </div>`;

    card.querySelector('.act-jump').addEventListener('click', (e) => {
      e.stopPropagation();
      this.getPlayer().seekToFrame(c.startFrame);
    });
    card.querySelector('.act-edit').addEventListener('click', (e) => {
      e.stopPropagation();
      this.onEdit(c.id);
    });
    card.querySelector('.act-toggle').addEventListener('click', (e) => {
      e.stopPropagation();
      const store = this.getStore();
      store.updateComment(c.id, { status: c.status === 'done' ? 'open' : 'done' });
    });
    card.addEventListener('click', () => {
      this.getPlayer().seekToFrame(c.startFrame);
    });
    return card;
  }
}
