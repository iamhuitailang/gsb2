/* UI  wiring：导入、渲染、导出。所有检查逻辑在 js/checks.js。 */
(function () {
  'use strict';

  const Checks = window.OidcChecks;
  const Examples = window.OidcExamples;

  /** 已导入环境：{ name, expectedIssuer, discovery, snapshots: [{label, jwks}] } */
  const environments = [];
  let selectedName = null;

  /* ---------- 工具 ---------- */

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function severityLabel(sev) {
    return Checks.SEVERITY_LABEL[sev] || sev;
  }

  function badge(sev) {
    return `<span class="badge ${sev}">${severityLabel(sev)}</span>`;
  }

  function findEnv(name) {
    return environments.find(function (e) { return e.name === name; }) || null;
  }

  function downloadJson(obj, filename) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function readFileAsJson(file) {
    return file.text().then(function (text) {
      try {
        return { ok: true, value: JSON.parse(text) };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    });
  }

  /* ---------- 导入校验（任一错误则整体拒绝，不覆盖已有配置） ---------- */

  function validateNewEnvironment(name, expectedIssuer, discovery, snapshots) {
    const errors = [];
    if (!name) errors.push('环境名称不能为空。');
    if (name && findEnv(name)) {
      errors.push(`环境 "${name}" 已存在，本次导入被拒绝，已有配置未被覆盖。如需重新导入请先删除该环境。`);
    }
    if (!expectedIssuer) errors.push('预期签发者不能为空。');
    if (!discovery) {
      errors.push('缺少发现文档，无法导入。');
    } else if (typeof discovery !== 'object' || discovery === null || Array.isArray(discovery)) {
      errors.push('发现文档必须是一个 JSON 对象。');
    }
    if (snapshots.length === 0) errors.push('至少需要一份 JWKS 快照。');
    const labels = new Set();
    for (const s of snapshots) {
      if (labels.has(s.label)) {
        errors.push(`JWKS 快照标签 "${s.label}" 重复，请重命名文件后再导入。`);
      }
      labels.add(s.label);
      if (typeof s.jwks !== 'object' || s.jwks === null || !Array.isArray(s.jwks.keys)) {
        errors.push(`快照 "${s.label}" 不是合法的 JWKS（缺少 keys 数组）。`);
      }
    }
    return errors;
  }

  function addEnvironment(env) {
    environments.push(env);
    selectedName = env.name;
    render();
  }

  /* ---------- 渲染 ---------- */

  function renderFinding(f) {
    let html = `<li>${badge(f.severity)}<span class="msg">${escapeHtml(f.message)}</span><span class="code">${escapeHtml(f.code)}</span>`;
    if (f.evidence) {
      html += `<pre class="evidence">${escapeHtml(JSON.stringify(f.evidence, null, 2))}</pre>`;
    }
    return html + '</li>';
  }

  function renderFindings(findings) {
    if (findings.length === 0) return '<p class="meta">无检查项。</p>';
    return `<ul class="findings">${findings.map(renderFinding).join('')}</ul>`;
  }

  function kidChips(kids, cls) {
    if (kids.length === 0) return '<span class="meta">（无）</span>';
    return kids.map(function (k) {
      return `<span class="kid-chip ${cls}">${escapeHtml(k)}</span>`;
    }).join('');
  }

  function renderComparison(c) {
    return `
      <div class="comparison-block">
        <h4>${escapeHtml(c.from)} → ${escapeHtml(c.to)} ${badge(c.verdict)}</h4>
        <div class="kid-groups">
          <div class="kid-group"><span class="label">新增</span>${kidChips(c.added, 'added')}</div>
          <div class="kid-group"><span class="label">保留</span>${kidChips(c.retained, 'retained')}</div>
          <div class="kid-group"><span class="label">移除</span>${kidChips(c.removed, 'removed')}</div>
          <div class="kid-group"><span class="label">同标识被替换</span>${kidChips(c.replaced, 'replaced')}</div>
        </div>
        ${renderFindings(c.findings)}
      </div>`;
  }

  function renderDetail() {
    const el = document.getElementById('detail');
    const env = findEnv(selectedName);
    if (!env) {
      el.innerHTML = '<p class="placeholder">请从左侧导入环境或载入示例，然后选择一个环境查看检查结论。</p>';
      return;
    }
    const report = Checks.evaluateEnvironment(env);

    const snapshotsHtml = report.snapshots.map(function (s) {
      return `<div class="snapshot-block"><h4>${escapeHtml(s.label)} ${badge(s.verdict)}</h4>${renderFindings(s.findings)}</div>`;
    }).join('');

    const comparisonsHtml = report.comparisons.length === 0
      ? '<p class="meta">仅有一份快照，无对比。追加另一时间的快照后可比较密钥变化。</p>'
      : report.comparisons.map(renderComparison).join('');

    el.innerHTML = `
      <h2>${escapeHtml(report.name)} ${badge(report.verdict)}</h2>
      <p class="meta">预期签发者：<code>${escapeHtml(report.expectedIssuer)}</code> · 快照数：${env.snapshots.length}</p>
      <div class="actions">
        <button type="button" class="secondary" data-action="export-one">导出该环境结果 (JSON)</button>
        <label class="secondary file-label">追加 JWKS 快照
          <input type="file" id="append-jwks" accept=".json,application/json" multiple hidden>
        </label>
        <button type="button" class="danger" data-action="delete">删除环境</button>
      </div>
      <div id="append-errors" class="errors" hidden></div>
      <h3>发现文档检查</h3>
      ${renderFindings(report.discoveryFindings)}
      <h3>JWKS 快照检查</h3>
      ${snapshotsHtml}
      <h3>快照对比（密钥轮换）</h3>
      ${comparisonsHtml}
    `;

    el.querySelector('[data-action="export-one"]').addEventListener('click', function () {
      downloadJson(report, `oidc-check-${env.name}.json`);
    });
    el.querySelector('[data-action="delete"]').addEventListener('click', function () {
      const i = environments.indexOf(env);
      if (i !== -1) environments.splice(i, 1);
      selectedName = environments.length ? environments[0].name : null;
      render();
    });
    el.querySelector('#append-jwks').addEventListener('change', function (ev) {
      appendSnapshots(env, Array.from(ev.target.files));
    });
  }

  function renderEnvList() {
    const ul = document.getElementById('env-list');
    if (environments.length === 0) {
      ul.innerHTML = '<li class="meta">尚未导入任何环境。</li>';
      return;
    }
    ul.innerHTML = environments.map(function (env) {
      const report = Checks.evaluateEnvironment(env);
      const active = env.name === selectedName ? ' class="active"' : '';
      return `<li${active} data-name="${escapeHtml(env.name)}"><span class="env-name">${escapeHtml(env.name)}</span>${badge(report.verdict)}</li>`;
    }).join('');
    ul.querySelectorAll('li[data-name]').forEach(function (li) {
      li.addEventListener('click', function () {
        selectedName = li.getAttribute('data-name');
        render();
      });
    });
  }

  function renderExamples() {
    const box = document.getElementById('example-buttons');
    box.innerHTML = '';
    for (const scenario of Examples.scenarios) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = scenario.title;
      btn.title = scenario.description;
      btn.addEventListener('click', function () {
        loadExample(scenario);
      });
      box.appendChild(btn);
    }
  }

  function render() {
    renderEnvList();
    renderDetail();
  }

  function showImportErrors(errors) {
    const box = document.getElementById('import-errors');
    if (errors.length === 0) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    box.hidden = false;
    box.innerHTML = `<ul>${errors.map(function (e) { return `<li>${escapeHtml(e)}</li>`; }).join('')}</ul>`;
  }

  /* ---------- 示例与导入 ---------- */

  function loadExample(scenario) {
    const env = JSON.parse(JSON.stringify(scenario.env)); // 深拷贝，避免示例数据被修改
    const errors = validateNewEnvironment(env.name, env.expectedIssuer, env.discovery, env.snapshots);
    if (errors.length > 0) {
      showImportErrors(errors);
      return;
    }
    showImportErrors([]);
    addEnvironment(env);
  }

  function appendSnapshots(env, files) {
    const box = document.getElementById('append-errors');
    if (files.length === 0) return;
    Promise.all(files.map(function (f) {
      return readFileAsJson(f).then(function (r) {
        return { file: f, result: r };
      });
    })).then(function (items) {
      const errors = [];
      const parsed = [];
      for (const item of items) {
        if (!item.result.ok) {
          errors.push(`文件 "${item.file.name}" 不是合法 JSON：${item.result.error}`);
        } else if (typeof item.result.value !== 'object' || item.result.value === null || !Array.isArray(item.result.value.keys)) {
          errors.push(`文件 "${item.file.name}" 不是合法的 JWKS（缺少 keys 数组）。`);
        } else if (env.snapshots.some(function (s) { return s.label === item.file.name; })) {
          errors.push(`快照标签 "${item.file.name}" 已存在于环境 "${env.name}"，未覆盖。`);
        } else {
          parsed.push({ label: item.file.name, jwks: item.result.value });
        }
      }
      if (errors.length > 0) {
        box.hidden = false;
        box.innerHTML = `<ul>${errors.map(function (e) { return `<li>${escapeHtml(e)}</li>`; }).join('')}</ul>`;
        return; // 有错误则整批不追加
      }
      for (const p of parsed) env.snapshots.push(p);
      render();
    });
  }

  document.getElementById('import-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    const name = document.getElementById('env-name').value.trim();
    const expectedIssuer = document.getElementById('expected-issuer').value.trim();
    const discoveryFile = document.getElementById('discovery-file').files[0] || null;
    const jwksFiles = Array.from(document.getElementById('jwks-files').files);

    const earlyErrors = [];
    if (!discoveryFile) earlyErrors.push('请选择发现文档文件。');
    if (jwksFiles.length === 0) earlyErrors.push('请至少选择一份 JWKS 快照文件。');
    if (earlyErrors.length > 0) {
      showImportErrors(earlyErrors);
      return;
    }

    const reads = [readFileAsJson(discoveryFile)].concat(jwksFiles.map(readFileAsJson));
    Promise.all(reads).then(function (results) {
      const errors = [];
      let discovery = null;
      if (!results[0].ok) {
        errors.push(`发现文档文件 "${discoveryFile.name}" 不是合法 JSON：${results[0].error}`);
      } else {
        discovery = results[0].value;
      }
      const snapshots = [];
      for (let i = 0; i < jwksFiles.length; i++) {
        const r = results[i + 1];
        if (!r.ok) {
          errors.push(`JWKS 文件 "${jwksFiles[i].name}" 不是合法 JSON：${r.error}`);
        } else {
          snapshots.push({ label: jwksFiles[i].name, jwks: r.value });
        }
      }
      if (errors.length === 0) {
        errors.push.apply(errors, validateNewEnvironment(name, expectedIssuer, discovery, snapshots));
      }
      if (errors.length > 0) {
        showImportErrors(errors);
        return;
      }
      showImportErrors([]);
      addEnvironment({ name, expectedIssuer, discovery, snapshots });
      ev.target.reset();
    });
  });

  document.getElementById('export-all').addEventListener('click', function () {
    if (environments.length === 0) {
      showImportErrors(['尚未导入任何环境，没有可导出的检查结果。']);
      return;
    }
    downloadJson(Checks.buildReport(environments), 'oidc-check-report.json');
  });

  renderExamples();
  render();
})();
