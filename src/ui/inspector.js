import { h, clear } from '../dom.js';
import { compileCondition } from '../expression.js';
import {
  NODE_TYPES,
  VARIABLE_TYPES,
  choiceColor,
  defaultLocale,
  getText,
  hasText,
  localeLabel,
  localeList,
} from '../story.js';

/* ------------------------------ 通用小块 ------------------------------ */

export function field(label, control, extra) {
  return h('label', { class: 'field' }, h('span', { text: label }), control, extra || null);
}

export function localeChip(code, isSource) {
  return h('span', { class: `locale-chip${isSource ? ' source' : ''}`, text: isSource ? `${code} · 原文` : code });
}

export function issueIcon(severity) {
  const map = { error: '✕', warning: '!', hint: 'i' };
  return h('span', { class: 'ico', text: map[severity] || '·' });
}

export function issueList(issues, { onJump } = {}) {
  if (!issues.length) return null;
  return h(
    'div',
    { class: 'issue-list' },
    issues.map((issue) =>
      h(
        'div',
        { class: `issue ${issue.severity}`, title: issue.message },
        issueIcon(issue.severity),
        h(
          'div',
          { class: 'body' },
          issue.message,
          onJump && issue.nodeId
            ? h('span', {
                class: 'jump',
                text: '定位',
                onclick: (event) => {
                  event.stopPropagation();
                  onJump(issue);
                },
              })
            : null,
        ),
      ),
    ),
  );
}

/**
 * 单语言文本输入。
 * 每个语言一个独立控件、独立写模型，修改原文永远不会清空或覆盖译文。
 * 输入过程中实时写模型（不重建界面），失焦时合并为一条撤销记录。
 */
export function localeTextArea({
  map,
  locale,
  sourceLocale,
  staleLocales = [],
  rows = 2,
  placeholder,
  onLive,
  onBegin,
  onFinish,
  label,
  kind = 'text',
  choiceId = '',
  showMissing = true,
}) {
  const isSource = locale === sourceLocale;
  const value = getText(map, locale);
  const missing = !isSource && !hasText(map, locale);
  const stale = (staleLocales || []).includes(locale);

  const textarea = h('textarea', {
    class: `textarea locale-area${isSource ? ' source' : ''}`,
    rows,
    placeholder: placeholder || (isSource ? '写下这段文字…' : '还没有翻译（运行时回退到原文）'),
    spellcheck: false,
    onfocus: () => onBegin?.(),
    oninput: (event) => onLive?.(event.target.value),
    onblur: () => onFinish?.(),
  });
  textarea.value = value;

  const head = h(
    'div',
    { class: 'text-head' },
    h(
      'span',
      { class: 'locale' },
      h('span', { text: label || (isSource ? '原文' : '译文') }),
      localeChip(locale, isSource),
      stale ? h('span', { class: 'stale-tag', title: '原文已修改，建议复核此译文' }, '待复核') : null,
    ),
    showMissing && missing ? h('span', { class: 'missing-tag' }, '缺少翻译') : null,
  );

  const block = h(
    'div',
    {
      class: 'text-block',
      dataset: { locale, kind, choice: choiceId, source: isSource ? '1' : '' },
    },
    head,
    textarea,
  );
  block.__head = head;
  return block;
}

/**
 * 就地刷新检查器里的“待复核 / 缺少翻译”标记。
 * 不重建 DOM，因此不会打断正在进行的输入，也不会吞掉按钮点击。
 */
export function refreshInspectorTags(container, store, node) {
  if (!container || !node) return;
  const source = defaultLocale(store.story);
  for (const block of container.querySelectorAll('.text-block[data-kind]')) {
    const kind = block.dataset.kind;
    const locale = block.dataset.locale;
    const isSource = Boolean(block.dataset.source);
    // 角色名覆盖不参与翻译统计，也不随正文标记待复核
    if (isSource || locale === source || kind === 'node-speaker') continue;
    let map = null;
    let staleList = [];
    if (kind === 'node-text') {
      map = node.text;
      staleList = node.staleLocales || [];
    } else if (kind === 'choice-text') {
      const choice = node.choices.find((item) => item.id === block.dataset.choice);
      if (choice) {
        map = choice.text;
        staleList = choice.staleLocales || [];
      }
    }
    if (!map) continue;
    const head = block.__head;
    if (!head) continue;
    const localeSpan = head.querySelector('.locale');

    const staleTag = localeSpan?.querySelector('.stale-tag');
    const stale = staleList.includes(locale);
    if (stale && !staleTag && localeSpan) {
      localeSpan.appendChild(h('span', { class: 'stale-tag', title: '原文已修改，建议复核此译文' }, '待复核'));
    } else if (!stale && staleTag) {
      staleTag.remove();
    }

    const missingTag = head.querySelector('.missing-tag');
    const missing = !hasText(map, locale);
    if (missing && !missingTag) {
      head.appendChild(h('span', { class: 'missing-tag' }, '缺少翻译'));
    } else if (!missing && missingTag) {
      missingTag.remove();
    }
  }
}

function speakerName(store, character) {
  if (!character) return '';
  return (
    getText(character.name, store.editLocale) ||
    getText(character.name, defaultLocale(store.story)) ||
    character.id
  );
}

/* ------------------------------ 效果编辑器 ------------------------------ */

export function effectEditor({ store, nodeId, choiceId, effects }) {
  const variables = store.story.variables;
  const rows = effects.map((effect) => {
    const variable = variables.find((item) => item.id === effect.variableId);
    const varSelect = h(
      'select',
      {
        class: 'select',
        title: '变量',
        onchange: (event) => store.updateEffect(nodeId, choiceId, effect.id, { variableId: event.target.value }),
      },
      h('option', { value: '' }, '选择变量…'),
      variables.map((item) =>
        h('option', { value: item.id, selected: item.id === effect.variableId }, `${item.name}（${VARIABLE_TYPES[item.type]?.label || item.type}）`),
      ),
    );
    const opSelect = h(
      'select',
      {
        class: 'select',
        title: '操作',
        onchange: (event) => store.updateEffect(nodeId, choiceId, effect.id, { op: event.target.value }),
      },
      h('option', { value: 'set', selected: effect.op === 'set' }, '设为'),
      h('option', { value: 'add', selected: effect.op === 'add' }, '增加'),
    );
    const valueInput = h('input', {
      class: 'input',
      value: effect.value,
      placeholder:
        variable?.type === 'boolean' ? 'true / false' : variable?.type === 'number' ? '数字' : '文本',
      onfocus: () => store.beginEdit(),
      oninput: (event) => {
        effect.value = event.target.value;
        store.touch();
      },
      onblur: () => store.finishEdit('effect:value'),
    });
    return h(
      'div',
      { class: 'effect-row' },
      varSelect,
      opSelect,
      valueInput,
      h('button', {
        class: 'icon-btn danger',
        title: '删除赋值',
        text: '✕',
        onclick: () => store.deleteEffect(nodeId, choiceId, effect.id),
      }),
    );
  });

  return h(
    'div',
    null,
    rows.length ? h('div', { class: 'form-grid' }, rows) : h('div', { class: 'empty-mini' }, '还没有赋值操作'),
    h('button', {
      class: 'btn small ghost',
      style: { marginTop: '6px' },
      text: '＋ 添加赋值',
      onclick: () => store.addEffect(nodeId, choiceId),
    }),
  );
}

/* ------------------------------ 条件输入 ------------------------------ */

export function conditionEditor({ store, node, choice }) {
  const variables = store.story.variables;
  const status = h('div', { class: 'cond-status' });

  const updateStatus = (source) => {
    clear(status);
    status.className = 'cond-status';
    if (!source.trim()) {
      status.appendChild(h('span', { class: 'cond-help' }, '空条件 = 总是可选'));
      return;
    }
    const compiled = compileCondition(source);
    if (!compiled.ok) {
      status.className = 'cond-status err';
      status.appendChild(h('span', {}, `✕ ${compiled.error}`));
      return;
    }
    const unknown = [...compiled.identifiers].filter((name) => !variables.some((item) => item.name === name));
    const unset = [...compiled.identifiers].filter((name) => variables.find((item) => item.name === name)?.hasInitial === false);
    if (unknown.length) {
      status.className = 'cond-status err';
      status.appendChild(h('span', {}, `✕ 未定义的变量：${unknown.join('、')}`));
      return;
    }
    status.className = 'cond-status ok';
    const used = [...compiled.identifiers];
    status.appendChild(h('span', {}, used.length ? `✓ 语法正确 · ${used.join('、')}` : '✓ 语法正确'));
    if (unset.length) {
      status.appendChild(h('span', { class: 'cond-help' }, `⚠ ${unset.join('、')} 没有初始值`));
    }
  };

  const input = h('input', {
    class: 'input mono',
    value: choice.condition || '',
    placeholder: '例如：信任 >= 2 && 持有钥匙',
    onfocus: () => store.beginEdit(),
    oninput: (event) => {
      const value = event.target.value;
      choice.condition = value;
      updateStatus(value);
      store.touch();
    },
    onblur: () => {
      store.finishEdit('choice:condition');
      updateStatus(choice.condition || '');
    },
  });
  updateStatus(choice.condition || '');

  const chips = variables.slice(0, 8).map((variable) =>
    h('button', {
      class: 'btn small ghost',
      style: { padding: '1px 6px', fontSize: '10.5px' },
      text: variable.name,
      title: `插入变量 ${variable.name}`,
      onclick: () => {
        const value = input.value.trim() ? `${input.value.trim()} ${variable.name}` : variable.name;
        input.value = value;
        store.beginEdit();
        choice.condition = value;
        store.touch();
        store.finishEdit('choice:condition');
        updateStatus(value);
        input.focus();
      },
    }),
  );

  return h(
    'div',
    null,
    input,
    status,
    variables.length
      ? h(
          'div',
          { class: 'cond-status', style: { flexWrap: 'wrap', marginTop: '2px' } },
          h('span', { class: 'cond-help' }, '插入变量：'),
          chips,
        )
      : h('div', { class: 'cond-help', text: '还没有变量。先在左侧「变量」页创建，条件才有意义。' }),
  );
}

/* ------------------------------ 文本编辑 wiring ------------------------------ */

/** 生成一个绑定到 store 的文本块：输入实时写模型，失焦合并撤销并刷新检查。 */
function editableTextBlock(store, { apply, editGroup = 'text:edit', ...options }) {
  return localeTextArea({
    ...options,
    onBegin: () => store.beginEdit(),
    onLive: (value) => apply(value, { live: true }),
    onFinish: () => store.finishEdit(editGroup),
  });
}

/* ------------------------------ 节点检查器 ------------------------------ */

export function nodeInspector({ store }) {
  const node = store.selectedNode;
  if (!node) return null;

  const story = store.story;
  const source = defaultLocale(story);
  const editLocale = store.editLocale;
  const report = store.report;
  const isEnd = node.type === 'end';
  const isStart = node.id === story.startNodeId;

  const allIssues = report.byNode[node.id] || [];
  const nodeIssues = allIssues.filter((issue) => !issue.choiceId);
  const choiceIssueCounts = new Map();
  for (const issue of allIssues) {
    if (!issue.choiceId) continue;
    choiceIssueCounts.set(issue.choiceId, (choiceIssueCounts.get(issue.choiceId) || 0) + 1);
  }

  const targetOptions = (value, placeholder = '（不连接）') => [
    h('option', { value: '' }, placeholder),
    story.nodes.map((item) =>
      h(
        'option',
        { value: item.id, selected: item.id === value },
        `${item.title} · ${NODE_TYPES[item.type]?.label || ''}${item.id === node.id ? '（本节点）' : ''}`,
      ),
    ),
  ];

  /* ---------------- 标题 ---------------- */
  const titleInput = h('input', {
    class: 'node-title-input',
    value: node.title,
    'aria-label': '节点标题',
    onfocus: () => store.beginEdit(),
    oninput: (event) => {
      const value = event.target.value;
      if (value.trim()) {
        node.title = value;
        store.touch();
      }
    },
    onblur: (event) => {
      const value = event.target.value.trim();
      if (!value) event.target.value = node.title;
      else node.title = value;
      store.finishEdit('node:title');
    },
    onkeydown: (event) => {
      if (event.key === 'Enter') event.target.blur();
    },
  });

  /* ---------------- 基本信息 ---------------- */
  const typeSelect = h(
    'select',
    { class: 'select', onchange: (event) => store.setNodeType(node.id, event.target.value) },
    Object.entries(NODE_TYPES).map(([value, meta]) => h('option', { value, selected: node.type === value }, meta.label)),
  );

  const characterSelect = h(
    'select',
    { class: 'select', onchange: (event) => store.updateNode(node.id, { characterId: event.target.value }) },
    h('option', { value: '' }, '（无角色 / 旁白）'),
    story.characters.map((character) =>
      h('option', { value: character.id, selected: character.id === node.characterId }, speakerName(store, character) || character.id),
    ),
  );

  const entryCheck = h('input', {
    type: 'checkbox',
    checked: node.entry,
    onchange: (event) => store.toggleEntry(node.id, event.target.checked),
  });

  const entryLabelInput = h('input', {
    class: 'input',
    value: node.entryLabel || '',
    placeholder: '入口显示名称（可留空）',
    disabled: !node.entry,
    onfocus: () => store.beginEdit(),
    oninput: (event) => {
      node.entryLabel = event.target.value;
      store.touch();
    },
    onblur: () => store.finishEdit('node:entry-label'),
  });

  /* ---------------- 多语言文本：原文 + 当前编辑语言 ---------------- */
  const textBlocks = [
    editableTextBlock(store, {
      map: node.text,
      locale: source,
      sourceLocale: source,
      staleLocales: node.staleLocales,
      rows: 3,
      label: '台词 / 旁白',
      kind: 'node-text',
      editGroup: 'node:text',
      apply: (value, options) => store.setNodeText(node.id, source, value, options),
    }),
  ];
  if (editLocale !== source) {
    textBlocks.push(
      editableTextBlock(store, {
        map: node.text,
        locale: editLocale,
        sourceLocale: source,
        staleLocales: node.staleLocales,
        rows: 3,
        label: `翻译 · ${localeLabel(story, editLocale)}`,
        kind: 'node-text',
        editGroup: 'node:text',
        apply: (value, options) => store.setNodeText(node.id, editLocale, value, options),
      }),
    );
  } else if (localeList(story).length === 1) {
    textBlocks.push(
      h('div', { class: 'hint-box' }, '当前只有一种语言。在「设置 → 语言」中添加语言后才能录入翻译。'),
    );
  }

  const speakerBlocks = [
    editableTextBlock(store, {
      map: node.speaker,
      locale: source,
      sourceLocale: source,
      rows: 1,
      label: '角色名覆盖（原文）',
      placeholder: '留空则使用所选角色的名字',
      kind: 'node-speaker',
      editGroup: 'node:speaker',
      showMissing: false,
      apply: (value, options) => store.setNodeSpeaker(node.id, source, value, options),
    }),
  ];
  if (editLocale !== source) {
    speakerBlocks.push(
      editableTextBlock(store, {
        map: node.speaker,
        locale: editLocale,
        sourceLocale: source,
        rows: 1,
        label: `角色名覆盖 · ${localeLabel(story, editLocale)}`,
        placeholder: '留空则回退原文',
        kind: 'node-speaker',
        editGroup: 'node:speaker',
        showMissing: false,
        apply: (value, options) => store.setNodeSpeaker(node.id, editLocale, value, options),
      }),
    );
  }

  /* ---------------- 选项 ---------------- */
  const choicesSection = h(
    'div',
    { class: 'inspector-section' },
    h(
      'div',
      { class: 'section-title' },
      h('span', {}, `选项${node.choices.length ? ` · ${node.choices.length}` : ''}`),
      h(
        'span',
        { class: 'actions' },
        h('button', {
          class: 'btn small ghost',
          text: '＋ 选项',
          onclick: () => store.addChoice(node.id),
        }),
      ),
    ),
    node.choices.length
      ? node.choices.map((choice, index) => choiceCard({ store, node, choice, index, choiceIssueCounts }))
      : h('div', { class: 'empty-mini', text: isEnd ? '结局节点不需要选项' : '没有选项时走默认出口' }),
  );

  /* ---------------- 默认出口 ---------------- */
  const nextSelect = h(
    'select',
    {
      class: 'select',
      disabled: isEnd,
      onchange: (event) => store.setNodeNext(node.id, event.target.value),
    },
    targetOptions(node.next),
  );
  const nextSection = h(
    'div',
    { class: 'inspector-section' },
    h(
      'div',
      { class: 'section-title' },
      h('span', {}, '默认出口'),
      h(
        'span',
        { class: 'muted', style: { fontSize: '10.5px', textTransform: 'none', letterSpacing: '0' } },
        '没有可用选项时自动继续',
      ),
    ),
    field('下一节点', nextSelect),
    node.next && !story.nodes.some((item) => item.id === node.next)
      ? h('div', { class: 'target-missing', text: '⚠ 目标节点不存在，请重新选择' })
      : null,
    isEnd ? h('div', { class: 'hint-box', text: '结局节点会结束播放，出口会被忽略。' }) : null,
  );
  /* ---------------- 进入赋值 ---------------- */
  const onEnterSection = h(
    'div',
    { class: 'inspector-section' },
    h(
      'div',
      { class: 'section-title' },
      h('span', {}, '进入节点时赋值'),
      h(
        'span',
        { class: 'muted', style: { fontSize: '10.5px', textTransform: 'none', letterSpacing: '0' } },
        '在显示选项之前执行',
      ),
    ),
    effectEditor({ store, nodeId: node.id, choiceId: null, effects: node.onEnter }),
  );

  /* ---------------- 备注 ---------------- */
  const notesInput = h('textarea', {
    class: 'textarea',
    rows: 2,
    placeholder: '给编剧的备注，不会导出到游戏',
    onfocus: () => store.beginEdit(),
    oninput: (event) => {
      node.notes = event.target.value;
      store.touch();
    },
    onblur: () => store.finishEdit('node:notes'),
  });
  notesInput.value = node.notes || '';

  return h(
    'div',
    null,
    h(
      'div',
      { class: 'inspector-header' },
      h('div', { class: 'titles' }, titleInput, h('div', { class: 'node-id', text: node.id })),
      h('button', {
        class: 'icon-btn',
        title: '复制节点',
        text: '⧉',
        onclick: () => store.duplicateNode(node.id),
      }),
      h('button', {
        class: 'icon-btn danger',
        title: '删除节点',
        text: '🗑',
        onclick: () => {
          if (confirm(`删除节点「${node.title}」？指向它的连线会被断开。`)) store.deleteNode(node.id);
        },
      }),
    ),

    h(
      'div',
      { class: 'inspector-section' },
      h('div', { class: 'form-row' }, field('节点类型', typeSelect), field('角色', characterSelect)),
      h(
        'div',
        { style: { marginTop: '10px' } },
        textBlocks,
        speakerBlocks,
        h('label', { class: 'check-row' }, entryCheck, h('span', { text: '作为额外入口（可在预览中直接开始）' })),
        node.entry ? h('div', { style: { marginTop: '8px' } }, entryLabelInput) : null,
        h(
          'div',
          { style: { marginTop: '10px' } },
          isStart
            ? h('div', { class: 'hint-box', text: '这是默认开始节点：运行、导出和「开始」入口都从这里起步。' })
            : h('button', {
                class: 'btn small ghost',
                text: '设为默认开始节点',
                onclick: () => store.setStartNode(node.id),
              }),
        ),
      ),
    ),

    nodeIssues.length
      ? h('div', { class: 'inspector-section' }, h('div', { class: 'section-title' }, h('span', {}, '此节点的问题')), issueList(nodeIssues))
      : null,

    choicesSection,
    nextSection,
    onEnterSection,

    h(
      'div',
      { class: 'inspector-section' },
      h('div', { class: 'section-title' }, h('span', {}, '备注')),
      notesInput,
    ),
  );
}

function choiceCard({ store, node, choice, index, choiceIssueCounts }) {
  const story = store.story;
  const source = defaultLocale(story);
  const editLocale = store.editLocale;
  const problemCount = choiceIssueCounts.get(choice.id) || 0;
  const choiceIssues = (store.report.byNode[node.id] || []).filter((issue) => issue.choiceId === choice.id);

  const textBlocks = [
    editableTextBlock(store, {
      map: choice.text,
      locale: source,
      sourceLocale: source,
      staleLocales: choice.staleLocales,
      rows: 1,
      label: '选项文本',
      kind: 'choice-text',
      choiceId: choice.id,
      editGroup: 'choice:text',
      apply: (value, options) => store.setChoiceText(node.id, choice.id, source, value, options),
    }),
  ];
  if (editLocale !== source) {
    textBlocks.push(
      editableTextBlock(store, {
        map: choice.text,
        locale: editLocale,
        sourceLocale: source,
        staleLocales: choice.staleLocales,
        rows: 1,
        label: `翻译 · ${localeLabel(story, editLocale)}`,
        kind: 'choice-text',
        choiceId: choice.id,
        editGroup: 'choice:text',
        apply: (value, options) => store.setChoiceText(node.id, choice.id, editLocale, value, options),
      }),
    );
  }

  const targetSelect = h(
    'select',
    {
      class: 'select',
      onchange: (event) => store.updateChoice(node.id, choice.id, { target: event.target.value }),
    },
    h('option', { value: '' }, '选择目标节点…'),
    story.nodes.map((item) =>
      h('option', { value: item.id, selected: item.id === choice.target }, `${item.title} · ${NODE_TYPES[item.type]?.label || ''}${item.id === node.id ? '（本节点）' : ''}`),
    ),
  );

  return h(
    'div',
    { class: `choice-card${problemCount ? ' problem' : ''}` },
    h(
      'div',
      { class: 'choice-head' },
      h('span', { class: 'choice-index', style: { color: choiceColor(index) } }, String(index + 1).padStart(2, '0')),
      h('span', { class: 'choice-tag' }, '选项'),
      problemCount ? h('span', { class: 'badge err' }, `${problemCount} 个问题`) : h('span'),
      h('span', { class: 'spacer' }),
      h('button', {
        class: 'icon-btn',
        title: '上移',
        text: '↑',
        disabled: index === 0,
        onclick: () => store.moveChoice(node.id, choice.id, -1),
      }),
      h('button', {
        class: 'icon-btn',
        title: '下移',
        text: '↓',
        disabled: index === node.choices.length - 1,
        onclick: () => store.moveChoice(node.id, choice.id, 1),
      }),
      h('button', {
        class: 'icon-btn danger',
        title: '删除选项',
        text: '✕',
        onclick: () => store.deleteChoice(node.id, choice.id),
      }),
    ),
    h(
      'div',
      { class: 'choice-body' },
      choiceIssues.length ? issueList(choiceIssues) : null,
      ...textBlocks,
      field('连接目标', targetSelect),
      choice.target && !story.nodes.some((item) => item.id === choice.target)
        ? h('div', { class: 'target-missing', text: '⚠ 目标节点不存在' })
        : null,
      h('div', { class: 'field' }, h('span', { text: '触发条件' }), conditionEditor({ store, node, choice })),
      h(
        'div',
        { class: 'field' },
        h('span', { text: '选择后赋值' }),
        effectEditor({ store, nodeId: node.id, choiceId: choice.id, effects: choice.effects }),
      ),
    ),
  );
}
