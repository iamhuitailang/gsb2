/*
 * app.js — 页面交互：读取输入、调用 csp.js 评估、渲染结果。
 * 安全约定：所有用户输入只通过 textContent 渲染，绝不拼接 HTML、绝不 eval。
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  function el(tag, className, text) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
  }

  /* ---------------- 样例 ---------------- */

  function initSamples() {
    var select = $('sampleSelect');
    (window.CSP_SAMPLES || []).forEach(function (s, i) {
      var opt = el('option', null, s.name);
      opt.value = String(i);
      select.appendChild(opt);
    });
    $('loadSampleBtn').addEventListener('click', function () {
      var s = window.CSP_SAMPLES[Number(select.value)];
      if (!s) return;
      $('pageUrl').value = s.pageUrl;
      $('policies').value = s.policies.join('\n');
      $('resources').value = s.resources;
      $('sampleDesc').textContent = s.description;
      runCheck();
    });
  }

  /* ---------------- 主流程 ---------------- */

  function runCheck() {
    var out = { errors: [] };

    // 1. 页面地址
    var pageOrigin = null;
    try {
      pageOrigin = CSP.parsePageOrigin($('pageUrl').value.trim());
    } catch (e) {
      out.errors.push('页面地址无效：' + $('pageUrl').value.trim());
    }

    // 2. 策略（每行一条，互不影响地解析）
    var policyTexts = $('policies').value.split('\n')
      .map(function (l) { return l.trim(); })
      .filter(function (l) { return l.length > 0; });
    var policies = policyTexts.map(function (t) { return CSP.parsePolicy(t); });

    // 3. 资源清单（逐行解析，单行出错不影响其他行）
    var resources = [];
    $('resources').value.split('\n').forEach(function (line, idx) {
      if (!line.trim()) return;
      try {
        var parsed = CSP.parseResourceLine(line);
        if (!parsed) return;
        var resource = {
          type: parsed.type, target: parsed.target, inline: parsed.inline,
          nonce: parsed.nonce, hash: parsed.hash, raw: parsed.raw, line: idx + 1, url: null
        };
        if (!parsed.inline && pageOrigin) {
          resource.url = CSP.parseUrl(parsed.target, $('pageUrl').value.trim());
        }
        resources.push(resource);
      } catch (e) {
        resources.push({ error: e.message, raw: line.trim(), line: idx + 1 });
      }
    });

    // 4. 评估
    var evaluations = [];
    if (pageOrigin && policies.length > 0) {
      resources.forEach(function (r) {
        if (r.error) {
          evaluations.push({ resource: r, result: null });
        } else if (r.inline || r.url) {
          evaluations.push({ resource: r, result: CSP.evaluateResource(policies, r, pageOrigin) });
        }
      });
    } else if (policies.length === 0) {
      out.errors.push('请至少输入一条策略。');
    }

    renderPolicyAnalysis(policies);
    renderResults(evaluations, policies.length);
    renderStats(evaluations, policies.length);
    renderErrors(out.errors);
  }

  /* ---------------- 渲染 ---------------- */

  function renderErrors(errors) {
    var box = $('errors');
    box.textContent = '';
    errors.forEach(function (msg) {
      box.appendChild(el('div', 'error-banner', msg));
    });
  }

  function renderPolicyAnalysis(policies) {
    var box = $('policyAnalysis');
    box.textContent = '';
    if (policies.length === 0) {
      box.appendChild(el('p', 'muted', '尚未输入策略。'));
      return;
    }
    policies.forEach(function (p, i) {
      var card = el('div', 'policy-card');
      card.appendChild(el('h3', null, '策略 ' + (i + 1)));
      card.appendChild(el('code', 'policy-raw', p.text));
      var info = el('p', 'muted',
        '解析出 ' + p.directives.size + ' 条生效指令，' + p.warnings.length + ' 条提示');
      card.appendChild(info);
      if (p.warnings.length === 0) {
        card.appendChild(el('p', 'ok-text', '未发现格式问题。'));
      } else {
        var ul = el('ul', 'warning-list');
        p.warnings.forEach(function (w) {
          ul.appendChild(el('li', 'warn-' + w.level, '[' + (w.level === 'warn' ? '警告' : '提示') + '] ' + w.message));
        });
        card.appendChild(ul);
      }
      box.appendChild(card);
    });
  }

  function verdictText(result) {
    if (result.allowed) return '允许';
    var blockers = result.perPolicy
      .filter(function (p) { return !p.allowed; })
      .map(function (p) { return '策略 ' + (p.index + 1); });
    return '阻止（' + blockers.join('、') + '）';
  }

  function renderResults(evaluations, policyCount) {
    var tbody = $('resultBody');
    tbody.textContent = '';
    if (evaluations.length === 0) {
      var tr = el('tr');
      var td = el('td', 'muted', '暂无结果。');
      td.colSpan = 5;
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }
    evaluations.forEach(function (ev, i) {
      var r = ev.resource;
      var tr = el('tr');
      tr.appendChild(el('td', null, String(i + 1)));
      tr.appendChild(el('td', null, r.type || '—'));

      var targetTd = el('td', 'target-cell');
      targetTd.appendChild(el('code', null, r.raw));
      tr.appendChild(targetTd);

      if (r.error) {
        tr.appendChild(el('td', null, '')).appendChild(el('span', 'badge badge-error', '输入错误'));
        var reasonTd = el('td');
        reasonTd.appendChild(el('span', 'warn-warn', r.error));
        tr.appendChild(reasonTd);
        tbody.appendChild(tr);
        return;
      }

      var res = ev.result;
      var verdictTd = el('td');
      verdictTd.appendChild(el('span',
        'badge ' + (res.allowed ? 'badge-allow' : 'badge-block'),
        verdictText(res)));
      tr.appendChild(verdictTd);

      var basisTd = el('td');
      res.perPolicy.forEach(function (p) {
        var line = el('div', 'policy-line ' + (p.allowed ? 'line-allow' : 'line-block'));
        var mark = p.allowed ? '✓' : '✗';
        var text = '策略 ' + (p.index + 1) + ' ' + mark + ' ';
        if (!p.directiveName) {
          text += p.reason;
        } else {
          text += p.directiveName;
          if (p.usedFallback) text += '（经 default-src 回退）';
          text += '：' + p.reason;
        }
        line.textContent = text;
        basisTd.appendChild(line);
      });
      tr.appendChild(basisTd);
      tbody.appendChild(tr);
    });
  }

  function renderStats(evaluations, policyCount) {
    var box = $('stats');
    box.textContent = '';
    var total = evaluations.length;
    var allowed = 0, blocked = 0, errors = 0;
    var byType = {};
    evaluations.forEach(function (ev) {
      if (ev.resource.error || !ev.result) { errors++; return; }
      if (ev.result.allowed) allowed++; else blocked++;
      var t = ev.resource.type;
      byType[t] = byType[t] || { allowed: 0, blocked: 0 };
      byType[t][ev.result.allowed ? 'allowed' : 'blocked']++;
    });

    var chips = el('div', 'stat-chips');
    chips.appendChild(el('span', 'chip', '策略数：' + policyCount));
    chips.appendChild(el('span', 'chip', '资源总数：' + total));
    chips.appendChild(el('span', 'chip chip-allow', '允许：' + allowed));
    chips.appendChild(el('span', 'chip chip-block', '阻止：' + blocked));
    if (errors > 0) chips.appendChild(el('span', 'chip chip-error', '输入错误：' + errors));
    box.appendChild(chips);

    var types = Object.keys(byType);
    if (types.length > 0) {
      var detail = el('div', 'stat-detail');
      detail.appendChild(el('span', 'muted', '按类型：'));
      types.forEach(function (t) {
        detail.appendChild(el('span', 'chip',
          t + ' 允许 ' + byType[t].allowed + ' / 阻止 ' + byType[t].blocked));
      });
      box.appendChild(detail);
    }
  }

  /* ---------------- 事件绑定 ---------------- */

  document.addEventListener('DOMContentLoaded', function () {
    initSamples();
    $('runBtn').addEventListener('click', runCheck);
    $('clearBtn').addEventListener('click', function () {
      $('policies').value = '';
      $('resources').value = '';
      $('sampleDesc').textContent = '';
      runCheck();
    });
    runCheck();
  });
})();
