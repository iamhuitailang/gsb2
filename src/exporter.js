import {
  STORY_VERSION,
  defaultLocale,
  localeLabel,
  speakerFor,
} from './story.js';

/**
 * 导出运行时剧情数据。
 * 与项目文件不同：项目文件保留编辑器状态（节点坐标、待复核标记等），
 * 导出文件面向游戏运行时，只包含播放所需的字段。
 */
export function buildRuntimeData(story) {
  const source = defaultLocale(story);
  const characterById = new Map(story.characters.map((character) => [character.id, character]));

  const nodes = story.nodes.map((node) => {
    const character = characterById.get(node.characterId);
    const data = {
      id: node.id,
      type: node.type,
      speaker: speakerFor(story, node, source) || null,
      character: character ? character.id : null,
      text: { ...node.text },
      entry: node.entry,
      entryLabel: node.entryLabel || undefined,
      next: node.next || null,
      effects: node.onEnter.map((effect) => exportEffect(story, effect)),
      choices: node.choices.map((choice) => ({
        id: choice.id,
        text: { ...choice.text },
        when: choice.condition.trim() || null,
        effects: choice.effects.map((effect) => exportEffect(story, effect)),
        next: choice.target || null,
      })),
    };
    if (node.type === 'end') delete data.next;
    return data;
  });

  return {
    format: 'storyloom.runtime',
    version: STORY_VERSION,
    story: {
      id: story.meta.id,
      title: story.meta.title,
      description: story.meta.description,
      defaultLocale: source,
      locales: story.locales.map((locale) => ({ code: locale.code, label: localeLabel(story, locale.code) })),
      start: story.startNodeId,
      maxSteps: story.settings.maxSteps,
      maxVisitsPerNode: story.settings.maxVisitsPerNode,
      characters: story.characters.map((character) => ({
        id: character.id,
        name: { ...character.name },
        color: character.color,
      })),
      variables: story.variables.map((variable) => ({
        id: variable.id,
        name: variable.name,
        type: variable.type,
        initial: variable.hasInitial ? variable.initial : undefined,
        description: variable.description || undefined,
      })),
      entries: story.nodes
        .filter((node) => node.entry)
        .map((node) => ({ nodeId: node.id, name: node.entryLabel || node.title })),
      nodes,
    },
  };
}

function exportEffect(story, effect) {
  const variable = story.variables.find((item) => item.id === effect.variableId);
  return {
    variable: variable?.name || null,
    op: effect.op,
    value: effect.value,
  };
}

export function exportRuntimeJSON(story) {
  return JSON.stringify(buildRuntimeData(story), null, 2);
}

/** 供其他引擎读取的扁平节点表（便于逐条比对/本地化导入）。 */
export function exportNodeTable(story) {
  const rows = [];
  for (const node of story.nodes) {
    rows.push({
      id: node.id,
      type: node.type,
      next: node.next || '',
      text: Object.fromEntries(story.locales.map((locale) => [locale.code, node.text[locale.code] || ''])),
      choices: node.choices.map((choice) => ({
        id: choice.id,
        target: choice.target,
        condition: choice.condition,
        text: Object.fromEntries(story.locales.map((locale) => [locale.code, choice.text[locale.code] || ''])),
      })),
    });
  }
  return rows;
}
