import { checkCondition } from './expression.js';
import {
  clone,
  coerceValue,
  defaultLocale,
  findNode,
  findVariable,
  initialVariables,
  speakerFor,
} from './story.js';

/**
 * 可试玩运行时。
 * 规则：
 * - 进入节点时记录访问次数；超过 maxVisitsPerNode 判定为循环并停止，
 *   避免「A → B → A → B …」无限播放。
 * - 每次推进（进入节点）计入步数；超过 maxSteps 同样停止。
 * - 选项条件求值失败（语法错误 / 未设置变量）时该选项不可选，并记录原因。
 * - 没有可用选项时：若有默认出口则继续；否则结束（无出口 / 选项均不满足）。
 */

export class StoryRuntime {
  constructor(story, options = {}) {
    this.story = story;
    this.entryNodeId = options.entryNodeId || story.startNodeId;
    this.maxSteps = Number.isFinite(options.maxSteps) ? options.maxSteps : story.settings?.maxSteps ?? 200;
    this.maxVisitsPerNode = Number.isFinite(options.maxVisitsPerNode)
      ? options.maxVisitsPerNode
      : story.settings?.maxVisitsPerNode ?? 3;
    this.locale = options.locale || defaultLocale(story);
    this.maxSteps = Math.max(1, this.maxSteps);
    this.maxVisitsPerNode = Math.max(1, this.maxVisitsPerNode);
    this.reset();
  }

  /** 计算当前语言下各选项的显示文本与可用性。 */
  buildChoices(node) {
    return node.choices.map((choice) => {
      const text = this.pickText(choice.text);
      const source = choice.condition?.trim() || '';
      const condition = source ? checkCondition(source, this.variables) : { ok: true, value: true };
      let error = '';
      if (!condition.ok) error = condition.error;
      else if (!condition.value) error = `条件不满足：${source}`;
      return {
        id: choice.id,
        text,
        rawText: choice.text,
        condition: source,
        conditionOk: condition.ok,
        available: condition.ok && condition.value,
        error,
        target: choice.target,
        effectPreview: this.effectPreview(choice.effects),
      };
    });
  }

  /**
   * 编辑剧情后刷新当前节点选项（不重置进度、不新增历史）。
   * 返回快照。
   */
  refreshChoices() {
    if (!this.currentView || this.ended) return this.snapshot();
    const node = findNode(this.story, this.currentView.nodeId);
    if (!node) return this.snapshot();
    const built = this.buildChoices(node);
    this.currentView.choices = built;
    this.currentView.text = this.pickText(node.text);
    this.currentView.speaker = speakerFor(this.story, node, this.locale);
    const entry = this.currentView.entry;
    if (entry) {
      entry.choices = built;
      entry.text = this.currentView.text;
      entry.speaker = this.currentView.speaker;
    }
    return this.snapshot();
  }

  /** 重置到入口：变量回到初始值、历史与访问计数清空。 */
  reset() {
    this.variables = initialVariables(this.story);
    this.history = [];
    this.visits = new Map();
    this.step = 0;
    this.currentNodeId = null;
    this.currentView = null;
    this.pendingAuto = null;
    this.ended = null;
    this.loopBlocked = null;
    return this.start();
  }

  start() {
    if (!this.entryNodeId) {
      this.ended = { reason: 'no-entry', message: '剧情没有可用的入口' };
      return this.snapshot();
    }
    this.enter(this.entryNodeId, { kind: 'start' });
    return this.snapshot();
  }

  /** 进入节点；返回快照。 */
  enter(nodeId, via = { kind: 'auto' }) {
    if (this.ended) return this.snapshot();
    this.pendingAuto = null;
    const node = findNode(this.story, nodeId);
    if (!node) {
      this.ended = { reason: 'missing-node', message: '目标节点不存在', nodeId };
      this.currentNodeId = null;
      return this.snapshot();
    }
    if (this.step >= this.maxSteps) {
      this.ended = {
        reason: 'max-steps',
        message: `已推进 ${this.step} 步，达到步数上限（${this.maxSteps}）；请检查是否存在过长的循环`,
      };
      return this.snapshot();
    }

    const visits = (this.visits.get(nodeId) || 0) + 1;
    this.visits.set(nodeId, visits);
    if (visits > this.maxVisitsPerNode) {
      this.loopBlocked = { nodeId, visits, limit: this.maxVisitsPerNode };
      this.ended = {
        reason: 'loop-blocked',
        message: `节点「${node.title}」已第 ${visits} 次被访问，超过上限 ${this.maxVisitsPerNode}，已停止播放以避免死循环`,
        nodeId,
        visits,
        limit: this.maxVisitsPerNode,
      };
      return this.snapshot();
    }
    this.step += 1;
    this.currentNodeId = nodeId;

    const onEnterChanges = this.applyEffects(node.onEnter);
    const choices = this.buildChoices(node);

    const entry = {
      index: this.history.length,
      nodeId,
      title: node.title,
      type: node.type,
      speaker: speakerFor(this.story, node, this.locale),
      characterId: node.characterId,
      text: this.pickText(node.text),
      rawText: node.text,
      via,
      step: this.step,
      visits,
      onEnterChanges,
      choices,
      variables: clone(this.variables),
    };
    this.history.push(entry);

    const view = {
      nodeId,
      title: node.title,
      type: node.type,
      speaker: entry.speaker,
      text: entry.text,
      rawText: node.text,
      entry,
      choices,
      variables: clone(this.variables),
    };

    if (node.type === 'end') {
      view.terminal = true;
      this.ended = { reason: 'end', message: '到达结局节点', nodeId };
      this.currentView = view;
      return this.snapshot();
    }

    const available = choices.filter((choice) => choice.available);
    if (node.choices.length > 0) {
      if (available.length === 0) {
        // 所有选项都不满足：视情况走默认出口，否则结束
        if (node.next) {
          this.currentView = { ...view, autoAdvance: true };
          this.pendingAuto = node.next;
        } else {
          view.terminal = true;
          this.currentView = view;
          this.ended = {
            reason: 'no-available-choice',
            message: '所有选项的条件都不满足，且没有默认出口',
            nodeId,
          };
        }
      } else {
        this.currentView = view;
      }
      return this.snapshot();
    }

    if (node.next) {
      this.currentView = { ...view, autoAdvance: true };
      this.pendingAuto = node.next;
      return this.snapshot();
    }

    view.terminal = true;
    this.ended = { reason: 'no-exit', message: '节点没有出口，流程在此结束', nodeId };
    this.currentView = view;
    return this.snapshot();
  }

  /** 选择选项并进入目标节点。 */
  choose(choiceId) {
    if (this.ended) return this.snapshot();
    const view = this.currentView;
    if (!view) return this.snapshot();
    const choice = view.choices.find((item) => item.id === choiceId);
    if (!choice) return this.snapshot();
    if (!choice.available) {
      return this.snapshot();
    }
    const node = findNode(this.story, view.nodeId);
    const source = node?.choices.find((item) => item.id === choiceId);
    const changes = this.applyEffects(source?.effects || []);
    if (view.entry) {
      view.entry.chosen = { choiceId, text: choice.text, changes };
      view.entry.variablesAfterChoice = clone(this.variables);
    }
    if (!choice.target) {
      this.ended = { reason: 'no-target', message: '该选项没有连接目标节点', nodeId: view.nodeId };
      return this.snapshot();
    }
    this.enter(choice.target, { kind: 'choice', choiceId, text: choice.text });
    return this.snapshot();
  }

  /** 推进自动出口（无选项节点）。 */
  advance() {
    if (this.ended) return this.snapshot();
    if (this.pendingAuto) {
      const target = this.pendingAuto;
      this.pendingAuto = null;
      if (this.currentView?.entry) this.currentView.entry.chosen = { auto: true };
      this.enter(target, { kind: 'auto' });
      return this.snapshot();
    }
    return this.snapshot();
  }

  flushAuto() {
    if (this.pendingAuto) this.advance();
  }

  applyEffects(effects = []) {
    const changes = [];
    for (const effect of effects) {
      const variable = findVariable(this.story, effect.variableId);
      if (!variable) continue;
      const before = Object.prototype.hasOwnProperty.call(this.variables, variable.name)
        ? this.variables[variable.name]
        : undefined;
      let next;
      if (effect.op === 'add') {
        if (variable.type === 'string') {
          next = `${before ?? ''}${effect.value ?? ''}`;
        } else {
          const delta = Number(effect.value);
          next = (typeof before === 'number' ? before : Number(before) || 0) + (Number.isFinite(delta) ? delta : 0);
        }
      } else {
        next = coerceValue(effect.value, variable.type);
      }
      this.variables[variable.name] = next;
      changes.push({
        variableId: variable.id,
        name: variable.name,
        op: effect.op,
        from: before,
        to: next,
        type: variable.type,
      });
    }
    return changes;
  }

  effectPreview(effects = []) {
    return effects
      .map((effect) => {
        const variable = findVariable(this.story, effect.variableId);
        if (!variable) return null;
        return `${variable.name} ${effect.op === 'add' ? '+=' : '='} ${effect.value}`;
      })
      .filter(Boolean);
  }

  pickText(map) {
    if (!map || typeof map !== 'object') return '';
    const preferred = map[this.locale];
    if (typeof preferred === 'string' && preferred.trim()) return preferred;
    const fallback = map[defaultLocale(this.story)];
    if (typeof fallback === 'string') return fallback;
    const first = Object.values(map).find((value) => typeof value === 'string' && value.trim());
    return first || '';
  }

  setLocale(locale) {
    this.locale = locale;
    for (const entry of this.history) {
      const node = findNode(this.story, entry.nodeId);
      if (!node) continue;
      entry.speaker = speakerFor(this.story, node, locale);
      entry.text = this.pickText(node.text);
      for (const choice of entry.choices) {
        const source = node.choices.find((item) => item.id === choice.id);
        if (source) choice.text = this.pickText(source.text);
      }
    }
    if (this.currentView) {
      const node = findNode(this.story, this.currentView.nodeId);
      if (node) {
        this.currentView.speaker = speakerFor(this.story, node, locale);
        this.currentView.text = this.pickText(node.text);
        for (const choice of this.currentView.choices) {
          const source = node.choices.find((item) => item.id === choice.id);
          if (source) choice.text = this.pickText(source.text);
        }
      }
    }
    return this.snapshot();
  }

  snapshot() {
    return {
      variables: clone(this.variables),
      history: clone(this.history),
      step: this.step,
      visits: Object.fromEntries(this.visits),
      current: this.currentView ? clone(this.currentView) : null,
      ended: this.ended ? { ...this.ended } : null,
      loopBlocked: this.loopBlocked ? { ...this.loopBlocked } : null,
      canAdvance: Boolean(this.pendingAuto) && !this.ended,
      locale: this.locale,
      entryNodeId: this.entryNodeId,
      maxSteps: this.maxSteps,
      maxVisitsPerNode: this.maxVisitsPerNode,
    };
  }
}

export function createRuntime(story, options = {}) {
  return new StoryRuntime(story, options);
}
