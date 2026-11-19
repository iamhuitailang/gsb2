/**
 * 扫描引擎：在保留原始结构的前提下递归遍历每条 JSON 记录，产出命中清单。
 *
 * 三种命中模式：
 *  - field：字段名命中（可作用于叶子或整个敏感子树，子树命中后不再下钻）
 *  - value：某条模式规则完整匹配整个叶子值（整值替换）
 *  - text ：字符串内部的片段命中（带 start/end 偏移，同文本可多次命中）
 *
 * 安全约定：finding 不保存原始值，仅保存脱敏预览与长度；因此 finding 列表可安全写入审计记录。
 */
(function (root, factory) {
  let deps;
  if (typeof module === 'object' && module.exports) {
    deps = Object.assign({}, require('./rules.js'));
    module.exports = factory(deps);
  } else {
    root.SanLog = root.SanLog || {};
    Object.assign(root.SanLog, factory(root.SanLog));
  }
})(typeof self !== 'undefined' ? self : this, function (R) {
  'use strict';

  /** 路径段数组 -> 可定位字符串，如 user.emails[0] */
  function pathString(segments) {
    let out = '';
    for (const seg of segments) {
      if (typeof seg === 'number') out += `[${seg}]`;
      else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(seg)) out += out ? `.${seg}` : String(seg);
      else out += `[${JSON.stringify(seg)}]`;
    }
    return out || '$';
  }

  function decisionKeyOf(recordIndex, segments, mode, ruleId, start, end) {
    const pos = mode === 'text' ? `:${start}-${end}` : '';
    return `${recordIndex}|${pathString(segments)}|${ruleId}${pos}`;
  }

  /** 已脱敏标记在文本中占据的区间：任何新命中不得覆盖这些区间 */
  function markerRangesOf(s) {
    const ranges = [];
    R.REDACTION_MARKER_IN_TEXT_RE.lastIndex = 0;
    let m;
    while ((m = R.REDACTION_MARKER_IN_TEXT_RE.exec(s)) !== null) {
      ranges.push([m.index, m.index + m[0].length]);
    }
    return ranges;
  }

  function overlapsAny(start, end, ranges) {
    return ranges.some(([a, b]) => start < b && end > a);
  }

  /**
   * 扫描整批解析结果。
   * @param {Array<{line:number, value:*}>} records
   * @param {Set<string>} enabledIds 启用的规则 id 集合
   * @returns {{findings: Array, countByRule: Object, countByType: Object}}
   */
  function scan(records, enabledIds) {
    const enabled = enabledIds instanceof Set ? enabledIds : new Set(enabledIds);
    const findings = [];
    const countByRule = {};
    const countByType = {};
    let seq = 0;

    const activePatterns = R.PATTERN_RULES.filter((rule) => enabled.has(rule.id)).map((rule, priority) => ({
      rule,
      priority,
    }));

    records.forEach((rec, recordIndex) => {
      // 顶层即标量（裸字符串/数字等合法 JSON）也要做内容扫描
      if (rec.value !== null && typeof rec.value === 'string' && !R.isRedactionMarker(rec.value)) {
        scanString(rec.value, [], recordIndex, activePatterns);
      }
      walk(rec.value, [], recordIndex);
    });

    function pushFinding(f) {
      f.id = `F${String(++seq).padStart(4, '0')}`;
      f.decisionKey = decisionKeyOf(f.recordIndex, f.pathSegments, f.mode, f.ruleId, f.start, f.end);
      findings.push(f);
      countByRule[f.ruleId] = (countByRule[f.ruleId] || 0) + 1;
      countByType[f.type] = (countByType[f.type] || 0) + 1;
    }

    function walk(node, segments, recordIndex) {
      if (node === null || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach((item, i) => visitChild(item, segments.concat(i), String(i), recordIndex));
      } else {
        for (const key of Object.keys(node)) {
          visitChild(node[key], segments.concat(key), key, recordIndex);
        }
      }
    }

    function visitChild(value, segments, rawKey, recordIndex) {
      // 1) 字段名规则优先；命中叶子直接产出 field 命中，命中容器则替换整棵子树
      const fieldRule = R.matchFieldName(rawKey);
      if (fieldRule && enabledIds.has(fieldRule.id)) {
        // 已脱敏标记绝不再判定为原始敏感值（支持导出后重新导入、更换规则再处理）
        if (R.isRedactionMarker(value)) return;
        if (value !== null && typeof value === 'object') {
          pushFinding({
            recordIndex,
            line: records[recordIndex].line,
            path: pathString(segments),
            pathSegments: segments.slice(),
            mode: 'field',
            type: fieldRule.type,
            ruleId: fieldRule.id,
            ruleLabel: fieldRule.label,
            reason: `字段名 ${rawKey} 命中规则 ${fieldRule.id}，整个对象/数组按敏感容器处理`,
            preview: R.maskPreview(fieldRule.type, JSON.stringify(value)),
            valueLength: JSON.stringify(value).length,
          });
          return; // 子树不再下钻，避免重复计数
        }
        pushFinding({
          recordIndex,
          line: records[recordIndex].line,
          path: pathString(segments),
          pathSegments: segments.slice(),
          mode: 'field',
          type: fieldRule.type,
          ruleId: fieldRule.id,
          ruleLabel: fieldRule.label,
          reason: `字段名 ${rawKey} 命中规则 ${fieldRule.id}（${fieldRule.label}）`,
          preview: R.maskPreview(fieldRule.type, value),
          valueLength: String(value).length,
        });
        return;
      }

      if (value === null || typeof value === 'object') {
        walk(value, segments, recordIndex);
        return;
      }
      if (typeof value !== 'string') return; // 数字/布尔仅由字段名规则覆盖
      if (R.isRedactionMarker(value)) return; // 整值已是脱敏标记，绝不再判定

      scanString(value, segments, recordIndex, activePatterns);
    }

    function scanString(s, segments, recordIndex, patterns) {
      const markerRanges = markerRangesOf(s);
      /** @type {Array<{start:number,end:number,rule:object,priority:number,raw:string}>} */
      let candidates = [];

      for (const { rule, priority } of patterns) {
        const re = rule.build();
        let m;
        while ((m = re.exec(s)) !== null) {
          if (m[0] === '') {
            re.lastIndex++;
            continue;
          }
          if (rule.check && !rule.check(m)) continue;
          const g = rule.captureGroup || 0;
          const start = m.indices ? m.indices[g][0] : computeGroupStart(s, m, g);
          const end = m.indices ? m.indices[g][1] : start + m[g].length;
          if (overlapsAny(start, end, markerRanges)) continue; // 不覆盖既有脱敏标记
          candidates.push({ start, end, rule, priority, raw: m[g] !== undefined ? m[g] : m[0] });
        }
      }
      if (candidates.length === 0) return;

      // 2) 跨规则区间去重：按优先级、再按长度（长者优先）排序，冲突时丢弃后者
      candidates.sort((a, b) => a.priority - b.priority || b.end - b.start - (a.end - a.start) || a.start - b.start);
      const kept = [];
      const keptRanges = [];
      for (const c of candidates) {
        if (overlapsAny(c.start, c.end, keptRanges)) continue;
        kept.push(c);
        keptRanges.push([c.start, c.end]);
      }
      kept.sort((a, b) => a.start - b.start);

      for (const c of kept) {
        const fullSpan = c.start === 0 && c.end === s.length && kept.length === 1;
        const mode = fullSpan ? 'value' : 'text';
        pushFinding({
          recordIndex,
          line: records[recordIndex].line,
          path: pathString(segments),
          pathSegments: segments.slice(),
          mode,
          type: c.rule.type,
          ruleId: c.rule.id,
          ruleLabel: c.rule.label,
          start: c.start,
          end: c.end,
          reason:
            mode === 'value'
              ? `整值命中规则 ${c.rule.id}（${c.rule.label}）`
              : `文本第 ${c.start + 1}-${c.end} 字符命中规则 ${c.rule.id}（${c.rule.label}）`,
          preview: R.maskPreview(c.rule.type, c.raw),
          valueLength: c.raw.length,
        });
      }
    }

    return { findings, countByRule, countByType };
  }

  /** 兜底：环境不支持正则 indices 时手工计算捕获组偏移 */
  function computeGroupStart(s, m, g) {
    if (g === 0) return m.index;
    let idx = m.index;
    for (let i = 1; i < g; i++) idx += m[i].length;
    // 捕获组之间可能存在未捕获文本，需用 indexOf 校正
    return s.indexOf(m[g], idx);
  }

  return { scan, pathString, decisionKeyOf };
});
