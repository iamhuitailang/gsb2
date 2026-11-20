// 侧边控制面板：工具切换、笔刷参数、规则表格、种子与项目存档/导出。
// 纯 DOM 构建，无框架依赖。

import { TOOL } from '../core/constants.js';
import { createRule } from '../core/rules.js';
import { saveProject, loadProject, exportInstancesJSON, exportInstancesCSV } from '../core/project.js';

const TOOL_LABELS = [
  [TOOL.PAINT, '绘制（局部重刷）'],
  [TOOL.ERASE, '擦除'],
  [TOOL.REPLACE, '替换模型'],
  [TOOL.MASK, '手绘遮罩'],
];

export class Panel {
  /**
   * @param {HTMLElement} root 面板容器
   * @param {object} hooks 编辑器回调
   */
  constructor(root, hooks) {
    this.root = root;
    this.hooks = hooks;
    this.rules = hooks.getRules();
    this._suppressEvents = false;
    this.root.innerHTML = '';
    this._build();
  }

  _build() {
    this.root.appendChild(this._section('工具', this._toolSection()));
    this.root.appendChild(this._section('笔刷', this._brushSection()));
    this.root.appendChild(this._section('植被规则', this._rulesSection()));
    this.root.appendChild(this._section('种子与项目', this._projectSection()));
    this.root.appendChild(this._section('视图', this._viewSection()));
    this._stats = document.createElement('div');
    this._stats.className = 'stats';
    this.root.appendChild(this._stats);
    this.refreshRules();
  }

  _section(title, body) {
    const el = document.createElement('section');
    el.className = 'panel-section';
    const h = document.createElement('h3');
    h.textContent = title;
    el.appendChild(h);
    el.appendChild(body);
    return el;
  }

  // ---------- 工具 ----------

  _toolSection() {
    const wrap = document.createElement('div');
    wrap.className = 'tool-grid';
    for (const [tool, label] of TOOL_LABELS) {
      const btn = document.createElement('button');
      btn.className = 'tool-btn';
      btn.dataset.tool = tool;
      btn.textContent = label;
      btn.onclick = () => {
        this.hooks.setTool(tool);
        wrap.querySelectorAll('.tool-btn').forEach((b) => b.classList.toggle('active', b === btn));
      };
      if (tool === TOOL.PAINT) btn.classList.add('active');
      wrap.appendChild(btn);
    }
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = '左键拖动作用于地形；右键/空白处拖动旋转视角，滚轮缩放。';
    wrap.appendChild(hint);

    // 替换目标选择
    const replaceRow = document.createElement('div');
    replaceRow.id = 'replace-row';
    replaceRow.className = 'field hidden';
    replaceRow.innerHTML = '<label>替换为</label>';
    this._replaceSelect = document.createElement('select');
    this._replaceSelect.onchange = () => this.hooks.setReplaceRule(this._replaceSelect.value);
    replaceRow.appendChild(this._replaceSelect);
    wrap.appendChild(replaceRow);

    // 遮罩加减
    const maskRow = document.createElement('div');
    maskRow.id = 'mask-row';
    maskRow.className = 'field hidden';
    maskRow.innerHTML = '<label>遮罩笔刷</label>';
    const maskSel = document.createElement('select');
    maskSel.innerHTML = '<option value="1">增加遮罩</option><option value="-1">擦除遮罩</option>';
    maskSel.onchange = () => this.hooks.setMaskMode(Number(maskSel.value));
    maskRow.appendChild(maskSel);
    wrap.appendChild(maskRow);

    this.hooks.onToolChange = (tool) => {
      replaceRow.classList.toggle('hidden', tool !== TOOL.REPLACE);
      maskRow.classList.toggle('hidden', tool !== TOOL.MASK);
    };
    // 包装 setTool 以联动显隐
    const origSetTool = this.hooks.setTool;
    this.hooks.setTool = (tool) => {
      origSetTool(tool);
      this.hooks.onToolChange(tool);
    };
    return wrap;
  }

  // ---------- 笔刷 ----------

  _brushSection() {
    const wrap = document.createElement('div');
    wrap.appendChild(this._slider('笔刷半径', 'radius', 2, 40, 0.5, 12, (v) => this.hooks.setBrushRadius(v), ' m'));
    wrap.appendChild(this._slider('笔刷强度', 'strength', 0.1, 1, 0.05, 0.8, (v) => this.hooks.setBrushStrength(v), ''));
    return wrap;
  }

  _slider(label, id, min, max, step, value, onInput, unit = '') {
    const field = document.createElement('div');
    field.className = 'field';
    const head = document.createElement('label');
    head.htmlFor = `sl-${id}`;
    const val = document.createElement('span');
    val.className = 'val';
    val.textContent = `${value}${unit}`;
    head.append(label, val);
    const input = document.createElement('input');
    input.type = 'range';
    input.id = `sl-${id}`;
    input.min = min;
    input.max = max;
    input.step = step;
    input.value = value;
    input.oninput = () => {
      const v = Number(input.value);
      val.textContent = `${v}${unit}`;
      onInput(v);
    };
    field.append(head, input);
    return field;
  }

  // ---------- 规则 ----------

  _rulesSection() {
    const wrap = document.createElement('div');
    this._rulesContainer = document.createElement('div');
    this._rulesContainer.className = 'rules';
    wrap.appendChild(this._rulesContainer);

    const btnRow = document.createElement('div');
    btnRow.className = 'btn-row';
    const addBtn = document.createElement('button');
    addBtn.textContent = '+ 新增规则';
    addBtn.onclick = () => {
      this.rules.push(createRule({ name: `植物 ${this.rules.length + 1}` }));
      this._commitRules(true);
    };
    const delBtn = document.createElement('button');
    delBtn.textContent = '删除选中';
    delBtn.onclick = () => {
      const selected = this._rulesContainer.querySelector('.rule-card.selected')?.dataset.id;
      if (!selected || this.rules.length <= 1) {
        this._toast('至少保留一条规则');
        return;
      }
      this.rules = this.rules.filter((r) => r.id !== selected);
      this._commitRules(true);
    };
    btnRow.append(addBtn, delBtn);
    wrap.appendChild(btnRow);
    return wrap;
  }

  refreshRules() {
    this._suppressEvents = true;
    this._rulesContainer.innerHTML = '';
    for (const rule of this.rules) {
      this._rulesContainer.appendChild(this._ruleCard(rule));
    }
    // 替换目标下拉
    this._replaceSelect.innerHTML = this.rules
      .map((r) => `<option value="${r.id}">${r.name}</option>`)
      .join('');
    this._suppressEvents = false;
  }

  _ruleCard(rule) {
    const card = document.createElement('div');
    card.className = 'rule-card';
    card.dataset.id = rule.id;
    card.onclick = () => {
      this._rulesContainer.querySelectorAll('.rule-card').forEach((c) => c.classList.remove('selected'));
      card.classList.add('selected');
    };

    const head = document.createElement('div');
    head.className = 'rule-head';
    const swatch = document.createElement('input');
    swatch.type = 'color';
    swatch.value = '#' + rule.color.toString(16).padStart(6, '0');
    swatch.oninput = () => {
      rule.color = parseInt(swatch.value.slice(1), 16);
      this._commitRules(false);
    };
    const name = document.createElement('input');
    name.type = 'text';
    name.value = rule.name;
    name.onchange = () => {
      rule.name = name.value;
      this._commitRules(true);
    };
    const enable = document.createElement('input');
    enable.type = 'checkbox';
    enable.title = '启用/停用';
    enable.checked = rule.enabled;
    enable.onchange = () => {
      rule.enabled = enable.checked;
      this._commitRules(false);
    };
    head.append(enable, swatch, name);
    card.appendChild(head);

    const kind = document.createElement('select');
    kind.innerHTML = ['tree', 'grass', 'rock']
      .map((k) => `<option value="${k}" ${rule.kind === k ? 'selected' : ''}>${{ tree: '乔木', grass: '草本', rock: '岩石' }[k]}</option>`)
      .join('');
    kind.onchange = () => {
      rule.kind = kind.value;
      this._commitRules(true);
    };
    card.appendChild(this._row('类型', kind));

    const numeric = [
      ['weight', '出现比例', 0, 20, 0.5, ''],
      ['density', '密度 (/㎡)', 0.001, 2, 0.005, ''],
      ['spacing', '间距 (m)', 0.2, 8, 0.1, ''],
    ];
    for (const [key, label, min, max, step, unit] of numeric) {
      card.appendChild(this._numRow(rule, key, label, min, max, step, unit));
    }

    card.appendChild(this._rangeRow(rule, 'rotation', '旋转范围°', 0, 360));
    card.appendChild(this._rangeRow(rule, 'scale', '缩放范围', 0.2, 3));
    card.appendChild(this._numRow(rule, 'tiltMax', '最大倾斜°', 0, 60, 1, ''));
    card.appendChild(this._numRangeRow(rule, 'heightRange', '海拔范围 m', -60, 80));
    card.appendChild(this._numRangeRow(rule, 'slopeRange', '坡度范围°', 0, 90));
    card.appendChild(this._numRow(rule, 'maskThreshold', '遮罩阈值', 0, 1, 0.05, ''));

    return card;
  }

  _row(label, control) {
    const row = document.createElement('div');
    row.className = 'field compact';
    const l = document.createElement('label');
    l.textContent = label;
    row.append(l, control);
    return row;
  }

  _numRow(rule, key, label, min, max, step, unit) {
    const input = document.createElement('input');
    input.type = 'number';
    input.min = min;
    input.max = max;
    input.step = step;
    input.value = rule[key];
    input.onchange = () => {
      rule[key] = Number(input.value);
      this._commitRules(false);
    };
    return this._row(label, input);
  }

  _rangeRow(rule, key, label, min, max) {
    const wrap = document.createElement('div');
    wrap.className = 'field compact';
    const l = document.createElement('label');
    l.textContent = label;
    const row = document.createElement('div');
    row.className = 'pair';
    const a = document.createElement('input');
    a.type = 'number';
    a.min = min; a.max = max; a.step = 0.05; a.value = rule[key].min;
    const b = document.createElement('input');
    b.type = 'number';
    b.min = min; b.max = max; b.step = 0.05; b.value = rule[key].max;
    const commit = () => {
      rule[key].min = Math.min(Number(a.value), Number(b.value));
      rule[key].max = Math.max(Number(a.value), Number(b.value));
      this._commitRules(false);
    };
    a.onchange = commit;
    b.onchange = commit;
    row.append(a, b);
    wrap.append(l, row);
    return wrap;
  }

  _numRangeRow(rule, key, label, min, max) {
    const wrap = document.createElement('div');
    wrap.className = 'field compact';
    const l = document.createElement('label');
    l.textContent = label;
    const row = document.createElement('div');
    row.className = 'pair';
    const [lo, hi] = rule[key];
    const a = document.createElement('input');
    a.type = 'number';
    a.min = min; a.max = max; a.step = 1;
    a.value = Number.isFinite(lo) ? lo : min;
    const b = document.createElement('input');
    b.type = 'number';
    b.min = min; b.max = max; b.step = 1;
    b.value = Number.isFinite(hi) ? hi : max;
    const commit = () => {
      rule[key] = [Math.min(Number(a.value), Number(b.value)), Math.max(Number(a.value), Number(b.value))];
      this._commitRules(false);
    };
    a.onchange = commit;
    b.onchange = commit;
    row.append(a, b);
    wrap.append(l, row);
    return wrap;
  }

  /**
   * 把编辑后的规则交给引擎。结构变化（id/密度导致格网变化）需要重建卡片，
   * 普通参数变化只刷新实例。
   */
  _commitRules(structural) {
    if (this._suppressEvents) return;
    this.hooks.applyRules(this.rules);
    if (structural) this.refreshRules();
  }

  // ---------- 种子与项目 ----------

  _projectSection() {
    const wrap = document.createElement('div');

    const seedField = document.createElement('div');
    seedField.className = 'field';
    seedField.innerHTML = '<label>固定种子（相同区域生成相同结果）</label>';
    const seedRow = document.createElement('div');
    seedRow.className = 'pair';
    this._seedInput = document.createElement('input');
    this._seedInput.type = 'number';
    this._seedInput.value = this.hooks.getSeed();
    const seedBtn = document.createElement('button');
    seedBtn.textContent = '应用';
    seedBtn.onclick = () => this.hooks.setSeed(Number(this._seedInput.value) >>> 0);
    const diceBtn = document.createElement('button');
    diceBtn.textContent = '随机';
    diceBtn.onclick = () => {
      this._seedInput.value = Math.floor(Math.random() * 0xffffffff) >>> 0;
      this.hooks.setSeed(Number(this._seedInput.value));
    };
    seedRow.append(this._seedInput, seedBtn, diceBtn);
    seedField.appendChild(seedRow);
    wrap.appendChild(seedField);

    const fileRow = document.createElement('div');
    fileRow.className = 'btn-row';
    const saveBtn = document.createElement('button');
    saveBtn.textContent = '保存项目';
    saveBtn.onclick = () => this._saveProject();
    const loadBtn = document.createElement('button');
    loadBtn.textContent = '打开项目';
    loadBtn.onclick = () => this._fileInput.click();
    fileRow.append(saveBtn, loadBtn);
    wrap.appendChild(fileRow);

    const exportRow = document.createElement('div');
    exportRow.className = 'btn-row';
    const jsonBtn = document.createElement('button');
    jsonBtn.textContent = '导出实例 JSON';
    jsonBtn.onclick = () => this._export('json');
    const csvBtn = document.createElement('button');
    csvBtn.textContent = '导出实例 CSV';
    csvBtn.onclick = () => this._export('csv');
    exportRow.append(jsonBtn, csvBtn);
    wrap.appendChild(exportRow);

    this._fileInput = document.createElement('input');
    this._fileInput.type = 'file';
    this._fileInput.accept = '.json,application/json';
    this._fileInput.style.display = 'none';
    this._fileInput.onchange = () => this._loadProject(this._fileInput.files?.[0]);
    wrap.appendChild(this._fileInput);
    return wrap;
  }

  _saveProject() {
    const project = saveProject(this.hooks.getWorld());
    this._download(
      `${project.name || 'vegetation-project'}.veg.json`,
      JSON.stringify(project),
      'application/json',
    );
    this._toast('项目已保存');
  }

  async _loadProject(file) {
    if (!file) return;
    try {
      const json = JSON.parse(await file.text());
      const restored = loadProject(json);
      this.rules = restored.rules;
      this.hooks.replaceWorld(restored);
      this._seedInput.value = restored.scatter.seed;
      this.refreshRules();
      this._toast(`已恢复项目：${restored.name}（${restored.scatter.getStats().total} 个实例）`);
    } catch (err) {
      this._toast(`打开失败：${err.message}`);
    } finally {
      this._fileInput.value = '';
    }
  }

  _export(format) {
    const { scatter, rules } = this.hooks.getWorld();
    if (format === 'json') {
      this._download('vegetation-instances.json', exportInstancesJSON(scatter, rules), 'application/json');
    } else {
      this._download('vegetation-instances.csv', exportInstancesCSV(scatter, rules), 'text/csv');
    }
    this._toast(`已导出 ${scatter.getStats().total} 个实例（${format.toUpperCase()}）`);
  }

  // ---------- 视图 ----------

  _viewSection() {
    const wrap = document.createElement('div');
    wrap.appendChild(this._toggle('显示分块边界', (v) => this.hooks.toggleChunks(v)));
    wrap.appendChild(this._toggle('显示遮罩热力图', (v) => this.hooks.toggleMask(v)));
    return wrap;
  }

  _toggle(label, onToggle) {
    const field = document.createElement('div');
    field.className = 'field compact';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    const l = document.createElement('label');
    l.textContent = label;
    cb.onchange = () => onToggle(cb.checked);
    field.append(cb, l);
    return field;
  }

  // ---------- 统计与小工具 ----------

  setStats(stats, pending) {
    const perRule = [...stats.perRule.entries()]
      .map(([id, n]) => {
        const rule = this.rules.find((r) => r.id === id);
        return `${rule?.name ?? id}: ${n}`;
      })
      .join('　');
    this._stats.innerHTML =
      `<div>实例总数：<b>${stats.total}</b>${pending > 0 ? `　待重建块：${pending}` : ''}</div>` +
      `<div class="per-rule">${perRule || '（在地形上按住左键刷出植被）'}</div>`;
  }

  _download(filename, content, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  _toast(text) {
    let el = document.querySelector('.toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }
}
