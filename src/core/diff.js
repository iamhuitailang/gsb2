// 当前清单与基线清单对比。匹配键为安装位置（packages key / v1 合成虚拟 key）。
// 计数口径：按唯一位置计数，一个位置命中多种变化只算 1 个 changed。
import { createFinding, RULE_IDS } from './model.js';
import { resolveSeverity } from './config.js';
import { integrityMap } from './sri.js';

function snapshot(rec) {
  return {
    name: rec?.name ?? null,
    version: rec?.version ?? null,
    resolved: rec?.resolved ?? null,
    host: rec?.host ?? null,
    integrity: rec?.integrity ?? null,
  };
}

function integrityEqual(a, b) {
  const ma = integrityMap(a);
  const mb = integrityMap(b);
  if (ma.size !== mb.size) return false;
  for (const [alg, digestsA] of ma) {
    const digestsB = mb.get(alg);
    if (!digestsB || digestsA.size !== digestsB.size) return false;
    for (const d of digestsA) if (!digestsB.has(d)) return false;
  }
  return true;
}

export function diffLockfiles(currentParsed, baselineParsed) {
  const current = currentParsed.records;
  const baseline = baselineParsed.records;
  const allKeys = new Set([...current.keys(), ...baseline.keys()]);
  const entries = [];
  const warnings = [];

  if (currentParsed.lockfileVersion !== baselineParsed.lockfileVersion) {
    warnings.push(
      `基线 lockfileVersion=${baselineParsed.lockfileVersion} 与当前 ${currentParsed.lockfileVersion} 不一致，按安装位置匹配的结果可能受版本差异影响`,
    );
  }

  let added = 0;
  let removed = 0;
  let changed = 0;
  let unchanged = 0;

  for (const key of [...allKeys].sort()) {
    if (key === '') continue; // 根条目不参与差异
    const afterRec = current.get(key);
    const beforeRec = baseline.get(key);
    const after = afterRec ? snapshot(afterRec) : null;
    const before = beforeRec ? snapshot(beforeRec) : null;

    let status;
    const changeTypes = [];

    if (before && !after) {
      status = 'removed';
      removed += 1;
    } else if (!before && after) {
      status = 'added';
      added += 1;
    } else if (before && after) {
      if (before.version !== after.version) changeTypes.push('version');
      if (before.host !== after.host) changeTypes.push('resolved-host');
      else if (before.resolved !== after.resolved) changeTypes.push('resolved-url');
      if (!integrityEqual(before.integrity, after.integrity)) changeTypes.push('integrity');
      if (before.name !== after.name) changeTypes.push('name');

      if (changeTypes.length === 0) {
        status = 'unchanged';
        unchanged += 1;
      } else {
        status = 'changed';
        changed += 1;
      }
    } else {
      continue;
    }

    entries.push({ key, name: after?.name ?? before?.name ?? null, status, changeTypes, before, after });
  }

  const summary = {
    baselineLocations: baseline.size - (baseline.has('') ? 1 : 0),
    currentLocations: current.size - (current.has('') ? 1 : 0),
    added,
    removed,
    changed,
    unchanged,
    unionLocations: entries.length,
  };

  return { entries, summary, warnings };
}

// 把差异转成可在 UI 按变化类型筛选的 finding（source="diff"）。
export function diffFindings(diff, rules) {
  const findings = [];
  const sev = (ruleId, def) => resolveSeverity(rules, ruleId, def);

  for (const entry of diff.entries) {
    const base = {
      packageKey: entry.key,
      name: entry.name,
      source: 'diff',
      evidence: { fieldPath: entry.key, before: entry.before, after: entry.after },
    };

    if (entry.status === 'added') {
      findings.push(
        createFinding({
          ...base,
          ruleId: RULE_IDS.DIFF_ADDED,
          severity: sev(rules, RULE_IDS.DIFF_ADDED, 'info'),
          title: '基线中不存在的新增依赖',
          message: `位置 ${entry.key} 为相对基线新增的依赖条目`,
          actual: entry.after,
        }),
      );
      continue;
    }
    if (entry.status === 'removed') {
      findings.push(
        createFinding({
          ...base,
          ruleId: RULE_IDS.DIFF_REMOVED,
          severity: sev(rules, RULE_IDS.DIFF_REMOVED, 'info'),
          title: '当前清单已移除的基线依赖',
          message: `位置 ${entry.key} 在当前清单中已移除`,
          actual: entry.before,
        }),
      );
      continue;
    }

    for (const changeType of entry.changeTypes) {
      if (changeType === 'resolved-host') {
        findings.push(
          createFinding({
            ...base,
            ruleId: RULE_IDS.DIFF_RESOLVED_HOST_CHANGED,
            severity: sev(rules, RULE_IDS.DIFF_RESOLVED_HOST_CHANGED, 'high'),
            title: '下载主机发生变化',
            message: `位置 ${entry.key} 的来源主机由 ${entry.before.host ?? '(空)'} 变为 ${entry.after.host ?? '(空)'}`,
            expected: { host: entry.before.host },
            actual: { host: entry.after.host },
          }),
        );
      } else if (changeType === 'resolved-url') {
        findings.push(
          createFinding({
            ...base,
            ruleId: RULE_IDS.DIFF_RESOLVED_URL_CHANGED,
            severity: sev(rules, RULE_IDS.DIFF_RESOLVED_URL_CHANGED, 'medium'),
            title: '下载 URL 发生变化（主机未变）',
            message: `位置 ${entry.key} 的 resolved URL 相对基线发生变化`,
            expected: { resolved: entry.before.resolved },
            actual: { resolved: entry.after.resolved },
          }),
        );
      } else if (changeType === 'version') {
        findings.push(
          createFinding({
            ...base,
            ruleId: RULE_IDS.DIFF_VERSION_CHANGED,
            severity: sev(rules, RULE_IDS.DIFF_VERSION_CHANGED, 'medium'),
            title: '版本发生变化',
            message: `位置 ${entry.key} 版本由 ${entry.before.version} 变为 ${entry.after.version}`,
            expected: { version: entry.before.version },
            actual: { version: entry.after.version },
          }),
        );
      } else if (changeType === 'integrity') {
        findings.push(
          createFinding({
            ...base,
            ruleId: RULE_IDS.DIFF_INTEGRITY_CHANGED,
            severity: sev(rules, RULE_IDS.DIFF_INTEGRITY_CHANGED, 'high'),
            title: '完整性声明发生变化',
            message: `位置 ${entry.key} 的 integrity 相对基线发生变化，需核实制品是否被重新打包或替换`,
            expected: { integrity: entry.before.integrity },
            actual: { integrity: entry.after.integrity },
            verified: false,
            status: '仅声明对比，未实际验证压缩包',
          }),
        );
      } else if (changeType === 'name') {
        findings.push(
          createFinding({
            ...base,
            ruleId: RULE_IDS.DIFF_NAME_CHANGED,
            severity: sev(rules, RULE_IDS.DIFF_NAME_CHANGED, 'high'),
            title: '包名发生变化',
            message: `位置 ${entry.key} 的包名由 ${entry.before.name} 变为 ${entry.after.name}`,
            expected: { name: entry.before.name },
            actual: { name: entry.after.name },
          }),
        );
      }
    }
  }
  return findings;
}
