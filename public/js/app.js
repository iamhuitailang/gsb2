import { AudioEngine } from './audio/engine.js';
import { PeaksCache } from './audio/peaks.js';
import { ProjectStore, normalizeDocument, CONFIDENCE_LEVELS } from './core/model.js';
import { coverageStats } from './core/layout.js';
import {
  buildExportDocument,
  documentFromCsv,
  documentFromJson,
  downloadBlob,
  safeFileStem,
  toCsvString,
  toJsonString,
} from './core/export.js';
import { MIN_REGION_SECONDS, formatSeconds, formatTimecode, parseTimeInput, roundSeconds } from './core/time.js';
import { Timeline } from './ui/timeline.js';
import { DEMO_FILE_NAME, DEMO_ID, demoAudioBlob, demoProject } from './demo/index.js';
import {
  deleteAudioBlob,
  hashBlob,
  loadAudioBlob as readAudioBlob,
  loadDraft,
  saveAudioBlob,
  saveDraft,
} from './storage.js';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const EMBED_AUDIO_LIMIT = 16 * 1024 * 1024;
const AUTOSAVE_DELAY = 500;
const NUDGE_STEP = 0.01;

class App {
  constructor() {
    this.store = new ProjectStore();
    this.engine = new AudioEngine();
    this.cache = null;
    this.audioBlob = null;
    this.selectionId = null;
    this.lastActive = new Set();
    this.lastUsed = { labelId: this.store.defaultLabelId(), speakerId: null };
    this.loopEnabled = false;
    this.saveTimer = 0;
    this.filters = { labelId: '', speakerId: '' };
    this.renderedRegionId = null;
    this.audioAvailable = false;
    this.filterSignature = '';
    this.dirty = false;
    this.frame = 0;

    this.timeline = new Timeline({
      rulerCanvas: $('#ruler-canvas'),
      waveCanvas: $('#wave-canvas'),
      overlayCanvas: $('#overlay-canvas'),
      overviewCanvas: $('#overview-canvas'),
      lanesScroll: $('#lanes-scroll'),
      lanesInner: $('#lanes-inner'),
      shell: $('#timeline-shell'),
      tooltip: $('#timeline-tooltip'),
      store: this.store,
      engine: this.engine,
      handlers: {
        onCreate: (range) => this.createRegion(range),
        onUpdate: (id, patch, options) => this.updateRegion(id, patch, options),
        onCommit: (id, type, options) => this.commitRegionDrag(id, type, options),
        onDragStart: () => this.startRegionDrag(),
        onSelect: (id, options) => this.selectRegion(id, options),
        onSeek: (time) => this.seek(time),
        onAudition: (start, end) => this.audition(start, end),
        onAuditionEnd: () => this.engine.stopAudition(),
        onActiveChange: (ids) => this.updateActiveRegions(ids),
      },
    });

    this.bindUi();
    this.bindKeyboard();
    this.bindStore();
    this.bindEngine();
    this.startFrameLoop();
    this.boot();
  }

  /* ------------------------------ boot ------------------------------ */

  async boot() {
    this.timeline.recomputeLanes();
    this.timeline.resize();
    this.renderAll();
    const draft = await loadDraft();
    if (draft?.project && Array.isArray(draft.project.regions)) {
      try {
        const doc = normalizeDocument(draft.project);
        const restoredAudio = await this.applyDocument(doc);
        this.setSaveState('saved', '已恢复本地草稿');
        this.toast(
          restoredAudio ? '已恢复上次编辑的工程和音频' : '已恢复上次编辑的标注（音频需要重新加载）',
          restoredAudio ? 'success' : 'warn',
        );
        return;
      } catch (error) {
        console.warn('[boot] 草稿恢复失败', error);
      }
    }
    await this.loadSample();
  }

  /* ------------------------------ store / engine wiring ------------------------------ */

  bindStore() {
    this.store.subscribe((doc, reason) => {
      if (reason === 'view') {
        this.updateViewLabel();
        this.timeline.drawOverview();
        return;
      }
      if (reason === 'region:note') {
        // 备注逐字输入：只更新对应列表项的备注行，不重绘波形也不重建列表
        this.updateRowNote(this.selectionId);
        this.renderStats();
        // 事务结束时也会走到这里，此时才新增撤销记录
        this.updateUndoButtons();
        this.markDirty(reason);
        return;
      }
      if (reason === 'rollback') {
        this.timeline.refresh();
        this.renderAll();
        this.updateUndoButtons();
        return;
      }
      if (reason === 'audio') {
        // 换音频只影响音轨信息与视图，不重建列表/属性面板（避免打断正在进行的编辑）
        this.timeline.refresh();
        this.renderAudioInfo();
        this.renderStats();
        this.markDirty(reason);
        return;
      }
      const transient = reason === 'region:drag' || reason === 'region:resize';
      this.timeline.refresh({ freezeLanes: transient });
      if (transient) {
        this.renderInspectorLive();
        this.renderStats();
      } else {
        this.renderAll();
      }
      this.updateUndoButtons();
      this.markDirty(reason);
      this.syncLoopRange(reason);
    });
    this.engine.on((type) => this.onEngineEvent(type));
  }

  bindEngine() {
    this.engine.setVolume(0.9);
  }

  onEngineEvent(type) {
    if (type === 'play') {
      this.updatePlayButton();
      this.timeline.setPlayheadOverride(null);
    } else if (type === 'pause' || type === 'stop' || type === 'ended') {
      this.updatePlayButton();
      this.timeline.setPlayheadOverride(null);
      this.lastActive = new Set();
      this.updateActiveRegions([]);
      this.timeline.drawOverlay();
    } else if (type === 'seek') {
      this.timeline.setPlayheadOverride(null);
    } else if (type === 'buffer') {
      this.renderAudioInfo();
    }
  }

  startFrameLoop() {
    let lastTimeText = '';
    const tick = () => {
      // 没有音轨时也能显示/拖动播放头（例如仅导入标注后核对时间）
      const position = this.engine.time;
      const text = formatTimecode(position);
      if (text !== lastTimeText) {
        $('#current-time').textContent = text;
        lastTimeText = text;
      }
      this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }

  /* ------------------------------ UI bindings ------------------------------ */

  bindUi() {
    $('#project-name').addEventListener('change', (event) => {
      this.store.setProjectName(event.target.value);
      event.target.value = this.store.doc.name;
    });
    $('#project-name').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') event.target.blur();
    });

    for (const [buttonId, menuId] of [
      ['btn-open', 'menu-open'],
      ['btn-save', 'menu-save'],
      ['btn-import', 'menu-import'],
    ]) {
      const button = $(`#${buttonId}`);
      const menu = $(`#${menuId}`);
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        this.toggleMenu(button, menu);
      });
    }
    document.addEventListener('click', () => this.closeMenus());
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.closeMenus();
    });
    for (const item of $$('.menu [role="menuitem"]')) {
      item.addEventListener('click', () => {
        this.closeMenus();
        this.handleAction(item.dataset.action);
      });
    }
    for (const button of $$('[data-action]')) {
      if (button.closest('.menu')) continue;
      button.addEventListener('click', () => this.handleAction(button.dataset.action));
    }

    $('#btn-play').addEventListener('click', () => this.togglePlay());
    $('#btn-loop').addEventListener('click', () => this.toggleLoop());
    $('#btn-prev-region').addEventListener('click', () => this.jumpRegion(-1));
    $('#btn-next-region').addEventListener('click', () => this.jumpRegion(1));
    $('#btn-skip-start').addEventListener('click', () => this.seek(0));
    $('#btn-add-region').addEventListener('click', () => this.createAtPlayhead());
    $('#btn-zoom-in').addEventListener('click', () => this.zoom(1.5));
    $('#btn-zoom-out').addEventListener('click', () => this.zoom(1 / 1.5));
    $('#btn-fit').addEventListener('click', () => this.timeline.fit());
    $('#btn-undo').addEventListener('click', () => this.store.undo());
    $('#btn-redo').addEventListener('click', () => this.store.redo());
    $('#btn-follow').addEventListener('click', () => {
      this.timeline.follow = !this.timeline.follow;
      $('#btn-follow').classList.toggle('active', this.timeline.follow);
      $('#btn-follow').setAttribute('aria-pressed', String(this.timeline.follow));
    });
    $('#btn-manage').addEventListener('click', () => this.openManageDialog());
    $('#btn-manage-2').addEventListener('click', () => this.openManageDialog());
    $('#btn-shortcuts').addEventListener('click', () => $('#shortcuts-dialog').showModal());
    $('#volume').addEventListener('input', (event) => {
      this.engine.setVolume(Number(event.target.value) / 100);
    });

    $('#filter-label').addEventListener('change', (event) => {
      this.filters.labelId = event.target.value;
      this.renderRegionList();
    });
    $('#filter-speaker').addEventListener('change', (event) => {
      this.filters.speakerId = event.target.value;
      this.renderRegionList();
    });

    $('#region-list').addEventListener('click', (event) => {
      const item = event.target.closest('.region-item');
      if (!item) return;
      const id = item.dataset.id;
      const action = event.target.closest('[data-row-action]')?.dataset.rowAction;
      if (action === 'play') {
        const region = this.store.getRegion(id);
        if (region) {
          this.selectRegion(id, { seek: false });
          this.playRange(region, { loop: this.loopEnabled });
        }
      } else if (action === 'loop') {
        const region = this.store.getRegion(id);
        if (region) {
          this.selectRegion(id, { seek: false });
          this.loopEnabled = true;
          this.updateLoopButton();
          this.playRange(region, { loop: true });
        }
      } else if (action === 'delete') {
        this.deleteRegion(id);
      } else {
        // 需求：列表选中区间时跳到对应声音
        this.selectRegion(id, { seek: true });
      }
    });

    $('#audio-file-input').addEventListener('change', (event) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (file) this.loadAudioFile(file);
    });
    $('#project-file-input').addEventListener('change', (event) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (file) this.openProjectFile(file);
    });
    $('#json-file-input').addEventListener('change', (event) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (file) this.importAnnotationsFile(file);
    });
    $('#csv-file-input').addEventListener('change', (event) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (file) this.importCsvFile(file);
    });

    $('#add-label').addEventListener('click', () => {
      const label = this.store.addLabel({ name: `类型 ${this.store.doc.labels.length + 1}` });
      this.renderManageDialog();
      requestAnimationFrame(() => {
        const row = document.querySelector(`[data-entity-id="${label.id}"] input[type="text"]`);
        row?.focus();
        row?.select();
      });
    });
    $('#add-speaker').addEventListener('click', () => {
      const speaker = this.store.addSpeaker({ name: `说话人 ${this.store.doc.speakers.length + 1}` });
      this.renderManageDialog();
      requestAnimationFrame(() => {
        const row = document.querySelector(`[data-entity-id="${speaker.id}"] input[type="text"]`);
        row?.focus();
        row?.select();
      });
    });

    this.bindDialogs();
    this.bindDragAndDrop();
    window.addEventListener('beforeunload', (event) => {
      if (this.dirty) {
        event.preventDefault();
        event.returnValue = '';
      }
    });
    window.addEventListener('resize', () => {
      this.renderOverviewOnly();
    });
  }

  bindDialogs() {
    const manage = $('#manage-dialog');
    manage.addEventListener('click', (event) => {
      const action = event.target.closest('[data-entity-action]')?.dataset.entityAction;
      if (!action) return;
      const row = event.target.closest('.entity-row');
      const id = row?.dataset.entityId;
      const kind = row?.dataset.entityKind;
      if (!id || !kind) return;
      if (action === 'delete') {
        if (kind === 'label') {
          if (!this.store.removeLabel(id)) this.toast('至少保留一个标注类型', 'warn');
        } else {
          this.store.removeSpeaker(id);
        }
        this.renderManageDialog();
      }
    });

    manage.addEventListener('change', (event) => {
      const row = event.target.closest('.entity-row');
      if (!row) return;
      const id = row.dataset.entityId;
      const kind = row.dataset.entityKind;
      if (event.target.matches('input[type="text"]')) {
        const value = event.target.value.trim();
        if (!value) {
          this.toast('名称不能为空', 'warn');
          this.renderManageDialog();
          return;
        }
        if (kind === 'label') this.store.updateLabel(id, { name: value });
        else this.store.updateSpeaker(id, { name: value });
        this.renderManageDialog();
        this.renderRegionList();
        this.renderInspector();
      } else if (event.target.matches('input[type="color"]')) {
        if (kind === 'label') this.store.updateLabel(id, { color: event.target.value });
        else this.store.updateSpeaker(id, { color: event.target.value });
        this.renderManageDialog();
      }
    });

    manage.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && event.target.matches('input[type="text"]')) {
        event.preventDefault();
        event.target.blur();
      }
    });
  }

  bindDragAndDrop() {
    const shell = $('#timeline-shell');
    const overlay = $('#drop-overlay');
    const show = () => {
      overlay.hidden = false;
    };
    const hide = () => {
      overlay.hidden = true;
    };
    window.addEventListener('dragenter', (event) => {
      if (![...(event.dataTransfer?.types ?? [])].includes('Files')) return;
      show();
    });
    window.addEventListener('dragleave', (event) => {
      // 只有真正离开窗口（relatedTarget 为空）才收起遮罩，避免子元素间移动导致闪烁
      if (event.relatedTarget) return;
      hide();
    });
    window.addEventListener('dragover', (event) => {
      event.preventDefault();
    });
    window.addEventListener('drop', async (event) => {
      event.preventDefault();
      hide();
      const files = [...(event.dataTransfer?.files ?? [])];
      if (!files.length) return;
      const audioFile = files.find((file) => file.type.startsWith('audio/') || /\.(wav|mp3|m4a|aac|ogg|flac|webm)$/i.test(file.name));
      const jsonFile = files.find((file) => /\.json$/i.test(file.name));
      const csvFile = files.find((file) => /\.csv$/i.test(file.name));
      try {
        if (audioFile) await this.loadAudioFile(audioFile);
        if (jsonFile) await this.openProjectFile(jsonFile);
        if (csvFile) await this.importCsvFile(csvFile);
      } catch (error) {
        this.reportError(error);
      }
    });
    shell.addEventListener('dragover', (event) => event.preventDefault());
  }

  bindKeyboard() {
    window.addEventListener('keydown', (event) => {
      const target = event.target;
      const editing =
        target instanceof HTMLElement &&
        (target.matches('input, textarea, select') || target.isContentEditable);
      const meta = event.metaKey || event.ctrlKey;
      const dialogOpen = Boolean(document.querySelector('dialog[open]'));

      // 对话框内的按键交给对话框本身（Esc 关闭、输入框保留原生文本操作）
      if (dialogOpen) return;

      if (meta && event.key.toLowerCase() === 's') {
        event.preventDefault();
        this.saveProject();
        return;
      }
      if (meta && event.key.toLowerCase() === 'z') {
        // 输入框内保留浏览器原生的文本撤销
        if (editing) return;
        event.preventDefault();
        if (event.shiftKey) this.store.redo();
        else this.store.undo();
        return;
      }
      if (event.key === 'Escape') {
        if (this.selectionId) {
          this.selectRegion(null, { seek: false });
        } else if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) {
          document.activeElement.blur();
        }
        return;
      }
      if (editing || meta) return;
      // 焦点在按钮/链接/列表项上时，空格应触发该控件本身，而不是开始播放
      if (event.key === ' ' && target instanceof HTMLElement && target.closest('button, a, [role="menuitem"], [role="option"]')) {
        return;
      }

      // 播放头步长：默认 0.1 秒，Shift 1 秒，Alt 10 毫秒
      const playStep = event.shiftKey ? 1 : event.altKey ? 0.01 : NUDGE_STEP * 10;
      // 边界微调步长：默认 10 毫秒，Alt 100 毫秒
      const step = event.altKey ? NUDGE_STEP * 10 : NUDGE_STEP;
      const region = this.selectionId ? this.store.getRegion(this.selectionId) : null;

      switch (event.key) {
        case ' ':
          event.preventDefault();
          this.togglePlay();
          break;
        case 'ArrowLeft':
          event.preventDefault();
          this.seek(this.playhead - playStep);
          break;
        case 'ArrowRight':
          event.preventDefault();
          this.seek(this.playhead + playStep);
          break;
        case 'ArrowUp':
          event.preventDefault();
          this.jumpRegion(-1);
          break;
        case 'ArrowDown':
          event.preventDefault();
          this.jumpRegion(1);
          break;
        case 'Home':
          event.preventDefault();
          this.seek(0);
          break;
        case 'End':
          event.preventDefault();
          this.seek(this.store.duration);
          break;
        case '[':
          if (!region) return;
          event.preventDefault();
          this.nudgeRegion(region.id, 'start', -step);
          break;
        case ']':
          if (!region) return;
          event.preventDefault();
          this.nudgeRegion(region.id, 'start', step);
          break;
        case '{':
          if (!region) return;
          event.preventDefault();
          this.nudgeRegion(region.id, 'end', -step);
          break;
        case '}':
          if (!region) return;
          event.preventDefault();
          this.nudgeRegion(region.id, 'end', step);
          break;
        case ',':
          if (!region) return;
          event.preventDefault();
          this.nudgeRegion(region.id, 'both', -step);
          break;
        case '.':
          if (!region) return;
          event.preventDefault();
          this.nudgeRegion(region.id, 'both', step);
          break;
        case 'n':
        case 'N':
          event.preventDefault();
          this.createAtPlayhead();
          break;
        case 's':
        case 'S':
          if (!region) return;
          event.preventDefault();
          this.splitSelectedAtPlayhead();
          break;
        case 'l':
        case 'L':
          event.preventDefault();
          this.toggleLoop();
          break;
        case 'Delete':
        case 'Backspace':
          if (!region) return;
          event.preventDefault();
          this.deleteRegion(region.id);
          break;
        case '+':
        case '=':
          event.preventDefault();
          this.zoom(1.5);
          break;
        case '-':
        case '_':
          event.preventDefault();
          this.zoom(1 / 1.5);
          break;
        case '0':
          event.preventDefault();
          this.timeline.fit();
          break;
        case '?':
          event.preventDefault();
          $('#shortcuts-dialog').showModal();
          break;
        default:
          break;
      }
    });
  }

  /* ------------------------------ menus / actions ------------------------------ */

  toggleMenu(button, menu) {
    const willOpen = menu.hidden;
    this.closeMenus();
    if (!willOpen) return;
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
  }

  closeMenus() {
    for (const menu of $$('.menu')) menu.hidden = true;
    for (const button of $$('[aria-haspopup="menu"]')) button.setAttribute('aria-expanded', 'false');
  }

  handleAction(action) {
    switch (action) {
      case 'open-project':
        $('#project-file-input').click();
        break;
      case 'replace-audio':
      case 'pick-audio':
        $('#audio-file-input').click();
        break;
      case 'load-sample':
        this.loadSample();
        break;
      case 'save-project':
        this.saveProject();
        break;
      case 'export-json':
        this.exportJson();
        break;
      case 'export-csv':
        this.exportCsv();
        break;
      case 'import-json':
        $('#json-file-input').click();
        break;
      case 'import-csv':
        $('#csv-file-input').click();
        break;
      default:
        break;
    }
  }

  /* ------------------------------ audio loading ------------------------------ */

  async ensureAudioUnlocked() {
    try {
      await this.engine.ensureContext();
    } catch (error) {
      console.warn('[audio] context', error);
    }
  }

  async loadAudioBlob(blob, { meta = {}, persist = true, attach = true, autoFit = true } = {}) {
    await this.ensureAudioUnlocked();
    const buffer = await this.engine.decode(await blob.arrayBuffer());
    const cache = await PeaksCache.build(buffer);
    this.cache = cache;
    this.audioAvailable = true;
    this.timeline.setCache(cache);

    let key = meta.audioKey ?? null;
    if (persist) {
      try {
        if (!key) key = await hashBlob(blob);
        if (key) await saveAudioBlob(key, blob);
      } catch (error) {
        // 存储失败（配额不足/隐私模式）不应影响本次编辑，只是刷新后需要重新选音频
        console.warn('[storage] 音频未能写入 IndexedDB', error);
        key = null;
      }
    }
    this.audioBlob = blob;

    const audioMeta = {
      fileName: meta.fileName || blob.name || 'audio',
      duration: roundSeconds(buffer.duration),
      sampleRate: buffer.sampleRate,
      channels: buffer.numberOfChannels,
      source: meta.source || 'local',
      sampleId: meta.sampleId,
      samplePath: meta.samplePath,
      audioKey: key ?? undefined,
      sizeBytes: blob.size,
      lastModified: blob.lastModified || Date.now(),
    };
    if (attach) {
      this.store.setAudio(audioMeta);
    } else {
      this.store.doc.audio = audioMeta;
      this.store.doc.updatedAt = Date.now();
    }
    if (autoFit) this.timeline.applyDurationView({ fit: true });
    else this.timeline.refresh();
    this.renderAll();
    return audioMeta;
  }

  async loadAudioFile(file) {
    if (!file) return;
    if (!file.type.startsWith('audio/') && !/\.(wav|mp3|m4a|aac|ogg|flac|webm)$/i.test(file.name)) {
      this.toast('请选择音频文件', 'warn');
      return;
    }
    try {
      const previousKey = this.store.doc.audio?.audioKey;
      const previousSource = this.store.doc.audio?.source;
      await this.loadAudioBlob(file, { meta: { fileName: file.name, source: 'local' } });
      if (previousKey && previousSource === 'local' && previousKey !== this.store.doc.audio?.audioKey) {
        deleteAudioBlob(previousKey);
      }
      this.audioBlob = file;
      $('#empty-state').hidden = true;
      this.toast(`已载入音频：${file.name}`, 'success');
    } catch (error) {
      this.reportError(error, '音频加载失败');
    }
  }

  async loadSample() {
    try {
      this.setSaveState('idle', '载入示例…');
      const projectDoc = normalizeDocument(demoProject({ now: Date.now() }));
      const blob = demoAudioBlob();
      await this.loadAudioBlob(blob, {
        meta: {
          fileName: projectDoc.audio?.fileName || DEMO_FILE_NAME,
          source: 'sample',
          sampleId: DEMO_ID,
        },
        // 示例每次都能重新合成，不写入 IndexedDB，避免白占空间
        persist: false,
        attach: false,
        autoFit: false,
      });
      projectDoc.audio = { ...this.store.doc.audio, source: 'sample', sampleId: DEMO_ID };
      this.selectionId = null;
      this.timeline.setSelection(null);
      this.store.replaceDocument(projectDoc);
      this.timeline.view = { ...projectDoc.view };
      this.timeline.applyDurationView();
      this.loopEnabled = false;
      this.updateLoopButton();
      this.renderAll();
      $('#empty-state').hidden = true;
      this.setSaveState('saved', '示例已载入');
      this.toast('已载入内置示例：含重叠、空白与听不清片段', 'success');
    } catch (error) {
      this.reportError(error, '示例载入失败');
    }
  }

  /* ------------------------------ region operations ------------------------------ */

  defaultRegionSeed() {
    const labelId = this.store.getLabel(this.lastUsed.labelId) ? this.lastUsed.labelId : this.store.defaultLabelId();
    const speakerId = this.store.getSpeaker(this.lastUsed.speakerId) ? this.lastUsed.speakerId : null;
    return { labelId, speakerId };
  }

  createRegion({ start, end }) {
    const seed = this.defaultRegionSeed();
    const region = this.store.addRegion({ start, end, ...seed });
    this.selectRegion(region.id, { seek: false });
    this.lastUsed = { labelId: region.labelId, speakerId: region.speakerId };
  }

  createAtPlayhead() {
    const duration = this.store.duration;
    if (!duration) {
      this.toast('请先加载音频', 'warn');
      return;
    }
    const start = Math.min(this.playhead, Math.max(0, duration - MIN_REGION_SECONDS));
    const end = Math.min(duration, Math.max(start + 1, start + MIN_REGION_SECONDS));
    const seed = this.defaultRegionSeed();
    const region = this.store.addRegion({ start, end, ...seed });
    this.selectRegion(region.id, { seek: false });
    this.toast(`已在 ${formatSeconds(region.start)} 秒处新建区间`, 'info');
  }

  updateRegion(id, patch, options = {}) {
    const region = this.store.updateRegion(id, patch, options);
    if (region && (patch.labelId || patch.speakerId)) {
      this.lastUsed = { labelId: region.labelId, speakerId: region.speakerId };
    }
    return region;
  }

  startRegionDrag() {
    if (this.engine.isPlaying) this.engine.pause();
    // 先收尾可能仍打开的备注输入事务，避免和拖动合并成一条撤销记录
    this.store.endTransaction();
    this.store.beginTransaction('region:drag');
  }

  commitRegionDrag(id, type, { moved = true } = {}) {
    this.store.endTransaction();
    // 事务结束后重新分配泳道（拖动期间是冻结的）
    this.timeline.refresh();
    const region = this.store.getRegion(id);
    if (moved && region) {
      const action = type === 'move' ? '已移动' : '已调整';
      $('#status-hint').textContent = `${action}区间：${formatSeconds(region.start)} – ${formatSeconds(region.end)} 秒`;
    }
    this.renderInspector();
    this.renderRegionList();
  }

  nudgeRegion(id, edge, delta) {
    const region = this.store.nudgeRegion(id, edge, delta);
    this.renderInspector();
    this.renderRegionList();
    return region;
  }

  deleteRegion(id) {
    const region = this.store.getRegion(id);
    if (!region) return;
    const wasSelected = this.selectionId === id;
    const index = this.store.sortedRegions().findIndex((item) => item.id === id);
    this.store.removeRegions([id]);
    if (wasSelected) {
      const neighbours = this.store.sortedRegions();
      const next = neighbours[Math.min(Math.max(0, index), neighbours.length - 1)];
      this.selectRegion(next?.id ?? null, { seek: false });
    }
    this.toast('已删除区间（⌘Z 可撤销）', 'info');
  }

  splitSelectedAtPlayhead() {
    if (!this.selectionId) return;
    const time = this.playhead;
    const rightId = this.store.splitRegionAt(this.selectionId, roundSeconds(time));
    if (!rightId) {
      this.toast('播放头需要位于区间内部才能分割', 'warn');
      return;
    }
    this.selectRegion(this.selectionId, { seek: false });
    this.toast('已在播放头分割区间', 'success');
  }

  selectRegion(id, { seek = false } = {}) {
    // 切换选中前先收尾进行中的备注编辑事务，避免撤销记录悬空
    this.store.endTransaction();
    this.selectionId = id;
    this.timeline.setSelection(id);
    this.updateSelectedRow();
    const region = id ? this.store.getRegion(id) : null;
    if (region) {
      this.timeline.scrollToTime(region.start, { selectRange: { start: region.start, end: region.end } });
      if (seek) this.seek(region.start);
      if (this.loopEnabled) this.syncLoopRange('selection', { restart: this.engine.isPlaying });
    } else if (this.loopEnabled) {
      this.syncLoopRange('selection');
    }
    this.renderInspector();
  }

  /** 只更新单个列表项的备注文字，避免逐字输入时整表重建。 */
  updateRowNote(id) {
    if (!id) return;
    const region = this.store.getRegion(id);
    const item = document.querySelector(`.region-item[data-id="${cssEscape(id)}"]`);
    if (!region || !item) return;
    const main = item.querySelector('.region-main');
    if (!main) return;
    let note = main.querySelector('.region-note');
    const text = region.note ?? '';
    if (!text) {
      note?.remove();
      return;
    }
    if (!note) {
      note = document.createElement('div');
      note.className = 'region-note';
      main.append(note);
    }
    note.textContent = text;
    note.title = text;
  }

  /** 只更新列表项的选中态，避免重建导致滚动位置跳动。 */
  updateSelectedRow() {
    for (const item of $$('.region-item')) {
      const selected = item.dataset.id === this.selectionId;
      item.classList.toggle('selected', selected);
      item.setAttribute('aria-selected', String(selected));
      if (selected) item.scrollIntoView({ block: 'nearest' });
    }
  }

  updateActiveRegions(ids) {
    const next = new Set(ids);
    const changed = next.size !== this.lastActive.size || [...next].some((id) => !this.lastActive.has(id));
    this.lastActive = next;
    // 列表可能刚被重建，这里每次都重新套用高亮类
    for (const item of $$('.region-item')) {
      const active = next.has(item.dataset.id);
      item.classList.toggle('active', active);
    }
    if (!changed) return;
    if (next.size && this.engine.isPlaying) {
      const firstActive = $$('.region-item').find((item) => next.has(item.dataset.id));
      firstActive?.scrollIntoView({ block: 'nearest' });
    }
    $('#status-hint').textContent = next.size
      ? `正在播放：${[...next]
          .map((id) => {
            const region = this.store.getRegion(id);
            return region ? `${this.store.regionLabel(region)?.name ?? '区间'} ${formatSeconds(region.start)}–${formatSeconds(region.end)}` : '';
          })
          .filter(Boolean)
          .join(' / ')}`
      : '空格播放 · ←/→ 微调播放头 · 拖动边界时自动循环试听';
  }

  /* ------------------------------ playback ------------------------------ */

  async togglePlay() {
    if (!this.engine.buffer) {
      this.toast(this.store.doc.regions.length ? '当前只有标注，没有音频可播放' : '请先加载音频', 'warn');
      return;
    }
    if (this.engine.isPlaying) {
      this.engine.pause();
      return;
    }
    await this.ensureAudioUnlocked();
    if (this.engine.isPlaying) return;
    const loopRange = this.loopEnabled ? this.currentLoopRange() : null;
    await this.engine.play({ from: this.playhead, loopRange });
  }

  playRange(region, { loop = false } = {}) {
    if (!this.engine.buffer) {
      this.toast('当前没有可播放的音频', 'warn');
      return;
    }
    this.ensureAudioUnlocked().then(() => {
      this.engine.play({
        from: region.start,
        loopRange: loop ? { start: region.start, end: region.end } : null,
      });
    });
  }

  currentLoopRange() {
    const region = this.selectionId ? this.store.getRegion(this.selectionId) : null;
    if (!region) return null;
    return { start: region.start, end: region.end };
  }

  toggleLoop() {
    if (this.loopEnabled) {
      this.loopEnabled = false;
      this.updateLoopButton();
      if (this.engine.isPlaying) this.engine.play({ from: this.engine.time, loopRange: null });
      this.toast('已关闭循环', 'info');
      return;
    }
    const range = this.currentLoopRange();
    if (!range) {
      this.loopEnabled = false;
      this.updateLoopButton();
      this.toast('选中一个区间后可循环播放', 'warn');
      return;
    }
    this.loopEnabled = true;
    this.updateLoopButton();
    if (this.engine.isPlaying) {
      const position = this.engine.currentTime;
      const from = position >= range.start && position < range.end ? position : range.start;
      this.engine.play({ from, loopRange: range });
    }
    this.toast(`循环试听 ${formatSeconds(range.start)} – ${formatSeconds(range.end)} 秒`, 'info');
  }

  syncLoopRange(reason, { restart = false } = {}) {
    if (!this.loopEnabled) return;
    // 拖动过程中由边界试听接管声音，不要每帧重建循环音源
    if (reason === 'region:drag' || reason === 'region:resize') return;
    const range = this.currentLoopRange();
    if (!range) {
      this.loopEnabled = false;
      this.updateLoopButton();
      return;
    }
    if (this.engine.isPlaying && (restart || reason === 'region:update' || reason === 'selection')) {
      const position = this.engine.currentTime;
      const from = position >= range.start && position < range.end ? position : range.start;
      this.engine.play({ from, loopRange: range });
    }
  }

  updateLoopButton() {
    const button = $('#btn-loop');
    button.setAttribute('aria-pressed', String(this.loopEnabled));
    button.title = this.loopEnabled ? '关闭循环 (L)' : '循环选中区间 (L)';
  }

  seek(time) {
    // 没有音频时（仅导入标注）仍允许沿时间轴移动播放头
    const max = Math.max(this.store.duration, this.timeline.duration);
    const clamped = Math.max(0, Math.min(Number(time) || 0, max));
    if (this.engine.buffer) {
      this.engine.seek(clamped);
    } else {
      this.engine.position = clamped;
    }
    this.timeline.setPlayheadOverride(null);
    if (!this.timeline.follow) this.timeline.scrollToTime(clamped);
    $('#current-time').textContent = formatTimecode(clamped);
    this.timeline.drawOverlay();
  }

  /** 播放头位置（秒）：播放中取实时位置，否则取上次定位。 */
  get playhead() {
    return this.engine.time;
  }

  jumpRegion(direction) {
    const regions = this.store.sortedRegions();
    if (!regions.length) return;
    const position = this.playhead;
    if (direction > 0) {
      const next = regions.find((region) => region.start > position + 1e-4) ?? regions[0];
      this.selectRegion(next.id, { seek: true });
    } else {
      const previous = [...regions].reverse().find((region) => region.start < position - 1e-4) ?? regions[regions.length - 1];
      this.selectRegion(previous.id, { seek: true });
    }
  }

  zoom(factor) {
    this.timeline.zoomBy(factor);
    $('#zoom-label').textContent = `${Math.round(this.timeline.view.pxPerSecond)} px/s`;
  }

  audition(start, end) {
    if (this.engine.isPlaying) this.engine.pause();
    this.engine.auditionLoop(start, end);
  }

  updatePlayButton() {
    const playing = this.engine.isPlaying;
    $('#btn-play').classList.toggle('playing', playing);
    $('#btn-play').setAttribute('aria-label', playing ? '暂停' : '播放');
    $('#btn-play').setAttribute('aria-pressed', String(playing));
  }

  /* ------------------------------ rendering ------------------------------ */

  renderAll() {
    if (this.selectionId && !this.store.getRegion(this.selectionId)) {
      // 撤销/导入后选中项可能已不存在
      this.selectionId = null;
      this.timeline.setSelection(null);
    }
    this.renderFilters();
    this.renderRegionList();
    this.renderInspector();
    this.renderStats();
    this.renderAudioInfo();
    this.renderProjectName();
    this.updateUndoButtons();
    this.updateViewLabel();
    const hasContent = Boolean(this.store.doc.audio) || this.store.doc.regions.length > 0;
    $('#empty-state').hidden = hasContent;
    this.renderOverviewOnly();
  }

  renderOverviewOnly() {
    this.timeline.drawOverview();
  }

  renderProjectName() {
    const input = $('#project-name');
    if (document.activeElement !== input) input.value = this.store.doc.name;
    document.title = `${this.store.doc.name} · 时间标注台`;
  }

  renderFilters() {
    const labelSelect = $('#filter-label');
    const speakerSelect = $('#filter-speaker');
    const labelValue = this.filters.labelId;
    const speakerValue = this.filters.speakerId;
    const signature = JSON.stringify([
      this.store.doc.labels.map((label) => [label.id, label.name]),
      this.store.doc.speakers.map((speaker) => [speaker.id, speaker.name]),
    ]);
    if (signature !== this.filterSignature) {
      // 只有类型/说话人列表本身变化时才重建下拉框，避免打断用户选择
      this.filterSignature = signature;
      labelSelect.innerHTML = '<option value="">全部类型</option>';
      for (const label of this.store.doc.labels) {
        const option = document.createElement('option');
        option.value = label.id;
        option.textContent = label.name;
        labelSelect.append(option);
      }
      speakerSelect.innerHTML = '<option value="">全部说话人</option>';
      speakerSelect.append(Object.assign(document.createElement('option'), { value: '__none__', textContent: '未指定' }));
      for (const speaker of this.store.doc.speakers) {
        const option = document.createElement('option');
        option.value = speaker.id;
        option.textContent = speaker.name;
        speakerSelect.append(option);
      }
    }
    labelSelect.value = this.store.getLabel(labelValue) ? labelValue : '';
    speakerSelect.value = speakerValue === '__none__' || this.store.getSpeaker(speakerValue) ? speakerValue : '';
    this.filters.labelId = labelSelect.value;
    this.filters.speakerId = speakerSelect.value;
  }

  visibleRegions() {
    return this.store.sortedRegions().filter((region) => {
      if (this.filters.labelId && region.labelId !== this.filters.labelId) return false;
      if (this.filters.speakerId === '__none__' && region.speakerId) return false;
      if (this.filters.speakerId && this.filters.speakerId !== '__none__' && region.speakerId !== this.filters.speakerId) return false;
      return true;
    });
  }

  renderRegionList() {
    const list = $('#region-list');
    const regions = this.visibleRegions();
    $('#region-count').textContent = String(regions.length);
    $('#list-empty').hidden = regions.length > 0;
    if (!regions.length) {
      list.innerHTML = '';
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const region of regions) {
      fragment.append(this.buildRegionItem(region));
    }
    list.replaceChildren(fragment);
    this.updateActiveRegions([...this.lastActive]);
  }

  buildRegionItem(region) {
    const label = this.store.regionLabel(region);
    const speaker = this.store.regionSpeaker(region);
    const confidence = CONFIDENCE_LEVELS.find((level) => level.value === region.confidence);
    const item = document.createElement('div');
    item.className = 'region-item';
    item.dataset.id = region.id;
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(this.selectionId === region.id));
    item.tabIndex = 0;
    if (this.selectionId === region.id) item.classList.add('selected');
    if (this.lastActive.has(region.id)) item.classList.add('active');

    const swatch = document.createElement('div');
    swatch.className = 'region-swatch';
    swatch.style.background = label?.color ?? '#94a3b8';

    const main = document.createElement('div');
    main.className = 'region-main';

    const line = document.createElement('div');
    line.className = 'region-line1';
    const time = document.createElement('span');
    time.className = 'region-time';
    time.textContent = `${formatTimecode(region.start)} – ${formatTimecode(region.end)}`;
    time.title = `${formatSeconds(region.start)} – ${formatSeconds(region.end)} 秒`;
    line.append(time);

    const tags = document.createElement('div');
    tags.className = 'region-labels';
    const labelTag = document.createElement('span');
    labelTag.className = 'tag';
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = label?.color ?? '#94a3b8';
    labelTag.append(dot, document.createTextNode(label?.name ?? '未分类'));
    tags.append(labelTag);
    if (speaker) {
      const speakerTag = document.createElement('span');
      speakerTag.className = 'tag';
      const speakerDot = document.createElement('span');
      speakerDot.className = 'dot';
      speakerDot.style.background = speaker.color;
      speakerTag.append(speakerDot, document.createTextNode(speaker.name));
      tags.append(speakerTag);
    }
    if (region.confidence !== 'certain' && confidence) {
      const badge = document.createElement('span');
      badge.className = 'confidence-badge';
      badge.dataset.level = region.confidence;
      badge.textContent = confidence.label;
      tags.append(badge);
    }
    line.append(tags);
    main.append(line);

    if (region.note) {
      const note = document.createElement('div');
      note.className = 'region-note';
      note.textContent = region.note;
      note.title = region.note;
      main.append(note);
    }

    const actions = document.createElement('div');
    actions.className = 'region-actions';
    for (const [action, symbol, title] of [
      ['play', '▶', '播放这个区间'],
      ['loop', '↻', '循环试听'],
      ['delete', '✕', '删除（⌘Z 撤销）'],
    ]) {
      const button = document.createElement('button');
      button.className = 'mini-btn';
      button.dataset.rowAction = action;
      button.title = title;
      button.setAttribute('aria-label', title);
      button.textContent = symbol;
      actions.append(button);
    }

    item.append(swatch, main, actions);
    item.addEventListener('keydown', (event) => {
      // 行内小按钮有自己的点击行为，不要被整行的快捷键拦截
      if (event.target !== item) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        event.stopPropagation();
        this.selectRegion(region.id, { seek: true });
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        // 阻止全局快捷键再删一次「当前选中」的另一个区间
        event.stopPropagation();
        this.deleteRegion(region.id);
      }
    });
    return item;
  }

  renderInspector() {
    const inspector = $('#inspector');
    const region = this.selectionId ? this.store.getRegion(this.selectionId) : null;
    if (!region) {
      this.renderedRegionId = null;
      inspector.innerHTML = `
        <div class="inspector-empty">
          <strong>选中一个区间查看详情</strong>
          <ul>
            <li>拖动空白处新建区间，拖动区间可移动</li>
            <li>拖动左右边缘调整起止点，会循环试听附近</li>
            <li>双击空白处快速建 1 秒区间</li>
          </ul>
        </div>`;
      return;
    }
    if (this.isInspectorEditing(inspector) && this.renderedRegionId === region.id) {
      // 正在输入时不重建，避免打断录入；切换到别的区间时仍要刷新
      return;
    }
    this.renderedRegionId = region.id;

    const duration = this.store.duration;
    const label = this.store.regionLabel(region);
    const speaker = this.store.regionSpeaker(region);
    const created = region.createdAt ? new Date(region.createdAt) : null;
    inspector.innerHTML = `
      <div class="inspect-head">
        <h2>区间属性</h2>
        <div class="inspect-head-actions">
          <button class="icon-btn small" data-inspect="duplicate" title="复制区间">⧉</button>
          <button class="icon-btn small" data-inspect="delete" title="删除区间">🗑</button>
        </div>
      </div>
      <div class="field-row">
        <div>
          <div class="field">
            <label for="insp-start">开始</label>
            <div class="time-field">
              <button class="nudge" data-nudge="start" data-delta="-0.01" title="提前 10ms">−</button>
              <input id="insp-start" data-field="start" type="text" inputmode="decimal" value="${formatSeconds(region.start)}" />
              <button class="nudge" data-nudge="start" data-delta="0.01" title="推后 10ms">+</button>
            </div>
          </div>
        </div>
        <div>
          <div class="field">
            <label for="insp-end">结束</label>
            <div class="time-field">
              <button class="nudge" data-nudge="end" data-delta="-0.01" title="提前 10ms">−</button>
              <input id="insp-end" data-field="end" type="text" inputmode="decimal" value="${formatSeconds(region.end)}" />
              <button class="nudge" data-nudge="end" data-delta="0.01" title="推后 10ms">+</button>
            </div>
          </div>
        </div>
      </div>
      <div class="duration-hint">${formatTimecode(region.start)} → ${formatTimecode(region.end)} · 时长 ${formatSeconds(region.end - region.start)} 秒</div>
      <div class="field">
        <label for="insp-label">类型</label>
        <select id="insp-label" data-field="labelId">
          ${this.store.doc.labels
            .map((item) => `<option value="${item.id}" ${item.id === region.labelId ? 'selected' : ''}>${escapeHtml(item.name)}</option>`)
            .join('')}
        </select>
      </div>
      <div class="field">
        <label for="insp-speaker">说话人</label>
        <select id="insp-speaker" data-field="speakerId">
          <option value="" ${!region.speakerId ? 'selected' : ''}>未指定</option>
          ${this.store.doc.speakers
            .map((item) => `<option value="${item.id}" ${item.id === region.speakerId ? 'selected' : ''}>${escapeHtml(item.name)}</option>`)
            .join('')}
        </select>
      </div>
      <div class="field" style="align-items:start">
        <label>置信状态</label>
        <div class="confidence-picker" role="group" aria-label="置信状态">
          ${CONFIDENCE_LEVELS.map(
            (level) =>
              `<button data-confidence="${level.value}" data-level="${level.value}" aria-pressed="${region.confidence === level.value}">${level.label}</button>`,
          ).join('')}
        </div>
      </div>
      <div class="field" style="align-items:start">
        <label for="insp-note">备注</label>
        <textarea id="insp-note" data-field="note" class="note-input" maxlength="4000" placeholder="记录听不清的词句、待确认内容…">${escapeHtml(region.note ?? '')}</textarea>
      </div>
      <div class="inspect-footer">
        <span>${label?.name ?? '未分类'}${speaker ? ` · ${escapeHtml(speaker.name)}` : ''}</span>
        <span>${created ? `创建于 ${created.toLocaleString('zh-CN', { hour12: false })}` : ''}</span>
      </div>
      <div class="inspect-footer" style="margin-top:6px;padding-top:6px">
        <span>${duration ? `时间范围 0 – ${formatSeconds(duration)} 秒` : '音频时长未知'}</span>
        <span>${region.end > duration && duration ? '⚠ 超出音频结尾' : ''}</span>
      </div>
    `;

    inspector.querySelector('[data-inspect="delete"]').addEventListener('click', () => this.deleteRegion(region.id));
    inspector.querySelector('[data-inspect="duplicate"]').addEventListener('click', () => {
      const copy = this.store.duplicateRegion(region.id);
      if (copy) {
        this.selectRegion(copy.id, { seek: false });
        this.toast('已复制区间', 'success');
      }
    });

    for (const input of inspector.querySelectorAll('[data-field="start"], [data-field="end"]')) {
      const field = input.dataset.field;
      const currentValue = () =>
        formatSeconds(this.store.getRegion(region.id)?.[field] ?? 0);
      const commit = () => {
        const parsed = parseTimeInput(input.value);
        if (parsed === null) {
          this.toast('时间格式无法识别，请使用秒或 mm:ss.mmm', 'warn');
          input.value = currentValue();
          return;
        }
        this.store.updateRegion(region.id, { [field]: parsed });
        this.renderedRegionId = null;
        this.renderInspector();
      };
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
          input.blur();
        } else if (event.key === 'Escape') {
          input.value = currentValue();
          input.blur();
        }
      });
      input.addEventListener('blur', commit);
    }

    for (const button of inspector.querySelectorAll('[data-nudge]')) {
      button.addEventListener('click', () => {
        const delta = Number(button.dataset.delta);
        this.store.nudgeRegion(region.id, button.dataset.nudge, delta);
        this.renderedRegionId = null;
        this.renderInspector();
      });
    }

    // 面板内所有按钮都不要抢焦点：否则输入框 blur 会先触发重建，点击随之丢失
    for (const button of inspector.querySelectorAll('button')) {
      button.addEventListener('mousedown', (event) => event.preventDefault());
    }

    inspector.querySelector('[data-field="labelId"]').addEventListener('change', (event) => {
      this.store.updateRegion(region.id, { labelId: event.target.value });
      this.lastUsed.labelId = event.target.value;
    });

    inspector.querySelector('[data-field="speakerId"]').addEventListener('change', (event) => {
      this.store.updateRegion(region.id, { speakerId: event.target.value || null });
      this.lastUsed.speakerId = event.target.value || null;
    });

    for (const button of inspector.querySelectorAll('[data-confidence]')) {
      button.addEventListener('click', () => {
        this.store.updateRegion(region.id, { confidence: button.dataset.confidence });
        this.renderInspector();
      });
    }

    const note = inspector.querySelector('[data-field="note"]');
    note.addEventListener('focus', () => this.store.beginTransaction('region:note'));
    note.addEventListener('input', () => {
      this.store.updateRegion(region.id, { note: note.value }, { history: false, reason: 'region:note' });
    });
    note.addEventListener('blur', () => {
      this.store.endTransaction();
      // 延后一拍再重建：让随后的 change 事件（例如点选下拉框）先送达，
      // 避免 blur 时把刚交互的元素整块替换掉。
      window.setTimeout(() => {
        this.renderedRegionId = null;
        this.renderRegionList();
        this.renderInspector();
      }, 0);
    });
  }

  isInspectorEditing(inspector) {
    const active = document.activeElement;
    return Boolean(active && inspector.contains(active) && active.matches('input, textarea'));
  }

  renderInspectorLive() {
    // 拖动/输入期间仅更新数值，不重建 DOM，避免打断用户操作
    const inspector = $('#inspector');
    if (!this.selectionId || this.isInspectorEditing(inspector)) return;
    const region = this.store.getRegion(this.selectionId);
    if (!region) return;
    const startInput = inspector.querySelector('[data-field="start"]');
    const endInput = inspector.querySelector('[data-field="end"]');
    if (startInput && document.activeElement !== startInput) startInput.value = formatSeconds(region.start);
    if (endInput && document.activeElement !== endInput) endInput.value = formatSeconds(region.end);
    const hint = inspector.querySelector('.duration-hint');
    if (hint) {
      hint.textContent = `${formatTimecode(region.start)} → ${formatTimecode(region.end)} · 时长 ${formatSeconds(region.end - region.start)} 秒`;
    }
  }

  renderStats() {
    // 统计口径与时间轴一致：取音频时长与最晚区间结尾的较大值
    const duration = Math.max(this.store.duration, this.timeline.duration);
    const stats = coverageStats(this.store.doc.regions, duration);
    const parts = [
      `<span class="stat">区间 <strong>${stats.regionCount}</strong></span>`,
      `<span class="stat">标注 <strong>${formatSeconds(stats.covered)}</strong> s</span>`,
      `<span class="stat">重叠 <strong>${formatSeconds(stats.overlap)}</strong> s</span>`,
      `<span class="stat">空白 <strong>${formatSeconds(stats.blank)}</strong> s</span>`,
    ];
    $('#stage-stats').innerHTML = parts.join('');
    this.currentStats = stats;
  }

  renderAudioInfo() {
    const audio = this.store.doc.audio;
    const info = $('#audio-info');
    if (!audio) {
      info.textContent = this.store.doc.regions.length ? '无音频（仅标注）' : '未加载音频';
      info.title = info.textContent;
      $('#total-time').textContent = formatTimecode(this.timeline.duration);
      return;
    }
    const size = audio.sizeBytes ? ` · ${(audio.sizeBytes / 1024 / 1024).toFixed(1)} MB` : '';
    const rate = audio.sampleRate ? ` · ${(audio.sampleRate / 1000).toFixed(1)} kHz` : '';
    const channels = audio.channels ? ` · ${audio.channels === 1 ? '单声道' : `${audio.channels} 声道`}` : '';
    const missing = this.audioAvailable === false ? '（音频未载入，请补选文件）' : '';
    info.textContent = `${audio.fileName}${rate}${channels} · ${formatSeconds(audio.duration)} 秒${size}${missing}`;
    info.title = info.textContent;
    $('#total-time').textContent = formatTimecode(audio.duration);
  }

  updateUndoButtons() {
    $('#btn-undo').disabled = !this.store.canUndo;
    $('#btn-redo').disabled = !this.store.canRedo;
  }

  updateViewLabel() {
    $('#zoom-label').textContent = `${Math.round(this.timeline.view.pxPerSecond)} px/s`;
  }

  setSaveState(state, text) {
    const element = $('#save-state');
    element.dataset.state = state;
    element.textContent = text;
  }

  markDirty() {
    this.dirty = true;
    this.setSaveState('dirty', '未保存');
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.autosave(), AUTOSAVE_DELAY);
  }

  /** 写草稿时去掉内嵌音频（音频按哈希单独存在 IndexedDB）。 */
  draftDocument() {
    if (!this.store.doc.audio?.dataUrl) return this.store.doc;
    const { dataUrl, ...audio } = this.store.doc.audio;
    return { ...this.store.doc, audio };
  }

  async autosave() {
    try {
      await saveDraft(this.draftDocument());
      this.dirty = false;
      this.setSaveState('saved', '已自动保存');
    } catch (error) {
      console.warn('[autosave]', error);
      this.setSaveState('error', '自动保存失败');
    }
  }

  /* ------------------------------ save / export / import ------------------------------ */

  async buildProjectPayload() {
    const doc = {
      ...this.store.doc,
      updatedAt: Date.now(),
      timeUnit: 'seconds',
    };
    let embedded = false;
    // 只内嵌「当前文档对应的那段音频」，避免把上一份音频带进新工程；
    // 内置示例可以随时重新合成，不必写进工程文件。
    const canEmbed = this.audioBlob && doc.audio && doc.audio.source !== 'sample' && this.audioBlob.size <= EMBED_AUDIO_LIMIT;
    if (canEmbed) {
      const dataUrl = await blobToDataUrl(this.audioBlob);
      doc.audio = { ...doc.audio, dataUrl };
      embedded = true;
    }
    return { doc, embedded };
  }

  async saveProject() {
    try {
      const { doc, embedded } = await this.buildProjectPayload();
      const text = `${JSON.stringify(doc, null, 2)}\n`;
      const blob = new Blob([text], { type: 'application/json' });
      downloadBlob(blob, `${safeFileStem(doc.name)}.gsb2.json`);
      await saveDraft(this.draftDocument());
      this.dirty = false;
      this.setSaveState('saved', '工程已保存');
      let message;
      if (embedded) {
        message = '工程已保存（包含音频，可直接重新打开）';
      } else if (doc.audio?.source === 'sample') {
        message = '工程已保存（内置示例可随时重新合成，未内嵌音频）';
      } else if (doc.audio?.audioKey) {
        message = '工程已保存（音频未内嵌：本浏览器仍保留，换机器需另拷音频）';
      } else {
        message = '工程已保存（当前没有可内嵌的音频文件）';
      }
      this.toast(message, embedded ? 'success' : 'info');
    } catch (error) {
      this.reportError(error, '保存工程失败');
    }
  }

  exportJson() {
    try {
      const text = toJsonString(this.store);
      downloadBlob(new Blob([text], { type: 'application/json;charset=utf-8' }), `${safeFileStem(this.store.doc.name)}.annotations.json`);
      const doc = buildExportDocument(this.store);
      this.toast(`已导出 JSON：${doc.annotations.length} 个区间`, 'success');
    } catch (error) {
      this.reportError(error, '导出 JSON 失败');
    }
  }

  exportCsv() {
    try {
      const text = toCsvString(this.store);
      downloadBlob(new Blob([text], { type: 'text/csv;charset=utf-8' }), `${safeFileStem(this.store.doc.name)}.annotations.csv`);
      this.toast(`已导出 CSV：${this.store.doc.regions.length} 个区间`, 'success');
    } catch (error) {
      this.reportError(error, '导出 CSV 失败');
    }
  }

  async openProjectFile(file) {
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (data?.format === 'gsb2.project' && Array.isArray(data.regions)) {
        await this.restoreProject(data, file.name);
      } else if (data?.annotations || data?.regions) {
        await this.importJsonText(text, { fileName: file.name });
      } else {
        throw new Error('无法识别的工程文件格式');
      }
    } catch (error) {
      this.reportError(error, '工程打开失败');
    }
  }

  /** 根据文档里的音频描述恢复音轨；成功时把最新元数据写回 store。 */
  async hydrateAudio(audio) {
    if (!audio) return false;
    let blob = null;
    let persist = audio.source !== 'sample';
    try {
      if (audio.dataUrl) {
        blob = await (await fetch(audio.dataUrl)).blob();
      } else if (audio.audioKey) {
        blob = await readAudioBlob(audio.audioKey);
        persist = false;
      }
      if (!blob && audio.source === 'sample') {
        // 内置示例按需重新合成，不依赖已落盘的 WAV，也不占用 IndexedDB
        blob = demoAudioBlob();
        persist = false;
      }
      if (!blob) return false;
      await this.loadAudioBlob(blob, { meta: { ...audio }, persist, attach: false, autoFit: false });
      return true;
    } catch (error) {
      console.warn('[audio] 恢复音频失败', error);
      return false;
    }
  }

  /** 统一用新文档替换当前工程，并尝试恢复音轨。 */
  async applyDocument(doc) {
    this.selectionId = null;
    this.timeline.setSelection(null);
    this.store.replaceDocument(doc);
    const audioDescriptor = this.store.doc.audio;
    const loaded = await this.hydrateAudio(audioDescriptor);
    if (!loaded) {
      this.engine.clear();
      this.cache = null;
      this.audioBlob = null;
      this.timeline.setCache(null);
    }
    // 音频描述保留在文档里（下次打开仍可尝试恢复），只是当前没有可播放的音轨
    this.audioAvailable = loaded;
    this.timeline.view = { ...this.store.doc.view };
    this.timeline.applyDurationView();
    this.loopEnabled = false;
    this.updateLoopButton();
    this.renderAll();
    return loaded;
  }

  async restoreProject(data, fileName) {
    const doc = normalizeDocument(data);
    const loaded = await this.applyDocument(doc);
    await saveDraft(this.draftDocument());
    this.dirty = false;
    this.setSaveState('saved', '工程已打开');
    if (loaded) {
      this.toast(`已打开工程：${fileName}`, 'success');
    } else {
      this.toast('已恢复标注，但缺少音频文件；请用「打开 → 加载音频文件」补上', 'warn');
    }
  }

  async importAnnotationsFile(file) {
    try {
      await this.importJsonText(await file.text(), { fileName: file.name });
    } catch (error) {
      this.reportError(error, 'JSON 导入失败');
    }
  }

  async importJsonText(text, { fileName = 'JSON' } = {}) {
    const doc = documentFromJson(text);
    const previousAudio = this.store.doc.audio;
    // 导入标注不换音频：导出 JSON 里只有文件名/时长这类参考信息，
    // 用它替换当前音轨会让标注和声音错位。工程文件请用「打开」。
    const keepAudio = Boolean(previousAudio);
    if (keepAudio) {
      doc.audio = { ...previousAudio };
      doc.name = this.store.doc.name;
    } else if (doc.audio) {
      // 当前没有音轨时，导入文件里的音频只作为「参考信息」保留，不去合成/加载
      doc.audio = { ...doc.audio, source: 'reference' };
    }
    await this.applyDocument(doc);
    await saveDraft(this.draftDocument());
    const count = this.store.doc.regions.length;
    this.toast(
      keepAudio ? `已导入 ${count} 个区间，沿用当前音频` : `已导入 ${fileName}：${count} 个区间`,
      'success',
    );
  }

  async importCsvFile(file) {
    try {
      const text = await file.text();
      const doc = documentFromCsv(text, {
        name: this.store.doc.audio ? this.store.doc.name : 'CSV 导入',
        audio: this.store.doc.audio,
      });
      // CSV 本身不含音频，沿用当前音轨（若有）
      if (this.store.doc.audio) doc.audio = { ...this.store.doc.audio };
      await this.applyDocument(doc);
      await saveDraft(this.draftDocument());
      this.toast(`已导入 CSV：${this.store.doc.regions.length} 个区间`, 'success');
    } catch (error) {
      this.reportError(error, 'CSV 导入失败');
    }
  }

  /* ------------------------------ manage dialog ------------------------------ */

  openManageDialog() {
    this.renderManageDialog();
    $('#manage-dialog').showModal();
  }

  renderManageDialog() {
    const labelList = $('#label-list');
    labelList.replaceChildren(
      ...this.store.doc.labels.map((label) => this.buildEntityRow('label', label, this.store.labelUsage(label.id))),
    );
    const speakerList = $('#speaker-list');
    speakerList.replaceChildren(
      ...this.store.doc.speakers.map((speaker) => this.buildEntityRow('speaker', speaker, this.store.speakerUsage(speaker.id))),
    );
  }

  buildEntityRow(kind, entity, usage) {
    const row = document.createElement('div');
    row.className = 'entity-row';
    row.dataset.entityId = entity.id;
    row.dataset.entityKind = kind;

    const color = document.createElement('input');
    color.type = 'color';
    color.value = entity.color;
    color.setAttribute('aria-label', `${entity.name} 颜色`);

    const name = document.createElement('input');
    name.type = 'text';
    name.value = entity.name;
    name.maxLength = 120;
    name.setAttribute('aria-label', `${kind === 'label' ? '类型' : '说话人'}名称`);

    const usageText = document.createElement('span');
    usageText.className = 'entity-usage';
    usageText.textContent = `${usage} 个区间`;

    const remove = document.createElement('button');
    remove.className = 'icon-btn small';
    remove.dataset.entityAction = 'delete';
    remove.title = '删除';
    remove.setAttribute('aria-label', `删除 ${entity.name}`);
    remove.textContent = '✕';

    row.append(color, name, usageText, remove);
    return row;
  }

  /* ------------------------------ helpers ------------------------------ */

  toast(message, kind = 'info') {
    const stack = $('#toast-stack');
    const element = document.createElement('div');
    element.className = 'toast';
    element.dataset.kind = kind;
    element.textContent = message;
    stack.append(element);
    window.setTimeout(() => {
      element.classList.add('leaving');
      window.setTimeout(() => element.remove(), 200);
    }, 3200);
  }

  reportError(error, context = '操作失败') {
    console.error(`[app] ${context}`, error);
    this.toast(`${context}：${error?.message ?? error}`, 'error');
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** CSS.escape 的降级实现（老浏览器/测试环境）。 */
function cssEscape(value) {
  if (window.CSS?.escape) return CSS.escape(value);
  return String(value).replace(/["\\]/g, '\\$&');
}

function blobToDataUrl(blob) {  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

window.addEventListener('DOMContentLoaded', () => {
  window.annotatorApp = new App();
});
