/* 应用主逻辑：方案管理、编辑器、模拟、对比、导出、持久化。 */
(function () {
  'use strict';

  const STORAGE_KEY = 'dropAnalyzer.v1';
  const SAMPLE_URL = 'examples/sample-table.json';

  /* ---------------- 内置示例（与 examples/sample-table.json 一致，文件加载失败时使用） ---------------- */
  const BUILTIN_SAMPLE = {
    name: '示例：新手池（含保底/互斥/重复转化）',
    rules: { expectedWeightTotal: 100 },
    items: [
      { id: 'legend_sword', name: '传说之剑', weight: 1, rare: true, pity: 80, mutexGroup: 'legend_weapon', maxOwn: 1, convertTo: { item: 'stardust', count: 20 } },
      { id: 'legend_bow', name: '传说之弓', weight: 1, rare: true, pity: 80, mutexGroup: 'legend_weapon', maxOwn: 1, convertTo: { item: 'stardust', count: 20 } },
      { id: 'epic_armor', name: '史诗护甲', weight: 4, rare: true, pity: 20, maxOwn: 3, convertTo: { item: 'stardust', count: 5 } },
      { id: 'arcane_scroll', name: '秘法卷轴', weight: 14, requires: ['epic_armor'] },
      { id: 'iron_sword', name: '精铁剑', weight: 30 },
      { id: 'iron_shield', name: '精铁盾', weight: 30 },
      { id: 'heal_potion', name: '治疗药水', weight: 20 },
      { id: 'stardust', name: '星尘（转化货币）', weight: 0 },
    ],
  };

  /* ---------------- 状态 ---------------- */
  const state = {
    schemes: [],          // [{ id, config }]
    activeId: null,
    simParams: { players: 10000, rounds: 100, seed: 42 },
    chart: { type: 'prob', items: [], histItem: null, logY: false },
    compare: { a: null, b: null },
    lastResult: null,     // 当前方案的模拟结果
    lastCompare: null,
    tab: 'edit',
  };

  function uid() { return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  function save() {
    const data = {
      schemes: state.schemes,
      activeId: state.activeId,
      simParams: state.simParams,
      chart: state.chart,
      compare: state.compare,
      tab: state.tab,
    };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (e) { /* 存储不可用时忽略 */ }
  }

  function load() {
    let data = null;
    try { data = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch (e) { data = null; }
    if (data && Array.isArray(data.schemes) && data.schemes.length) {
      state.schemes = data.schemes.map((s) => ({ id: s.id || uid(), config: Engine.normalizeConfig(s.config) }));
      state.activeId = data.activeId && state.schemes.some((s) => s.id === data.activeId)
        ? data.activeId : state.schemes[0].id;
      Object.assign(state.simParams, data.simParams || {});
      Object.assign(state.chart, data.chart || {});
      Object.assign(state.compare, data.compare || {});
      state.tab = data.tab || 'edit';
    } else {
      addScheme(BUILTIN_SAMPLE);
      state.activeId = state.schemes[0].id;
    }
  }

  function addScheme(configRaw) {
    const config = Engine.normalizeConfig(configRaw);
    const s = { id: uid(), config };
    state.schemes.push(s);
    return s;
  }

  function activeScheme() { return state.schemes.find((s) => s.id === state.activeId) || null; }

  /* ---------------- DOM 工具 ---------------- */
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  function h(tag, attrs, ...children) {
    const n = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === 'class') n.className = attrs[k];
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), attrs[k]);
      else n.setAttribute(k, attrs[k]);
    }
    children.forEach((c) => {
      if (c == null) return;
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return n;
  }

  function pct(x) { return x == null ? '—' : (x * 100).toFixed(2) + '%'; }
  function num(x, d) { return x == null ? '—' : Number(x).toFixed(d == null ? 2 : d); }

  /* ---------------- 渲染：方案列表 ---------------- */
  function renderSchemes() {
    const ul = $('#scheme-list');
    ul.innerHTML = '';
    state.schemes.forEach((s) => {
      const li = h('li', { class: s.id === state.activeId ? 'active' : '' },
        h('span', { class: 'scheme-name' }, s.config.name),
        h('span', { class: 'scheme-actions' },
          h('button', { title: '复制方案', onclick: (e) => { e.stopPropagation(); duplicateScheme(s.id); } }, '⧉'),
          h('button', { title: '删除方案', onclick: (e) => { e.stopPropagation(); deleteScheme(s.id); } }, '✕'),
        ),
      );
      li.addEventListener('click', () => {
        state.activeId = s.id;
        state.lastResult = null;
        save(); renderAll();
      });
      ul.appendChild(li);
    });
    // 对比下拉
    fillCompareSelects();
  }

  function duplicateScheme(id) {
    const src = state.schemes.find((s) => s.id === id);
    if (!src) return;
    const copy = JSON.parse(JSON.stringify(src.config));
    copy.name = copy.name + '（副本）';
    const s = addScheme(copy);
    state.activeId = s.id;
    save(); renderAll();
  }

  function deleteScheme(id) {
    if (state.schemes.length <= 1) { alert('至少保留一个方案。'); return; }
    if (!confirm('确定删除该方案？')) return;
    state.schemes = state.schemes.filter((s) => s.id !== id);
    if (state.activeId === id) state.activeId = state.schemes[0].id;
    save(); renderAll();
  }

  /* ---------------- 渲染：编辑器 ---------------- */
  function renderEditor() {
    const s = activeScheme();
    if (!s) return;
    $('#scheme-name').value = s.config.name;
    $('#expected-total').value = s.config.rules.expectedWeightTotal;

    const tbody = $('#items-tbody');
    tbody.innerHTML = '';
    s.config.items.forEach((it, idx) => {
      const tr = h('tr', null,
        cellInput(it.id, (v) => { it.id = v.trim(); onEdit(); }),
        cellInput(it.name, (v) => { it.name = v; onEdit(); }),
        cellInput(it.weight, (v) => { it.weight = v === '' ? NaN : Number(v); onEdit(); }, 'number'),
        h('td', null, (() => {
          const c = h('input', { type: 'checkbox' });
          c.checked = !!it.rare;
          c.addEventListener('change', () => { it.rare = c.checked; onEdit(); });
          return c;
        })()),
        cellInput(it.pity == null ? '' : it.pity, (v) => { it.pity = v === '' ? null : Number(v); onEdit(); }, 'number'),
        cellInput(it.mutexGroup || '', (v) => { it.mutexGroup = v.trim() || null; onEdit(); }),
        cellInput(it.maxOwn == null ? '' : it.maxOwn, (v) => { it.maxOwn = v === '' ? null : Number(v); onEdit(); }, 'number'),
        cellInput((it.requires || []).join(','), (v) => {
          it.requires = v.split(',').map((x) => x.trim()).filter(Boolean); onEdit();
        }),
        cellInput(it.convertTo ? it.convertTo.item : '', (v) => {
          const t = v.trim();
          it.convertTo = t ? { item: t, count: (it.convertTo && it.convertTo.count) || 1 } : null; onEdit();
        }),
        cellInput(it.convertTo ? it.convertTo.count : '', (v) => {
          if (it.convertTo) it.convertTo.count = Number(v) || 1;
          else if (v.trim()) it.convertTo = { item: '', count: Number(v) || 1 };
          onEdit();
        }, 'number'),
        h('td', null, h('button', { class: 'danger', onclick: () => { s.config.items.splice(idx, 1); onEdit(true); } }, '删')),
      );
      tbody.appendChild(tr);
    });
    renderValidation();
  }

  function cellInput(value, onchange, type) {
    const td = h('td');
    const inp = h('input', { type: type || 'text', class: 'cell-input' });
    inp.value = value == null ? '' : value;
    inp.addEventListener('change', () => onchange(inp.value));
    td.appendChild(inp);
    return td;
  }

  function onEdit(structural) {
    save();
    if (structural) renderEditor();
    else renderValidation();
  }

  function renderValidation() {
    const s = activeScheme();
    const box = $('#validation');
    box.innerHTML = '';
    if (!s) return;
    const problems = Engine.validateConfig(s.config);
    if (!problems.length) {
      box.appendChild(h('div', { class: 'ok' }, '✓ 配置校验通过：权重合计、保底、互斥组与前置引用均符合规则。'));
      return;
    }
    problems.forEach((p) => {
      box.appendChild(h('div', { class: p.level === 'error' ? 'err' : 'warn' },
        (p.level === 'error' ? '✕ ' : '⚠ ') + p.msg));
    });
  }

  /* ---------------- 渲染：模拟 ---------------- */
  function renderSimControls() {
    $('#sim-players').value = state.simParams.players;
    $('#sim-rounds').value = state.simParams.rounds;
    $('#sim-seed').value = state.simParams.seed;
  }

  function runSimulation() {
    const s = activeScheme();
    if (!s) return;
    const problems = Engine.validateConfig(s.config).filter((p) => p.level === 'error');
    if (problems.length) {
      alert('配置存在错误，无法模拟：\n' + problems.map((p) => '· ' + p.msg).join('\n'));
      return;
    }
    state.simParams = {
      players: Math.max(1, Math.floor(Number($('#sim-players').value) || 1)),
      rounds: Math.max(1, Math.floor(Number($('#sim-rounds').value) || 1)),
      seed: $('#sim-seed').value,
    };
    state.lastResult = Engine.simulate(s.config, state.simParams);
    // 默认选中稀有物品画概率曲线
    if (!state.chart.items.length) {
      state.chart.items = s.config.items.filter((i) => i.rare).map((i) => i.id);
    }
    if (!state.chart.histItem || !s.config.items.some((i) => i.id === state.chart.histItem)) {
      const first = s.config.items.find((i) => i.rare) || s.config.items[0];
      state.chart.histItem = first ? first.id : null;
    }
    save();
    renderSimResult();
  }

  function renderSimResult() {
    const res = state.lastResult;
    const s = activeScheme();
    const box = $('#sim-result');
    if (!res) { box.innerHTML = '<p class="hint">设置参数后点击「运行模拟」。相同种子与参数会得到完全相同的结果。</p>'; return; }
    box.innerHTML = '';

    // 概要
    const summary = h('div', { class: 'summary' },
      h('span', null, `玩家数：${res.params.players}`),
      h('span', null, `局数：${res.params.rounds}`),
      h('span', null, `种子：${res.params.seed}`),
      h('span', null, `终局稀有覆盖率：${pct(res.rareCoverage[res.params.rounds])}`),
    );
    const conv = Object.entries(res.converted);
    if (conv.length) {
      summary.appendChild(h('span', null, '重复转化产出：' + conv.map(([k, v]) => `${k}×${v}`).join('，')));
    }
    box.appendChild(summary);

    // 图表控制
    const ctrl = h('div', { class: 'chart-ctrl' });
    const typeSel = h('select', { id: 'chart-type' },
      h('option', { value: 'prob' }, '获得概率曲线'),
      h('option', { value: 'hist' }, '获得次数分布'),
      h('option', { value: 'rare' }, '稀有奖励覆盖率'),
    );
    typeSel.value = state.chart.type;
    typeSel.addEventListener('change', () => { state.chart.type = typeSel.value; save(); renderSimResult(); });
    ctrl.appendChild(h('label', null, '图表：', typeSel));

    const logC = h('input', { type: 'checkbox', id: 'chart-logy' });
    logC.checked = !!state.chart.logY;
    logC.addEventListener('change', () => { state.chart.logY = logC.checked; save(); renderSimResult(); });
    ctrl.appendChild(h('label', null, logC, ' 对数纵轴'));
    box.appendChild(ctrl);

    const chartDiv = h('div', { id: 'chart-box' });
    box.appendChild(chartDiv);

    if (state.chart.type === 'prob') {
      // 物品多选
      const picker = h('div', { class: 'item-picker' });
      s.config.items.forEach((it) => {
        const cb = h('input', { type: 'checkbox' });
        cb.checked = state.chart.items.includes(it.id);
        cb.addEventListener('change', () => {
          state.chart.items = cb.checked
            ? state.chart.items.concat(it.id)
            : state.chart.items.filter((x) => x !== it.id);
          save(); renderSimResult();
        });
        picker.appendChild(h('label', null, cb, ' ' + (it.name || it.id)));
      });
      box.insertBefore(picker, chartDiv);
      const series = state.chart.items
        .map((id) => res.perItem.find((i) => i.id === id))
        .filter(Boolean)
        .map((i) => ({ name: i.name || i.id, points: i.probByRound }));
      Charts.lineChart(chartDiv, series, { logY: state.chart.logY, yPercent: true });
    } else if (state.chart.type === 'hist') {
      const sel = h('select');
      res.perItem.forEach((i) => sel.appendChild(h('option', { value: i.id }, i.name || i.id)));
      sel.value = state.chart.histItem;
      sel.addEventListener('change', () => { state.chart.histItem = sel.value; save(); renderSimResult(); });
      box.insertBefore(h('label', { class: 'item-picker' }, '物品：', sel), chartDiv);
      const item = res.perItem.find((i) => i.id === state.chart.histItem) || res.perItem[0];
      if (item) {
        const labels = item.hist.map((_, k) => (k === item.hist.length - 1 ? k + '+' : String(k)));
        Charts.barChart(chartDiv, labels, Array.from(item.hist));
        box.appendChild(h('p', { class: 'hint' },
          `「${item.name || item.id}」每个玩家在 ${res.params.rounds} 局内抽中次数的人数分布（含保底与转化前的抽中次数）。`));
      }
    } else {
      Charts.lineChart(chartDiv, [{ name: '稀有覆盖率', points: res.rareCoverage }], { yPercent: true });
      box.appendChild(h('p', { class: 'hint' }, '第 n 局结束时，已拥有至少 1 个稀有物品的玩家占比。'));
    }

    // 明细表
    const table = h('table', { class: 'stats' },
      h('thead', null, h('tr', null,
        h('th', null, '物品'), h('th', null, '获得率'), h('th', null, '总抽中'),
        h('th', null, '转化次数'), h('th', null, '丢弃'), h('th', null, '平均获得局数'), h('th', null, '中位获得局数'))));
    const tb = h('tbody');
    res.perItem.forEach((i) => {
      tb.appendChild(h('tr', null,
        h('td', null, (i.rare ? '★ ' : '') + (i.name || i.id)),
        h('td', null, pct(i.obtainProb)),
        h('td', null, String(i.totalDrops)),
        h('td', null, String(i.convertedOut)),
        h('td', null, String(i.wasted)),
        h('td', null, num(i.meanFirstRound)),
        h('td', null, i.medianFirstRound == null ? '—' : String(i.medianFirstRound)),
      ));
    });
    table.appendChild(tb);
    box.appendChild(table);
  }

  /* ---------------- 渲染：对比 ---------------- */
  function fillCompareSelects() {
    ['#cmp-a', '#cmp-b'].forEach((sel, k) => {
      const el = $(sel);
      if (!el) return;
      el.innerHTML = '';
      state.schemes.forEach((s) => el.appendChild(h('option', { value: s.id }, s.config.name)));
      const cur = k === 0 ? state.compare.a : state.compare.b;
      el.value = cur && state.schemes.some((s) => s.id === cur) ? cur : (state.schemes[k] || state.schemes[0]).id;
    });
  }

  function runCompare() {
    state.compare.a = $('#cmp-a').value;
    state.compare.b = $('#cmp-b').value;
    const a = state.schemes.find((s) => s.id === state.compare.a);
    const b = state.schemes.find((s) => s.id === state.compare.b);
    if (!a || !b) return;
    for (const [name, cfg] of [['版本 A', a.config], ['版本 B', b.config]]) {
      const errs = Engine.validateConfig(cfg).filter((p) => p.level === 'error');
      if (errs.length) {
        alert(`${name}（${cfg.name}）存在错误，无法对比：\n` + errs.map((p) => '· ' + p.msg).join('\n'));
        return;
      }
    }
    state.lastCompare = Engine.compareConfigs(a.config, b.config, state.simParams);
    save();
    renderCompare();
  }

  function renderCompare() {
    const box = $('#cmp-result');
    const cmp = state.lastCompare;
    if (!cmp) { box.innerHTML = '<p class="hint">选择两个方案后点击「运行对比」。两版使用相同种子与参数模拟。</p>'; return; }
    box.innerHTML = '';
    box.appendChild(h('p', { class: 'hint' },
      `按最终局获得概率变化幅度排序（模拟参数：${state.simParams.players} 玩家 × ${state.simParams.rounds} 局，种子 ${state.simParams.seed}）。`));
    const table = h('table', { class: 'stats' },
      h('thead', null, h('tr', null,
        h('th', null, '物品'), h('th', null, '获得率 A→B'), h('th', null, 'Δ 概率'),
        h('th', null, '平均获得局数 A→B'), h('th', null, 'Δ 局数'), h('th', null, '保底 A→B'))));
    const tb = h('tbody');
    cmp.rows.forEach((r, idx) => {
      const dProbTxt = r.dProb == null ? '—' : (r.dProb >= 0 ? '+' : '') + (r.dProb * 100).toFixed(2) + 'pp';
      const dMeanTxt = r.dMean == null ? '—' : (r.dMean >= 0 ? '+' : '') + r.dMean.toFixed(2);
      const cls = r.dProb == null ? '' : r.dProb > 0 ? 'up' : r.dProb < 0 ? 'down' : '';
      const meanCls = r.dMean == null ? '' : r.dMean < 0 ? 'up' : r.dMean > 0 ? 'down' : '';
      tb.appendChild(h('tr', { class: idx < 3 ? 'top-change' : '' },
        h('td', null, (idx < 3 ? '▲ ' : '') + r.name + (r.onlyIn ? `（仅存在于 ${r.onlyIn}）` : '')),
        h('td', null, `${pct(r.probA)} → ${pct(r.probB)}`),
        h('td', { class: cls }, dProbTxt),
        h('td', null, `${num(r.meanA)} → ${num(r.meanB)}`),
        h('td', { class: meanCls }, dMeanTxt),
        h('td', { class: r.pityChanged ? 'down' : '' },
          `${r.pityA == null ? '无' : r.pityA} → ${r.pityB == null ? '无' : r.pityB}`),
      ));
    });
    table.appendChild(tb);
    box.appendChild(table);
    box.appendChild(h('p', { class: 'hint' },
      '绿色 = 对玩家更有利（概率上升或所需局数减少）；红色 = 更不利。pp = 百分点。前 3 行标 ▲ 为变化最大的物品。'));
  }

  /* ---------------- 导出 / 导入 ---------------- */
  function download(filename, text, mime) {
    const blob = new Blob([text], { type: mime || 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: filename });
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }

  function exportConfig() {
    const s = activeScheme();
    if (!s) return;
    download(`${s.config.name || 'config'}.json`, JSON.stringify(s.config, null, 2));
  }

  function exportAllSchemes() {
    download('schemes-all.json', JSON.stringify(state.schemes.map((s) => s.config), null, 2));
  }

  function exportResultJSON() {
    if (!state.lastResult) { alert('请先在「模拟」页运行一次模拟。'); return; }
    const s = activeScheme();
    download(`result-${s.config.name}.json`, JSON.stringify({
      configName: s.config.name,
      params: state.lastResult.params,
      perItem: state.lastResult.perItem.map((i) => ({
        id: i.id, name: i.name, rare: i.rare,
        obtainProb: i.obtainProb, totalDrops: i.totalDrops,
        convertedOut: i.convertedOut, wasted: i.wasted,
        meanFirstRound: i.meanFirstRound, medianFirstRound: i.medianFirstRound,
        hist: Array.from(i.hist), probByRound: i.probByRound,
      })),
      rareCoverage: state.lastResult.rareCoverage,
      converted: state.lastResult.converted,
    }, null, 2));
  }

  function exportResultCSV() {
    if (!state.lastResult) { alert('请先在「模拟」页运行一次模拟。'); return; }
    const rows = [['item_id', 'item_name', 'rare', 'obtain_prob', 'total_drops', 'converted_out', 'wasted', 'mean_first_round', 'median_first_round']];
    state.lastResult.perItem.forEach((i) => rows.push([
      i.id, `"${(i.name || '').replace(/"/g, '""')}"`, i.rare ? 1 : 0,
      i.obtainProb.toFixed(6), i.totalDrops, i.convertedOut, i.wasted,
      i.meanFirstRound == null ? '' : i.meanFirstRound.toFixed(3),
      i.medianFirstRound == null ? '' : i.medianFirstRound,
    ]));
    download('result.csv', rows.map((r) => r.join(',')).join('\n'), 'text/csv');
  }

  function importConfig(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        const list = Array.isArray(data) ? data : [data];
        let last = null;
        list.forEach((c) => { last = addScheme(c); });
        if (last) state.activeId = last.id;
        save(); renderAll();
      } catch (e) {
        alert('导入失败：不是有效的 JSON 配置。\n' + e.message);
      }
    };
    reader.readAsText(file);
  }

  /* ---------------- 标签页 ---------------- */
  function switchTab(tab) {
    state.tab = tab;
    $$('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    $$('.tab-page').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + tab));
    save();
  }

  /* ---------------- 总渲染 ---------------- */
  function renderAll() {
    renderSchemes();
    renderEditor();
    renderSimControls();
    renderSimResult();
    renderCompare();
    switchTab(state.tab);
  }

  /* ---------------- 启动 ---------------- */
  function init() {
    load();
    renderAll();

    $('#btn-new-scheme').addEventListener('click', () => {
      const s = addScheme(Engine.defaultConfig());
      state.activeId = s.id;
      save(); renderAll();
    });
    $('#btn-load-sample').addEventListener('click', async () => {
      try {
        const resp = await fetch(SAMPLE_URL);
        if (!resp.ok) throw new Error('http ' + resp.status);
        addScheme(await resp.json());
      } catch (e) {
        addScheme(BUILTIN_SAMPLE); // file:// 下 fetch 失败时用内置副本
      }
      state.activeId = state.schemes[state.schemes.length - 1].id;
      save(); renderAll();
    });
    $('#scheme-name').addEventListener('change', (e) => {
      const s = activeScheme();
      if (s) { s.config.name = e.target.value; save(); renderSchemes(); }
    });
    $('#expected-total').addEventListener('change', (e) => {
      const s = activeScheme();
      if (s) { s.config.rules.expectedWeightTotal = Number(e.target.value) || 100; onEdit(); }
    });
    $('#btn-add-item').addEventListener('click', () => {
      const s = activeScheme();
      if (!s) return;
      s.config.items.push(Engine.normalizeConfig({ items: [{ id: 'item_' + (s.config.items.length + 1), name: '', weight: 0 }] }).items[0]);
      onEdit(true);
    });
    $('#btn-run-sim').addEventListener('click', runSimulation);
    $('#btn-run-cmp').addEventListener('click', runCompare);
    $('#btn-export-config').addEventListener('click', exportConfig);
    $('#btn-export-all').addEventListener('click', exportAllSchemes);
    $('#btn-export-json').addEventListener('click', exportResultJSON);
    $('#btn-export-csv').addEventListener('click', exportResultCSV);
    $('#import-file').addEventListener('change', (e) => {
      if (e.target.files[0]) importConfig(e.target.files[0]);
      e.target.value = '';
    });
    $$('.tab-btn').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  }

  document.addEventListener('DOMContentLoaded', init);
})();
