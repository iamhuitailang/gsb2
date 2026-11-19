/**
 * 页面主逻辑：所有数据仅保存在当前页面内存中，刷新即消失。
 * 安全约定：
 *  - 不调用任何网络 API（fetch/XHR 均不使用），文件导入走 FileReader、导出走 Blob 下载；
 *  - 不向 console 打印任何用户数据，错误提示只含固定文案与计数，不含原文；
 *  - 列表中敏感值只通过 maskPreview 显示脱敏片段；
 *  - 导出前对导出文本做最终泄漏自检（对照所有命中原值逐一确认已不在导出内容中，
 *    被用户明确「保留」的项除外并显著提示）。
 */
(function () {
  'use strict';

  const R = window.SanLog;
  const $ = (id) => document.getElementById(id);

  /** 全局页面状态（仅内存） */
  const state = {
    rawText: '',
    importResult: null,
    enabledIds: new Set(R.DEFAULT_ENABLED_IDS),
    findings: [],
    countByType: {},
    countByRule: {},
    decisions: {}, // decisionKey -> 'redact' | 'keep'
    lastResult: null, // 最近一次 applyRedactions/pipeline 的完整结果
  };

  /* ---------------- 通用工具 ---------------- */

  function showPanel(step) {
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    $(`panel-${['import', 'rules', 'review', 'export'][step - 1]}`).classList.add('active');
    document.querySelectorAll('.step-indicator li').forEach((li, i) => {
      li.classList.toggle('active', i === step - 1);
      li.classList.toggle('done', i < step - 1);
    });
    window.scrollTo({ top: 0 });
  }

  function setStatus(el, text, kind) {
    el.textContent = text;
    el.className = kind ? `status ${kind}` : 'status';
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function card(num, label, cls) {
    const c = el('div', `card${cls ? ' ' + cls : ''}`);
    c.append(el('div', 'num', String(num)), el('div', 'lbl', label));
    return c;
  }

  function decisionOf(f) {
    return state.decisions[f.decisionKey] || 'redact';
  }

  /* ---------------- 步骤 1：导入 ---------------- */

  $('btnLoadDemo').addEventListener('click', () => {
    const demo = window.SANLOG_DEMO_TEXT;
    if (!demo) {
      setStatus($('importStatus'), '演示数据缺失，请通过 npm run gen:demo 生成', 'err');
      return;
    }
    $('rawInput').value = demo;
    setStatus($('importStatus'), '已载入本地演示日志（含嵌套、重复值、异常行等场景）', 'ok');
  });

  $('fileInput').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      $('rawInput').value = String(reader.result || '');
      setStatus($('importStatus'), `已读取本地文件：${file.name}`, 'ok');
    };
    reader.onerror = () => setStatus($('importStatus'), '文件读取失败，请重试', 'err');
    reader.readAsText(file);
    e.target.value = '';
  });

  $('btnClearInput').addEventListener('click', () => {
    $('rawInput').value = '';
    setStatus($('importStatus'), '');
  });

  $('btnParse').addEventListener('click', () => {
    const text = $('rawInput').value;
    if (!text.trim()) {
      setStatus($('importStatus'), '请先粘贴或导入日志内容', 'warn');
      return;
    }
    state.rawText = text;
    try {
      state.importResult = R.parseInput(text);
    } catch (err) {
      // 不回显 err 细节，避免任何原文片段进入提示
      setStatus($('importStatus'), '解析过程异常，请检查输入是否为文本', 'err');
      return;
    }
    renderImport();
    if (state.importResult.records.length === 0) {
      setStatus($('importStatus'), '没有可处理的 JSON 记录，请检查格式', 'warn');
      return;
    }
    runScan();
    renderRulesPanel();
    setStatus($('importStatus'), `解析完成：${state.importResult.records.length} 条可处理，${state.importResult.failures.length} 行失败`, 'ok');
  });

  function renderImport() {
    const ir = state.importResult;
    $('importSummary').hidden = false;
    $('okCount').textContent = String(ir.records.length);
    $('failCount').textContent = String(ir.failures.length);
    const sum = $('importSummary');
    sum.replaceChildren(
      card(ir.totalLines, '总行数（含空行）'),
      card(ir.records.length, '可处理记录', 'ok'),
      card(ir.failures.length, '解析失败行', ir.failures.length ? 'warn' : ''),
      card(ir.blankLines, '空行'),
    );

    const okList = $('recordList');
    okList.replaceChildren();
    if (!ir.records.length) okList.append(el('div', 'empty', '无可处理记录'));
    ir.records.forEach((rec, idx) => {
      const item = el('div', 'record-item');
      item.append(el('div', 'line', `记录 #${idx + 1} · 原始行号 ${rec.line}`));
      const pre = el('pre');
      pre.textContent = safeStringify(rec.value);
      item.append(pre);
      okList.append(item);
    });

    const failList = $('failureList');
    failList.replaceChildren();
    if (!ir.failures.length) failList.append(el('div', 'empty', '无失败行'));
    ir.failures.forEach((f) => {
      const item = el('div', 'failure-item');
      item.append(el('div', 'line', `原始行号 ${f.line} · ${f.rawLength || 0} 字符${f.reimported ? ' · 来自上次导出的失败包装' : ''}`));
      item.append(el('div', 'reason', f.reason));
      // 仅在用户当前会话内、页面上展示失败行原文供修正；该内容不进入任何导出与审计对象
      if (f.raw) {
        const pre = el('pre');
        pre.textContent = f.raw;
        item.append(pre);
      } else {
        item.append(el('div', 'hint small', '失败行原文未随导出保留，仅记录长度与原因'));
      }
      failList.append(item);
    });
  }

  function safeStringify(value) {
    try {
      return JSON.stringify(value, null, 2);
    } catch (_) {
      return String(value);
    }
  }

  /* ---------------- 步骤 2：规则 ---------------- */

  function ruleCard(rule, kind) {
    const cardNode = el('div', 'rule-card');
    const top = el('div', 'rule-top');
    const left = el('div');
    left.append(el('div', 'rule-name', rule.label));
    left.append(el('div', 'rule-id', `${rule.id} · ${kind === 'field' ? '字段名' : '内容模式'}`));
    const sw = el('label', 'switch');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = state.enabledIds.has(rule.id);
    input.setAttribute('aria-label', rule.label);
    input.addEventListener('change', () => {
      if (input.checked) state.enabledIds.add(rule.id);
      else state.enabledIds.delete(rule.id);
      cardNode.classList.toggle('off', !input.checked);
    });
    const slider = el('span', 'slider');
    sw.append(input, slider);
    top.append(left, sw);
    const hits = state.countByRule[rule.id] || 0;
    cardNode.append(top);
    cardNode.append(el('div', 'rule-desc', rule.description));
    cardNode.append(el('div', 'rule-meta', `当前预览命中：${hits}`));
    if (!input.checked) cardNode.classList.add('off');
    return cardNode;
  }

  function renderRulesPanel() {
    const fg = $('fieldRules');
    fg.replaceChildren(...R.FIELD_RULES.map((rule) => ruleCard(rule, 'field')));
    const pg = $('patternRules');
    pg.replaceChildren(...R.PATTERN_RULES.map((rule) => ruleCard(rule, 'pattern')));
    renderScanSummary();
  }

  function runScan() {
    const result = R.preview(state.rawText, state.enabledIds);
    state.importResult = result.importResult;
    state.findings = result.findings;
    state.countByRule = result.countByRule;
    state.countByType = result.countByType;
    // 规则变化后，已不存在的命中决定自动失效
    const valid = new Set(state.findings.map((f) => f.decisionKey));
    for (const key of Object.keys(state.decisions)) {
      if (!valid.has(key)) delete state.decisions[key];
    }
  }

  function renderScanSummary() {
    const box = $('scanSummary');
    box.hidden = false;
    const keepCount = state.findings.filter((f) => decisionOf(f) === 'keep').length;
    box.replaceChildren(
      card(state.findings.length, '命中总数', state.findings.length ? 'danger' : 'ok'),
      card(state.findings.length - keepCount, '将处理', 'danger'),
      card(keepCount, '将保留', 'ok'),
      card(Object.keys(state.countByType).length, '涉及类型数'),
      card(R.RULE_VERSION, '规则版本'),
    );
    setStatus($('scanStatus'), `预览时间 ${new Date().toLocaleString()} · 共 ${state.findings.length} 条命中`, 'ok');
  }

  $('btnRescan').addEventListener('click', () => {
    runScan();
    renderRulesPanel();
    setStatus($('scanStatus'), '已按当前规则重新扫描', 'ok');
  });

  $('btnRulesAll').addEventListener('click', () => {
    state.enabledIds = new Set([...R.FIELD_RULES, ...R.PATTERN_RULES].map((r) => r.id));
    runScan();
    renderRulesPanel();
  });

  $('btnRulesDefault').addEventListener('click', () => {
    state.enabledIds = new Set(R.DEFAULT_ENABLED_IDS);
    runScan();
    renderRulesPanel();
  });

  $('btnBackToImport').addEventListener('click', () => showPanel(1));
  $('btnToReview').addEventListener('click', () => {
    renderFindings();
    renderTypeFilter();
    showPanel(3);
  });

  /* ---------------- 步骤 3：逐项审查 ---------------- */

  function renderTypeFilter() {
    const sel = $('typeFilter');
    const current = sel.value;
    const types = [...new Set(state.findings.map((f) => f.type))].sort();
    sel.replaceChildren(el('option', '', '全部类型'));
    types.forEach((t) => {
      const o = el('option', '', t);
      o.value = t;
      sel.append(o);
    });
    sel.value = types.includes(current) ? current : '';
  }

  function filteredFindings() {
    const type = $('typeFilter').value;
    const action = $('actionFilter').value;
    const q = $('findingSearch').value.trim().toLowerCase();
    return state.findings.filter((f) => {
      if (type && f.type !== type) return false;
      if (action && decisionOf(f) !== action) return false;
      if (q && !(f.path.toLowerCase().includes(q) || f.ruleId.toLowerCase().includes(q) || f.ruleLabel.toLowerCase().includes(q))) return false;
      return true;
    });
  }

  function renderFindings() {
    const list = $('findingList');
    const items = filteredFindings();
    $('findingCount').textContent = String(items.length);
    list.replaceChildren();
    if (!items.length) {
      list.append(el('div', 'empty', state.findings.length ? '没有符合筛选条件的命中' : '当前规则下没有命中，可直接进入下一步导出'));
      renderMarkerPreview();
      return;
    }
    items.forEach((f) => list.append(findingNode(f)));
    renderMarkerPreview();
  }

  function findingNode(f) {
    const action = decisionOf(f);
    const node = el('div', `finding-item ${action}`);
    const row = el('div', 'finding-row');
    const left = el('div');
    const title = el('div');
    title.append(el('span', 'finding-path', f.path));
    left.append(title);
    const badges = el('div', 'finding-row');
    badges.style.marginTop = '5px';
    badges.append(
      badge(f.type, 'type'),
      badge(f.mode === 'text' ? `文本 ${f.start + 1}-${f.end}` : f.mode === 'value' ? '整值' : '字段名', 'mode'),
      badge(action === 'keep' ? '将保留' : '将处理', action),
    );
    left.append(badges);
    const actions = el('div', 'mini-actions');
    const btnRedact = el('button', `mini-btn${action === 'redact' ? ' active-redact' : ''}`, '处理');
    const btnKeep = el('button', `mini-btn${action === 'keep' ? ' active-keep' : ''}`, '保留');
    btnRedact.addEventListener('click', () => setDecision(f, 'redact'));
    btnKeep.addEventListener('click', () => setDecision(f, 'keep'));
    actions.append(btnRedact, btnKeep);
    row.append(left, actions);
    node.append(row);
    node.append(el('div', 'finding-meta', `行 ${f.line} · ${f.id} · ${f.ruleId}`));
    node.append(el('div', 'finding-reason', f.reason));
    node.append(el('div', 'finding-preview', `脱敏预览：${f.preview}`));
    return node;
  }

  function badge(text, cls) {
    return el('span', `badge ${cls}`, text);
  }

  function setDecision(f, action) {
    state.decisions[f.decisionKey] = action;
    renderFindings();
    renderScanSummary();
  }

  $('typeFilter').addEventListener('change', renderFindings);
  $('actionFilter').addEventListener('change', renderFindings);
  $('findingSearch').addEventListener('input', renderFindings);

  $('btnAllRedact').addEventListener('click', () => {
    state.decisions = {};
    renderFindings();
    renderScanSummary();
  });
  $('btnAllKeep').addEventListener('click', () => {
    state.findings.forEach((f) => { state.decisions[f.decisionKey] = 'keep'; });
    renderFindings();
    renderScanSummary();
  });

  /**
   * 标记一致性预览：按当前决定模拟一次脱敏，展示「原值指纹 → 标记」映射。
   * 指纹只取长度+脱敏预览，不展示完整原值，足以让用户核对同值同标记、异值异标记。
   */
  function renderMarkerPreview() {
    const wrap = $('markerTable');
    let result;
    try {
      result = R.applyRedactions(state.importResult.records, state.findings, state.decisions);
    } catch (_) {
      wrap.replaceChildren(el('div', 'empty', '标记表暂不可用'));
      return;
    }
    const rows = new Map(); // marker -> {type, count}
    for (const change of result.changes) {
      for (const item of change.items) {
        if (item.action !== 'redact') continue;
        if (!rows.has(item.marker)) {
          rows.set(item.marker, { type: item.type, marker: item.marker, count: 0 });
        }
        rows.get(item.marker).count += 1;
      }
    }
    // 预览指纹来自 finding 本身（已脱敏），通过路径/规则/偏移与标记关联
    const markerToPreview = new Map();
    result.changes.forEach((change) => {
      change.items.forEach((item) => {
        if (item.action !== 'redact') return;
        const f = state.findings.find(
          (x) => x.path === item.path && x.ruleId === item.ruleId &&
            (x.mode !== 'text' || (x.start === item.start && x.end === item.end)),
        );
        if (f && !markerToPreview.has(item.marker)) markerToPreview.set(item.marker, f.preview);
      });
    });

    if (!rows.size) {
      wrap.replaceChildren(el('div', 'empty', '没有将处理的命中'));
      return;
    }
    const table = el('table', 'marker-table');
    const thead = el('thead');
    const hr = el('tr');
    ['替代标记', '类型', '复用次数', '值指纹（脱敏预览）'].forEach((h) => hr.append(el('th', '', h)));
    thead.append(hr);
    const tbody = el('tbody');
    [...rows.values()].sort((a, b) => a.marker.localeCompare(b.marker)).forEach((r) => {
      const tr = el('tr');
      tr.append(el('td', 'mono', r.marker));
      tr.append(el('td', '', r.type));
      tr.append(el('td', 'muted', String(r.count)));
      tr.append(el('td', 'mono', markerToPreview.get(r.marker) || '****'));
      tbody.append(tr);
    });
    table.append(thead, tbody);
    wrap.replaceChildren(table);
  }

  $('btnBackToRules').addEventListener('click', () => showPanel(2));

  /* ---------------- 步骤 4：应用与导出 ---------------- */

  $('btnApply').addEventListener('click', () => {
    try {
      const full = R.runPipeline(state.rawText, {
        enabledIds: state.enabledIds,
        decisions: state.decisions,
      });
      state.lastResult = full;
      renderExport(full);
      showPanel(4);
    } catch (err) {
      window.alert('生成脱敏副本时发生异常，请调整输入后重试');
    }
  });

  function renderExport(full) {
    const { report, maskedJsonl, redactionResult, findings } = full;
    $('maskedOutput').value = maskedJsonl;
    $('reportOutput').value = full.reportJson;

    const sum = $('exportSummary');
    sum.replaceChildren(
      card(redactionResult.totalRedacted, '已处理命中', 'ok'),
      card(redactionResult.totalKept, '明确保留（仍含原值）', redactionResult.totalKept ? 'warn' : 'ok'),
      card(redactionResult.distinctValues, '不同替代值数量'),
      card(report.importSummary.failedLines, '失败行（已保留原因）', report.importSummary.failedLines ? 'warn' : ''),
    );

    // 安全自检：所有将处理的原值不得出现在导出文本中
    const leaks = leakCheck(findings, maskedJsonl);
    const banner = $('safetyBanner');
    banner.classList.remove('safe', 'warn', 'unsafe');
    if (leaks.length) {
      banner.classList.add('unsafe');
      banner.textContent = `安全自检未通过：${leaks.length} 个应处理的值仍出现在导出内容中，请勿导出，并返回检查规则。`;
    } else if (redactionResult.totalKept > 0) {
      banner.classList.add('warn');
      banner.textContent = `安全自检通过，可以导出，但存在 ${redactionResult.totalKept} 处你明确选择「保留」的原始值，请确认接收方与用途后再交付。处理记录中不含任何原值。`;
    } else {
      banner.classList.add('safe');
      banner.textContent = '安全自检通过：导出的 JSONL 中未发现任何被规则命中的原始敏感值；处理记录不含原文，可随副本一并交付。';
    }

    renderChanges(report);
  }

  /**
   * 最终泄漏自检：从当前会话内存中的命中对象取出原值（仅内存比对，不落盘、不打印），
   * 逐一确认凡是 action=redact 的原值都不在导出文本中。
   */
  function leakCheck(findings, exportedText) {
    const leaked = [];
    const seen = new Set();
    // 需要从原始记录里按 finding 取回原值
    const ir = state.importResult;
    for (const f of findings) {
      if (decisionOf(f) === 'keep') continue;
      const raw = extractRaw(ir.records, f);
      if (raw === undefined || raw === null) continue;
      const needle = String(raw);
      if (!needle || seen.has(needle)) continue;
      seen.add(needle);
      if (exportedText.includes(needle)) leaked.push(needle);
    }
    return leaked;
  }

  function extractRaw(records, f) {
    const rec = records[f.recordIndex];
    if (!rec) return undefined;
    let cur = rec.value;
    for (const seg of f.pathSegments) {
      if (cur === null || typeof cur !== 'object') return undefined;
      cur = cur[seg];
    }
    if (f.mode === 'text' && typeof cur === 'string') return cur.slice(f.start, f.end);
    return cur;
  }

  function renderChanges(report) {
    const box = $('changesList');
    box.replaceChildren();
    if (!report.changes.length) {
      box.append(el('div', 'empty', '本批没有变更'));
      return;
    }
    report.changes.forEach((c) => {
      const node = el('div', 'change-item');
      node.append(el('div', 'head', `记录 #${c.recordIndex + 1} · 原始行号 ${c.line} · 处理 ${c.redacted} · 保留 ${c.kept}`));
      c.items.forEach((i) => {
        const pos = i.mode === 'text' ? ` [${i.start}-${i.end}]` : '';
        const line = el('div', 'change-detail');
        line.append(document.createTextNode(`${i.ruleId} · ${i.path}${pos} · `));
        if (i.action === 'keep') {
          line.append(el('span', 'kp', '保留原值'));
        } else {
          line.append(el('span', 'mk', i.marker));
        }
        node.append(line);
      });
      box.append(node);
    });
  }

  /* ---------------- 下载与再导入 ---------------- */

  function download(filename, text, mime) {
    const blob = new Blob([text], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  $('btnDownloadJsonl').addEventListener('click', () => {
    if (!state.lastResult) return;
    download(`masked-logs-${stamp()}.jsonl`, state.lastResult.maskedJsonl, 'application/x-ndjson');
  });
  $('btnDownloadReport').addEventListener('click', () => {
    if (!state.lastResult) return;
    download(`redaction-report-${stamp()}.json`, state.lastResult.reportJson, 'application/json');
  });

  $('btnReimportMasked').addEventListener('click', () => {
    if (!state.lastResult) return;
    const preview = R.preview(state.lastResult.maskedJsonl, state.enabledIds);
    const f = preview.findings.length;
    const fl = preview.importResult.failures.length;
    const keptCount = Object.values(state.decisions).filter((a) => a === 'keep').length;
    if (f === 0) {
      window.alert(`再导入验证通过：脱敏副本中 ${preview.importResult.records.length} 条记录零新命中，${fl} 行失败包装已保留。`);
    } else if (f <= keptCount) {
      window.alert(`再导入发现 ${f} 条命中，与你明确选择「保留」的 ${keptCount} 处原始值一致，属于预期；其余内容零新命中。失败包装 ${fl} 行。`);
    } else {
      window.alert(`再导入发现 ${f} 条新命中，多于保留项 ${keptCount} 处，请回到规则页检查是否有遗漏；失败包装 ${fl} 行。`);
    }
  });

  $('btnRestart').addEventListener('click', () => {
    Object.assign(state, {
      rawText: '',
      importResult: null,
      enabledIds: new Set(R.DEFAULT_ENABLED_IDS),
      findings: [],
      countByType: {},
      countByRule: {},
      decisions: {},
      lastResult: null,
    });
    $('rawInput').value = '';
    $('importSummary').hidden = true;
    $('scanSummary').hidden = true;
    setStatus($('importStatus'), '');
    setStatus($('scanStatus'), '');
    showPanel(1);
  });

  $('btnBackToReview').addEventListener('click', () => showPanel(3));

  // Tab 切换
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach((p) => p.classList.remove('active'));
      tab.classList.add('active');
      $(`tab-${tab.dataset.tab}`).classList.add('active');
    });
  });

  // 初始化
  showPanel(1);
})();
