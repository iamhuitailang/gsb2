import { compileCondition } from './expression.js';
import {
  NODE_TYPES,
  VARIABLE_TYPES,
  addEdgeInfo,
  defaultLocale,
  entries,
  getText,
  hasText,
  isValidVariableName,
  localeList,
} from './story.js';

const SEVERITY_RANK = { error: 0, warning: 1, hint: 2 };

/**
 * 静态分析剧情：
 * - 条件语法 / 未声明变量 / 未初始化变量
 * - 断头节点、失效连线、孤立节点
 * - 循环路径（SCC）、汇合点、多入口
 * - 缺失 / 待复核的翻译
 */
export function validateStory(story) {
  const issues = [];
  const nodeIds = new Set(story.nodes.map((node) => node.id));
  const choiceIds = new Set();
  const variableById = new Map(story.variables.map((variable) => [variable.id, variable]));
  const variablesByName = new Map();
  const duplicateNames = new Set();

  for (const variable of story.variables) {
    if (variablesByName.has(variable.name)) duplicateNames.add(variable.name);
    variablesByName.set(variable.name, variable);
    if (!isValidVariableName(variable.name)) {
      issues.push({
        id: `VARIABLE_NAME:${variable.id}`,
        severity: 'error',
        code: 'VARIABLE_NAME',
        message: `变量名「${variable.name}」不合法，只能使用中英文、数字和下划线，且不能以数字开头`,
        variableId: variable.id,
      });
    }
    if (!VARIABLE_TYPES[variable.type]) {
      issues.push({
        id: `VARIABLE_TYPE:${variable.id}`,
        severity: 'error',
        code: 'VARIABLE_TYPE',
        message: `变量「${variable.name}」的类型未知`,
        variableId: variable.id,
      });
    }
    if (variable.hasInitial === false) {
      issues.push({
        id: `VARIABLE_UNSET:${variable.id}`,
        severity: 'warning',
        code: 'VARIABLE_UNSET',
        message: `变量「${variable.name}」没有设置初始值；若流程未先赋值，条件求值会失败`,
        variableId: variable.id,
        variableName: variable.name,
      });
    }
  }

  for (const name of duplicateNames) {
    issues.push({
      id: `VARIABLE_DUPLICATE:${name}`,
      severity: 'error',
      code: 'VARIABLE_DUPLICATE',
      message: `变量名「${name}」重复定义`,
      variableName: name,
    });
  }

  const checkCondition = (source, context) => {
    const compiled = compileCondition(source);
    if (!compiled.ok) {
      issues.push({
        id: `CONDITION_SYNTAX:${context.key}`,
        severity: 'error',
        code: 'CONDITION_SYNTAX',
        message: `条件语法错误：${compiled.error}`,
        ...context,
      });
      return;
    }
    for (const identifier of compiled.identifiers) {
      const variable = variablesByName.get(identifier);
      if (!variable) {
        issues.push({
          id: `UNDECLARED_VARIABLE:${context.key}:${identifier}`,
          severity: 'error',
          code: 'UNDECLARED_VARIABLE',
          message: `条件引用了未定义的变量「${identifier}」`,
          variableName: identifier,
          ...context,
        });
        continue;
      }
      if (variable.hasInitial === false) {
        issues.push({
          id: `UNSET_USAGE:${context.key}:${identifier}`,
          severity: 'warning',
          code: 'UNSET_USAGE',
          message: `条件依赖的变量「${identifier}」没有初始值，需要确保在此之前被赋值`,
          variableName: identifier,
          variableId: variable.id,
          ...context,
        });
      }
    }
  };

  const checkEffects = (effects, context) => {
    for (const effect of effects) {
      const variable = variableById.get(effect.variableId);
      if (!variable) {
        issues.push({
          id: `EFFECT_VARIABLE:${effect.id}`,
          severity: 'error',
          code: 'EFFECT_VARIABLE',
          message: '赋值操作没有选择变量',
          ...context,
        });
        continue;
      }
      if (effect.op === 'add' && variable.type !== 'number' && variable.type !== 'string') {
        issues.push({
          id: `EFFECT_ADD_TYPE:${effect.id}`,
          severity: 'warning',
          code: 'EFFECT_ADD_TYPE',
          message: `「${variable.name}」是${VARIABLE_TYPES[variable.type]?.label || ''}类型，不支持累加`,
          variableId: variable.id,
          ...context,
        });
      }
      if (variable.type === 'number' && effect.op === 'set' && String(effect.value).trim() !== '' && !Number.isFinite(Number(effect.value))) {
        issues.push({
          id: `EFFECT_VALUE:${effect.id}`,
          severity: 'warning',
          code: 'EFFECT_VALUE',
          message: `「${variable.name}」需要数字，当前值「${effect.value}」无法转换`,
          variableId: variable.id,
          ...context,
        });
      }
    }
  };

  for (const node of story.nodes) {
    for (const choice of node.choices) {
      if (choiceIds.has(choice.id)) {
        issues.push({
          id: `CHOICE_DUPLICATE:${choice.id}`,
          severity: 'warning',
          code: 'CHOICE_DUPLICATE',
          message: '选项 ID 重复，导出时可能冲突',
          nodeId: node.id,
          choiceId: choice.id,
        });
      }
      choiceIds.add(choice.id);
    }
    checkEffects(node.onEnter, { nodeId: node.id });
    for (const choice of node.choices) {
      checkEffects(choice.effects, { nodeId: node.id, choiceId: choice.id });
      checkCondition(choice.condition, {
        key: `${node.id}:${choice.id}`,
        nodeId: node.id,
        choiceId: choice.id,
      });
    }
  }

  const { edges, incoming } = addEdgeInfo(story);

  for (const node of story.nodes) {
    const isEnd = node.type === 'end';
    const hasChoices = node.choices.length > 0;
    if (node.next && !nodeIds.has(node.next)) {
      issues.push({
        id: `MISSING_TARGET:${node.id}:next`,
        severity: 'error',
        code: 'MISSING_TARGET',
        message: `默认出口指向不存在的节点（${node.next}）`,
        nodeId: node.id,
      });
    }
    for (const choice of node.choices) {
      if (!choice.target) {
        issues.push({
          id: `CHOICE_TARGET:${node.id}:${choice.id}`,
          severity: 'error',
          code: 'CHOICE_TARGET',
          message: '选项没有连接目标节点',
          nodeId: node.id,
          choiceId: choice.id,
        });
      } else if (!nodeIds.has(choice.target)) {
        issues.push({
          id: `MISSING_TARGET:${node.id}:${choice.id}`,
          severity: 'error',
          code: 'MISSING_TARGET',
          message: `选项指向不存在的节点（${choice.target}）`,
          nodeId: node.id,
          choiceId: choice.id,
        });
      }
      if (!hasText(choice.text, defaultLocale(story))) {
        issues.push({
          id: `CHOICE_TEXT_EMPTY:${node.id}:${choice.id}`,
          severity: 'warning',
          code: 'CHOICE_TEXT_EMPTY',
          message: `选项在原文（${defaultLocale(story)}）中没有文本`,
          nodeId: node.id,
          choiceId: choice.id,
        });
      }
    }
    if (!isEnd && !hasChoices && !node.next) {
      issues.push({
        id: `DEAD_END:${node.id}`,
        severity: 'error',
        code: 'DEAD_END',
        message: '节点没有出口：既没有默认下一节点，也没有选项',
        nodeId: node.id,
      });
    }
    if (isEnd && (node.next || hasChoices)) {
      issues.push({
        id: `END_HAS_EXIT:${node.id}`,
        severity: 'warning',
        code: 'END_HAS_EXIT',
        message: '结局节点上的出口不会被执行，可以移除',
        nodeId: node.id,
      });
    }
    if (hasChoices && node.next) {
      issues.push({
        id: `CHOICE_AND_NEXT:${node.id}`,
        severity: 'warning',
        code: 'CHOICE_AND_NEXT',
        message: '节点同时设置了选项和默认出口，运行时会优先使用选项',
        nodeId: node.id,
      });
    }
    if (node.characterId && !story.characters.some((character) => character.id === node.characterId)) {
      issues.push({
        id: `MISSING_CHARACTER:${node.id}`,
        severity: 'error',
        code: 'MISSING_CHARACTER',
        message: '节点引用的角色已被删除',
        nodeId: node.id,
      });
    }
    if (!isEnd && !hasText(node.text, defaultLocale(story)) && !hasChoices) {
      issues.push({
        id: `NODE_TEXT_EMPTY:${node.id}`,
        severity: 'hint',
        code: 'NODE_TEXT_EMPTY',
        message: `节点在原文（${defaultLocale(story)}）中没有文本`,
        nodeId: node.id,
      });
    }
  }

  const entryList = entries(story);
  const startNode = nodeIds.has(story.startNodeId) ? story.startNodeId : null;
  if (!startNode) {
    issues.push({
      id: 'NO_START',
      severity: 'error',
      code: 'NO_START',
      message: '没有设置默认开始节点',
    });
  }

  const reachable = new Set();
  const queue = entryList.map((entry) => entry.nodeId);
  while (queue.length) {
    const id = queue.shift();
    if (!id || reachable.has(id) || !nodeIds.has(id)) continue;
    reachable.add(id);
    const node = story.nodes.find((item) => item.id === id);
    if (!node) continue;
    if (node.next) queue.push(node.next);
    for (const choice of node.choices) queue.push(choice.target);
  }

  for (const node of story.nodes) {
    if (!reachable.has(node.id)) {
      issues.push({
        id: `UNREACHABLE:${node.id}`,
        severity: 'warning',
        code: 'UNREACHABLE',
        message: '该节点无法从任何入口到达',
        nodeId: node.id,
      });
    }
  }

  if (entryList.length > 1) {
    issues.push({
      id: 'MULTI_ENTRY',
      severity: 'hint',
      code: 'MULTI_ENTRY',
      message: `剧情有 ${entryList.length} 个入口，预览时可选择起点`,
    });
  }

  const cycles = findCycles(story);
  for (const cycle of cycles) {
    issues.push({
      id: `CYCLE:${cycle.nodeIds.join('>')}`,
      severity: 'hint',
      code: 'CYCLE',
      message: `检测到循环路径（${cycle.nodeIds.length} 个节点），运行时会限制重复访问次数`,
      nodeIds: cycle.nodeIds,
      nodeId: cycle.nodeIds[0],
    });
  }

  const merges = [];
  for (const [nodeId, sources] of incoming) {
    if (sources.size > 1) merges.push({ nodeId, sources: [...sources] });
  }

  const translations = buildTranslationReport(story);

  for (const report of translations) {
    if (report.missingCount > 0) {
      issues.push({
        id: `MISSING_TRANSLATION:${report.locale}`,
        severity: 'warning',
        code: 'MISSING_TRANSLATION',
        message: `${report.label}（${report.locale}）缺少 ${report.missingCount} 条翻译`,
        locale: report.locale,
      });
    }
    if (report.staleCount > 0) {
      issues.push({
        id: `STALE_TRANSLATION:${report.locale}`,
        severity: 'hint',
        code: 'STALE_TRANSLATION',
        message: `${report.label}（${report.locale}）有 ${report.staleCount} 条译文在原文修改后待复核`,
        locale: report.locale,
      });
    }
  }

  issues.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);

  const byNode = {};
  for (const issue of issues) {
    if (!issue.nodeId) continue;
    if (!byNode[issue.nodeId]) byNode[issue.nodeId] = [];
    byNode[issue.nodeId].push(issue);
  }

  const summary = {
    errors: issues.filter((issue) => issue.severity === 'error').length,
    warnings: issues.filter((issue) => issue.severity === 'warning').length,
    hints: issues.filter((issue) => issue.severity === 'hint').length,
    missingTranslations: translations.reduce((total, item) => total + item.missingCount, 0),
    staleTranslations: translations.reduce((total, item) => total + item.staleCount, 0),
  };

  return {
    issues,
    byNode,
    cycles,
    merges,
    reachable,
    entryList,
    translations,
    summary,
    stats: {
      nodes: story.nodes.length,
      choices: story.nodes.reduce((total, node) => total + node.choices.length, 0),
      edges: edges.length,
      entries: entryList.length,
      merges: merges.length,
      cycles: cycles.length,
      locales: localeList(story).length,
      variables: story.variables.length,
      characters: story.characters.length,
    },
  };
}

/** Tarjan 强连通分量；大小 > 1 或自环即为循环路径。 */
export function findCycles(story) {
  const adjacency = new Map();
  for (const node of story.nodes) {
    const targets = [];
    if (node.next) targets.push(node.next);
    for (const choice of node.choices) if (choice.target) targets.push(choice.target);
    adjacency.set(node.id, targets.filter((id) => story.nodes.some((item) => item.id === id)));
  }

  let index = 0;
  const indices = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const result = [];

  function strongConnect(id) {
    indices.set(id, index);
    low.set(id, index);
    index += 1;
    stack.push(id);
    onStack.add(id);
    for (const target of adjacency.get(id) || []) {
      if (!indices.has(target)) {
        strongConnect(target);
        low.set(id, Math.min(low.get(id), low.get(target)));
      } else if (onStack.has(target)) {
        low.set(id, Math.min(low.get(id), indices.get(target)));
      }
    }
    if (low.get(id) === indices.get(id)) {
      const component = [];
      let current;
      do {
        current = stack.pop();
        onStack.delete(current);
        component.push(current);
      } while (current !== id);
      const selfLoop = component.length === 1 && (adjacency.get(component[0]) || []).includes(component[0]);
      if (component.length > 1 || selfLoop) {
        result.push({ nodeIds: component, selfLoop });
      }
    }
  }

  for (const node of story.nodes) {
    if (!indices.has(node.id)) strongConnect(node.id);
  }
  return result;
}

/**
 * 一条“条目”= 节点台词 / 选项 / 角色名。
 * 只把原文有内容的条目录入翻译任务，避免空条目污染统计。
 */
export function buildTranslationReport(story) {
  const source = defaultLocale(story);
  const items = [];

  for (const character of story.characters) {
    if (hasText(character.name, source)) {
      items.push({
        key: `character:${character.id}`,
        kind: 'character',
        characterId: character.id,
        label: getText(character.name, source),
        sourceText: getText(character.name, source),
        map: character.name,
        stale: character.staleLocales || [],
      });
    }
  }

  for (const node of story.nodes) {
    if (hasText(node.text, source)) {
      items.push({
        key: `node:${node.id}`,
        kind: 'node-text',
        nodeId: node.id,
        label: node.title,
        sourceText: getText(node.text, source),
        map: node.text,
        stale: node.staleLocales || [],
      });
    }
    for (const choice of node.choices) {
      if (hasText(choice.text, source)) {
        items.push({
          key: `choice:${choice.id}`,
          kind: 'choice',
          nodeId: node.id,
          choiceId: choice.id,
          label: `${node.title} · 选项`,
          sourceText: getText(choice.text, source),
          map: choice.text,
          stale: choice.staleLocales || [],
        });
      }
    }
  }

  return story.locales
    .filter((locale) => locale.code !== source)
    .map((locale) => {
      const missing = [];
      const stale = [];
      for (const item of items) {
        if (!hasText(item.map, locale.code)) {
          missing.push(item);
        } else if (item.stale.includes(locale.code)) {
          stale.push(item);
        }
      }
      return {
        locale: locale.code,
        label: locale.label,
        total: items.length,
        missingCount: missing.length,
        staleCount: stale.length,
        translatedCount: items.length - missing.length,
        missing,
        stale,
        items,
      };
    });
}

export function issuesForNode(report, nodeId) {
  return report.byNode[nodeId] || [];
}

export function nodeIssueLevel(report, nodeId) {
  const list = issuesForNode(report, nodeId);
  if (list.some((issue) => issue.severity === 'error')) return 'error';
  if (list.some((issue) => issue.severity === 'warning')) return 'warning';
  if (list.length) return 'hint';
  return null;
}

export { NODE_TYPES };
