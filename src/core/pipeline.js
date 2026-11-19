/**
 * 流水线编排：把导入、扫描、脱敏、审计四个核心模块串成一次完整处理。
 * 纯函数风格，所有状态由调用方持有；本模块不访问文件系统或网络。
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
      require('./audit.js'),
    );
    module.exports = factory(deps);
  } else {
    root.SanLog = root.SanLog || {};
    Object.assign(root.SanLog, factory(root.SanLog));
  }
})(typeof self !== 'undefined' ? self : this, function (R) {
  'use strict';

  /**
   * 一次完整处理。
   * @param {string} rawText 原始多行日志
   * @param {object} [opts]
   * @param {Set|string[]} [opts.enabledIds] 启用规则；缺省用默认规则集
   * @param {Object<string,'redact'|'keep'>} [opts.decisions] 逐项决定
   * @param {string} [opts.createdAt] 注入时间（测试用）
   */
  function runPipeline(rawText, opts) {
    const options = opts || {};
    const enabledIds =
      options.enabledIds instanceof Set
        ? options.enabledIds
        : new Set(options.enabledIds || R.DEFAULT_ENABLED_IDS);
    const decisions = options.decisions || {};

    const importResult = R.parseInput(rawText);
    const scanResult = R.scan(importResult.records, enabledIds);
    const redactionResult = R.applyRedactions(importResult.records, scanResult.findings, decisions);
    const report = R.buildReport({
      enabledIds,
      importResult,
      findings: scanResult.findings,
      redactionResult,
      decisions,
      createdAt: options.createdAt,
    });

    return {
      importResult,
      enabledIds,
      findings: scanResult.findings,
      countByRule: scanResult.countByRule,
      countByType: scanResult.countByType,
      redactionResult,
      report,
      maskedJsonl: R.buildMaskedJsonl(redactionResult, importResult),
      reportJson: R.buildReportJson(report),
    };
  }

  /** 只重新扫描（规则启停、导入后预览），不生成脱敏副本 */
  function preview(rawText, enabledIds) {
    const ids = enabledIds instanceof Set ? enabledIds : new Set(enabledIds || R.DEFAULT_ENABLED_IDS);
    const importResult = R.parseInput(rawText);
    const scanResult = R.scan(importResult.records, ids);
    return {
      importResult,
      enabledIds: ids,
      findings: scanResult.findings,
      countByRule: scanResult.countByRule,
      countByType: scanResult.countByType,
    };
  }

  return { runPipeline, preview };
});
