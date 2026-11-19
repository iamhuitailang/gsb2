// 规则配置：默认值、物化（补全缺省字段）与校验。所有规则均为用户可配置项，
// 工具本身不内置"恶意"判断，只描述与规则的符合程度。
import { AppError, ERROR_CODES } from './errors.js';

export const DEFAULT_RULES = Object.freeze({
  trustedHosts: ['registry.npmjs.org'],
  matchSubdomains: true,
  // scheme 统一保留末尾冒号（与 URL.protocol 对齐）
  allowedSchemes: ['https:'],
  allowedAlgorithms: ['sha512', 'sha384', 'sha256'],
  weakAlgorithms: ['sha1'],
  forceIntegrity: true,
  // 10 MiB，锁文件足够用，防止超大输入耗尽资源
  maxFileSizeBytes: 10 * 1024 * 1024,
  reviewGitSources: 'high',
  reviewFileSources: 'medium',
  reviewLinkSources: 'low',
  severityOverrides: {},
});

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];
const SEVERITY_LEVELS = Object.freeze({ critical: 5, high: 4, medium: 3, low: 2, info: 1 });

export function severityRank(severity) {
  return SEVERITY_LEVELS[severity] ?? 0;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function requireStringArray(obj, field, errors) {
  const v = obj[field];
  if (v === undefined) return;
  if (!Array.isArray(v) || v.some((s) => typeof s !== 'string')) {
    errors.push(`${field} 必须是字符串数组`);
  }
}

// 校验用户规则并补全缺省字段，返回物化后的新对象（不修改入参）。
export function materializeRules(input) {
  const base = structuredClone(DEFAULT_RULES);
  if (input === undefined || input === null) return base;
  if (!isPlainObject(input)) {
    throw new AppError(ERROR_CODES.INVALID_RULES, '规则配置必须是 JSON 对象');
  }

  const errors = [];
  const out = { ...base };

  for (const key of [
    'trustedHosts',
    'allowedSchemes',
    'allowedAlgorithms',
    'weakAlgorithms',
  ]) {
    requireStringArray(input, key, errors);
    if (Array.isArray(input[key])) out[key] = [...input[key]];
  }

  if (input.matchSubdomains !== undefined) {
    if (typeof input.matchSubdomains !== 'boolean') {
      errors.push('matchSubdomains 必须是布尔值');
    } else {
      out.matchSubdomains = input.matchSubdomains;
    }
  }

  if (input.forceIntegrity !== undefined) {
    if (typeof input.forceIntegrity !== 'boolean') {
      errors.push('forceIntegrity 必须是布尔值');
    } else {
      out.forceIntegrity = input.forceIntegrity;
    }
  }

  if (input.maxFileSizeBytes !== undefined) {
    if (!Number.isInteger(input.maxFileSizeBytes) || input.maxFileSizeBytes <= 0) {
      errors.push('maxFileSizeBytes 必须是正整数');
    } else {
      out.maxFileSizeBytes = input.maxFileSizeBytes;
    }
  }

  for (const key of ['reviewGitSources', 'reviewFileSources', 'reviewLinkSources']) {
    if (input[key] !== undefined) {
      if (!SEVERITIES.includes(input[key])) {
        errors.push(`${key} 必须是 ${SEVERITIES.join('/')} 之一`);
      } else {
        out[key] = input[key];
      }
    }
  }

  if (input.severityOverrides !== undefined) {
    if (!isPlainObject(input.severityOverrides)) {
      errors.push('severityOverrides 必须是对象');
    } else {
      const overrides = Object.create(null);
      for (const [ruleId, sev] of Object.entries(input.severityOverrides)) {
        if (!SEVERITIES.includes(sev)) {
          errors.push(`severityOverrides.${ruleId} 必须是 ${SEVERITIES.join('/')} 之一`);
        } else {
          overrides[ruleId] = sev;
        }
      }
      out.severityOverrides = overrides;
    }
  }

  if (errors.length > 0) {
    throw new AppError(ERROR_CODES.INVALID_RULES, `规则配置不合法：${errors.join('；')}`, {
      validationErrors: errors,
    });
  }
  return out;
}

// 应用用户的 severityOverrides，返回最终严重级别。
export function resolveSeverity(rules, ruleId, defaultSeverity) {
  return rules.severityOverrides[ruleId] ?? defaultSeverity;
}
