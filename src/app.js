// 应用主控制器：状态、撤销/重做、同步、偏移校正与前后对比、工程保存/打开、EDL 导出。

import {
  createProject,
  addCut,
  removeCut,
  moveCut,
  setSegmentCamera,
  setSourceOffset,
  segmentAt,
  buildSegments,
  timelineBounds,
  coverageAt,
  diffCuts,
  diffOffsets,
  getSource,
} from './core/model.js';
import { parseFps, formatTimecode, formatSeconds, formatOffset } from './core/time.js';
import { estimateOffset, ENVELOPE_RATE } from './core/sync.js';
import { buildEDL, edlToCsv } from './core/edl.js';
import { serializeProject, deserializeProject } from './core/persistence.js';
import { MediaStore } from './media.js';
import { Player } from './player.js';
import { Timeline, sourceColor } from './timeline.js';

const HISTORY_LIMIT = 100;

const $ = (id) => document.getElementById(id);

class App {
  constructor() {
    this.project = createProject();
    this.media = new MediaStore();
    this.history = [];
    this.future = [];
    this.projectName = '未命名工程';
    this.dirty = false;
    this.selectedSegment = -1;
    /** 偏移修改前后的对比基线：{ label, project, offsets, cuts } */
    this.compareBaseline = null;

    this.cacheDom();
    this.player = new Player(this.canvas, this.media, () => this.project);
    this.timeline = new Timeline(this.timelineCanvas, this.media, () => this.project, {
      onSeek: (t) => this.seek(t),
      onMoveCutStart: (i) => this.snapshot(),
      onMoveCut: (i, t) => this.applyMoveCut(i, t),
      onSelectSegment: (i) => this.selectSegment(i),
      onAddCut: (t) => this.applyAddCut(t),
      onDragSourceOffset: (id, off) => this.liveOffsetPreview(id, off),
    });
    this.player.onFrame = (t) => this.timeline.setPlayhead(t);
    this.bindUi();
    this.refreshAll();
  }

  cacheDom() {
    this.canvas = $('preview');
    this.timelineCanvas = $('timeline');
    this.sourcesList = $('sources-list');
    this.segmentsList = $('segments-list');
    this.syncPanel = $('sync-panel');
    this.offsetPanel = $('offset-panel');
    this.diffPanel = $('diff-panel');
    this.status = $('status-text');
    this.playBtn = $('play-btn');
    this.timeReadout = $('time-readout');
  }

  bindUi() {
    $('import-btn').addEventListener('click', () => $('file-input').click());
    $('file-input').addEventListener('change', (e) => this.importFiles([...e.target.files]));
    $('open-project-btn').addEventListener('click', () => $('project-input').click());
    $('project-input').addEventListener('change', (e) => this.openProject([...e.target.files]));
    $('save-project-btn').addEventListener('click', () => this.saveProject());
    $('export-json-btn').addEventListener('click', () => this.exportEDL('json'));
    $('export-csv-btn').addEventListener('click', () => this.exportEDL('csv'));
    $('load-sample-btn').addEventListener('click', () => this.loadSampleFlow());

    this.playBtn.addEventListener('click', () => this.togglePlay());
    $('seek-start-btn').addEventListener('click', () => this.seek(this.timeline.currentBounds().min));
    $('seek-end-btn').addEventListener('click', () => this.seek(this.timeline.currentBounds().max));
    $('add-cut-btn').addEventListener('click', () => this.applyAddCut(this.player.timelineTime));
    $('del-cut-btn').addEventListener('click', () => this.applyRemoveCut(this.selectedSegment));
    $('undo-btn').addEventListener('click', () => this.undo());
    $('redo-btn').addEventListener('click', () => this.redo());
    $('zoom-in-btn').addEventListener('click', () => this.timeline.zoom(1 / 1.3, this.player.timelineTime));
    $('zoom-out-btn').addEventListener('click', () => this.timeline.zoom(1.3, this.player.timelineTime));
    $('zoom-fit-btn').addEventListener('click', () => this.timeline.fitToProject());

    // 同步面板
    this.syncPanel.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === 'sync-all') this.runSyncAll(btn);
      if (action === 'sync-one') this.runSyncOne(btn.dataset.sourceId, btn);
      if (action === 'set-ref') this.setReference(btn.dataset.sourceId);
    });

    // 偏移面板
    this.offsetPanel.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const { action, sourceId } = btn.dataset;
      const src = getSource(this.project, sourceId);
      if (!src) return;
      const fps = parseFps(src.fps);
      if (action === 'nudge-minus-frame') this.beginOffsetEdit(sourceId, src.offset - 1 / fps);
      if (action === 'nudge-plus-frame') this.beginOffsetEdit(sourceId, src.offset + 1 / fps);
      if (action === 'nudge-minus-ms') this.beginOffsetEdit(sourceId, src.offset - 0.001);
      if (action === 'nudge-plus-ms') this.beginOffsetEdit(sourceId, src.offset + 0.001);
      if (action === 'commit') this.commitOffsetEdit();
      if (action === 'revert') this.revertOffsetEdit();
      if (action === 'compare') this.toggleCompare();
    });
    this.offsetPanel.addEventListener('change', (e) => {
      if (e.target.dataset.action === 'offset-input') {
        const src = getSource(this.project, e.target.dataset.sourceId);
        const v = parseFloat(e.target.value);
        if (src && Number.isFinite(v)) this.beginOffsetEdit(src.id, v);
      }
    });

    // 段落列表：切换机位
    this.segmentsList.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-camera]');
      const row = e.target.closest('tr[data-segment]');
      if (!row) return;
      const i = Number(row.dataset.segment);
      if (btn) {
        this.applySegmentCamera(i, btn.dataset.camera);
      } else {
        this.selectSegment(i);
        const seg = buildSegments(this.project)[i];
        if (seg) this.seek(seg.start);
      }
    });

    this.sourcesList.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-remove-source]');
      if (btn) this.removeSource(btn.dataset.removeSource);
    });

    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT') return;
      if (e.code === 'Space') {
        e.preventDefault();
        this.togglePlay();
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        this.undo();
      } else if ((e.metaKey || e.ctrlKey) && (e.key === 'y' || (e.shiftKey && e.key === 'Z'))) {
        e.preventDefault();
        this.redo();
      } else if (/^[1-9]$/.test(e.key)) {
        const i = this.selectedSegment >= 0 ? this.selectedSegment : segmentAt(this.project, this.player.timelineTime)?.cutIndex;
        const src = this.project.sources[Number(e.key) - 1];
        if (i !== undefined && src) this.applySegmentCamera(i, src.id);
      }
    });

    window.addEventListener('resize', () => this.refreshAll());
  }

  // ---------- 历史 ----------

  snapshot() {
    this.history.push(structuredClone(this.project));
    if (this.history.length > HISTORY_LIMIT) this.history.shift();
    this.future = [];
    this.dirty = true;
  }

  undo() {
    if (this.history.length === 0) return this.flashStatus('没有可撤销的操作');
    this.future.push(structuredClone(this.project));
    this.project = this.history.pop();
    this.dirty = true;
    this.refreshAll();
    this.player.seek(this.player.timelineTime);
  }

  redo() {
    if (this.future.length === 0) return this.flashStatus('没有可重做的操作');
    this.history.push(structuredClone(this.project));
    this.project = this.future.pop();
    this.dirty = true;
    this.refreshAll();
    this.player.seek(this.player.timelineTime);
  }

  // ---------- 导入 ----------

  async importFiles(files) {
    if (files.length === 0) return;
    this.flashStatus(`正在读取 ${files.length} 个本地文件…`);
    const firstImport = this.project.sources.length === 0;
    for (const file of files) {
      try {
        const id = await this.media.loadFile(file);
        const item = this.media.get(id);
        this.snapshot();
        this.project.sources.push({
          id,
          name: file.name,
          path: file.webkitRelativePath || file.name,
          size: file.size,
          kind: item.kind,
          duration: item.duration,
          fps: item.kind === 'video' ? item.fps : null,
          offset: 0,
          hasAudio: !!item.audioBuffer,
        });
        if (firstImport && this.project.cuts.length === 0) {
          this.project.cuts.push({ id: `cut_${id}`, time: 0, sourceId: id });
        }
      } catch (err) {
        this.flashStatus(`跳过 ${file.name}：${err.message}`);
      }
    }
    this.timeline.fitToProject();
    this.refreshAll();
    this.flashStatus(`已导入 ${files.length} 个文件（仅本地读取，未上传）`);
  }

  removeSource(sourceId) {
    const idx = this.project.sources.findIndex((s) => s.id === sourceId);
    if (idx < 0) return;
    this.snapshot();
    this.project.sources.splice(idx, 1);
    this.project.cuts = this.project.cuts.filter((c) => c.sourceId !== sourceId);
    this.media.release(sourceId);
    if (this.project.cuts.length === 0 && this.project.sources.length > 0) {
      const s = this.project.sources[0];
      this.project.cuts.push({ id: `cut_${s.id}`, time: s.offset, sourceId: s.id });
    }
    this.refreshAll();
    this.player.seek(this.player.timelineTime);
  }

  // ---------- 自动同步 ----------

  referenceSourceId() {
    return this.project.sources.find((s) => this.media.hasAudio(s.id))?.id || null;
  }

  async runSyncAll(btn) {
    const refId = this.referenceSourceId();
    if (!refId) return this.flashStatus('没有带音轨的素材可用于同步');
    this.flashStatus('正在解码音频并计算波形互相关…');
    await Promise.all(this.project.sources.map((s) => this.media.whenReady(s.id)));
    const ref = this.media.get(refId);
    this.snapshot();
    const refSrc = getSource(this.project, refId);
    const reports = [];
    for (const src of this.project.sources) {
      if (src.id === refId || !this.media.hasAudio(src.id)) continue;
      const item = this.media.get(src.id);
      const est = estimateOffset(ref.envelope, item.envelope, refSrc.offset);
      this.applyOffsetValue(src.id, est.offset, /*record*/ false);
      reports.push(`${src.name}: ${formatOffset(est.offset)}（置信度 ${(est.confidence * 100).toFixed(0)}%）`);
    }
    this.refreshAll();
    this.player.seek(this.player.timelineTime);
    btn.textContent = '重新同步全部';
    this.flashStatus(`同步完成，参考机位 ${refSrc.name}。${reports.join('；') || '没有其它带音轨素材'}`);
  }

  async runSyncOne(sourceId, btn) {
    const refId = this.referenceSourceId();
    if (!refId) return this.flashStatus('没有带音轨的参考机位');
    if (sourceId === refId) return this.flashStatus('该素材本身就是参考机位');
    await Promise.all([this.media.whenReady(refId), this.media.whenReady(sourceId)]);
    const refItem = this.media.get(refId);
    const item = this.media.get(sourceId);
    if (!item?.envelope) return this.flashStatus('该素材没有可用于同步的音轨');
    this.snapshot();
    const est = estimateOffset(refItem.envelope, item.envelope, getSource(this.project, refId).offset);
    this.applyOffsetValue(sourceId, est.offset, false);
    // 在偏移面板展示候选，方便手动在多个峰值间切换
    const src = getSource(this.project, sourceId);
    src._lastCandidates = est.candidates;
    this.refreshAll();
    this.player.seek(this.player.timelineTime);
    this.flashStatus(
      `${src.name} 同步结果 ${formatOffset(est.offset)}，置信度 ${(est.confidence * 100).toFixed(0)}%。可在「偏移校正」里微调`,
    );
  }

  setReference(sourceId) {
    // 参考机位约定 offset 为 0（时间线锚点），其余素材相对它计算
    this.snapshot();
    const ref = getSource(this.project, sourceId);
    const delta = -ref.offset;
    for (const s of this.project.sources) this.applyOffsetValue(s.id, s.offset + delta, false);
    this.refreshAll();
    this.player.seek(this.player.timelineTime);
    this.flashStatus(`已把 ${ref.name} 设为参考机位（偏移归零，其余素材平移）`);
  }

  // ---------- 偏移手动校正 + 前后对比 ----------

  /**
   * 开始一次偏移编辑：记录基线（修改前快照），随后每次微调只更新该素材，
   * setSourceOffset 内部只重算与该机位相关的切点，其它切点不动。
   * 同一素材的连续微调合并为一个可撤销步骤。
   */
  beginOffsetEdit(sourceId, newOffset) {
    if (!this.compareBaseline || this.compareBaseline.sourceId !== sourceId) {
      this.snapshot();
      this.compareBaseline = {
        sourceId,
        label: getSource(this.project, sourceId).name,
        project: structuredClone(this.history[this.history.length - 1]),
        showingAfter: true,
      };
    }
    this.applyOffsetValue(sourceId, newOffset, false);
    this.refreshAll();
    this.player.seek(this.player.timelineTime);
  }

  liveOffsetPreview(sourceId, newOffset) {
    // 拖动泳道手柄：首次按下建立基线并压栈，拖动过程不再产生历史条目
    if (!this.compareBaseline || this.compareBaseline.sourceId !== sourceId) {
      this.snapshot();
      this.compareBaseline = {
        sourceId,
        label: getSource(this.project, sourceId).name,
        project: structuredClone(this.history[this.history.length - 1]),
        showingAfter: true,
      };
    }
    this.applyOffsetValue(sourceId, newOffset, false);
    this.refreshAll();
    this.player.seek(this.player.timelineTime);
  }

  commitOffsetEdit() {
    if (!this.compareBaseline) return;
    this.flashStatus(`已确认 ${this.compareBaseline.label} 的偏移修改，可点「对比修改前后」查看差异`);
  }

  revertOffsetEdit() {
    if (!this.compareBaseline) return;
    // 回到修改前：与 undo 等价，保证历史栈一致
    this.future.push(structuredClone(this.project));
    this.project = structuredClone(this.compareBaseline.project);
    this.history.pop();
    this.compareBaseline = null;
    this.dirty = true;
    this.refreshAll();
    this.player.seek(this.player.timelineTime);
    this.flashStatus('已恢复到本次偏移修改前');
  }

  /** 在修改前/修改后两套时间线之间切换预览（播放头的时间线时间保持不变 -> 无时间跳跃）。 */
  toggleCompare() {
    if (!this.compareBaseline) return this.flashStatus('先调整某个素材的偏移，再进行前后对比');
    if (this.compareBaseline.showingAfter) {
      // 当前是修改后 -> 切到修改前，两份工程交换保存
      const after = structuredClone(this.project);
      this.project = structuredClone(this.compareBaseline.project);
      this.compareBaseline.project = after;
      this.compareBaseline.showingAfter = false;
    } else {
      const before = structuredClone(this.project);
      this.project = structuredClone(this.compareBaseline.project);
      this.compareBaseline.project = before;
      this.compareBaseline.showingAfter = true;
    }
    const beforeProject = this.compareBaseline.showingAfter ? this.compareBaseline.project : this.project;
    const afterProject = this.compareBaseline.showingAfter ? this.project : this.compareBaseline.project;
    const offsetChanges = diffOffsets(beforeProject, afterProject);
    const cutChanges = diffCuts(beforeProject, afterProject);
    this.refreshAll();
    this.player.seek(this.player.timelineTime);
    this.flashStatus(
      `正在预览「${this.compareBaseline.showingAfter ? '修改后' : '修改前'}」：偏移变化 ${offsetChanges.length} 处，受影响切点 ${cutChanges.length} 个，再点一次切回`,
    );
  }

  applyOffsetValue(sourceId, newOffset, record = true) {
    if (record) this.snapshot();
    setSourceOffset(this.project, sourceId, newOffset);
    this.dirty = true;
  }

  // ---------- 切点 / 机位 ----------

  applyAddCut(t) {
    this.snapshot();
    const i = addCut(this.project, t);
    if (i !== null) this.selectSegment(i);
    this.refreshAll();
    this.player.seek(this.player.timelineTime);
  }

  applyRemoveCut(cutIndex) {
    if (cutIndex <= 0) return this.flashStatus('第一个切点是时间线起点，不能删除');
    this.snapshot();
    removeCut(this.project, cutIndex);
    this.selectedSegment = Math.max(0, this.selectedSegment - 1);
    this.refreshAll();
    this.player.seek(this.player.timelineTime);
  }

  applyMoveCut(i, t) {
    moveCut(this.project, i, t);
    this.dirty = true;
    this.refreshAll();
    this.player.seek(this.player.timelineTime);
  }

  applySegmentCamera(cutIndex, sourceId) {
    this.snapshot();
    setSegmentCamera(this.project, cutIndex, sourceId);
    this.selectSegment(cutIndex);
    this.refreshAll();
    this.player.seek(this.player.timelineTime);
  }

  selectSegment(i) {
    this.selectedSegment = i;
    this.timeline.setSelected(i);
    this.refreshSegments();
  }

  // ---------- 播放 ----------

  togglePlay() {
    this.player.toggle();
    this.playBtn.textContent = this.player.playing ? '⏸ 暂停' : '▶ 播放';
  }

  seek(t) {
    const b = timelineBounds(this.project);
    const clamped = b.duration > 0 ? Math.min(b.max, Math.max(b.min, t)) : t;
    this.player.seek(clamped);
    this.timeline.setPlayhead(clamped);
    this.timeReadout.textContent = `${formatSeconds(clamped)}s  ${formatTimecode(clamped, 30)}`;
  }

  // ---------- 工程保存 / 打开 ----------

  saveProject() {
    const json = serializeProject(this.project, this.projectName);
    downloadText(`${this.projectName}.multicam.json`, json, 'application/json');
    this.dirty = false;
    this.flashStatus('工程已保存（只含文件名指纹、偏移与切点，不含素材本体）');
  }

  /**
   * 打开工程。支持两种选择方式：
   *  - 只选工程 json：打开后对缺失素材弹出补选对话框；
   *  - 同时选 json 和素材文件：一次性按文件名+大小匹配。
   */
  async openProject(files) {
    if (files.length === 0) return;
    const projectFile = files.find((f) => f.name.endsWith('.json')) || files[0];
    let handles = files.filter((f) => f !== projectFile);
    try {
      const json = JSON.parse(await projectFile.text());
      let { project, missing, name } = deserializeProject(json, handles);
      // 只选了工程文件、或部分素材没匹配上：引导用户补选
      if (missing.length > 0) {
        const more = await this.pickFiles(
          `工程引用了 ${missing.length} 个本地素材，请选择这些文件（可多选，文件名需一致）：${missing
            .map((m) => m.name)
            .join('、')}`,
        );
        if (more.length > 0) {
          handles = [...handles, ...more];
          ({ project, missing, name } = deserializeProject(json, handles));
        }
      }
      // 反序列化拿到 source.id <-> 文件 的映射后，用稳定 id 载入媒体
      this.media.clear();
      for (const src of project.sources) {
        const file = src.handle;
        if (!file) continue; // 缺失素材：保留记录，UI 标注「素材缺失」
        try {
          await this.media.loadFile(file, src.kind, src.id);
        } catch {
          /* 个别文件损坏不阻塞整体打开，缺失状态会在 UI 标注 */
        }
      }
      this.project = project;
      this.projectName = name;
      this.history = [];
      this.future = [];
      this.compareBaseline = null;
      this.selectedSegment = 0;
      this.timeline.fitToProject();
      this.refreshAll();
      this.seek(timelineBounds(project).min);
      this.flashStatus(
        missing.length
          ? `工程已打开，${missing.length} 个素材未找到本地文件：${missing.map((m) => m.name).join('、')}（相关段落标注为素材缺失，可重新「打开工程」补选）`
          : '工程已打开，全部素材已重新定位',
      );
    } catch (err) {
      this.flashStatus(`工程打开失败：${err.message}`);
    }
  }

  /** 弹出原生文件选择框，返回选中的 File 数组（取消则为空数组）。 */
  pickFiles(message) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.accept = 'video/*,audio/*';
      input.addEventListener('change', () => resolve([...input.files]), { once: true });
      // 用户取消选择不会触发 change，用 cancel 事件（支持的浏览器）兜底
      input.addEventListener('cancel', () => resolve([]), { once: true });
      if (message) this.flashStatus(message);
      input.click();
    });
  }

  // ---------- EDL 导出 ----------

  exportEDL(kind) {
    const edl = buildEDL(this.project);
    if (kind === 'json') {
      downloadText(`${this.projectName}.edl.json`, JSON.stringify(edl, null, 2), 'application/json');
      this.flashStatus('已导出机位切换清单 JSON');
    } else {
      downloadText(`${this.projectName}.edl.csv`, edlToCsv(edl), 'text/csv');
      const bad = edl.cuts.filter((c) => c.status !== 'ok').length;
      this.flashStatus(`已导出机位切换清单 CSV（${edl.cuts.length} 段，其中 ${bad} 段含越界标记）`);
    }
  }

  // ---------- 样例 ----------

  // 样例由 npm run generate:samples 生成、静态服务器本地托管。
  // 直接 fetch 成本地 File 走与用户导入完全相同的读取路径；
  // 取不到（例如 file:// 打开或缺样例）时回退到手动选择。
  async loadSampleFlow() {
    const names = ['camA_synctest_25fps.mp4', 'camB_synctest_30fps.mp4', 'reference_click.wav'];
    try {
      const files = [];
      for (const name of names) {
        const res = await fetch(`public/samples/${name}`);
        if (!res.ok) throw new Error(`缺少样例 ${name}`);
        const blob = await res.blob();
        files.push(new File([blob], name, { type: blob.type }));
      }
      await this.importFiles(files);
      if (this.project.sources.length >= 2) {
        this.projectName = 'sample-two-cam';
        this.flashStatus('样例已载入。点「音频同步全部」观察自动对齐（B 应得 -0.8s，参考音频 +0.5s），再手动微调偏移');
      }
    } catch {
      this.flashStatus('未找到内置样例（先运行 npm run generate:samples）。请手动选择 samples/ 下的 3 个文件');
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.accept = 'video/*,audio/*';
      input.addEventListener('change', async () => this.importFiles([...input.files]));
      input.click();
    }
  }

  // ---------- 渲染 ----------

  refreshAll() {
    this.renderSources();
    this.renderSyncPanel();
    this.renderOffsetPanel();
    this.renderSegments();
    this.renderDiff();
    this.timeline.draw();
    this.timeReadout.textContent = `${formatSeconds(this.player.timelineTime)}s  ${formatTimecode(this.player.timelineTime, 30)}`;
  }

  renderSources() {
    const refId = this.referenceSourceId();
    this.sourcesList.innerHTML = this.project.sources
      .map((s, i) => {
        const color = sourceColor(i);
        const hasAudio = this.media.hasAudio(s.id);
        const loaded = this.media.get(s.id);
        return `
        <tr style="box-shadow: inset 3px 0 0 ${color.border}">
          <td>${s.kind === 'audio' ? '🎧' : '🎥'}</td>
          <td title="${escapeHtml(s.path || s.name)}">${escapeHtml(s.name)}
            ${!loaded ? '<span class="badge badge-warn">素材缺失</span>' : ''}
            ${s.id === refId ? '<span class="badge">参考机位</span>' : ''}
            ${!hasAudio ? '<span class="badge badge-warn">无音轨</span>' : ''}
          </td>
          <td>${s.kind === 'video' ? `${parseFps(s.fps).toFixed(3)} fps` : '—'}</td>
          <td>${formatSeconds(s.duration)}s</td>
          <td>${formatOffset(s.offset)}</td>
          <td class="nowrap">
            <button class="btn small" data-remove-source="${s.id}">移除</button>
          </td>
        </tr>`;
      })
      .join('');
  }

  renderSyncPanel() {
    const refId = this.referenceSourceId();
    const rows = this.project.sources
      .map((s) => {
        const canSync = this.media.hasAudio(s.id);
        return `
        <tr>
          <td>${escapeHtml(s.name)}</td>
          <td>${canSync ? '✅ 有音轨' : '— 无音轨'}</td>
          <td class="nowrap">
            ${s.id === refId ? '<em>参考</em>' : `<button class="btn small" data-action="set-ref" data-source-id="${s.id}" ${canSync ? '' : 'disabled'}>设为参考</button>`}
            <button class="btn small" data-action="sync-one" data-source-id="${s.id}" ${canSync && s.id !== refId ? '' : 'disabled'}>同步此素材</button>
          </td>
        </tr>`;
      })
      .join('');
    this.syncPanel.innerHTML = `
      <div class="row">
        <button class="btn" data-action="sync-all" ${refId ? '' : 'disabled'}>音频同步全部（波形互相关）</button>
        <span class="hint">包络采样率 ${ENVELOPE_RATE}Hz，理论定位精度 ${(1000 / ENVELOPE_RATE).toFixed(0)}ms；结果写入偏移，仍可手动校正</span>
      </div>
      <table class="table"><thead><tr><th>素材</th><th>音频</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  renderOffsetPanel() {
    if (this.project.sources.length === 0) {
      this.offsetPanel.innerHTML = '<p class="hint">导入素材后可在此手动校正偏移。</p>';
      return;
    }
    this.offsetPanel.innerHTML = this.project.sources
      .map((s) => {
        const fps = parseFps(s.fps);
        const frameMs = s.kind === 'video' ? (1000 / fps).toFixed(1) : null;
        return `
        <div class="offset-card">
          <div class="offset-title">${escapeHtml(s.name)}
            <span class="hint">当前偏移 ${formatOffset(s.offset)}${frameMs ? ` · 1 帧 = ${frameMs}ms` : ''}</span>
          </div>
          <div class="row">
            <button class="btn small" data-action="nudge-minus-frame" data-source-id="${s.id}" ${s.kind === 'video' ? '' : 'disabled'}>−1 帧</button>
            <button class="btn small" data-action="nudge-plus-frame" data-source-id="${s.id}" ${s.kind === 'video' ? '' : 'disabled'}>+1 帧</button>
            <button class="btn small" data-action="nudge-minus-ms" data-source-id="${s.id}">−1ms</button>
            <button class="btn small" data-action="nudge-plus-ms" data-source-id="${s.id}">+1ms</button>
            <label class="hint">偏移(秒)
              <input type="number" step="0.001" data-action="offset-input" data-source-id="${s.id}" value="${s.offset.toFixed(3)}" style="width:7em">
            </label>
          </div>
          ${s._lastCandidates ? `<div class="hint">同步候选峰值：${s._lastCandidates
            .map((c) => `${formatOffset(c.offset)} (${(c.confidence * 100).toFixed(0)}%)`)
            .join('；')}</div>` : ''}
        </div>`;
      })
      .join('') + `
      <div class="row">
        <button class="btn" data-action="compare" ${this.compareBaseline ? '' : 'disabled'}>对比修改前后（切换预览）</button>
        <button class="btn" data-action="commit" ${this.compareBaseline ? '' : 'disabled'}>确认本次修改</button>
        <button class="btn" data-action="revert" ${this.compareBaseline ? '' : 'disabled'}>撤销本次偏移修改</button>
      </div>`;
  }

  renderSegments() {
    const segs = buildSegments(this.project);
    const cameraButtons = this.project.sources
      .map((s, i) => `<button class="btn small cam-btn" data-camera="${s.id}" title="数字键 ${i + 1}">${i + 1}. ${escapeHtml(s.name)}</button>`)
      .join('');
    this.segmentsList.innerHTML = segs
      .map((seg, i) => {
        const src = getSource(this.project, seg.sourceId);
        const startCov = src ? coverageAt(this.project, seg.sourceId, seg.start) : { status: 'gap' };
        const endCov = src ? coverageAt(this.project, seg.sourceId, Math.max(seg.start, seg.end - 0.0001)) : { status: 'gap' };
        const out = startCov.status !== 'ok' || endCov.status !== 'ok';
        return `
        <tr data-segment="${i}" class="${i === this.selectedSegment ? 'selected' : ''} ${out ? 'out-of-range' : ''}">
          <td>${i + 1}</td>
          <td>${escapeHtml(src?.name || '(素材缺失)')}</td>
          <td>${formatSeconds(seg.start)} → ${formatSeconds(seg.end)}</td>
          <td>${src ? `${formatSeconds(seg.start - src.offset)} → ${formatSeconds(seg.end - src.offset)}` : '—'}</td>
          <td>${out ? '<span class="badge badge-warn">越界</span>' : '✅'}</td>
          <td class="cam-cell">${cameraButtons}</td>
        </tr>`;
      })
      .join('');
  }

  renderDiff() {
    if (!this.compareBaseline) {
      this.diffPanel.innerHTML = '<p class="hint">调整任意素材偏移后，这里列出受影响的切点（只重算与该机位相关的切点）。</p>';
      return;
    }
    const offChanges = diffOffsets(this.compareBaseline.project, this.project);
    const cutChanges = diffCuts(this.compareBaseline.project, this.project);
    this.diffPanel.innerHTML = `
      <div class="hint">对比基线：${escapeHtml(this.compareBaseline.label)} 修改前</div>
      <table class="table">
        <thead><tr><th>偏移变化</th><th>修改前</th><th>修改后</th></tr></thead>
        <tbody>${offChanges
          .map(
            (c) => `<tr><td>${escapeHtml(c.name)}</td><td>${formatOffset(c.before)}</td><td>${formatOffset(c.after)}</td></tr>`,
          )
          .join('')}</tbody>
      </table>
      <table class="table">
        <thead><tr><th>受影响切点</th><th>修改前时间</th><th>修改后时间</th><th>变化</th></tr></thead>
        <tbody>${cutChanges
          .map(
            (c) => `<tr>
              <td>${c.kind} ${c.cutId.slice(-6)}</td>
              <td>${c.beforeTime === null ? '—' : formatSeconds(c.beforeTime) + 's'}</td>
              <td>${c.afterTime === null ? '—' : formatSeconds(c.afterTime) + 's'}</td>
              <td>${c.delta === undefined ? '—' : `${c.delta >= 0 ? '+' : ''}${c.delta.toFixed(3)}s`}</td>
            </tr>`,
          )
          .join('') || '<tr><td colspan="4" class="hint">无切点受影响</td></tr>'}</tbody>
      </table>`;
  }

  flashStatus(text) {
    this.status.textContent = text;
    clearTimeout(this._statusTimer);
    this._statusTimer = setTimeout(() => (this.status.textContent = '就绪 · 素材仅在本机读取，不发起网络请求'), 6000);
  }
}

function downloadText(filename, text, mime) {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

window.addEventListener('DOMContentLoaded', () => {
  window.app = new App();
});
