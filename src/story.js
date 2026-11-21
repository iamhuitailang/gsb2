/** 剧情数据模型：创建、归一化、查询与安全的文本编辑。 */

export const STORY_FORMAT = 'storyloom.story';
export const STORY_VERSION = 1;

export const NODE_TYPES = {
  dialogue: { label: '对话', description: '一段台词，可带选项或默认出口' },
  hub: { label: '枢纽', description: '多路汇合/分流用节点，可带多个选项' },
  end: { label: '结局', description: '流程终点，没有默认出口' },
};

export const LOCALE_PRESETS = [
  { code: 'zh-CN', label: '简体中文' },
  { code: 'zh-TW', label: '繁體中文' },
  { code: 'en', label: 'English' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'es', label: 'Español' },
  { code: 'ru', label: 'Русский' },
  { code: 'pt', label: 'Português' },
];

export const VARIABLE_TYPES = {
  number: { label: '数字', defaultValue: 0 },
  string: { label: '文本', defaultValue: '' },
  boolean: { label: '布尔', defaultValue: false },
};

const CHOICE_COLORS = ['#e0a25e', '#7fb5c9', '#c98bb0', '#8fbf7f', '#b4a5e8', '#d98b7a'];

export function choiceColor(index) {
  return CHOICE_COLORS[index % CHOICE_COLORS.length];
}

export function makeId(prefix = 'id') {
  const uid =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 10)
      : Math.random().toString(36).slice(2, 12);
  return `${prefix}_${uid}`;
}

export function clone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

export function nowIso() {
  return new Date().toISOString();
}

export function createVariable({ name, type = 'number', hasInitial = true, initial, description = '' } = {}) {
  return {
    id: makeId('var'),
    name: name || '变量',
    type,
    hasInitial,
    initial: hasInitial ? coerceValue(initial, type) : null,
    description,
  };
}

export function createCharacter({ name = '角色', color = '#8fb0c9', description = '' } = {}, locale = 'zh-CN') {
  return {
    id: makeId('char'),
    name: { [locale]: name },
    color,
    description,
  };
}

export function createEffect(variableId = '', op = 'set', value = '') {
  return { id: makeId('fx'), variableId, op, value };
}

export function createChoice(text = '', locale = 'zh-CN') {
  return {
    id: makeId('choice'),
    text: text ? { [locale]: text } : {},
    staleLocales: [],
    condition: '',
    effects: [],
    target: '',
  };
}

export function createNode({
  title = '新节点',
  type = 'dialogue',
  locale = 'zh-CN',
  text = '',
  position = { x: 0, y: 0 },
} = {}) {
  return {
    id: makeId('node'),
    title,
    type,
    position: { x: position.x, y: position.y },
    characterId: '',
    speaker: {},
    text: text ? { [locale]: text } : {},
    staleLocales: [],
    entry: false,
    entryLabel: '',
    onEnter: [],
    next: '',
    choices: [],
    notes: '',
  };
}

export function localeList(story) {
  return story.locales.map((item) => item.code);
}

export function defaultLocale(story) {
  return story.settings?.defaultLocale || story.locales[0]?.code || 'zh-CN';
}

export function localeLabel(story, code) {
  return story.locales.find((item) => item.code === code)?.label || code;
}

export function getText(map, locale) {
  if (!map || typeof map !== 'object') return '';
  const value = map[locale];
  return typeof value === 'string' ? value : '';
}

/** 只写入指定语言，其他语言的已有内容保持不变。 */
export function setText(map, locale, value) {
  if (!map || typeof map !== 'object') throw new TypeError('文本字段必须是语言映射对象');
  map[locale] = String(value ?? '');
  return map;
}

export function hasText(map, locale) {
  return getText(map, locale).trim().length > 0;
}

export function coerceValue(value, type) {
  if (type === 'number') {
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (type === 'boolean') {
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === '1' || value === 1) return true;
    return false;
  }
  if (value === null || value === undefined) return '';
  return String(value);
}

export function findNode(story, nodeId) {
  return story.nodes.find((node) => node.id === nodeId) || null;
}

export function findCharacter(story, characterId) {
  return story.characters.find((character) => character.id === characterId) || null;
}

export function findVariable(story, variableId) {
  return story.variables.find((variable) => variable.id === variableId) || null;
}

export function findVariableByName(story, name) {
  return story.variables.find((variable) => variable.name === name) || null;
}

export function initialVariables(story) {
  const values = {};
  for (const variable of story.variables) {
    if (variable.hasInitial) values[variable.name] = clone(variable.initial);
  }
  return values;
}

export function entries(story) {
  const list = [];
  const start = findNode(story, story.startNodeId);
  if (start) list.push({ id: `start:${start.id}`, nodeId: start.id, name: '默认开始', label: start.title, isStart: true });
  for (const node of story.nodes) {
    if (node.entry && node.id !== story.startNodeId) {
      list.push({
        id: `entry:${node.id}`,
        nodeId: node.id,
        name: node.entryLabel?.trim() || node.title,
        label: node.title,
        isStart: false,
      });
    }
  }
  return list;
}

export function speakerFor(story, node, locale) {
  const override = getText(node.speaker, locale);
  if (override.trim()) return override;
  const character = findCharacter(story, node.characterId);
  if (!character) return '';
  return getText(character.name, locale) || getText(character.name, defaultLocale(story));
}

export function addEdgeInfo(story) {
  const incoming = new Map(story.nodes.map((node) => [node.id, new Set()]));
  const outgoing = new Map(story.nodes.map((node) => [node.id, new Set()]));
  const edges = [];
  const add = (from, to, kind, choiceId = null, condition = '') => {
    if (!to) return;
    edges.push({ from, to, kind, choiceId, condition });
    if (incoming.has(to)) incoming.get(to).add(from);
    if (outgoing.has(from)) outgoing.get(from).add(to);
  };
  for (const node of story.nodes) {
    if (node.next) add(node.id, node.next, 'next');
    node.choices.forEach((choice) => {
      if (choice.target) add(node.id, choice.target, 'choice', choice.id, choice.condition);
    });
  }
  return { edges, incoming, outgoing };
}

export function createEmptyStory({ title = '未命名剧情', locales = [{ code: 'zh-CN', label: '简体中文' }] } = {}) {
  const defaultCode = locales[0]?.code || 'zh-CN';
  const start = createNode({
    title: '开始',
    type: 'dialogue',
    locale: defaultCode,
    text: '故事从这里开始。',
    position: { x: 120, y: 220 },
  });
  const end = createNode({
    title: '结局',
    type: 'end',
    locale: defaultCode,
    text: '（在这里写下结局。）',
    position: { x: 500, y: 220 },
  });
  start.next = end.id;
  return normalizeStory({
    format: STORY_FORMAT,
    version: STORY_VERSION,
    meta: {
      id: makeId('story'),
      title,
      description: '',
      createdAt: nowIso(),
      updatedAt: nowIso(),
    },
    settings: { defaultLocale: defaultCode, maxSteps: 200, maxVisitsPerNode: 3 },
    locales,
    variables: [],
    characters: [],
    nodes: [start, end],
    startNodeId: start.id,
  });
}

function normalizeLocaleMap(map, fallbackLocale, legacyValue) {
  if (typeof map === 'string') return { [fallbackLocale]: map };
  if (!map || typeof map !== 'object' || Array.isArray(map)) {
    if (legacyValue !== undefined) return { [fallbackLocale]: String(legacyValue) };
    return {};
  }
  const result = {};
  for (const [code, value] of Object.entries(map)) {
    if (typeof value === 'string') result[code] = value;
  }
  return result;
}

/** 宽容地归一化导入数据，补齐缺失字段，避免旧文件/手写文件直接崩溃。 */
export function normalizeStory(input) {
  if (!input || typeof input !== 'object') throw new Error('剧情文件为空或格式不正确');
  if (input.format && input.format !== STORY_FORMAT) {
    throw new Error(`不支持的文件格式：${input.format}`);
  }
  const localesInput = Array.isArray(input.locales) ? input.locales : [];
  const locales = [];
  const localeCodes = new Set();
  for (const item of localesInput) {
    const code = typeof item === 'string' ? item : item?.code;
    if (!code || localeCodes.has(code)) continue;
    localeCodes.add(code);
    locales.push({ code, label: (typeof item === 'object' && item.label) || code });
  }
  if (!locales.length) locales.push({ code: 'zh-CN', label: '简体中文' });
  const fallback = locales.find((item) => item.code === input.settings?.defaultLocale)?.code || locales[0].code;

  const variables = (Array.isArray(input.variables) ? input.variables : []).map((variable, index) => {
    const type = VARIABLE_TYPES[variable?.type] ? variable.type : 'number';
    const hasInitial = variable?.hasInitial !== false;
    return {
      id: variable?.id || makeId('var'),
      name: typeof variable?.name === 'string' && variable.name.trim() ? variable.name.trim() : `变量${index + 1}`,
      type,
      hasInitial,
      initial: hasInitial ? coerceValue(variable?.initial, type) : null,
      description: typeof variable?.description === 'string' ? variable.description : '',
    };
  });

  const characters = (Array.isArray(input.characters) ? input.characters : []).map((character, index) => ({
    id: character?.id || makeId('char'),
    name: normalizeLocaleMap(character?.name, fallback, character?.displayName),
    staleLocales: normalizeStale(character?.staleLocales),
    color: /^#[0-9a-fA-F]{3,8}$/.test(character?.color || '') ? character.color : '#8fb0c9',
    description: typeof character?.description === 'string' ? character.description : `角色${index + 1}`,
  }));

  const nodes = (Array.isArray(input.nodes) ? input.nodes : []).map((node, index) => {
    const type = NODE_TYPES[node?.type] ? node.type : 'dialogue';
    const choices = (Array.isArray(node?.choices) ? node.choices : []).map((choice) => ({
      id: choice?.id || makeId('choice'),
      text: normalizeLocaleMap(choice?.text, fallback),
      staleLocales: normalizeStale(choice?.staleLocales),
      condition: typeof choice?.condition === 'string' ? choice.condition : '',
      effects: (Array.isArray(choice?.effects) ? choice.effects : []).map((effect) => ({
        id: effect?.id || makeId('fx'),
        variableId: typeof effect?.variableId === 'string' ? effect.variableId : '',
        op: effect?.op === 'add' ? 'add' : 'set',
        value: effect?.value ?? '',
      })),
      target: typeof choice?.target === 'string' ? choice.target : '',
    }));
    return {
      id: node?.id || makeId('node'),
      title: typeof node?.title === 'string' && node.title.trim() ? node.title : `节点${index + 1}`,
      type,
      position: {
        x: Number.isFinite(node?.position?.x) ? node.position.x : NaN,
        y: Number.isFinite(node?.position?.y) ? node.position.y : NaN,
      },
      characterId: typeof node?.characterId === 'string' ? node.characterId : '',
      speaker: normalizeLocaleMap(node?.speaker, fallback),
      text: normalizeLocaleMap(node?.text, fallback),
      staleLocales: normalizeStale(node?.staleLocales),
      entry: Boolean(node?.entry),
      entryLabel: typeof node?.entryLabel === 'string' ? node.entryLabel : '',
      onEnter: (Array.isArray(node?.onEnter) ? node.onEnter : []).map((effect) => ({
        id: effect?.id || makeId('fx'),
        variableId: typeof effect?.variableId === 'string' ? effect.variableId : '',
        op: effect?.op === 'add' ? 'add' : 'set',
        value: effect?.value ?? '',
      })),
      next: typeof node?.next === 'string' ? node.next : '',
      choices,
      notes: typeof node?.notes === 'string' ? node.notes : '',
    };
  });

  if (!nodes.length) {
    const fallbackNode = createNode({ title: '开始', locale: fallback, text: '故事从这里开始。' });
    nodes.push(fallbackNode);
  }

  ensurePositions(nodes);

  // 入口标记可能因手写文件缺失；默认开始节点始终可作为入口
  const startNodeId = nodes.some((node) => node.id === input.startNodeId) ? input.startNodeId : nodes[0].id;
  return {
    format: STORY_FORMAT,
    version: STORY_VERSION,
    meta: {
      id: typeof input.meta?.id === 'string' ? input.meta.id : makeId('story'),
      title: typeof input.meta?.title === 'string' && input.meta.title.trim() ? input.meta.title : '未命名剧情',
      description: typeof input.meta?.description === 'string' ? input.meta.description : '',
      createdAt: typeof input.meta?.createdAt === 'string' ? input.meta.createdAt : nowIso(),
      updatedAt: typeof input.meta?.updatedAt === 'string' ? input.meta.updatedAt : nowIso(),
    },
    settings: {
      defaultLocale: fallback,
      maxSteps: clampInt(input.settings?.maxSteps, 10, 2000, 200),
      maxVisitsPerNode: clampInt(input.settings?.maxVisitsPerNode, 2, 50, 3),
    },
    locales,
    variables,
    characters,
    nodes,
    startNodeId,
  };
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function normalizeStale(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item) => typeof item === 'string' && item))];
}

/** 只对位置缺失的节点自动布局；已有坐标保持不变。 */
export function ensurePositions(nodes) {
  const missing = nodes.filter(
    (node) => !Number.isFinite(node.position?.x) || !Number.isFinite(node.position?.y),
  );
  if (!missing.length) return nodes;
  const placed = nodes.filter((node) => !missing.includes(node));
  const offsetY = placed.reduce((max, node) => Math.max(max, node.position.y + 190), 60);
  layoutNodes(missing).forEach((node, index) => {
    node.position = { x: 80 + index * 320, y: offsetY + Math.floor(index / 4) * 190 };
  });
  return nodes;
}

/** 简单的分层布局：入口在左，按 BFS 深度向右展开。 */
export function layoutNodes(nodes, startNodeId) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const queue = [];
  const depth = new Map();
  const roots = nodes.filter((node) => node.entry);
  if (startNodeId && byId.has(startNodeId)) roots.unshift(byId.get(startNodeId));
  if (!roots.length && nodes[0]) roots.push(nodes[0]);
  for (const root of roots) {
    if (!depth.has(root.id)) {
      depth.set(root.id, 0);
      queue.push(root.id);
    }
  }
  while (queue.length) {
    const id = queue.shift();
    const node = byId.get(id);
    if (!node) continue;
    const nextDepth = depth.get(id) + 1;
    const targets = [node.next, ...node.choices.map((choice) => choice.target)].filter((target) => byId.has(target));
    for (const target of targets) {
      if (!depth.has(target)) {
        depth.set(target, nextDepth);
        queue.push(target);
      }
    }
  }
  let maxDepth = Math.max(0, ...depth.values());
  for (const node of nodes) {
    if (!depth.has(node.id)) {
      maxDepth += 1;
      depth.set(node.id, maxDepth);
    }
  }
  const perLayer = new Map();
  for (const node of nodes) {
    const layer = depth.get(node.id) || 0;
    const index = perLayer.get(layer) || 0;
    perLayer.set(layer, index + 1);
    node.position = { x: 80 + layer * 320, y: 100 + index * 190 };
  }
  return nodes;
}

/** 重命名变量，同时把条件表达式中的同名标识符替换掉。 */
export function renameVariable(story, variableId, newName) {
  const variable = findVariable(story, variableId);
  if (!variable) return false;
  const oldName = variable.name;
  const cleaned = String(newName || '').trim();
  if (!cleaned || cleaned === oldName) return false;
  if (!isValidVariableName(cleaned)) return false;
  if (story.variables.some((item) => item.id !== variableId && item.name === cleaned)) return false;
  variable.name = cleaned;
  const pattern = new RegExp(`(^|[^A-Za-z0-9_\\u4e00-\\u9fff])${escapeRegExp(oldName)}(?=[^A-Za-z0-9_\\u4e00-\\u9fff]|$)`, 'g');
  for (const node of story.nodes) {
    for (const choice of node.choices) {
      choice.condition = choice.condition.replace(pattern, (match, prefix) => `${prefix}${cleaned}`);
    }
  }
  return true;
}

export function isValidVariableName(name) {
  if (!/^[A-Za-z_一-鿿][A-Za-z0-9_一-鿿]*$/.test(name)) return false;
  return !['true', 'false', 'and', 'or', 'not'].includes(name);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function serializeProject(story) {
  const payload = clone(story);
  payload.meta.updatedAt = nowIso();
  return JSON.stringify(payload, null, 2);
}

export function deserializeProject(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('不是有效的 JSON 文件');
  }
  return normalizeStory(parsed);
}

export function duplicateNode(story, nodeId) {
  const source = findNode(story, nodeId);
  if (!source) return null;
  const copy = clone(source);
  copy.id = makeId('node');
  copy.title = `${source.title} 副本`;
  copy.position = { x: source.position.x + 40, y: source.position.y + 50 };
  copy.entry = false;
  copy.entryLabel = '';
  copy.choices = copy.choices.map((choice) => ({ ...choice, id: makeId('choice') }));
  copy.onEnter = copy.onEnter.map((effect) => ({ ...effect, id: makeId('fx') }));
  story.nodes.push(copy);
  return copy;
}

export function removeNode(story, nodeId) {
  const node = findNode(story, nodeId);
  if (!node) return false;
  story.nodes = story.nodes.filter((item) => item.id !== nodeId);
  for (const other of story.nodes) {
    if (other.next === nodeId) other.next = '';
    for (const choice of other.choices) {
      if (choice.target === nodeId) choice.target = '';
    }
  }
  if (story.startNodeId === nodeId) story.startNodeId = story.nodes[0]?.id || '';
  return true;
}
