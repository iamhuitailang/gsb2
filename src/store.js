import {
  NODE_TYPES,
  clone,
  createChoice,
  createEffect,
  createNode,
  createVariable,
  defaultLocale,
  duplicateNode,
  entries,
  findNode,
  getText,
  isValidVariableName,
  layoutNodes,
  localeLabel,
  localeList,
  makeId,
  normalizeStory,
  nowIso,
  removeNode,
  renameVariable,
  setText,
  STORY_FORMAT,
  STORY_VERSION,
  createEmptyStory,
} from './story.js';
import { validateStory } from './validation.js';

const PROJECT_KEY = 'storyloom:project:v1';
const SESSION_KEY = 'storyloom:session:v1';
const UNDO_LIMIT = 80;

export class Store {
  constructor() {
    this.story = createEmptyStory();
    this.selection = { nodeId: null, choiceId: null };
    this.editLocale = defaultLocale(this.story);
    this.previewLocale = defaultLocale(this.story);
    this.previewEntryId = '';
    this.sidebarTab = 'outline';
    this.undoStack = [];
    this.redoStack = [];
    this.revision = 0;
    this.editBaseline = null;
    this.persistTimer = null;
    this.dirty = false;
    this.listeners = new Set();
    this.report = validateStory(this.story);
    this.loadSession();
    this.report = validateStory(this.story);
  }

  /* ------------------------------ 事件 ------------------------------ */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(type, detail = {}) {
    for (const listener of this.listeners) listener({ type, detail });
  }

  /* ------------------------------ 状态 ------------------------------ */
  get renderable() {
    return {
      story: this.story,
      selection: this.selection,
      editLocale: this.editLocale,
      previewLocale: this.previewLocale,
      report: this.report,
      dirty: this.dirty,
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
    };
  }

  get selectedNode() {
    return this.selection.nodeId ? findNode(this.story, this.selection.nodeId) : null;
  }

  get sourceLocale() {
    return defaultLocale(this.story);
  }

  /** 记录快照并执行修改；用于所有会改动剧情的操作。 */
  commit(group, mutate, options = {}) {
    // 若正在输入文本，撤销点应回溯到输入开始前，避免一次编辑被拆成多条
    const pendingBaseline = this.editBaseline;
    const before = pendingBaseline ?? JSON.stringify(this.story);
    const beforeLocale = this.editLocale;
    const result = mutate();
    if (result === false) return false;
    const after = JSON.stringify(this.story);
    if (before === after) {
      this.editBaseline = null;
      return true;
    }
    this.editBaseline = null;
    this.persistNow();
    this.story.meta.updatedAt = nowIso();
    this.undoStack.push({
      key: `${group}:${Date.now()}:${Math.random()}`,
      snapshot: before,
      selection: { ...this.selection },
      locale: beforeLocale,
    });
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.revision += 1;
    this.report = validateStory(this.story);
    this.dirty = true;
    this.emit(options.event || 'story:change', { group, selection: this.selection });
    this.persist();
    return true;
  }

  /* ------------------------------ 就地编辑 ------------------------------ */
  /**
   * 文本输入期间直接写模型（避免重建 DOM 时丢失其他输入框的草稿），
   * 获得焦点时记录撤销基线，失焦时合并成一条撤销记录。
   */
  beginEdit() {
    if (this.editBaseline === null) this.editBaseline = JSON.stringify(this.story);
  }

  /** 输入中：只更新模型与保存状态，不重建界面。 */
  touch() {
    this.touchPending = true;
    this.dirty = true;
    this.persistSoon();
  }

  finishEdit(group = 'text:edit') {
    const baseline = this.editBaseline;
    this.editBaseline = null;
    this.touchPending = false;
    if (!baseline) return false;
    this.persistNow();
    const after = JSON.stringify(this.story);
    if (baseline === after) return false;
    this.story.meta.updatedAt = nowIso();
    this.undoStack.push({
      key: `${group}:${Date.now()}:${Math.random()}`,
      snapshot: baseline,
      selection: { ...this.selection },
      locale: this.editLocale,
    });
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.revision += 1;
    this.report = validateStory(this.story);
    this.dirty = true;
    this.emit('story:text', { group, selection: this.selection });
    this.persist();
    return true;
  }

  persistSoon() {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.dirty = true;
      this.persist();
      this.emit('save:state');
    }, 400);
  }

  persistNow() {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
  }

  /* ------------------------------ 撤销/重做 ------------------------------ */
  undo() {
    if (this.editBaseline) this.finishEdit('text:edit');
    const entry = this.undoStack.pop();
    if (!entry) return false;
    this.redoStack.push({
      key: entry.key,
      snapshot: JSON.stringify(this.story),
      selection: { ...this.selection },
      locale: this.editLocale,
    });
    this.restoreSnapshot(entry);
    this.emit('story:undo');
    return true;
  }

  redo() {
    if (this.editBaseline) this.finishEdit('text:edit');
    const entry = this.redoStack.pop();
    if (!entry) return false;
    this.undoStack.push({
      key: entry.key,
      snapshot: JSON.stringify(this.story),
      selection: { ...this.selection },
      locale: this.editLocale,
    });
    this.restoreSnapshot(entry);
    this.emit('story:redo');
    return true;
  }

  restoreSnapshot(entry) {
    this.persistNow();
    this.editBaseline = null;
    this.story = JSON.parse(entry.snapshot);
    this.selection = { ...entry.selection };
    if (!findNode(this.story, this.selection.nodeId)) this.selection = { nodeId: null, choiceId: null };
    if (localeList(this.story).includes(entry.locale)) this.editLocale = entry.locale;
    else this.editLocale = this.sourceLocale;
    this.revision += 1;
    this.report = validateStory(this.story);
    this.dirty = true;
    this.persist();
  }

  /* ------------------------------ 选择 ------------------------------ */
  selectNode(nodeId, choiceId = null, options = {}) {
    if (!findNode(this.story, nodeId) && nodeId !== null) return;
    // 切换选中会重建检查器，先把正在进行的文本编辑落成一条撤销记录
    if (this.editBaseline) this.finishEdit('text:edit');
    this.selection = { nodeId, choiceId };
    if (options.emit !== false) this.emit('selection:change', { nodeId, choiceId });
  }

  selectChoice(choiceId) {
    this.selection = { ...this.selection, choiceId };
    this.emit('selection:change', this.selection);
  }

  setEditLocale(code) {
    if (!localeList(this.story).includes(code)) return;
    if (this.editBaseline) this.finishEdit('text:edit');
    this.editLocale = code;
    this.emit('locale:change', { code });
    this.persistSession();
  }

  setPreviewLocale(code) {
    if (!localeList(this.story).includes(code)) return;
    this.previewLocale = code;
    this.persistSession();
  }

  setSidebarTab(tab) {
    if (this.editBaseline) this.finishEdit('text:edit');
    this.sidebarTab = tab;
    this.emit('sidebar:tab', { tab });
  }

  /* ------------------------------ 节点操作 ------------------------------ */
  addNode(position) {
    const node = createNode({
      title: `新节点 ${this.story.nodes.length + 1}`,
      locale: this.sourceLocale,
      position: position || this.nextFreePosition(),
    });
    this.commit('node:add', () => {
      this.story.nodes.push(node);
    });
    this.selectNode(node.id);
    return node;
  }

  nextFreePosition() {
    const count = this.story.nodes.length;
    return { x: 140 + (count % 4) * 300, y: 120 + Math.floor(count / 4) * 180 };
  }

  updateNode(nodeId, patch) {
    const node = findNode(this.story, nodeId);
    if (!node) return;
    return this.commit('node:update', () => {
      Object.assign(node, patch);
    });
  }

  /**
   * 编辑单个语言的文本；绝不触碰其他语言。
   * live=true 时用于输入过程中：只写模型、不重建界面、不生成撤销点。
   */
  setNodeText(nodeId, locale, value, { live = false } = {}) {
    const node = findNode(this.story, nodeId);
    if (!node) return;
    const apply = () => {
      if (locale === this.sourceLocale) {
        const previous = getText(node.text, locale);
        if (previous.trim() && previous !== value) {
          const stale = new Set(node.staleLocales || []);
          for (const code of localeList(this.story)) {
            if (code !== locale && getText(node.text, code).trim()) stale.add(code);
          }
          node.staleLocales = [...stale];
        }
      }
      setText(node.text, locale, value);
      if (locale !== this.sourceLocale && node.staleLocales?.includes(locale)) {
        node.staleLocales = node.staleLocales.filter((code) => code !== locale);
      }
    };
    if (live) {
      apply();
      this.touch();
      return;
    }
    return this.commit('node:text', apply);
  }

  setNodeSpeaker(nodeId, locale, value, { live = false } = {}) {
    const node = findNode(this.story, nodeId);
    if (!node) return;
    // 角色名覆盖是节点的可选字段，不参与正文译文统计，因此不写 staleLocales
    const apply = () => setText(node.speaker, locale, value);
    if (live) {
      apply();
      this.touch();
      return;
    }
    return this.commit('node:speaker', apply);
  }

  setCharacterName(characterId, locale, value, { live = false } = {}) {
    const character = this.story.characters.find((item) => item.id === characterId);
    if (!character) return;
    const apply = () => {
      if (locale === this.sourceLocale) {
        const previous = getText(character.name, locale);
        if (previous.trim() && previous !== value) {
          const stale = new Set(character.staleLocales || []);
          for (const code of localeList(this.story)) {
            if (code !== locale && getText(character.name, code).trim()) stale.add(code);
          }
          character.staleLocales = [...stale];
        }
      }
      setText(character.name, locale, value);
      if (locale !== this.sourceLocale && character.staleLocales?.includes(locale)) {
        character.staleLocales = character.staleLocales.filter((code) => code !== locale);
      }
    };
    if (live) {
      apply();
      this.touch();
      return;
    }
    return this.commit('character:name', apply);
  }

  setChoiceText(nodeId, choiceId, locale, value, { live = false } = {}) {
    const node = findNode(this.story, nodeId);
    const choice = node?.choices.find((item) => item.id === choiceId);
    if (!choice) return;
    const apply = () => {
      if (locale === this.sourceLocale) {
        const previous = getText(choice.text, locale);
        if (previous.trim() && previous !== value) {
          const stale = new Set(choice.staleLocales || []);
          for (const code of localeList(this.story)) {
            if (code !== locale && getText(choice.text, code).trim()) stale.add(code);
          }
          choice.staleLocales = [...stale];
        }
      }
      setText(choice.text, locale, value);
      if (locale !== this.sourceLocale && choice.staleLocales?.includes(locale)) {
        choice.staleLocales = choice.staleLocales.filter((code) => code !== locale);
      }
    };
    if (live) {
      apply();
      this.touch();
      return;
    }
    return this.commit('choice:text', apply);
  }

  moveNode(nodeId, position, { transient = false } = {}) {
    const node = findNode(this.story, nodeId);
    if (!node) return;
    if (transient) {
      node.position = position;
      this.emit('graph:move', { nodeId });
      return;
    }
    return this.commit('node:move', () => {
      node.position = position;
    });
  }

  deleteNode(nodeId) {
    const node = findNode(this.story, nodeId);
    if (!node) return;
    this.commit('node:delete', () => {
      removeNode(this.story, nodeId);
      if (this.selection.nodeId === nodeId) this.selection = { nodeId: null, choiceId: null };
    });
    this.emit('selection:change', this.selection);
  }

  duplicateNode(nodeId) {
    let copy = null;
    this.commit('node:duplicate', () => {
      copy = duplicateNode(this.story, nodeId);
    });
    if (copy) this.selectNode(copy.id);
    return copy;
  }

  setNodeType(nodeId, type) {
    if (!NODE_TYPES[type]) return;
    return this.updateNode(nodeId, { type });
  }

  toggleEntry(nodeId, entry) {
    return this.updateNode(nodeId, { entry });
  }

  setNodeNext(nodeId, targetId) {
    return this.updateNode(nodeId, { next: targetId });
  }

  setStartNode(nodeId) {
    if (!findNode(this.story, nodeId)) return;
    return this.commit('story:start', () => {
      this.story.startNodeId = nodeId;
    });
  }

  /* ------------------------------ 选项 ------------------------------ */
  addChoice(nodeId) {
    const node = findNode(this.story, nodeId);
    if (!node) return null;
    const choice = createChoice('', this.sourceLocale);
    this.commit('choice:add', () => {
      node.choices.push(choice);
      if (node.type === 'end') node.type = 'dialogue';
    });
    this.selectNode(nodeId, choice.id);
    return choice;
  }

  updateChoice(nodeId, choiceId, patch) {
    const node = findNode(this.story, nodeId);
    const choice = node?.choices.find((item) => item.id === choiceId);
    if (!choice) return;
    return this.commit('choice:update', () => {
      Object.assign(choice, patch);
    });
  }

  deleteChoice(nodeId, choiceId) {
    const node = findNode(this.story, nodeId);
    if (!node) return;
    return this.commit('choice:delete', () => {
      node.choices = node.choices.filter((item) => item.id !== choiceId);
      if (this.selection.choiceId === choiceId) this.selection = { ...this.selection, choiceId: null };
    });
  }

  moveChoice(nodeId, choiceId, direction) {
    const node = findNode(this.story, nodeId);
    if (!node) return;
    const index = node.choices.findIndex((item) => item.id === choiceId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= node.choices.length) return;
    return this.commit('choice:move', () => {
      const [item] = node.choices.splice(index, 1);
      node.choices.splice(target, 0, item);
    });
  }

  addEffect(nodeId, choiceId) {
    const node = findNode(this.story, nodeId);
    if (!node) return;
    const variable = this.story.variables[0];
    const effect = createEffect(variable?.id || '', variable?.type === 'number' ? 'add' : 'set', '');
    return this.commit('effect:add', () => {
      if (choiceId) {
        const choice = node.choices.find((item) => item.id === choiceId);
        choice?.effects.push(effect);
      } else {
        node.onEnter.push(effect);
      }
    });
  }

  updateEffect(nodeId, choiceId, effectId, patch) {
    const node = findNode(this.story, nodeId);
    if (!node) return;
    const list = choiceId ? node.choices.find((item) => item.id === choiceId)?.effects : node.onEnter;
    const effect = list?.find((item) => item.id === effectId);
    if (!effect) return;
    return this.commit('effect:update', () => {
      Object.assign(effect, patch);
      const variable = this.story.variables.find((item) => item.id === effect.variableId);
      // 累加只对数字（数值相加）和文本（字符串拼接）有意义；布尔请用「设为」
      if (variable && effect.op === 'add' && variable.type === 'boolean') effect.op = 'set';
    });
  }

  deleteEffect(nodeId, choiceId, effectId) {
    const node = findNode(this.story, nodeId);
    if (!node) return;
    return this.commit('effect:delete', () => {
      if (choiceId) {
        const choice = node.choices.find((item) => item.id === choiceId);
        if (choice) choice.effects = choice.effects.filter((item) => item.id !== effectId);
      } else {
        node.onEnter = node.onEnter.filter((item) => item.id !== effectId);
      }
    });
  }

  /* ------------------------------ 变量/角色 ------------------------------ */
  addVariable(input = {}) {
    const name = input.name || this.uniqueVariableName();
    const variable = createVariable({ ...input, name });
    this.commit('variable:add', () => {
      this.story.variables.push(variable);
    });
    return variable;
  }

  uniqueVariableName(prefix = '新变量') {
    let index = 1;
    const names = new Set(this.story.variables.map((item) => item.name));
    let name = `${prefix}${index}`;
    while (names.has(name)) {
      index += 1;
      name = `${prefix}${index}`;
    }
    return name;
  }

  updateVariable(variableId, patch) {
    const variable = this.story.variables.find((item) => item.id === variableId);
    if (!variable) return false;
    const data = { ...patch };
    const newName = typeof data.name === 'string' ? data.name.trim() : null;
    delete data.name;
    if (newName && newName !== variable.name) {
      if (!isValidVariableName(newName)) return false;
      if (this.story.variables.some((item) => item.id !== variableId && item.name === newName)) return false;
    }
    return this.commit('variable:update', () => {
      if (newName && newName !== variable.name) {
        if (!renameVariable(this.story, variableId, newName)) return false;
      }
      Object.assign(variable, data);
      if (variable.hasInitial) {
        if (variable.type === 'number') {
          const number = Number(variable.initial);
          variable.initial = Number.isFinite(number) ? number : 0;
        } else if (variable.type === 'boolean') {
          variable.initial = variable.initial === true || variable.initial === 'true';
        } else {
          variable.initial = String(variable.initial ?? '');
        }
      }
      return true;
    });
  }

  deleteVariable(variableId) {
    const variable = this.story.variables.find((item) => item.id === variableId);
    if (!variable) return;
    this.commit('variable:delete', () => {
      for (const node of this.story.nodes) {
        for (const effect of node.onEnter) {
          if (effect.variableId === variableId) effect.variableId = '';
        }
        for (const choice of node.choices) {
          for (const effect of choice.effects) {
            if (effect.variableId === variableId) effect.variableId = '';
          }
        }
      }
      this.story.variables = this.story.variables.filter((item) => item.id !== variableId);
    });
  }

  addCharacter(name = '新角色') {
    const character = {
      id: makeId('char'),
      name: { [this.sourceLocale]: name },
      staleLocales: [],
      color: '#8fb0c9',
      description: '',
    };
    this.commit('character:add', () => {
      this.story.characters.push(character);
    });
    return character;
  }

  updateCharacter(characterId, patch) {
    const character = this.story.characters.find((item) => item.id === characterId);
    if (!character) return;
    return this.commit('character:update', () => {
      Object.assign(character, patch);
    });
  }

  deleteCharacter(characterId) {
    this.commit('character:delete', () => {
      for (const node of this.story.nodes) {
        if (node.characterId === characterId) node.characterId = '';
      }
      this.story.characters = this.story.characters.filter((item) => item.id !== characterId);
    });
  }

  /* ------------------------------ 语言 ------------------------------ */
  addLocale(code, label) {
    const trimmed = String(code || '').trim();
    if (!trimmed || localeList(this.story).includes(trimmed)) return false;
    this.commit('locale:add', () => {
      this.story.locales.push({ code: trimmed, label: label || trimmed });
    });
    return true;
  }

  removeLocale(code) {
    if (code === this.sourceLocale) return false;
    if (localeList(this.story).length <= 1) return false;
    this.commit('locale:remove', () => {
      this.story.locales = this.story.locales.filter((item) => item.code !== code);
      const strip = (map) => {
        if (map && typeof map === 'object') delete map[code];
      };
      for (const node of this.story.nodes) {
        strip(node.text);
        strip(node.speaker);
        node.staleLocales = (node.staleLocales || []).filter((item) => item !== code);
        for (const choice of node.choices) {
          strip(choice.text);
          choice.staleLocales = (choice.staleLocales || []).filter((item) => item !== code);
        }
      }
      for (const character of this.story.characters) {
        strip(character.name);
        character.staleLocales = (character.staleLocales || []).filter((item) => item !== code);
      }
      if (this.editLocale === code) this.editLocale = this.sourceLocale;
      if (this.previewLocale === code) this.previewLocale = this.sourceLocale;
    });
    return true;
  }

  setDefaultLocale(code) {
    if (!localeList(this.story).includes(code)) return false;
    return this.commit('locale:default', () => {
      this.story.settings.defaultLocale = code;
    });
  }

  updateSettings(patch) {
    return this.commit('settings:update', () => {
      Object.assign(this.story.settings, patch);
    });
  }

  renameProject(title) {
    const value = String(title || '').trim();
    if (!value || value === this.story.meta.title) return false;
    return this.commit('project:rename', () => {
      this.story.meta.title = value;
    });
  }

  updateDescription(description) {
    return this.commit('project:description', () => {
      this.story.meta.description = String(description ?? '');
    });
  }

  /* ------------------------------ 结构工具 ------------------------------ */
  autoLayout() {
    return this.commit('story:layout', () => {
      layoutNodes(this.story.nodes, this.story.startNodeId);
    });
  }

  setEntryLabel(nodeId, label) {
    return this.updateNode(nodeId, { entryLabel: label });
  }

  entryOptions() {
    return entries(this.story);
  }

  /* ------------------------------ 序列化 ------------------------------ */
  serialize() {
    const payload = clone(this.story);
    payload.meta.updatedAt = nowIso();
    return JSON.stringify(payload, null, 2);
  }

  loadFromObject(input) {
    this.story = input;
    this.editLocale = localeList(input).includes(this.editLocale) ? this.editLocale : defaultLocale(input);
    this.previewLocale = localeList(input).includes(this.previewLocale) ? this.previewLocale : defaultLocale(input);
    this.selection = { nodeId: null, choiceId: null };
    this.undoStack = [];
    this.redoStack = [];
    this.editBaseline = null;
    this.persistNow();
    this.revision += 1;
    this.dirty = false;
    this.report = validateStory(this.story);
    this.emit('story:load');
    this.persist();
  }

  newProject() {
    this.loadFromObject(createEmptyStory());
    this.dirty = false;
    this.emit('story:new');
  }

  persist() {
    try {
      localStorage.setItem(PROJECT_KEY, this.serialize());
      this.persistSession();
    } catch {
      /* localStorage 不可用时静默降级 */
    }
  }

  /** 保存到浏览器并清除未保存标记。 */
  saveNow() {
    this.persistNow();
    this.persist();
    this.dirty = false;
    this.emit('save:state');
  }

  persistSession() {
    try {
      localStorage.setItem(
        SESSION_KEY,
        JSON.stringify({
          selection: this.selection,
          editLocale: this.editLocale,
          previewLocale: this.previewLocale,
          sidebarTab: this.sidebarTab,
        }),
      );
    } catch {
      /* ignore */
    }
  }

  loadSession() {
    try {
      const raw = localStorage.getItem(PROJECT_KEY);
      if (raw) {
        const parsed = normalizeImported(raw);
        if (parsed) this.story = parsed;
      }
      const sessionRaw = localStorage.getItem(SESSION_KEY);
      if (sessionRaw) {
        const session = JSON.parse(sessionRaw);
        if (session.selection?.nodeId && findNode(this.story, session.selection.nodeId)) {
          this.selection = {
            nodeId: session.selection.nodeId,
            choiceId: session.selection.choiceId || null,
          };
        }
        if (localeList(this.story).includes(session.editLocale)) this.editLocale = session.editLocale;
        if (localeList(this.story).includes(session.previewLocale)) this.previewLocale = session.previewLocale;
        if (['outline', 'variables', 'characters'].includes(session.sidebarTab)) this.sidebarTab = session.sidebarTab;
      }
    } catch {
      /* 数据损坏时回到默认项目 */
    }
    if (!localeList(this.story).includes(this.editLocale)) this.editLocale = this.sourceLocale;
    if (!localeList(this.story).includes(this.previewLocale)) this.previewLocale = this.sourceLocale;
  }

  localeLabel(code) {
    return localeLabel(this.story, code);
  }

  storyFormat() {
    return { format: STORY_FORMAT, version: STORY_VERSION };
  }
}

function normalizeImported(raw) {
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return null;
    return normalizeStory(data);
  } catch {
    return null;
  }
}

export const store = new Store();
export { clone };
