import { h, clear, formatValue } from '../dom.js';
import { StoryRuntime } from '../runtime.js';
import { localeList } from '../story.js';

/**
 * 可试玩预览。所有状态保存在 StoryRuntime 里；
 * 重新开始 = 新建 runtime，变量回到初始值、历史清空。
 */
export function mountPreview(root, store) {
  const elements = {
    panel: root.querySelector('#preview-panel'),
    stage: root.querySelector('#preview-stage'),
    variables: root.querySelector('#preview-variables'),
    history: root.querySelector('#preview-history'),
    meta: root.querySelector('#preview-meta'),
    entry: root.querySelector('#preview-entry'),
    locale: root.querySelector('#preview-locale'),
    stepCount: root.querySelector('#preview-step-count'),
    restart: root.querySelector('#btn-preview-restart'),
    close: root.querySelector('#btn-preview-close'),
  };

  let runtime = null;
  let open = false;
  let entryOverride = '';

  function refreshEntryOptions() {
    const previous = entryOverride || store.previewEntryId || elements.entry.value;
    clear(elements.entry);
    const options = store.entryOptions();
    const overrideNode =
      entryOverride && !options.some((item) => item.nodeId === entryOverride)
        ? store.story.nodes.find((node) => node.id === entryOverride)
        : null;
    if (overrideNode) {
      options.unshift({ nodeId: overrideNode.id, name: `${overrideNode.title}（临时起点）`, isStart: false });
    }
    for (const item of options) {
      elements.entry.appendChild(
        h('option', { value: item.nodeId }, `${item.isStart ? '★ ' : ''}${item.name}`),
      );
    }
    if (options.some((item) => item.nodeId === previous)) elements.entry.value = previous;
    if (!elements.entry.value && options.length) elements.entry.value = options[0].nodeId;
  }

  function refreshLocaleOptions() {
    const previous = elements.locale.value;
    clear(elements.locale);
    for (const locale of store.story.locales) {
      elements.locale.appendChild(h('option', { value: locale.code }, locale.label || locale.code));
    }
    elements.locale.value = localeList(store.story).includes(store.previewLocale)
      ? store.previewLocale
      : localeList(store.story).includes(previous)
        ? previous
        : store.previewLocale;
    store.previewLocale = elements.locale.value || store.previewLocale;
  }

  /** 结构签名：节点、选项、连线或入口变化时预览需要重置；只改文案则保留进度。 */
  function structureSignature() {
    const story = store.story;
    const parts = [story.startNodeId];
    for (const node of story.nodes) {
      parts.push(`${node.id}:${node.entry ? 1 : 0}:${node.next}`);
      for (const choice of node.choices) {
        parts.push(`${choice.id}>${choice.target}`);
      }
    }
    return parts.join('|');
  }

  let lastSignature = '';

  function start() {
    if (entryOverride && !store.story.nodes.some((node) => node.id === entryOverride)) entryOverride = '';
    refreshEntryOptions();
    refreshLocaleOptions();
    lastSignature = structureSignature();
    const candidate = entryOverride || elements.entry.value;
    const entryNodeId = candidate && store.story.nodes.some((node) => node.id === candidate)
      ? candidate
      : store.story.startNodeId;
    store.previewEntryId = entryNodeId;
    runtime = new StoryRuntime(store.story, {
      entryNodeId,
      locale: elements.locale.value || store.previewLocale,
      maxSteps: store.story.settings.maxSteps,
      maxVisitsPerNode: store.story.settings.maxVisitsPerNode,
    });
    render();
  }

  function render() {
    if (!runtime) return;
    const snap = runtime.snapshot();
    elements.meta.textContent = `· ${snap.step} 步 · 上限 ${snap.maxSteps} 步 / 单节点 ${snap.maxVisitsPerNode} 次`;
    renderStage(snap);
    renderVariables(snap);
    renderHistory(snap);
  }

  function renderStage(snap) {
    clear(elements.stage);

    const lines = snap.history.slice(-14);
    for (const item of lines) {
      const isCurrent = item.index === snap.history.length - 1;
      const node = store.story.nodes.find((entry) => entry.id === item.nodeId);
      const character = store.story.characters.find((entry) => entry.id === item.characterId);
      const color = character?.color || '#8a94a6';
      const name = item.speaker || '旁白';
      const showChoices =
        isCurrent &&
        snap.current?.choices?.length &&
        !snap.current?.autoAdvance &&
        (!snap.ended || snap.ended.reason === 'no-available-choice');

      const textIsEmpty = !item.text?.trim();
      const speakerText = h(
        'div',
        { class: 'story-speaker' },
        h('span', { text: name }),
        h('span', { class: 'node-ref', text: node?.title || item.title }),
        item.chosen
          ? h('span', { class: 'node-ref', style: { borderColor: 'rgba(217,165,95,0.4)', color: '#dcb27c' } }, `选择了：${item.chosen.text || '（继续）'}`)
          : null,
      );

      const bubble = h(
        'div',
        { class: 'story-line' },
        h(
          'div',
          { class: 'story-avatar', style: { background: color } },
          (name || '旁').slice(0, 1),
        ),
        h(
          'div',
          { class: 'story-bubble' },
          speakerText,
          h(
            'div',
            {
              class: `story-text${textIsEmpty ? ' placeholder' : ''}`,
              text: textIsEmpty ? `（当前语言 ${snap.locale} 没有文本，请补充翻译）` : item.text,
            },
          ),
          item.onEnterChanges?.length
            ? h(
                'div',
                { class: 'fx-tags' },
                item.onEnterChanges.map((change) =>
                  h('span', { class: `fx-tag ${change.op === 'add' ? 'up' : ''}` }, `${change.name}: ${formatValue(change.from)} → ${formatValue(change.to)}`),
                ),
              )
            : null,
          item.variablesAfterChoice && item.chosen?.changes?.length
            ? h(
                'div',
                { class: 'fx-tags' },
                item.chosen.changes.map((change) =>
                  h('span', { class: 'fx-tag up' }, `${change.name}: ${formatValue(change.from)} → ${formatValue(change.to)}`),
                ),
              )
            : null,
        ),
      );

      elements.stage.appendChild(bubble);

      if (showChoices) {
        const list = h('div', { class: 'choice-list' });
        for (const choice of snap.current.choices) {
          const button = h(
            'button',
            {
              class: `choice-btn${choice.available ? '' : ' locked'}`,
              title: choice.available ? '' : choice.error || '条件不满足',
              onclick: () => {
                if (!choice.available) return;
                runtime.choose(choice.id);
                render();
              },
            },
            h('span', { class: 'arrow', text: choice.available ? '›' : '🔒' }),
            h('span', { class: 'label', text: choice.text || '（缺少文本）' }),
            !choice.available
              ? h('span', { class: 'reason', text: choice.error || (choice.condition ? `条件不满足：${choice.condition}` : '当前不可选') })
              : choice.condition
                ? h('span', { class: 'reason', text: `if ${choice.condition}` })
                : null,
          );
          button.disabled = !choice.available;
          list.appendChild(button);
        }
        elements.stage.appendChild(list);
      }

      if (isCurrent && snap.current?.autoAdvance && !snap.ended) {
        elements.stage.appendChild(
          h(
            'div',
            { class: 'preview-end' },
            h('span', { text: '↳' }),
            h('span', { class: 'grow', text: '自动继续到下一节点' }),
            h('button', {
              class: 'btn small primary',
              text: '继续',
              onclick: () => {
                runtime.advance();
                render();
              },
            }),
          ),
        );
      }
    }

    if (snap.ended) {
      const ending = snap.ended;
      const kind =
        ending.reason === 'end' ? 'end' : ending.reason === 'loop-blocked' || ending.reason === 'max-steps' ? 'loop' : 'err';
      const icon = kind === 'end' ? '◈' : kind === 'loop' ? '⟳' : '⚠';
      elements.stage.appendChild(
        h(
          'div',
          { class: `preview-end ${kind}` },
          h('span', { text: icon }),
          h(
            'div',
            { class: 'grow' },
            h('div', { style: { fontWeight: 600, marginBottom: '2px' } }, ending.reason === 'end' ? '剧情结束' : '播放已停止'),
            h('div', { text: ending.message }),
            ending.reason === 'loop-blocked'
              ? h(
                  'div',
                  { style: { marginTop: '5px', fontSize: '11.5px', opacity: 0.85 } },
                  `「${store.story.nodes.find((node) => node.id === ending.nodeId)?.title || ending.nodeId}」被访问 ${ending.visits} 次（上限 ${ending.limit}）。可在「设置」里调整单节点访问上限。`,
                )
              : null,
          ),
          h('button', {
            class: 'btn small',
            text: '↺ 重新开始',
            onclick: () => {
              start();
            },
          }),
        ),
      );
    }

    requestAnimationFrame(() => {
      elements.stage.scrollTop = elements.stage.scrollHeight;
    });
  }

  function renderVariables(snap) {
    clear(elements.variables);
    const story = store.story;
    const names = story.variables.map((variable) => variable.name);
    if (!names.length) {
      elements.variables.appendChild(h('div', { class: 'var-empty', text: '这个剧情还没有定义变量' }));
      return;
    }
    // 显示所有已声明变量；未出现在运行时变量表里的标为“未设置”
    const table = h('div', { class: 'var-table' });
    for (const variable of story.variables) {
      const has = Object.prototype.hasOwnProperty.call(snap.variables, variable.name);
      const value = snap.variables[variable.name];
      const changed = changedRecently(snap.history, variable.name);
      table.appendChild(h('div', { class: 'k', title: variable.description || variable.name }, variable.name));
      table.appendChild(
        has
          ? h('div', { class: `v${changed ? ' changed' : ''}` }, formatValue(value))
          : h('div', { class: 'v' }, h('span', { class: 'unset', text: '未设置' })),
      );
    }
    elements.variables.appendChild(table);
  }

  function changedRecently(history, name) {
    const last = history[history.length - 1];
    if (!last) return false;
    if (last.onEnterChanges?.some((change) => change.name === name)) return true;
    if (last.chosen?.changes?.some((change) => change.name === name)) return true;
    return false;
  }

  function renderHistory(snap) {
    clear(elements.history);
    elements.stepCount.textContent = `${snap.history.length} 个`;
    if (!snap.history.length) {
      elements.history.appendChild(h('li', { class: 'var-empty', style: { padding: '4px' } }, '还没有经过任何节点'));
      return;
    }
    snap.history.forEach((item, index) => {
      const isCurrent = index === snap.history.length - 1;
      const changes = [
        ...(item.onEnterChanges || []),
        ...(item.chosen?.changes || []),
      ];
      const sub = changes.length
        ? changes.map((change) => `${change.name}→${formatValue(change.to)}`).join(' · ')
        : item.chosen?.text || (item.via?.kind === 'start' ? '起点' : '');
      elements.history.appendChild(
        h(
          'li',
          {
            class: `history-item${isCurrent ? ' current' : ' earlier'}`,
            onclick: () => {
              store.selectNode(item.nodeId);
            },
            title: '点击在图中定位该节点',
          },
          h('span', { class: 'history-step', text: String(index + 1).padStart(2, '0') }),
          h(
            'span',
            { class: 'history-main' },
            h('span', { class: 'history-title', text: item.title }),
            sub ? h('span', { class: 'history-sub', text: sub }) : null,
          ),
        ),
      );
    });
  }

  /* ---------------- 事件绑定 ---------------- */
  elements.restart.addEventListener('click', () => start());
  elements.close.addEventListener('click', () => closePreview());
  elements.entry.addEventListener('change', () => {
    store.previewEntryId = elements.entry.value;
    if (entryOverride && elements.entry.value !== entryOverride) entryOverride = '';
    start();
  });
  elements.locale.addEventListener('change', () => {
    store.setPreviewLocale(elements.locale.value);
    if (runtime) {
      runtime.setLocale(elements.locale.value);
      render();
    }
  });
  function openPreview() {
    open = true;
    elements.panel.hidden = false;
    entryOverride = '';
    start();
  }

  /** 从任意节点直接开始试玩（不必先标记为入口）。 */
  function openAt(nodeId) {
    if (!store.story.nodes.some((node) => node.id === nodeId)) return;
    entryOverride = nodeId;
    open = true;
    elements.panel.hidden = false;
    start();
  }

  function closePreview() {
    open = false;
    elements.panel.hidden = true;
    runtime = null;
    entryOverride = '';
  }

  function togglePreview() {
    if (open) closePreview();
    else openPreview();
  }

  function onStoryChanged() {
    if (!open || !runtime) return;
    // 结构变化（增删节点/选项/连线）才重置；仅改文案时保留当前进度重新渲染
    if (structureSignature() !== lastSignature) {
      start();
      return;
    }
    runtime.story = store.story;
    runtime.maxSteps = store.story.settings.maxSteps;
    runtime.maxVisitsPerNode = store.story.settings.maxVisitsPerNode;
    // 文案或条件可能被修改：刷新历史与当前节点的显示文本、选项可用性
    runtime.setLocale(runtime.locale);
    runtime.refreshChoices();
    render();
  }

  return {
    openPreview,
    openAt,
    closePreview,
    togglePreview,
    onStoryChanged,
    get isOpen() {
      return open;
    },
    restart: start,
  };
}
