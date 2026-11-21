import { h, clear } from '../dom.js';
import { VARIABLE_TYPES, defaultLocale, getText, localeList } from '../story.js';

export function renderSidebar(root, store) {
  clear(root);
  const tab = store.sidebarTab;
  if (tab === 'variables') root.appendChild(variablesTab(store));
  else if (tab === 'characters') root.appendChild(charactersTab(store));
  else root.appendChild(outlineTab(store));
}

function outlineTab(store) {
  const story = store.story;
  const report = store.report;
  const source = defaultLocale(story);
  const cycleNodes = new Set(report.cycles.flatMap((cycle) => cycle.nodeIds));
  const missingNodes = new Set();
  for (const item of report.translations) {
    if (item.locale === source) continue;
    for (const entry of item.missing) {
      if (entry.nodeId) missingNodes.add(entry.nodeId);
    }
  }

  const filter = h('input', {
    class: 'input',
    placeholder: '筛选节点…',
    oninput: (event) => {
      const query = event.target.value.trim().toLowerCase();
      for (const item of list.querySelectorAll('.outline-item')) {
        const match = !query || item.dataset.search.includes(query);
        item.style.display = match ? '' : 'none';
      }
    },
  });

  const list = h('div', { class: 'side-section' });

  for (const node of story.nodes) {
    const issues = report.byNode[node.id] || [];
    const hasError = issues.some((issue) => issue.severity === 'error');
    const hasWarning = issues.some((issue) => issue.severity === 'warning');
    const preview = getText(node.text, source) || getText(node.text, store.editLocale);
    const item = h(
      'div',
      {
        class: `outline-item${store.selection.nodeId === node.id ? ' active' : ''}`,
        dataset: { search: `${node.title} ${preview}`.toLowerCase(), nodeId: node.id },
        title: preview || node.title,
        onclick: () => store.selectNode(node.id),
      },
      h('span', { class: 'dot', style: { background: node.entry ? 'var(--blue)' : node.type === 'end' ? 'var(--violet)' : undefined } }),
      h('span', { class: 'name', text: node.title }),
      h(
        'span',
        { class: 'badges' },
        node.id === story.startNodeId ? h('span', { class: 'badge start' }, '始') : null,
        node.entry ? h('span', { class: 'badge entry' }, '入') : null,
        node.type === 'hub' ? h('span', { class: 'badge hub' }, '枢纽') : null,
        node.type === 'end' ? h('span', { class: 'badge end' }, '终') : null,
        cycleNodes.has(node.id) ? h('span', { class: 'badge cycle' }, '环') : null,
        missingNodes.has(node.id) ? h('span', { class: 'badge warn', title: '缺少翻译' }, '译') : null,
        hasError ? h('span', { class: 'badge err' }, '!') : hasWarning ? h('span', { class: 'badge warn' }, '!') : null,
      ),
    );
    list.appendChild(item);
  }

  return h(
    'div',
    null,
    h(
      'div',
      { class: 'side-section' },
      h(
        'div',
        { class: 'side-head' },
        h('span', {}, `节点 · ${story.nodes.length}`),
        h('button', { class: 'btn small ghost', text: '＋ 新建', onclick: () => store.addNode() }),
      ),
      filter,
      h('div', { style: { height: '8px' } }),
      story.nodes.length
        ? list
        : h('div', { class: 'empty-tip', text: '还没有节点，点击上方「＋ 新建」。' }),
    ),
    h(
      'div',
      { class: 'side-section' },
      h('div', { class: 'side-head' }, h('span', {}, '结构')),
      h(
        'div',
        { class: 'empty-tip', style: { padding: '2px 8px', lineHeight: '1.9' } },
        h('div', {}, `入口 ${report.stats.entries} · 汇合点 ${report.stats.merges} · 循环 ${report.stats.cycles}`),
        h(
          'div',
          {},
          `问题：${report.summary.errors} 错误 / ${report.summary.warnings} 警告 / ${report.summary.hints} 提示`,
        ),
        h('div', {}, `缺译 ${report.summary.missingTranslations} 条 · 待复核 ${report.summary.staleTranslations} 条`),
      ),
    ),
  );
}

function variablesTab(store) {
  const story = store.story;
  const report = store.report;
  const issueByVariable = new Map();
  for (const issue of report.issues) {
    if (issue.variableId) {
      if (!issueByVariable.has(issue.variableId)) issueByVariable.set(issue.variableId, []);
      issueByVariable.get(issue.variableId).push(issue);
    }
  }

  const cards = story.variables.map((variable) => {
    const issues = issueByVariable.get(variable.id) || [];
    const error = issues.some((issue) => issue.severity === 'error');
    const warn = issues.some((issue) => issue.severity === 'warning');

    const nameInput = h('input', {
      class: 'input',
      value: variable.name,
      onchange: (event) => {
        const ok = store.updateVariable(variable.id, { name: event.target.value.trim() });
        if (!ok) {
          event.target.value = variable.name;
          event.target.select();
        }
      },
    });

    const typeSelect = h(
      'select',
      { class: 'select', onchange: (event) => store.updateVariable(variable.id, { type: event.target.value }) },
      Object.entries(VARIABLE_TYPES).map(([value, meta]) =>
        h('option', { value, selected: variable.type === value }, meta.label),
      ),
    );

    const initialInput =
      variable.type === 'boolean'
        ? h(
            'select',
            {
              class: 'select',
              disabled: !variable.hasInitial,
              onchange: (event) => store.updateVariable(variable.id, { initial: event.target.value === 'true' }),
            },
            h('option', { value: 'false', selected: variable.initial === false }, '假 false'),
            h('option', { value: 'true', selected: variable.initial === true }, '真 true'),
          )
        : h('input', {
            class: 'input',
            value: variable.hasInitial ? String(variable.initial ?? '') : '',
            disabled: !variable.hasInitial,
            placeholder: variable.type === 'number' ? '0' : '文本',
            onchange: (event) => store.updateVariable(variable.id, { initial: event.target.value }),
          });

    const hasInitialCheck = h('input', {
      type: 'checkbox',
      checked: variable.hasInitial,
      onchange: (event) => store.updateVariable(variable.id, { hasInitial: event.target.checked }),
    });

    return h(
      'div',
      { class: 'mini-card' },
      h(
        'div',
        { class: 'row' },
        nameInput,
        h('span', { class: 'type-tag' }, VARIABLE_TYPES[variable.type]?.label || variable.type),
        error ? h('span', { class: 'badge err' }, '!') : warn ? h('span', { class: 'badge warn' }, '!') : null,
        h('button', {
          class: 'icon-btn danger',
          title: '删除变量',
          text: '✕',
          onclick: () => {
            const used = countVariableUsage(story, variable.id);
            if (used > 0 && !confirm(`变量「${variable.name}」被 ${used} 处引用，删除后这些引用会失效。继续？`)) return;
            store.deleteVariable(variable.id);
          },
        }),
      ),
      h(
        'div',
        { class: 'row' },
        h('label', { class: 'check-row', style: { fontSize: '11px' } }, hasInitialCheck, h('span', { text: '初始值' })),
        h('div', { style: { flex: 1 } }, initialInput),
        typeSelect,
      ),
      issues.length
        ? h(
            'div',
            { style: { marginTop: '6px', fontSize: '11px', color: error ? '#e79c9c' : '#d9b579', lineHeight: '1.5' } },
            issues.map((issue) => h('div', {}, `· ${issue.message}`)),
          )
        : null,
    );
  });

  const newName = h('input', { class: 'input', placeholder: '变量名（如 信任、hasKey）' });
  const newType = h(
    'select',
    { class: 'select' },
    Object.entries(VARIABLE_TYPES).map(([value, meta]) => h('option', { value }, meta.label)),
  );
  const addForm = h(
    'div',
    { class: 'mini-card' },
    h('div', { class: 'row' }, newName, newType),
    h(
      'div',
      { class: 'row' },
      h('button', {
        class: 'btn small block',
        text: '＋ 添加变量',
        onclick: () => {
          const name = newName.value.trim() || store.uniqueVariableName();
          const variable = store.addVariable({ name, type: newType.value });
          if (!variable) {
            newName.value = '';
            return;
          }
          newName.value = '';
        },
      }),
    ),
  );

  return h(
    'div',
    null,
    h(
      'div',
      { class: 'side-section' },
      h('div', { class: 'side-head' }, h('span', {}, `变量 · ${story.variables.length}`)),
      story.variables.length ? cards : h('div', { class: 'empty-tip', text: '还没有变量。条件表达式只能引用这里定义的变量；没有初始值的变量会在检查中被标记。' }),
    ),
    h('div', { class: 'side-section' }, h('div', { class: 'side-head' }, h('span', {}, '新建变量')), addForm),
  );
}

function countVariableUsage(story, variableId) {
  let count = 0;
  for (const node of story.nodes) {
    count += node.onEnter.filter((effect) => effect.variableId === variableId).length;
    for (const choice of node.choices) {
      count += choice.effects.filter((effect) => effect.variableId === variableId).length;
    }
  }
  return count;
}

function charactersTab(store) {
  const story = store.story;
  const source = defaultLocale(story);

  const cards = story.characters.map((character) => {
    const nameInput = h('input', {
      class: 'input',
      value: getText(character.name, source),
      placeholder: '角色名（原文）',
      onfocus: () => store.beginEdit(),
      oninput: (event) => store.setCharacterName(character.id, source, event.target.value, { live: true }),
      onblur: () => store.finishEdit('character:name'),
    });
    const localeNote = localeList(story).length > 1
      ? h('div', { class: 'empty-tip', style: { padding: '4px 0 0', fontSize: '10.5px' } }, '在翻译工作台编辑角色名的其他语言')
      : null;
    return h(
      'div',
      { class: 'mini-card' },
      h(
        'div',
        { class: 'row' },
        h('span', { class: 'swatch', style: { background: character.color } }),
        nameInput,
        h(
          'button',
          {
            class: 'icon-btn danger',
            title: '删除角色',
            text: '✕',
            onclick: () => {
              const used = story.nodes.filter((node) => node.characterId === character.id).length;
              if (used > 0 && !confirm(`角色被 ${used} 个节点引用，删除后这些节点会失去角色。继续？`)) return;
              store.deleteCharacter(character.id);
            },
          },
        ),
      ),
      h(
        'div',
        { class: 'row' },
        h('input', {
          type: 'color',
          class: 'swatch',
          style: { width: '26px', height: '24px', padding: 0, background: 'transparent', cursor: 'pointer' },
          value: character.color,
          onchange: (event) => store.updateCharacter(character.id, { color: event.target.value }),
        }),
        h('input', {
          class: 'input',
          value: character.description || '',
          placeholder: '说明（可选）',
          onchange: (event) => store.updateCharacter(character.id, { description: event.target.value }),
        }),
      ),
      localeNote,
    );
  });

  const nameInput = h('input', { class: 'input', placeholder: '新角色名' });
  return h(
    'div',
    null,
    h(
      'div',
      { class: 'side-section' },
      h('div', { class: 'side-head' }, h('span', {}, `角色 · ${story.characters.length}`)),
      story.characters.length ? cards : h('div', { class: 'empty-tip', text: '还没有角色。节点可以单独设置角色名，但角色是跨语言与跨节点复用的推荐方式。' }),
    ),
    h(
      'div',
      { class: 'side-section' },
      h('div', { class: 'side-head' }, h('span', {}, '新建角色')),
      h(
        'div',
        { class: 'mini-card' },
        h('div', { class: 'row' }, nameInput),
        h(
          'div',
          { class: 'row' },
          h('button', {
            class: 'btn small block',
            text: '＋ 添加角色',
            onclick: () => {
              const name = nameInput.value.trim() || `角色${story.characters.length + 1}`;
              store.addCharacter(name);
              nameInput.value = '';
            },
          }),
        ),
      ),
    ),
  );
}
