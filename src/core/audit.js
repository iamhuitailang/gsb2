/**
 * 审计模块：生成可追溯的处理记录与导出文件。
 *
 * 红线：审计对象中的任何字段都不保存原始敏感值——
 *  只保存规则、路径、类型、数量、偏移与替代标记（标记本身不是敏感值）。
 * 因此审计报告可随脱敏副本一起交付，不构成二次泄漏。
 */
(function (root, factory) {
  let deps;
  if (typeof module === 'object' && module.exports) {
    deps = Object.assign(
      {},
      require('./rules.js'),
      require('./scanner.js'),
      require('./redactor.js'),
      require('./importer.js'),
    );
    module.exports = factory(deps);
  } else {
    root.SanLog = root.SanLog || {};
    Object.assign(root.SanLog, factory(root.SanLog));
  }
})(typeof self !== 'undefined' ? self : this, function (R) {
  'use strict';

  const REPORT_FORMAT = 'sanlog-audit/1';

  function makeId() {
    try {
      if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    } catch (_) {
      /* 浏览器非安全上下文时降级 */
    }
    return `rpt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function ruleSnapshot(enabledIds) {
    const enabled = enabledIds instanceof Set ? enabledIds : new Set(enabledIds);
    const all = [...R.FIELD_RULES, ...R.PATTERN_RULES];
    return {
      ruleVersion: R.RULE_VERSION,
      enabled: all.filter((r) => enabled.has(r.id)).map((r) => ({
        id: r.id,
        kind: R.FIELD_RULES.includes(r) ? 'field' : 'pattern',
        type: r.type,
        label: r.label,
        description: r.description,
      })),
      disabled: all.filter((r) => !enabled.has(r.id)).map((r) => ({
        id: r.id,
        kind: R.FIELD_RULES.includes(r) ? 'field' : 'pattern',
        type: r.type,
        label: r.label,
        description: r.description,
      })),
    };
  }

  /**
   * 构建审计报告。
   * @param {object} p
   * @param {Set} p.enabledIds 启用规则
   * @param {object} p.importResult parseInput 的结果
   * @param {Array} p.findings 扫描命中（本身不含原值）
   * @param {object} p.redactionResult applyRedactions 的结果
   * @param {object} p.decisions 逐项保留/处理决定
   * @param {string} [p.createdAt] 可注入时间，便于测试
   */
  function buildReport(p) {
    const { enabledIds, importResult, findings, redactionResult, decisions } = p;
    const snapshot = ruleSnapshot(enabledIds);

    const findingsByRule = {};
    const findingsByType = {};
    for (const f of findings) {
      findingsByRule[f.ruleId] = (findingsByRule[f.ruleId] || 0) + 1;
      findingsByType[f.type] = (findingsByType[f.type] || 0) + 1;
    }

    return {
      reportFormat: REPORT_FORMAT,
      reportId: makeId(),
      ruleVersion: R.RULE_VERSION,
      createdAt: p.createdAt || new Date().toISOString(),
      rules: snapshot,
      importSummary: {
        totalLines: importResult.totalLines,
        processableRecords: importResult.records.length,
        failedLines: importResult.failures.length,
        blankLines: importResult.blankLines,
      },
      detection: {
        totalFindings: findings.length,
        findingsByRule,
        findingsByType,
      },
      processing: {
        redacted: redactionResult.totalRedacted,
        kept: redactionResult.totalKept,
        distinctReplacementValues: redactionResult.distinctValues,
        countByType: redactionResult.countByType,
        countByRule: redactionResult.countByRule,
      },
      decisions: findings.map((f) => ({
        decisionKey: f.decisionKey,
        action: (decisions && decisions[f.decisionKey]) || 'redact',
      })),
      changes: redactionResult.changes,
      failures: importResult.failures.map((f) => ({
        line: f.line,
        reason: f.reason,
        rawLength: f.rawLength || 0,
        reimported: !!f.reimported,
      })),
      safetyNote: '本报告不包含任何原始敏感值，仅含规则、路径、类型、偏移与替代标记',
    };
  }

  /** 脱敏 jsonl 文本：成功记录 + 失败行包装对象逐行输出，失败不静默丢弃 */
  function buildMaskedJsonl(redactionResult, importResult) {
    const lines = [];
    // 按原始行号归并，保持导入时的相对顺序
    const successByLine = new Map(redactionResult.output.map((o) => [o.line, o.value]));
    const allLines = [
      ...redactionResult.output.map((o) => ({ line: o.line, kind: 'ok' })),
      ...importResult.failures.map((f) => ({ line: f.line, kind: 'fail', failure: f })),
    ].sort((a, b) => a.line - b.line);

    for (const item of allLines) {
      if (item.kind === 'ok') {
        lines.push(JSON.stringify(successByLine.get(item.line)));
      } else {
        lines.push(JSON.stringify(R.buildFailureEntry(item.failure)));
      }
    }
    return lines.join('\n') + (lines.length ? '\n' : '');
  }

  /** 审计报告 JSON 文本（不含原文） */
  function buildReportJson(report) {
    return JSON.stringify(report, null, 2) + '\n';
  }

  /** 读取报告文件：校验格式，返回报告对象；格式不符时抛出可理解错误（不含任何用户数据） */
  function parseReport(text) {
    let obj;
    try {
      obj = JSON.parse(text);
    } catch (e) {
      throw new Error('审计记录不是合法 JSON，无法读取');
    }
    if (!obj || obj.reportFormat !== REPORT_FORMAT || !obj.rules || !obj.processing) {
      throw new Error('缺少 sanlog 审计记录标识（reportFormat），不是本工具生成的处理记录');
    }
    return obj;
  }

  return {
    REPORT_FORMAT,
    buildReport,
    buildMaskedJsonl,
    buildReportJson,
    parseReport,
    ruleSnapshot,
  };
});
