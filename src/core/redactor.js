/**
 * 脱敏引擎：根据审查决定（redact / keep）生成脱敏副本。
 *
 * 关键保证：
 *  - 同一类型 + 同一原始值在整批数据中复用同一个替代标记（[REDACTED:TYPE:序号]），
 *    不同值序号不同，不会因截断或格式相似而混淆；
 *  - 只动命中位置，其他字段（含数字、布尔、null、业务编号、日期）原样保留；
 *  - 同一字符串内多个片段命中按区间从后向前替换，区间互不重叠（扫描器已去重）；
 *  - 输出结构与输入一致，仅敏感叶子/子树变为字符串标记；
 *  - 变更摘要只含路径、规则、类型、标记与偏移，不含原始敏感值。
 */
(function (root, factory) {
  let deps;
  if (typeof module === 'object' && module.exports) {
    deps = Object.assign({}, require('./rules.js'), require('./scanner.js'));
    module.exports = factory(deps);
  } else {
    root.SanLog = root.SanLog || {};
    Object.assign(root.SanLog, factory(root.SanLog));
  }
})(typeof self !== 'undefined' ? self : this, function (R) {
  'use strict';

  function getAt(root, segments) {
    let cur = root;
    for (const seg of segments) {
      if (cur === null || typeof cur !== 'object') return undefined;
      cur = cur[seg];
    }
    return cur;
  }

  function setAt(root, segments, value) {
    const parent = getAt(root, segments.slice(0, -1));
    if (parent === null || typeof parent !== 'object') return false;
    parent[segments[segments.length - 1]] = value;
    return true;
  }

  function deepClone(value) {
    // 现代浏览器/Node 均内置 structuredClone；老环境降级为 JSON 拷贝
    // （本工具处理的是 JSON 数据，JSON 拷贝可完整覆盖其类型语义）
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  /**
   * @param {Array<{line:number, value:*}>} records 可处理记录
   * @param {Array} findings 扫描命中
   * @param {Object<string,'redact'|'keep'>} decisions 按 decisionKey 给出的逐项决定，缺省视为 redact
   */
  function applyRedactions(records, findings, decisions) {
    const decide = decisions || {};
    const output = records.map((r) => ({ line: r.line, value: deepClone(r.value) }));
    const valueMap = new Map(); // `${TYPE} ${RAW}` -> 序号
    const typeSeq = Object.create(null);
    const countByType = Object.create(null);
    const countByRule = Object.create(null);
    const changes = [];
    let totalRedacted = 0;
    let totalKept = 0;

    function markerFor(type, raw) {
      const key = `${type} ${String(raw)}`;
      let seq = valueMap.get(key);
      if (seq === undefined) {
        const prefix = R.TYPE_PREFIX[type] || 'VALUE';
        seq = (typeSeq[prefix] || 0) + 1;
        typeSeq[prefix] = seq;
        valueMap.set(key, seq);
      }
      if (!countByType[type]) countByType[type] = 0;
      return `[REDACTED:${R.TYPE_PREFIX[type] || 'VALUE'}:${String(seq).padStart(4, '0')}]`;
    }

    // 按记录分组
    const byRecord = new Map();
    for (const f of findings) {
      if (!byRecord.has(f.recordIndex)) byRecord.set(f.recordIndex, []);
      byRecord.get(f.recordIndex).push(f);
    }

    for (const [recordIndexStr, group] of byRecord) {
      const recordIndex = Number(recordIndexStr);
      const recordChange = {
        recordIndex,
        line: records[recordIndex].line,
        redacted: 0,
        kept: 0,
        items: [],
      };

      // 同一文本路径的 text 命中需要合并后一次替换
      const textGroups = new Map();
      const wholeHits = [];
      for (const f of group) {
        if ((decide[f.decisionKey] || 'redact') === 'keep') {
          totalKept += 1;
          recordChange.kept += 1;
          recordChange.items.push({
            path: f.path,
            ruleId: f.ruleId,
            type: f.type,
            mode: f.mode,
            action: 'keep',
            start: f.start,
            end: f.end,
          });
          continue;
        }
        if (f.mode === 'text') {
          const pk = f.path;
          if (!textGroups.has(pk)) textGroups.set(pk, []);
          textGroups.get(pk).push(f);
        } else {
          wholeHits.push(f);
        }
      }

      const root = output[recordIndex].value;

      // 根级（segments 为空）命中只能是标量字符串的文本命中，直接替换整条记录值
      const writeValue = (segments, value) => {
        if (segments.length === 0) output[recordIndex].value = value;
        else setAt(root, segments, value);
      };

      for (const f of wholeHits) {
        const raw = getAt(records[recordIndex].value, f.pathSegments);
        // 防御：已是标记的内容绝不再处理（正常情况下扫描器不会产出此类命中）
        if (R.isRedactionMarker(raw) || (typeof raw === 'string' && R.REDACTION_MARKER_RE.test(raw))) {
          continue;
        }
        const marker = markerFor(f.type, raw);
        writeValue(f.pathSegments, marker);
        totalRedacted += 1;
        recordChange.redacted += 1;
        countByRule[f.ruleId] = (countByRule[f.ruleId] || 0) + 1;
        recordChange.items.push({
          path: f.path,
          ruleId: f.ruleId,
          type: f.type,
          mode: f.mode,
          action: 'redact',
          marker,
        });
      }

      for (const [path, textFindings] of textGroups) {
        const segments = textFindings[0].pathSegments;
        const original = getAt(records[recordIndex].value, segments);
        if (typeof original !== 'string') continue;
        // 先为每个区间解析一致标记，再从后向前拼接，避免偏移失效
        const intervals = textFindings
          .slice()
          .sort((a, b) => a.start - b.start)
          .map((f) => ({
            start: f.start,
            end: f.end,
            marker: markerFor(f.type, original.slice(f.start, f.end)),
            finding: f,
          }));
        let result = original;
        for (let i = intervals.length - 1; i >= 0; i--) {
          const iv = intervals[i];
          result = result.slice(0, iv.start) + iv.marker + result.slice(iv.end);
          totalRedacted += 1;
          recordChange.redacted += 1;
          const f = iv.finding;
          countByRule[f.ruleId] = (countByRule[f.ruleId] || 0) + 1;
          recordChange.items.push({
            path: f.path,
            ruleId: f.ruleId,
            type: f.type,
            mode: 'text',
            action: 'redact',
            start: f.start,
            end: f.end,
            marker: iv.marker,
          });
        }
        writeValue(segments, result);
      }

      if (recordChange.items.length > 0) changes.push(recordChange);
    }

    return {
      output,
      changes,
      countByType,
      countByRule,
      totalRedacted,
      totalKept,
      distinctValues: valueMap.size,
    };
  }

  return { applyRedactions, getAt, setAt };
});
