// 规则引擎：把每条 PackageRecord 对照用户规则产出 Finding 与 Inconclusive 项。
// 重要措辞原则：只陈述"与规则不符 / 无法判定 / 待核实"，绝不断言"恶意"。
// 所有完整性结论 verified 恒为 false —— 本工具不下载压缩包，无法验证实际内容。
import { createFinding, RELATIONSHIPS, RULE_IDS, SOURCE_TYPES } from './model.js';
import { hostMatches, extractTarballName } from './url-source.js';
import { evaluateAlgorithms, parseIntegrity } from './sri.js';
import { resolveSeverity } from './config.js';

const INTEGRITY_DECL_ONLY = '仅声明、未实际验证（工具离线运行，未下载压缩包）';

function makeFinding(rules, partial) {
  const ruleId = partial.ruleId;
  const defaultSeverity = partial.severity;
  return createFinding({
    ...partial,
    severity: resolveSeverity(rules, ruleId, defaultSeverity),
  });
}

// 评估单条记录（跳过根条目）。
function evaluateRecord(rec, rules) {
  const findings = [];
  const inconclusive = [];
  const push = (f) => findings.push(makeFinding(rules, f));
  const base = {
    recordId: rec.recordId,
    packageKey: rec.key,
    name: rec.name,
    version: rec.version,
  };

  const isV3Omitted = (field) => rec.lockfileVersion === 3 && rec.omittedFields.includes(field);
  const isLinkLike = rec.sourceType === SOURCE_TYPES.LINK || rec.link;

  // ---------- 来源 resolved ----------
  if (rec.resolved === null) {
    if (isLinkLike) {
      // link 条目没有远程来源是正常的，仅按 link 规则提示
    } else if (isV3Omitted('resolved')) {
      inconclusive.push({
        recordId: rec.recordId,
        packageKey: rec.key,
        name: rec.name,
        reason: 'lockfileVersion 3 省略了 resolved，无法判定实际下载主机',
        missingFields: ['resolved'],
        hint: '可在安装环境用 npm config get registry 核对默认注册表，本工具不做联网推断',
      });
      push({
        ...base,
        ruleId: RULE_IDS.RESOLVED_OMITTED_V3,
        severity: 'info',
        title: '来源被锁文件省略（v3）',
        message: `位置 ${rec.key} 的 resolved 被省略，来源主机无法依据本文件判定，列入待核实项`,
        actual: { resolved: null },
        evidence: { fieldPath: `${rec.key}.resolved`, rawValue: null },
        status: '无法判定',
      });
    } else {
      push({
        ...base,
        ruleId: RULE_IDS.RESOLVED_MISSING,
        severity: 'medium',
        title: '缺少解析来源',
        message: `位置 ${rec.key} 没有 resolved 字段，无法确认下载来源`,
        expected: { resolvedPresent: true },
        actual: { resolved: null },
        evidence: { fieldPath: `${rec.key}.resolved`, rawValue: null },
        status: '待核实',
      });
    }
  } else if (rec.sourceType === SOURCE_TYPES.GIT) {
    push({
      ...base,
      ruleId: RULE_IDS.RESOLVED_NON_REGISTRY_GIT,
      severity: rules.reviewGitSources,
      title: 'Git 来源依赖',
      message: `位置 ${rec.key} 来自 Git 仓库而非 registry 压缩包，来源与制品身份需人工核实`,
      expected: { sourceType: 'registry tarball' },
      actual: { sourceType: rec.sourceType, resolved: rec.resolved, host: rec.host },
      evidence: { fieldPath: `${rec.key}.resolved`, rawValue: rec.resolved },
      status: '待核实',
    });
  } else if (rec.sourceType === SOURCE_TYPES.FILE) {
    push({
      ...base,
      ruleId: RULE_IDS.RESOLVED_NON_REGISTRY_FILE,
      severity: rules.reviewFileSources,
      title: '本地路径依赖',
      message: `位置 ${rec.key} 来自本地文件路径，分发内容不受 registry 管控，需核实该路径制品`,
      expected: { sourceType: 'registry tarball' },
      actual: { sourceType: rec.sourceType, resolved: rec.resolved },
      evidence: { fieldPath: `${rec.key}.resolved`, rawValue: rec.resolved },
      status: '待核实',
    });
  } else if (isLinkLike) {
    push({
      ...base,
      ruleId: RULE_IDS.RESOLVED_NON_REGISTRY_LINK,
      severity: rules.reviewLinkSources,
      title: '链接（工作区）依赖',
      message: `位置 ${rec.key} 是符号链接/工作区依赖，没有独立远程下载来源`,
      expected: { sourceType: 'registry tarball' },
      actual: { sourceType: SOURCE_TYPES.LINK, resolved: rec.resolved },
      evidence: { fieldPath: `${rec.key}.resolved`, rawValue: rec.resolved },
      status: '待核实',
    });
  } else if (rec.sourceType === SOURCE_TYPES.UNKNOWN) {
    inconclusive.push({
      recordId: rec.recordId,
      packageKey: rec.key,
      name: rec.name,
      reason: 'resolved 无法解析为受支持的来源形态',
      missingFields: [],
      hint: rec.resolved,
    });
  } else {
    // http/https 类：先查 scheme，再查主机白名单
    if (rec.scheme && !rules.allowedSchemes.includes(rec.scheme)) {
      push({
        ...base,
        ruleId: RULE_IDS.RESOLVED_SCHEME_NOT_ALLOWED,
        severity: 'high',
        title: '来源协议不在允许列表',
        message: `位置 ${rec.key} 使用 ${rec.scheme} 协议，不符合规则允许的 ${rules.allowedSchemes.join(', ')}`,
        expected: { allowedSchemes: rules.allowedSchemes },
        actual: { scheme: rec.scheme, resolved: rec.resolved },
        evidence: { fieldPath: `${rec.key}.resolved`, rawValue: rec.resolved },
        status: '待核实',
      });
    }
    if (!hostMatches(rec.host, rules.trustedHosts, rules.matchSubdomains)) {
      push({
        ...base,
        ruleId: RULE_IDS.RESOLVED_HOST_UNTRUSTED,
        severity: 'high',
        title: '来源主机不在可信列表',
        message: `位置 ${rec.key} 的下载主机 ${rec.host ?? '(空)'} 不在可信域名列表内，来源是否为预期镜像需人工核实`,
        expected: { trustedHosts: rules.trustedHosts, matchSubdomains: rules.matchSubdomains },
        actual: { host: rec.host, resolved: rec.resolved },
        evidence: { fieldPath: `${rec.key}.resolved`, rawValue: rec.resolved },
        status: '待核实',
      });
    }
  }

  // ---------- 包身份：tarball URL 包名 vs 声明包名 ----------
  if (rec.resolved && (rec.sourceType === SOURCE_TYPES.HTTP_TARBALL || rec.sourceType === SOURCE_TYPES.REGISTRY)) {
    const tarballName = extractTarballName(rec.resolved);
    if (tarballName && rec.declaredName && tarballName !== rec.declaredName) {
      push({
        ...base,
        ruleId: RULE_IDS.RESOLVED_NAME_MISMATCH,
        severity: 'high',
        title: '来源压缩包包名与声明包名不一致',
        message: `位置 ${rec.key} 声明包名为 ${rec.declaredName}，但 resolved 压缩包路径指向 ${tarballName}，包身份对不上，需核实是否被替换`,
        expected: { tarballPackageName: rec.declaredName },
        actual: { tarballPackageName: tarballName, resolved: rec.resolved },
        evidence: {
          fieldPath: `${rec.key}.resolved`,
          rawValue: rec.resolved,
        },
        status: '待核实',
      });
    }
  }

  // ---------- 别名身份 ----------
  if (rec.alias) {
    push({
      ...base,
      ruleId: RULE_IDS.ALIAS_NAME_MISMATCH,
      severity: 'medium',
      title: '安装别名与真实包名不同',
      message: `安装位置目录名 ${rec.basename} 与条目声明包名 ${rec.declaredName} 不一致（npm alias）。别名本身合法，但需核实别名指向是否符合预期`,
      expected: { installedBasename: rec.declaredName },
      actual: { installedBasename: rec.basename, declaredName: rec.declaredName },
      evidence: {
        fieldPath: `${rec.key}.name`,
        rawValue: rec.declaredName,
      },
      status: '待核实',
    });
  }

  // ---------- 完整性 integrity ----------
  // git/file/link 不使用 registry SRI，跳过完整性策略判定
  const integrityApplicable =
    !isLinkLike && rec.sourceType !== SOURCE_TYPES.GIT && rec.sourceType !== SOURCE_TYPES.FILE;

  if (integrityApplicable) {
    if (rec.integrity === null) {
      if (isV3Omitted('integrity')) {
        inconclusive.push({
          recordId: rec.recordId,
          packageKey: rec.key,
          name: rec.name,
          reason: 'lockfileVersion 3 省略了 integrity，无法获得完整性声明',
          missingFields: ['integrity'],
          hint: null,
        });
        push({
          ...base,
          ruleId: RULE_IDS.INTEGRITY_OMITTED_V3,
          severity: 'info',
          title: '完整性声明被省略（v3）',
          message: `位置 ${rec.key} 的 integrity 被省略，无法依据本文件核对摘要，列入待核实项`,
          actual: { integrity: null },
          evidence: { fieldPath: `${rec.key}.integrity`, rawValue: null },
          status: '无法判定',
        });
      } else {
        push({
          ...base,
          ruleId: RULE_IDS.INTEGRITY_MISSING,
          severity: rules.forceIntegrity ? 'high' : 'medium',
          title: '缺少完整性声明',
          message: `位置 ${rec.key} 没有 integrity 字段，锁文件未提供任何摘要声明`,
          expected: { integrityPresent: rules.forceIntegrity },
          actual: { integrity: null },
          evidence: { fieldPath: `${rec.key}.integrity`, rawValue: null },
          status: '待核实',
        });
      }
    } else {
      const parsed = parseIntegrity(rec.integrity);
      const evaluated = evaluateAlgorithms(parsed, rules);
      for (const token of evaluated) {
        if (token.ruleId === RULE_IDS.INTEGRITY_SRI_MALFORMED) {
          push({
            ...base,
            ruleId: RULE_IDS.INTEGRITY_SRI_MALFORMED,
            severity: 'high',
            title: '完整性声明格式不合法',
            message: `位置 ${rec.key} 的 SRI token "${token.raw}" 格式不合法：${token.errors.join('；')}`,
            expected: { sriFormat: 'alg-base64，base64 字符与 padding 合法' },
            actual: { token: token.raw, errors: token.errors },
            evidence: { fieldPath: `${rec.key}.integrity`, rawValue: rec.integrity },
            verified: false,
            status: INTEGRITY_DECL_ONLY,
          });
        } else if (token.ruleId === RULE_IDS.INTEGRITY_ALG_WEAK) {
          push({
            ...base,
            ruleId: RULE_IDS.INTEGRITY_ALG_WEAK,
            severity: 'medium',
            title: '完整性摘要算法过弱',
            message: `位置 ${rec.key} 使用 ${token.alg} 摘要，算法强度不足，建议更换为 ${rules.allowedAlgorithms.join('/')}`,
            expected: { allowedAlgorithms: rules.allowedAlgorithms },
            actual: { algorithm: token.alg, token: token.raw },
            evidence: { fieldPath: `${rec.key}.integrity`, rawValue: rec.integrity },
            verified: false,
            status: INTEGRITY_DECL_ONLY,
          });
        } else if (token.ruleId === RULE_IDS.INTEGRITY_ALG_NOT_ALLOWED) {
          push({
            ...base,
            ruleId: RULE_IDS.INTEGRITY_ALG_NOT_ALLOWED,
            severity: 'high',
            title: '完整性摘要算法不在允许列表',
            message: `位置 ${rec.key} 使用未被规则允许的算法 ${token.alg}`,
            expected: { allowedAlgorithms: rules.allowedAlgorithms },
            actual: { algorithm: token.alg },
            evidence: { fieldPath: `${rec.key}.integrity`, rawValue: rec.integrity },
            verified: false,
            status: INTEGRITY_DECL_ONLY,
          });
        }
        // policy === 'allowed' 时不出 finding，但仍在记录上体现"仅声明未验证"
      }
    }
  }

  // ---------- 不可达条目 ----------
  if (rec.relationship === RELATIONSHIPS.UNREACHABLE) {
    inconclusive.push({
      recordId: rec.recordId,
      packageKey: rec.key,
      name: rec.name,
      reason: '在依赖图中没有从根项目到该条目的路径（可能是遗留/孤儿条目）',
      missingFields: [],
      hint: null,
    });
    push({
      ...base,
      ruleId: RULE_IDS.PACKAGE_UNREACHABLE,
      severity: 'low',
      title: '依赖图中不可达的条目',
      message: `位置 ${rec.key} 无法从根依赖到达，无法确认其被谁引入，列入待核实项`,
      actual: { reachable: false },
      evidence: { fieldPath: rec.key, rawValue: rec.raw },
      status: '无法判定',
    });
  }

  return { findings, inconclusive };
}

export function evaluate(parsed, graph, rules) {
  const findings = [];
  const inconclusive = [];
  for (const rec of parsed.records.values()) {
    if (rec.key === graph.rootKey) continue;
    const result = evaluateRecord(rec, rules);
    findings.push(...result.findings);
    inconclusive.push(...result.inconclusive);
  }
  return { findings, inconclusive };
}
