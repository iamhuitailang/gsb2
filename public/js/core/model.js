import { clamp, clampRegion, MIN_REGION_SECONDS, roundSeconds } from './time.js';

export const PROJECT_FORMAT = 'gsb2.project';
export const PROJECT_VERSION = 1;
export const TIME_UNIT = 'seconds';

export const CONFIDENCE_LEVELS = [
  { value: 'certain', label: '确定', color: '#34d399' },
  { value: 'uncertain', label: '存疑', color: '#fbbf24' },
  { value: 'inaudible', label: '听不清', color: '#fb7185' },
];

export const DEFAULT_LABELS = [
  { id: 'label_speech', name: '说话', color: '#f0b35a' },
  { id: 'label_event', name: '声音事件', color: '#a78bfa' },
  { id: 'label_unclear', name: '听不清', color: '#fb7185' },
  { id: 'label_other', name: '其他', color: '#7dd3fc' },
];

export const DEFAULT_SPEAKERS = [
  { id: 'spk_interviewer', name: '采访者', color: '#60a5fa' },
  { id: 'spk_guest', name: '受访者', color: '#34d399' },
];

const CONFIDENCE_VALUES = new Set(CONFIDENCE_LEVELS.map((level) => level.value));

let idCounter = 0;

export function makeId(prefix = 'reg') {
  idCounter += 1;
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}${random}`;
}

export function isConfidence(value) {
  return CONFIDENCE_VALUES.has(value);
}

export function confidenceMeta(value) {
  return CONFIDENCE_LEVELS.find((level) => level.value === value) ?? CONFIDENCE_LEVELS[0];
}

export function createEmptyDocument({ idFactory = makeId, now = () => Date.now() } = {}) {
  const timestamp = now();
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    timeUnit: TIME_UNIT,
    id: idFactory('prj'),
    name: '未命名采访',
    createdAt: timestamp,
    updatedAt: timestamp,
    audio: null,
    labels: DEFAULT_LABELS.map((label) => ({ ...label, id: label.id })),
    speakers: DEFAULT_SPEAKERS.map((speaker) => ({ ...speaker })),
    regions: [],
    view: { start: 0, pxPerSecond: 90 },
  };
}

/**
 * 内存中的标注工程。所有公开时间字段单位均为秒。
 * 数据修改通过 mutate() 完成，自动维护撤销/重做快照。
 */
export class ProjectStore {
  constructor({ document = null, idFactory = makeId, now = () => Date.now() } = {}) {
    this.idFactory = idFactory;
    this.now = now;
    this.listeners = new Set();
    this.history = { past: [], future: [] };
    this.transaction = null;
    this.doc = document ? normalizeDocument(document, { idFactory, now }) : createEmptyDocument({ idFactory, now });
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(reason = 'change') {
    for (const listener of [...this.listeners]) {
      try {
        listener(this.doc, reason);
      } catch (error) {
        console.error('[store] listener failed', error);
      }
    }
  }

  get duration() {
    return this.doc.audio?.duration ?? 0;
  }

  get bounds() {
    return this.duration > 0 ? this.duration : Infinity;
  }

  snapshot() {
    // 音轨来自浏览器端的音频缓冲区，不属于「标注编辑」，
    // 因此不进入撤销栈：撤销永远不会让音轨与文档脱节。
    return {
      name: this.doc.name,
      labels: this.doc.labels.map((item) => ({ ...item })),
      speakers: this.doc.speakers.map((item) => ({ ...item })),
      regions: this.doc.regions.map((item) => ({ ...item })),
      view: { ...this.doc.view },
    };
  }

  applySnapshot(snapshot) {
    this.doc.name = snapshot.name;
    this.doc.labels = snapshot.labels.map((item) => ({ ...item }));
    this.doc.speakers = snapshot.speakers.map((item) => ({ ...item }));
    this.doc.regions = snapshot.regions.map((item) => ({ ...item }));
    this.doc.view = { ...snapshot.view };
    this.doc.updatedAt = this.now();
  }

  pushPast(snapshot) {
    this.history.past.push(snapshot);
    if (this.history.past.length > 100) this.history.past.shift();
    this.history.future = [];
  }

  get canUndo() {
    return this.history.past.length > 0;
  }

  get canRedo() {
    return this.history.future.length > 0;
  }

  undo() {
    if (!this.canUndo) return false;
    const current = this.snapshot();
    const previous = this.history.past.pop();
    this.history.future.push(current);
    this.applySnapshot(previous);
    this.emit('undo');
    return true;
  }

  redo() {
    if (!this.canRedo) return false;
    const current = this.snapshot();
    const next = this.history.future.pop();
    this.history.past.push(current);
    this.applySnapshot(next);
    this.emit('redo');
    return true;
  }

  /**
   * 修改文档。事务中的连续修改只生成一条撤销记录。
   * mutator 可以直接改 this.doc，也可返回 false 表示放弃。
   */
  mutate(mutator, { reason = 'edit', history = true } = {}) {
    const before = history && !this.transaction ? this.snapshot() : null;
    const result = mutator(this.doc);
    if (result === false) return false;
    this.doc.updatedAt = this.now();
    if (before) this.pushPast(before);
    this.emit(reason);
    return true;
  }

  beginTransaction(reason = 'transaction') {
    if (this.transaction) return;
    this.transaction = { before: this.snapshot(), reason };
  }

  endTransaction() {
    if (!this.transaction) return;
    const { before, reason } = this.transaction;
    this.transaction = null;
    if (JSON.stringify(before) === JSON.stringify(this.snapshot())) return;
    this.pushPast(before);
    this.doc.updatedAt = this.now();
    this.emit(reason);
  }

  rollbackTransaction() {
    if (!this.transaction) return;
    this.applySnapshot(this.transaction.before);
    this.transaction = null;
    this.emit('rollback');
  }

  replaceDocument(nextDoc, { reason = 'load' } = {}) {
    this.doc = normalizeDocument(nextDoc, { idFactory: this.idFactory, now: this.now });
    this.history = { past: [], future: [] };
    this.transaction = null;
    this.emit(reason);
  }

  refresh(reason = 'refresh') {
    this.emit(reason);
  }

  setProjectName(name) {
    const trimmed = String(name ?? '').trim();
    if (!trimmed || trimmed === this.doc.name) return;
    this.mutate((doc) => {
      doc.name = trimmed;
    }, { reason: 'name' });
  }

  setAudio(audio) {
    // 不裁剪既有标注：先导入标注、后补音频是常见流程，
    // 后台数据的时间必须原样保留；越界由界面提示。
    // 音频本身不进入撤销栈，因此这里不产生历史记录（否则撤销会「空转」一次）。
    this.mutate((doc) => {
      doc.audio = audio ? { ...audio, duration: roundSeconds(audio.duration) } : null;
    }, { reason: 'audio', history: false });
  }

  setView(view) {
    this.doc.view = { ...this.doc.view, ...view };
    this.emit('view');
  }

  getRegion(id) {
    return this.doc.regions.find((region) => region.id === id) ?? null;
  }

  getLabel(id) {
    return this.doc.labels.find((label) => label.id === id) ?? null;
  }

  getSpeaker(id) {
    return id ? this.doc.speakers.find((speaker) => speaker.id === id) ?? null : null;
  }

  regionLabel(region) {
    return this.getLabel(region.labelId) ?? this.doc.labels[0] ?? null;
  }

  regionSpeaker(region) {
    return this.getSpeaker(region.speakerId);
  }

  defaultLabelId() {
    return this.doc.labels[0]?.id ?? null;
  }

  /** 创建区间。新建时夹到音频范围内（此时时间是用户刚拖出的，越界没有意义）。 */
  addRegion(input = {}, { history = true, reason = 'region:add' } = {}) {
    const bounds = this.bounds;
    if (!Number.isFinite(bounds)) {
      // 没有音频时也允许先建标注（例如先导入 CSV 再补音频）
      const start = Math.max(0, Number(input.start) || 0);
      const end = Math.max(start + MIN_REGION_SECONDS, Number(input.end) || start + 1);
      return this.insertRegion(input, { start, end }, { history, reason });
    }
    const clamped = clampRegion(Number(input.start) || 0, Number(input.end) || 0, bounds);
    return this.insertRegion(input, clamped, { history, reason });
  }

  insertRegion(input, { start, end }, { history = true, reason = 'region:add' } = {}) {
    const labelId = this.getLabel(input.labelId) ? input.labelId : this.defaultLabelId();
    const speakerId = this.getSpeaker(input.speakerId) ? input.speakerId : null;
    const region = {
      id: input.id && !this.getRegion(input.id) ? input.id : this.idFactory('reg'),
      start: roundSeconds(start),
      end: roundSeconds(end),
      labelId,
      speakerId,
      confidence: isConfidence(input.confidence) ? input.confidence : 'certain',
      note: String(input.note ?? ''),
      createdAt: Number(input.createdAt) || this.now(),
      updatedAt: this.now(),
    };
    this.mutate((doc) => {
      doc.regions.push(region);
    }, { history, reason });
    return region;
  }

  /**
   * 局部更新。只修改存在的字段；start/end 会保持最短时长和音频边界。
   */
  updateRegion(id, patch = {}, { history = true, reason = 'region:update' } = {}) {
    const region = this.getRegion(id);
    if (!region) return null;
    const updated = applyRegionPatch(region, patch, this);
    if (!updated) return region;
    this.mutate((doc) => {
      const index = doc.regions.findIndex((item) => item.id === id);
      if (index >= 0) doc.regions[index] = updated;
    }, { history, reason });
    return updated;
  }

  nudgeRegion(id, edge, deltaSeconds, options = {}) {
    const region = this.getRegion(id);
    if (!region) return null;
    if (edge === 'start') {
      return this.updateRegion(id, { start: region.start + deltaSeconds }, options);
    }
    if (edge === 'end') {
      return this.updateRegion(id, { end: region.end + deltaSeconds }, options);
    }
    return this.updateRegion(id, { start: region.start + deltaSeconds, end: region.end + deltaSeconds }, options);
  }

  removeRegions(ids, { history = true, reason = 'region:remove' } = {}) {
    const set = new Set(Array.isArray(ids) ? ids : [ids]);
    if (!set.size) return 0;
    let removed = 0;
    this.mutate((doc) => {
      const before = doc.regions.length;
      doc.regions = doc.regions.filter((region) => !set.has(region.id));
      removed = before - doc.regions.length;
    }, { history, reason });
    return removed;
  }

  duplicateRegion(id) {
    const region = this.getRegion(id);
    if (!region) return null;
    return this.addRegion({ ...region, id: undefined, createdAt: this.now() });
  }

  splitRegionAt(id, time) {
    const region = this.getRegion(id);
    if (!region || !(time > region.start + MIN_REGION_SECONDS) || !(time < region.end - MIN_REGION_SECONDS)) return null;
    const rightId = this.idFactory('reg');
    this.mutate((doc) => {
      const index = doc.regions.findIndex((item) => item.id === id);
      if (index < 0) return;
      const original = doc.regions[index];
      const left = { ...original, end: roundSeconds(time), updatedAt: this.now() };
      const right = {
        ...original,
        id: rightId,
        start: roundSeconds(time),
        createdAt: this.now(),
        updatedAt: this.now(),
      };
      doc.regions.splice(index, 1, left, right);
    }, { reason: 'region:split' });
    return rightId;
  }

  addLabel({ name, color } = {}) {
    const label = {
      id: this.idFactory('label'),
      name: String(name ?? '新类型').trim() || '新类型',
      color: color || '#f0b35a',
    };
    this.mutate((doc) => {
      doc.labels.push(label);
    }, { reason: 'label:add' });
    return label;
  }

  updateLabel(id, patch = {}) {
    const label = this.getLabel(id);
    if (!label) return null;
    const nextName = patch.name === undefined ? label.name : String(patch.name).trim() || label.name;
    const nextColor = patch.color ?? label.color;
    if (nextName === label.name && nextColor === label.color) return label;
    this.mutate((doc) => {
      const target = doc.labels.find((item) => item.id === id);
      if (!target) return;
      target.name = nextName;
      target.color = nextColor;
    }, { reason: 'label:update' });
    return { ...label, name: nextName, color: nextColor };
  }

  removeLabel(id) {
    if (this.doc.labels.length <= 1) return false;
    const fallback = this.doc.labels.find((label) => label.id !== id);
    if (!fallback) return false;
    this.mutate((doc) => {
      doc.labels = doc.labels.filter((label) => label.id !== id);
      for (const region of doc.regions) {
        if (region.labelId === id) region.labelId = fallback.id;
      }
    }, { reason: 'label:remove' });
    return true;
  }

  addSpeaker({ name, color } = {}) {
    const speaker = {
      id: this.idFactory('spk'),
      name: String(name ?? '新说话人').trim() || '新说话人',
      color: color || '#60a5fa',
    };
    this.mutate((doc) => {
      doc.speakers.push(speaker);
    }, { reason: 'speaker:add' });
    return speaker;
  }

  updateSpeaker(id, patch = {}) {
    const speaker = this.getSpeaker(id);
    if (!speaker) return null;
    const nextName = patch.name === undefined ? speaker.name : String(patch.name).trim() || speaker.name;
    const nextColor = patch.color ?? speaker.color;
    if (nextName === speaker.name && nextColor === speaker.color) return speaker;
    this.mutate((doc) => {
      const target = doc.speakers.find((item) => item.id === id);
      if (!target) return;
      target.name = nextName;
      target.color = nextColor;
    }, { reason: 'speaker:update' });
    return { ...speaker, name: nextName, color: nextColor };
  }

  renameSpeaker(id, name) {
    return this.updateSpeaker(id, { name });
  }

  removeSpeaker(id) {
    if (!this.getSpeaker(id)) return false;
    this.mutate((doc) => {
      doc.speakers = doc.speakers.filter((speaker) => speaker.id !== id);
      for (const region of doc.regions) {
        if (region.speakerId === id) region.speakerId = null;
      }
    }, { reason: 'speaker:remove' });
    return true;
  }

  /** 说话人（或标签）改名只会影响引用，不会碰区间时间。 */
  speakerUsage(id) {
    return this.doc.regions.filter((region) => region.speakerId === id).length;
  }

  labelUsage(id) {
    return this.doc.regions.filter((region) => region.labelId === id).length;
  }

  sortedRegions() {
    return [...this.doc.regions].sort((a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id));
  }
}

function applyRegionPatch(region, patch, store) {
  const next = { ...region };
  let changed = false;

  if (patch.start !== undefined || patch.end !== undefined) {
    // 编辑时不按音频时长裁剪：导入的标注可能超出音频，任何微调都不应静默改动另一端。
    // 只保证起点非负、结束不早于起点、且区间不短于最短时长。
    let start = patch.start !== undefined ? Number(patch.start) : region.start;
    let end = patch.end !== undefined ? Number(patch.end) : region.end;
    if (!Number.isFinite(start)) start = region.start;
    if (!Number.isFinite(end)) end = region.end;
    start = Math.max(0, start);
    end = Math.max(0, end);

    if (patch.start !== undefined && patch.end === undefined) {
      start = Math.min(start, Math.max(0, end - MIN_REGION_SECONDS));
    } else if (patch.end !== undefined && patch.start === undefined) {
      end = Math.max(end, start + MIN_REGION_SECONDS);
    } else {
      end = Math.max(end, start + MIN_REGION_SECONDS);
    }

    start = roundSeconds(start);
    end = roundSeconds(end);
    if (start !== region.start || end !== region.end) {
      next.start = start;
      next.end = end;
      changed = true;
    }
  }

  if (patch.labelId !== undefined) {
    const labelId = store.getLabel(patch.labelId) ? patch.labelId : store.defaultLabelId();
    if (labelId && labelId !== region.labelId) {
      next.labelId = labelId;
      changed = true;
    }
  }

  if (patch.speakerId !== undefined) {
    const speakerId = store.getSpeaker(patch.speakerId) ? patch.speakerId : null;
    if (speakerId !== region.speakerId) {
      next.speakerId = speakerId;
      changed = true;
    }
  }

  if (patch.confidence !== undefined && isConfidence(patch.confidence) && patch.confidence !== region.confidence) {
    next.confidence = patch.confidence;
    changed = true;
  }

  if (patch.note !== undefined) {
    const note = String(patch.note);
    if (note !== region.note) {
      next.note = note;
      changed = true;
    }
  }

  if (!changed) return null;
  next.updatedAt = Date.now();
  return next;
}

/**
 * 校验并规整外部文档（工程文件/导出文件）。无法修复的区间会被丢弃。
 * 说话人列表允许为空；缺失（undefined）时才补默认说话人。
 */
export function normalizeDocument(input, { idFactory = makeId, now = () => Date.now() } = {}) {
  if (!input || typeof input !== 'object') {
    throw new Error('工程数据不是有效对象');
  }
  const labels = normalizeEntities(input.labels, { prefix: 'label', idFactory, fallback: DEFAULT_LABELS });
  // 说话人可以为空：来源给出空数组（如 CSV 无说话人列）时保持为空。
  const speakers = normalizeEntities(input.speakers, {
    prefix: 'spk',
    idFactory,
    fallback: DEFAULT_SPEAKERS,
    allowEmpty: true,
  });
  const speakerByName = new Map(speakers.map((speaker) => [speaker.name, speaker.id]));
  const labelByName = new Map(labels.map((label) => [label.name, label.id]));
  const duration = Number(input.audio?.duration ?? input.durationSeconds ?? 0);
  const resolvedDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;

  const regions = [];
  const seen = new Set();
  for (const raw of Array.isArray(input.regions) ? input.regions : []) {
    if (!raw || typeof raw !== 'object') continue;
    let start = Number(raw.start ?? raw.startSeconds);
    let end = Number(raw.end ?? raw.endSeconds);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    start = Math.max(0, start);
    // 不按音频时长裁剪：导入的标注时间必须原样保留，
    // 越界由界面提示，用户可自行修正。
    if (end - start < MIN_REGION_SECONDS) continue;
    const labelId =
      (raw.labelId && labels.some((label) => label.id === raw.labelId) ? raw.labelId : null) ??
      labelByName.get(raw.label) ??
      labels[0]?.id;
    if (!labelId) continue;
    const speakerId =
      (raw.speakerId && speakers.some((speaker) => speaker.id === raw.speakerId) ? raw.speakerId : null) ??
      speakerByName.get(raw.speaker) ??
      null;
    let id = raw.id ? String(raw.id) : idFactory('reg');
    while (seen.has(id)) id = idFactory('reg');
    seen.add(id);
    regions.push({
      id,
      start: roundSeconds(start),
      end: roundSeconds(end),
      labelId,
      speakerId,
      confidence: isConfidence(raw.confidence) ? raw.confidence : 'certain',
      note: String(raw.note ?? '').slice(0, 4000),
      createdAt: Number(raw.createdAt) || now(),
      updatedAt: Number(raw.updatedAt) || now(),
    });
  }

  const timestamp = now();
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    timeUnit: TIME_UNIT,
    id: input.id ? String(input.id) : idFactory('prj'),
    name: String(input.name ?? input.project?.name ?? '未命名采访').slice(0, 200) || '未命名采访',
    createdAt: Number(input.createdAt) || timestamp,
    updatedAt: timestamp,
    audio: normalizeAudio(input.audio, resolvedDuration),
    labels,
    speakers,
    regions,
    view: {
      start: Math.max(0, Number(input.view?.start) || 0),
      pxPerSecond: clamp(Number(input.view?.pxPerSecond) || 90, 0.25, 40000),
    },
  };
}

function normalizeAudio(audio, fallbackDuration) {
  if (!audio || typeof audio !== 'object') return null;
  const rawDuration = Number(audio.duration ?? audio.durationSeconds);
  const resolvedDuration =
    Number.isFinite(rawDuration) && rawDuration > 0
      ? rawDuration
      : Number.isFinite(fallbackDuration) && fallbackDuration > 0
        ? fallbackDuration
        : 0;
  if (!resolvedDuration) return null;
  const dataUrl =
    typeof audio.dataUrl === 'string' && audio.dataUrl.startsWith('data:') ? audio.dataUrl : undefined;
  // 内嵌音频本身就说明是「本机音频」，即使原作者标记为 reference/sample
  const source =
    dataUrl || audio.audioKey
      ? 'local'
      : audio.source === 'sample' || audio.sampleId
        ? 'sample'
        : audio.source === 'local'
          ? 'local'
          : 'reference';
  return {
    fileName: String(audio.fileName ?? audio.name ?? '未命名音频'),
    duration: roundSeconds(resolvedDuration),
    sampleRate: Number(audio.sampleRate) || 0,
    channels: Number(audio.channels) || 0,
    source,
    sampleId: audio.sampleId ? String(audio.sampleId) : undefined,
    samplePath: audio.samplePath ? String(audio.samplePath) : undefined,
    audioKey: audio.audioKey ? String(audio.audioKey) : undefined,
    dataUrl,
    sizeBytes: Number(audio.sizeBytes) || 0,
    lastModified: Number(audio.lastModified) || 0,
  };
}

function normalizeEntities(list, { prefix, idFactory, fallback, allowEmpty = false }) {
  // 来源明确给了空列表（例如 CSV 没有说话人列）时尊重它，不要凭空补默认项
  if (allowEmpty && Array.isArray(list) && list.length === 0) return [];
  const provided = Array.isArray(list) && list.length > 0;
  const source = provided ? list : fallback;
  const result = [];
  const ids = new Set();
  for (const item of source) {
    if (!item) continue;
    const name = String(item.name ?? '').trim().slice(0, 120);
    if (!name) continue;
    let id = item.id ? String(item.id) : '';
    if (!id || ids.has(id)) id = idFactory(prefix);
    ids.add(id);
    result.push({ id, name, color: validColor(item.color) ? item.color : '#94a3b8' });
  }
  if (!result.length) {
    return fallback.map((item) => ({ ...item, id: item.id || idFactory(prefix) }));
  }
  return result;
}

function validColor(color) {
  return typeof color === 'string' && /^#[0-9a-f]{3,8}$/i.test(color);
}
