/* 主控：素材打开/替换、意见编辑弹窗、键盘快捷键、项目存取、修订流程编排。 */
'use strict';

class App {
  constructor() {
    this.store = new Store();
    this.player = new Player($('#video'));
    this.player.fps = this.store.state.fps;

    this.markerLayer = new MarkerLayer({
      stage: $('#stage'), scroll: $('#stage-scroll'), overlay: $('#overlay'),
      svg: $('#marker-svg'), htmlLayer: $('#marker-html'), canvas: $('#draw-canvas'),
      video: $('#video'),
      getComments: () => this.store.state.comments,
      onSelect: (id) => this.selectComment(id),
      getCurrentFrame: () => this.player.currentFrame,
      showAll: () => $('#toggle-all-markers').checked,
    });

    this.panel = new CommentPanel({
      listEl: $('#comment-list'),
      filterText: $('#filter-text'), filterStatus: $('#filter-status'),
      filterType: $('#filter-type'), filterCurrentFrame: $('#filter-current-frame'),
      getStore: () => this.store, getPlayer: () => this.player,
      onEdit: (id) => this.openCommentModal(id),
    });

    this.editingId = null;
    this.pendingRect = null;
    this._mediaFile = null;
    this._replacing = false;
    this._boundFrame = this.onFrameChange.bind(this);

    this.bindEvents();
    this.refreshControls();
    this.renderProjectPanel();

    // 启动时尝试恢复上次工作快照（不含视频文件，需要重新关联）
    if (this.store.loadAutosave()) {
      $('#fps-input').value = this.store.state.fps;
      this.player.fps = this.store.state.fps;
      this.panel.render();
      this.renderProjectPanel();
      this.toast('已恢复上次的审片快照，请重新关联本地视频文件');
    }
    window.app = this;
  }

  /* ---------------- 事件绑定 ---------------- */

  bindEvents() {
    const on = (id, ev, fn) => $(id).addEventListener(ev, fn);

    on('#btn-open-video', 'click', () => this.pickVideo(this.openVideo.bind(this)));
    on('#btn-replace-video', 'click', () => this.pickVideo(this.replaceVideo.bind(this)));
    on('#btn-save', 'click', () => Exporter.exportJSON(this.store));
    on('#btn-open-project', 'click', () => this.pickProject());
    on('#btn-export-report', 'click', () => this.captureMissingThumbs().then(() => Exporter.exportHTML(this.store, this.player)));
    on('#btn-export-json', 'click', () => Exporter.exportJSON(this.store));
    on('#btn-export-csv', 'click', () => Exporter.exportCSV(this.store));

    on('#btn-play', 'click', () => this.player.togglePlay());
    on('#btn-prev-frame', 'click', () => this.player.step(-1));
    on('#btn-next-frame', 'click', () => this.player.step(1));
    on('#btn-prev-comment', 'click', () => this.jumpComment(-1));
    on('#btn-next-comment', 'click', () => this.jumpComment(1));

    on('#scrub', 'input', (e) => {
      this.player.video.pause();
      this.player.seekToFrame(parseInt(e.target.value, 10));
    });

    on('#frame-jump', 'keydown', (e) => {
      if (e.key === 'Enter') this.jumpByInput();
    });
    on('#btn-jump-frame', 'click', () => this.jumpByInput());

    on('#btn-add-point', 'click', () => this.startCreate(null));
    on('#btn-add-rect', 'click', () => this.toggleDrawMode());

    on('#btn-zoom-in', 'click', () => this.markerLayer.zoomBy(1.25));
    on('#btn-zoom-out', 'click', () => this.markerLayer.zoomBy(0.8));
    on('#btn-zoom-fit', 'click', () => this.markerLayer.setZoom('fit'));
    on('#btn-zoom-100', 'click', () => this.markerLayer.setZoom(1));

    on('#fps-input', 'change', (e) => {
      const fps = clamp(parseInt(e.target.value, 10) || 30, 1, 240);
      e.target.value = fps;
      this.player.setFps(fps);
      this.store.setFps(fps);
      this.panel.render();
    });
    on('#toggle-all-markers', 'change', () => this.markerLayer.render());

    // Tab 切换
    $$('.tab').forEach((tab) => tab.addEventListener('click', () => {
      $$('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${tab.dataset.tab}`));
      if (tab.dataset.tab === 'revision') this.renderRevisionPanel();
      if (tab.dataset.tab === 'project') this.renderProjectPanel();
    }));

    // 弹窗
    on('#modal-save', 'click', () => this.saveCommentFromModal());
    on('#modal-cancel', 'click', () => this.closeModal());
    on('#modal-delete', 'click', () => this.deleteEditingComment());
    on('#modal-backdrop', 'click', (e) => { if (e.target.id === 'modal-backdrop') this.closeModal(); });
    on('#replace-cancel', 'click', () => { $('#replace-backdrop').classList.add('hidden'); });
    on('#btn-run-mapping', 'click', () => this.toast('匹配在每次「替换为修订版…」时自动执行；如需重新匹配，请再次选择同一修订版文件'));

    // 矩形绘制事件
    window.addEventListener('marker-drawn', (e) => {
      this.markerLayer.setDrawMode(false);
      $('#btn-add-rect').classList.remove('active');
      this.startCreate(e.detail);
    });
    window.addEventListener('marker-draw-cancel', () => {
      this.markerLayer.setDrawMode(false);
      $('#btn-add-rect').classList.remove('active');
      this.toast('矩形太小，已取消');
    });

    // 播放器事件
    this.player.addEventListener('framechange', this._boundFrame);
    this.player.addEventListener('loaded', () => {
      this.onMediaLoaded();
    });

    // 数据变化 → 重新渲染
    this.store.addEventListener('change', () => {
      this.panel.render();
      this.markerLayer.render();
      this.renderScrubTicks();
      this.renderProjectPanel();
      this.refreshControls();
    });

    // 键盘快捷键
    document.addEventListener('keydown', (e) => this.onKeydown(e));

    // 拖拽视频到舞台
    const scroll = $('#stage-scroll');
    ['dragenter', 'dragover'].forEach((ev) => scroll.addEventListener(ev, (e) => {
      e.preventDefault();
      scroll.classList.add('drag-over');
    }));
    ['dragleave', 'drop'].forEach((ev) => scroll.addEventListener(ev, (e) => {
      e.preventDefault();
      scroll.classList.remove('drag-over');
    }));
    scroll.addEventListener('drop', (e) => {
      const file = e.dataTransfer.files?.[0];
      if (file) this.openVideo(file);
    });

    // 隐藏的文件选择器
    this.videoPicker = document.createElement('input');
    this.videoPicker.type = 'file';
    this.videoPicker.accept = 'video/*,.mkv,.mov,.webm,.avi,.m4v';
    this.projectPicker = document.createElement('input');
    this.projectPicker.type = 'file';
    this.projectPicker.accept = '.json,application/json';
  }

  /* ---------------- 文件选择 ---------------- */

  pickVideo(cb) {
    this.videoPicker.value = '';
    this.videoPicker.onchange = () => {
      const f = this.videoPicker.files?.[0];
      if (f) cb(f);
    };
    this.videoPicker.click();
  }

  pickProject() {
    this.projectPicker.value = '';
    this.projectPicker.onchange = async () => {
      const f = this.projectPicker.files?.[0];
      if (!f) return;
      try {
        const data = JSON.parse(await readFileAsText(f));
        this.store.loadJSON(data);
        $('#fps-input').value = this.store.state.fps;
        this.player.fps = this.store.state.fps;
        this._mediaFile = null;
        $('#stage-hint').classList.remove('hidden');
        $('#stage-hint').innerHTML = `<p>项目已加载：${escapeHtml(this.store.state.name)}</p>
          <p class="sub">项目文件不包含视频本体，请选择「打开本地视频」关联素材：<br><b>${escapeHtml(this.store.state.media?.name || '')}</b></p>`;
        this.toast('项目已打开，请重新关联视频文件');
      } catch (err) {
        this.toast(`项目打开失败：${err.message}`, 'error');
      }
    };
    this.projectPicker.click();
  }

  /* ---------------- 视频加载 ---------------- */

  async buildMedia(file) {
    const buf = await readFileAsArrayBuffer(file);
    const hash = await sha256Hex(buf);
    return {
      name: file.name,
      size: file.size,
      hash,
      type: file.type || '',
      width: null,
      height: null,
      frameCount: null,
      loadedAt: Date.now(),
    };
  }

  async openVideo(file) {
    try {
      const media = await this.buildMedia(file);

      // 加载前先判断是否为不同素材，避免取消后视频已切换、数据却保留的不一致
      const existing = this.store.state.media;
      const isSame = existing && (existing.hash === media.hash || existing.name === media.name);
      if (existing && !isSame) {
        if (!confirm('当前项目已关联其他素材。加载新素材将清空现有意见，确定继续吗？\n（如需保留意见并迁移，请使用「替换为修订版…」）')) {
          return;
        }
        this.store.reset();
      }

      const fps = this.store.state.fps || 30;
      this.player.fps = fps;
      await this.player.load(file, fps);
      media.width = this.player.video.videoWidth;
      media.height = this.player.video.videoHeight;
      media.frameCount = this.player.frameCount;
      this._mediaFile = file;

      if (isSame) {
        this.store.setMedia({ ...existing, ...media });
        this.toast('视频已关联');
      } else {
        this.store.setMedia(media);
        if (!this.store.state.name || this.store.state.name === '未命名审片项目') {
          this.store.state.name = file.name.replace(/\.[^.]+$/, '') + ' 审片项目';
        }
      }
      $('#fps-input').value = this.store.state.fps;
    } catch (err) {
      this.toast(`视频加载失败：${err.message}`, 'error');
    }
  }

  onMediaLoaded() {
    $('#stage-hint').classList.add('hidden');
    this.player.setFps(this.store.state.fps);
    // 修订替换过程中 player 已加载新视频，但 store.media 还是旧素材，不能覆盖其元数据
    if (this.store.state.media && !this._replacing) {
      this.store.state.media.width = this.player.video.videoWidth;
      this.store.state.media.height = this.player.video.videoHeight;
      this.store.state.media.frameCount = this.player.frameCount;
    }
    this.refreshControls();
    this.markerLayer.setZoom('fit');
  }

  /* ---------------- 修订版替换 ---------------- */

  async replaceVideo(file) {
    const oldStore = structuredClone(this.store.state);
    this._replacing = true;   // 阻止 onMediaLoaded 把新视频元数据写回旧素材
    const backdrop = $('#replace-backdrop');
    const stepsEl = $('#replace-steps');
    const stepDefs = ['读取并校验修订版视频', '抽取修订版全部帧指纹', '抽取当前版本帧指纹', '执行画面对齐（动态规划）', '迁移意见并标记待确认项'];
    stepsEl.innerHTML = stepDefs.map((t, i) => `<li class="pending" data-i="${i}">${t}</li>`).join('');
    backdrop.classList.remove('hidden');
    const setStep = (i, cls) => {
      const li = stepsEl.querySelector(`li[data-i="${i}"]`);
      li.className = cls;
      li.textContent = `${stepDefs[i]}${cls === 'done' ? ' ✓' : ''}`;
    };

    try {
      setStep(0, 'active');
      const newMedia = await this.buildMedia(file);
      const oldPlayer = this.player;
      const oldSigs = await oldPlayer.scanSignatures((done, total) => {
        setStep(2, 'active');
        stepsEl.querySelector('li[data-i="2"]').textContent = `${stepDefs[2]}（${done}/${total}）`;
      });
      setStep(2, 'done');

      setStep(0, 'done');
      setStep(1, 'active');
      this.player.fps = oldStore.fps;
      await this.player.load(file, oldStore.fps);
      newMedia.width = this.player.video.videoWidth;
      newMedia.height = this.player.video.videoHeight;
      newMedia.frameCount = this.player.frameCount;
      const newSigs = await this.player.scanSignatures((done, total) => {
        stepsEl.querySelector('li[data-i="1"]').textContent = `${stepDefs[1]}（${done}/${total}）`;
      });
      setStep(1, 'done');

      setStep(3, 'active');
      const alignment = Revision.align(oldSigs, newSigs);
      setStep(3, 'done');

      setStep(4, 'active');
      const mappings = Revision.mapComments(oldStore.comments, alignment, newMedia.frameCount);
      this.store.applyRevision({
        newMedia,
        mappings,
        methodInfo: `帧指纹 NCC + 动态规划对齐（旧 ${oldSigs.length} 帧 / 新 ${newSigs.length} 帧，gap 罚分 ${Revision.GAP_PENALTY}）`,
      });
      this._mediaFile = file;
      setStep(4, 'done');

      const needConfirm = mappings.filter((m) => m.confidence < Revision.CONF_AUTO).length;
      this.toast(`修订版已关联：${mappings.length} 条意见已迁移，${needConfirm} 条待人工确认`, needConfirm ? 'error' : 'success');
      setTimeout(() => backdrop.classList.add('hidden'), 900);
      this.switchTab('revision');
      this.renderRevisionPanel();
      this.markerLayer.setZoom('fit');
    } catch (err) {
      console.error(err);
      this.toast(`替换失败：${err.message}`, 'error');
      backdrop.classList.add('hidden');
    } finally {
      this._replacing = false;
    }
  }

  /* ---------------- 意见创建/编辑 ---------------- */

  startCreate(rect) {
    if (!this.store.state.media) {
      this.toast('请先打开本地视频', 'error');
      return;
    }
    this.pendingRect = rect;
    this.editingId = null;
    const frame = this.player.currentFrame;
    $('#modal-title').textContent = rect ? '新建矩形标记意见' : '新建点意见';
    $('#modal-type-readout').textContent = rect ? '矩形标记（可在下方调整时间范围）' : '点意见（无矩形标记）';
    $('#modal-frame-start').value = frame;
    $('#modal-frame-end').value = '';
    $('#modal-marker-readout').textContent = rect
      ? `x=${rect.x} y=${rect.y} w=${rect.w} h=${rect.h}（归一化 0–1）`
      : '无';
    $('#modal-text').value = '';
    $('#modal-author').value = '审阅人';
    $('#modal-status').value = 'open';
    $('#modal-mapping-box').classList.add('hidden');
    $('#modal-delete').classList.add('hidden');
    $('#modal-backdrop').classList.remove('hidden');
    setTimeout(() => $('#modal-text').focus(), 50);
  }

  openCommentModal(id) {
    const c = this.store.getComment(id);
    if (!c) return;
    this.editingId = id;
    this.pendingRect = c.rect;
    $('#modal-title').textContent = '编辑意见';
    $('#modal-type-readout').textContent = c.rect ? '矩形标记' : '点意见';
    $('#modal-frame-start').value = c.startFrame;
    $('#modal-frame-end').value = c.endFrame ?? '';
    $('#modal-marker-readout').textContent = c.rect
      ? `x=${c.rect.x} y=${c.rect.y} w=${c.rect.w} h=${c.rect.h}`
      : '无';
    $('#modal-text').value = c.text;
    $('#modal-author').value = c.author;
    $('#modal-status').value = c.status;
    const lastHistory = c.history[c.history.length - 1];
    if (lastHistory) {
      $('#modal-mapping-box').classList.remove('hidden');
      $('#modal-confirm-mapping').checked = !!lastHistory.confirmed;
    } else {
      $('#modal-mapping-box').classList.add('hidden');
    }
    $('#modal-delete').classList.remove('hidden');
    $('#modal-backdrop').classList.remove('hidden');
  }

  saveCommentFromModal() {
    const fps = this.store.state.fps;
    const maxFrame = this.player.frameCount - 1;
    let start = clamp(parseInt($('#modal-frame-start').value, 10) || 0, 0, maxFrame);
    const endRaw = $('#modal-frame-end').value;
    let end = endRaw === '' ? null : clamp(parseInt(endRaw, 10) || 0, 0, maxFrame);
    if (end != null && end < start) [start, end] = [end, start];

    const patch = {
      startFrame: start,
      endFrame: end,
      rect: this.pendingRect,
      text: $('#modal-text').value.trim(),
      author: $('#modal-author').value.trim() || '未署名',
      status: $('#modal-status').value,
    };

    let target;
    if (this.editingId) {
      this.store.updateComment(this.editingId, patch);
      target = this.store.getComment(this.editingId);
    } else {
      target = this.store.addComment(patch);
    }

    if (!$('#modal-mapping-box').classList.contains('hidden')) {
      if ($('#modal-confirm-mapping').checked) this.store.confirmMapping(target.id);
    }

    this.closeModal();
    this.markerLayer.setDrawMode(false);
    $('#btn-add-rect').classList.remove('active');
    this.player.seekToFrame(start).then(() => this.captureThumb(target));
    this.selectComment(target.id);
    this.toast('意见已保存');
  }

  deleteEditingComment() {
    if (!this.editingId) return;
    if (confirm('确定删除这条意见吗？')) {
      this.store.removeComment(this.editingId);
      this.closeModal();
    }
  }

  closeModal() {
    $('#modal-backdrop').classList.add('hidden');
    this.editingId = null;
    this.pendingRect = null;
  }

  toggleDrawMode() {
    if (!this.store.state.media) {
      this.toast('请先打开本地视频', 'error');
      return;
    }
    const on = !this.markerLayer.drawMode;
    this.markerLayer.setDrawMode(on);
    $('#btn-add-rect').classList.toggle('active', on);
    if (on) this.toast('在画面上拖拽画出矩形，Esc 取消');
  }

  /* ---------------- 缩略图 ---------------- */

  captureThumb(comment) {
    try {
      const dataUrl = Thumbnails.captureDataUrl(this.player.video);
      if (!dataUrl) return;
      this.store.updateComment(comment.id, {
        thumbnail: { dataUrl, capturedAtFrame: comment.startFrame, stale: false },
      });
    } catch (err) {
      console.warn('截图失败', err);
    }
  }

  /** 导出报告前补齐缺失/过期的截图 */
  async captureMissingThumbs() {
    const targets = this.store.sortedComments().filter((c) => !c.thumbnail?.dataUrl || c.thumbnail.stale);
    for (const c of targets) {
      await this.player.seekToFrame(c.startFrame);
      await new Promise((r) => setTimeout(r, 60));
      const dataUrl = Thumbnails.captureDataUrl(this.player.video);
      if (dataUrl) {
        c.thumbnail = { dataUrl, capturedAtFrame: c.startFrame, stale: false };
      }
    }
    this.store.emit();
  }

  /* ---------------- 选择与跳转 ---------------- */

  selectComment(id) {
    this.panel.setSelected(id);
    this.markerLayer.setSelected(id);
    const c = this.store.getComment(id);
    if (c) this.player.seekToFrame(c.startFrame);
  }

  jumpComment(delta) {
    const sorted = this.store.sortedComments();
    if (!sorted.length) return;
    const cur = this.player.currentFrame;
    let target;
    if (delta > 0) target = sorted.find((c) => c.startFrame > cur);
    else target = [...sorted].reverse().find((c) => c.startFrame < cur);
    if (!target) target = delta > 0 ? sorted[0] : sorted[sorted.length - 1];
    this.selectComment(target.id);
  }

  jumpByInput() {
    const raw = $('#frame-jump').value;
    const parsed = Timecode.parseTc(raw, this.store.state.fps);
    if (parsed == null) {
      this.toast('无法识别的帧号/时间码，支持格式：帧号(如 45)、秒(如 1.5)、HH:MM:SS:FF', 'error');
      return;
    }
    this.player.seekToFrame(parsed);
  }

  switchTab(name) {
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${name}`));
  }

  /* ---------------- 帧变化刷新 ---------------- */

  onFrameChange() {
    const f = this.player.currentFrame;
    const fps = this.store.state.fps;
    $('#tc-current').textContent = Timecode.framesToTc(f, fps);
    const frameInput = $('#frame-jump');
    if (document.activeElement !== frameInput) frameInput.value = f;
    const scrub = $('#scrub');
    if (document.activeElement !== scrub) scrub.value = f;
    this.markerLayer.render();
    // 当前帧筛选时同步列表
    if ($('#filter-current-frame').checked) this.panel.render();
  }

  refreshControls() {
    const hasMedia = !!this.store.state.media;
    ['#btn-replace-video', '#btn-save', '#btn-export-report', '#btn-export-json', '#btn-export-csv',
      '#btn-add-point', '#btn-add-rect'].forEach((id) => { $(id).disabled = !hasMedia; });
    const scrub = $('#scrub');
    scrub.disabled = !hasMedia;
    $('#frame-jump').disabled = !hasMedia;
    $('#btn-jump-frame').disabled = !hasMedia;
    scrub.max = String(Math.max(0, this.player.frameCount - 1));
    $('#frame-count').textContent = this.player.frameCount;
    $('#tc-duration').textContent = Timecode.framesToTc(Math.max(0, this.player.frameCount - 1), this.store.state.fps);
    $('#zoom-label').textContent = this.markerLayer.zoomLabel;

    const badge = $('#media-badge');
    if (hasMedia) {
      const m = this.store.state.media;
      badge.classList.add('loaded');
      badge.textContent = `${m.name} · ${m.width}×${m.height} · ${m.frameCount} 帧 @ ${this.store.state.fps}fps`;
      badge.title = `${m.name}\nSHA-256: ${m.hash}\n大小: ${formatBytes(m.size)}`;
      $('#stage-hint').classList.add('hidden');
    } else {
      badge.classList.remove('loaded');
      badge.textContent = '未加载视频';
    }
  }

  renderScrubTicks() {
    const ticks = $('#scrub-ticks');
    const total = Math.max(1, this.player.frameCount - 1);
    ticks.innerHTML = this.store.state.comments.map((c) => {
      const left = (c.startFrame / total) * 100;
      return `<span class="scrub-tick ${c.status}" style="left:${left.toFixed(2)}%" title="${escapeHtml(c.text)}"></span>`;
    }).join('');
  }

  /* ---------------- 修订面板 ---------------- */

  renderRevisionPanel() {
    const revisions = this.store.state.revisions;
    const comments = this.store.state.comments;
    const summary = $('#revision-summary');
    const list = $('#revision-list');
    $('#btn-run-mapping').disabled = !this.store.state.media;

    if (!revisions.length) {
      summary.innerHTML = '';
      list.innerHTML = '<div class="empty-state">还没有替换过修订版。<br>使用顶栏「替换为修订版…」开始画面匹配迁移。</div>';
      return;
    }
    const last = revisions[revisions.length - 1];
    const confirmCount = comments.filter((c) => c.status === 'needs-confirm').length;
    const autoCount = comments.length - confirmCount;
    summary.innerHTML = `
      <div class="stat-box"><div class="num">${last.from?.frameCount ?? '?'}</div><div class="lbl">旧版帧数</div></div>
      <div class="stat-box"><div class="num">${last.to?.frameCount ?? '?'}</div><div class="lbl">新版帧数</div></div>
      <div class="stat-box"><div class="num" style="color:var(--green)">${autoCount}</div><div class="lbl">自动迁移</div></div>
      <div class="stat-box"><div class="num" style="color:var(--amber)">${confirmCount}</div><div class="lbl">待人工确认</div></div>`;

    const fps = this.store.state.fps;
    list.innerHTML = comments.map((c) => {
      const h = c.history[c.history.length - 1];
      if (!h) return '';
      const pct = Math.round((h.confidence || 0) * 100);
      const cls = h.confidence >= Revision.CONF_AUTO ? '' : h.confidence >= Revision.CONF_SOFT ? 'low' : 'bad';
      const confText = h.confidence >= Revision.CONF_AUTO ? '高置信自动迁移' : h.confidence >= Revision.CONF_SOFT ? '低置信，建议确认' : '无可靠匹配，必须确认';
      return `<div class="rev-item">
        <div class="row">
          <code>${Timecode.framesToTc(h.oldStartFrame, fps)}</code>
          <span class="arrow">→</span>
          <code>${Timecode.framesToTc(h.newStartFrame, fps)}</code>
          <span class="cc-status ${c.status}">${c.status === 'needs-confirm' ? '待确认' : c.status === 'done' ? '已完成' : '已迁移'}</span>
          ${h.confirmed ? '<span style="color:var(--green)">✓ 已人工确认</span>' : ''}
        </div>
        <div class="dim" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(c.text || '（无文字）')}</div>
        <div class="conf-bar"><div class="conf-fill ${cls}" style="width:${pct}%"></div></div>
        <div class="row" style="justify-content:space-between">
          <span class="dim">${confText}（NCC ${h.confidence.toFixed(2)}）</span>
          <span style="display:flex;gap:6px">
            <button class="btn small" data-act="old" data-id="${c.id}">看旧位置</button>
            <button class="btn small" data-act="new" data-id="${c.id}">看新位置</button>
            <button class="btn small primary" data-act="confirm" data-id="${c.id}">确认无误</button>
          </span>
        </div>
      </div>`;
    }).join('');

    list.querySelectorAll('button[data-act]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const c = this.store.getComment(btn.dataset.id);
        const h = c.history[c.history.length - 1];
        if (btn.dataset.act === 'new') this.player.seekToFrame(h.newStartFrame);
        if (btn.dataset.act === 'old') this.toast(`旧位置 ${Timecode.framesToTc(h.oldStartFrame, this.store.state.fps)}（第 ${h.oldStartFrame} 帧），旧版视频已不在项目中`);
        if (btn.dataset.act === 'confirm') {
          this.store.confirmMapping(btn.dataset.id);
          this.renderRevisionPanel();
          this.toast('已确认该意见的迁移位置');
        }
      });
    });
  }

  /* ---------------- 项目面板 ---------------- */

  renderProjectPanel() {
    const s = this.store.state;
    const info = $('#project-media-info');
    if (!s.media) {
      info.innerHTML = '<div class="empty-text">未加载</div>';
    } else {
      info.innerHTML = `
        <div class="kv"><span class="k">文件名</span><span class="v">${escapeHtml(s.media.name)}</span></div>
        <div class="kv"><span class="k">分辨率</span><span class="v">${s.media.width}×${s.media.height}</span></div>
        <div class="kv"><span class="k">帧率</span><span class="v">${s.fps} fps</span></div>
        <div class="kv"><span class="k">帧数/时长</span><span class="v">${s.media.frameCount} 帧 / ${(s.media.frameCount / s.fps).toFixed(2)}s</span></div>
        <div class="kv"><span class="k">大小</span><span class="v">${formatBytes(s.media.size)}</span></div>
        <div class="kv"><span class="k">SHA-256</span><span class="v" style="font-size:10px">${s.media.hash.slice(0, 24)}…</span></div>`;
    }

    $('#version-list').innerHTML = s.revisions.length ? s.revisions.map((r, i) => `
      <div class="version-item ${i === s.revisions.length - 1 ? 'current' : ''}">
        <div class="vi-head"><span>v${i + 1} → v${i + 2}</span><span>${formatDateTime(r.createdAt)}</span></div>
        <div class="dim">${escapeHtml(r.from?.name || '?')}（${r.from?.frameCount ?? '?'}帧）→ ${escapeHtml(r.to?.name || '?')}（${r.to?.frameCount ?? '?'}帧）</div>
      </div>`).join('') : '<div class="empty-text">尚无修订记录</div>';

    const total = s.comments.length;
    const done = s.comments.filter((c) => c.status === 'done').length;
    const confirm = s.comments.filter((c) => c.status === 'needs-confirm').length;
    const withRect = s.comments.filter((c) => c.rect).length;
    $('#project-stats').innerHTML = `
      <div class="kv"><span class="k">意见总数</span><span class="v">${total}</span></div>
      <div class="kv"><span class="k">已完成</span><span class="v">${done}</span></div>
      <div class="kv"><span class="k">待人工确认</span><span class="v">${confirm}</span></div>
      <div class="kv"><span class="k">含矩形标记</span><span class="v">${withRect}</span></div>
      <div class="kv"><span class="k">最近更新</span><span class="v">${formatDateTime(s.updatedAt)}</span></div>`;
  }

  /* ---------------- 快捷键 ---------------- */

  onKeydown(e) {
    if (e.target.matches('input, textarea, select') || !$('#modal-backdrop').classList.contains('hidden')) {
      if (e.key === 'Escape' && !$('#modal-backdrop').classList.contains('hidden')) this.closeModal();
      return;
    }
    switch (e.key) {
      case ' ':
        e.preventDefault();
        this.player.togglePlay();
        break;
      case 'ArrowLeft':
      case ',':
        e.preventDefault();
        this.player.step(-1);
        break;
      case 'ArrowRight':
      case '.':
        e.preventDefault();
        this.player.step(1);
        break;
      case '[': this.jumpComment(-1); break;
      case ']': this.jumpComment(1); break;
      case 'n': case 'N': this.startCreate(null); break;
      case 'r': case 'R': this.toggleDrawMode(); break;
      case 'Escape':
        if (this.markerLayer.drawMode) this.toggleDrawMode();
        break;
    }
  }

  /* ---------------- Toast ---------------- */

  toast(msg, type = '') {
    const el = $('#toast');
    el.textContent = msg;
    el.className = `toast ${type}`;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => el.classList.add('hidden'), 3200);
  }
}

window.addEventListener('DOMContentLoaded', () => new App());
