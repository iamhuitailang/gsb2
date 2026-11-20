import {
  CURVE_CHANNELS,
  cloneCurve,
  defaultCurveSet,
  normalizeCurve,
  validateCurve
} from './curve.js';

export const ADJUSTMENT_GROUPS = [
  { key: 'exposure', label: '曝光', hint: '以线性光计算，模拟 ±5 EV 曝光补偿' },
  { key: 'whiteBalance', label: '白平衡', hint: '色温 / 色调可在预览中微调' },
  { key: 'toneCurve', label: '色调曲线', hint: '亮度与 RGB 分通道，多控制点平滑插值' },
  { key: 'saturation', label: '饱和度', hint: '调整整体色彩浓度' }
];

export const GROUP_LABELS = Object.fromEntries(ADJUSTMENT_GROUPS.map((g) => [g.key, g.label]));

export const EXPOSURE_RANGE = { min: -5, max: 5 };
export const WB_RANGE = { min: -100, max: 100 };
export const SATURATION_RANGE = { min: -100, max: 100 };

export class AdjustmentError extends Error {
  constructor(message, group) {
    super(message);
    this.name = 'AdjustmentError';
    this.group = group;
  }
}

export function defaultAdjustments() {
  return {
    exposure: { ev: 0 },
    whiteBalance: { temperature: 0, tint: 0 },
    toneCurve: defaultCurveSet(),
    saturation: { value: 0 }
  };
}

export function cloneAdjustments(adjustments) {
  const source = adjustments || defaultAdjustments();
  const curves = defaultCurveSet();
  for (const { key } of CURVE_CHANNELS) {
    if (source.toneCurve?.[key]) curves[key] = cloneCurve(source.toneCurve[key]);
  }
  return {
    exposure: { ev: source.exposure?.ev ?? 0 },
    whiteBalance: {
      temperature: source.whiteBalance?.temperature ?? 0,
      tint: source.whiteBalance?.tint ?? 0
    },
    toneCurve: curves,
    saturation: { value: source.saturation?.value ?? 0 }
  };
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function checkRange(value, range, label, unit = '') {
  if (!isFiniteNumber(value)) {
    return `${label}必须是数字。`;
  }
  if (value < range.min || value > range.max) {
    return `${label}必须在 ${range.min} 至 ${range.max}${unit} 之间（当前 ${value}）。`;
  }
  return null;
}

export function validateExposure(value) {
  const ev = value?.ev;
  const error = checkRange(ev, EXPOSURE_RANGE, '曝光', ' EV');
  if (error) return { ok: false, error };
  return { ok: true, value: { ev: Number(ev) } };
}

export function validateWhiteBalance(value) {
  const temperature = value?.temperature;
  const tint = value?.tint;
  const tempError = checkRange(temperature, WB_RANGE, '色温');
  if (tempError) return { ok: false, error: tempError };
  const tintError = checkRange(tint, WB_RANGE, '色调');
  if (tintError) return { ok: false, error: tintError };
  return { ok: true, value: { temperature: Number(temperature), tint: Number(tint) } };
}

export function validateSaturation(value) {
  const amount = value?.value;
  const error = checkRange(amount, SATURATION_RANGE, '饱和度');
  if (error) return { ok: false, error };
  return { ok: true, value: { value: Number(amount) } };
}

export function validateToneCurve(value) {
  const out = defaultCurveSet();
  for (const { key, label } of CURVE_CHANNELS) {
    const result = validateCurve(value?.[key], `色调曲线（${label}）`);
    if (!result.ok) return result;
    out[key] = result.points;
  }
  return { ok: true, value: out };
}

const VALIDATORS = {
  exposure: validateExposure,
  whiteBalance: validateWhiteBalance,
  toneCurve: validateToneCurve,
  saturation: validateSaturation
};

export function validateGroup(groupKey, value) {
  const validator = VALIDATORS[groupKey];
  if (!validator) return { ok: false, error: `未知参数组：${groupKey}` };
  return validator(value);
}

/**
 * Tolerant loader for persisted projects. Returns defaults where the data is
 * unusable instead of throwing.
 */
export function normalizeAdjustments(input) {
  const adjustments = defaultAdjustments();
  const warnings = [];
  if (!input || typeof input !== 'object') {
    return { adjustments, warnings: ['调整参数缺失，已使用默认值。'] };
  }

  const exp = validateExposure(input.exposure);
  if (exp.ok) adjustments.exposure = exp.value;
  else if (input.exposure) warnings.push(exp.error);

  const wb = validateWhiteBalance(input.whiteBalance);
  if (wb.ok) adjustments.whiteBalance = wb.value;
  else if (input.whiteBalance) warnings.push(wb.error);

  const sat = validateSaturation(input.saturation);
  if (sat.ok) adjustments.saturation = sat.value;
  else if (input.saturation) warnings.push(sat.error);

  if (input.toneCurve && typeof input.toneCurve === 'object') {
    for (const { key, label } of CURVE_CHANNELS) {
      const normalized = normalizeCurve(input.toneCurve[key]);
      if (normalized.warning) warnings.push(`色调曲线（${label}）：${normalized.warning}`);
      adjustments.toneCurve[key] = normalized.points;
    }
  } else if (input.toneCurve) {
    warnings.push('色调曲线数据无效，已使用线性曲线。');
  }

  return { adjustments, warnings };
}

export function setGroup(adjustments, groupKey, value) {
  const result = validateGroup(groupKey, value);
  if (!result.ok) throw new AdjustmentError(result.error, groupKey);
  const next = cloneAdjustments(adjustments);
  next[groupKey] = result.value;
  return next;
}

export function resetGroup(adjustments, groupKey) {
  const defaults = defaultAdjustments();
  return setGroup(adjustments, groupKey, defaults[groupKey]);
}

export function isDefaultGroup(adjustments, groupKey) {
  return JSON.stringify(adjustments?.[groupKey]) === JSON.stringify(defaultAdjustments()[groupKey]);
}

export function adjustmentsAreDefault(adjustments) {
  return ADJUSTMENT_GROUPS.every((group) => isDefaultGroup(adjustments, group.key));
}

export function describeAdjustments(adjustments) {
  const parts = [];
  if (Math.abs(adjustments.exposure.ev) > 0.001) {
    const ev = adjustments.exposure.ev;
    parts.push(`曝光 ${ev > 0 ? '+' : ''}${ev.toFixed(2)} EV`);
  }
  if (adjustments.whiteBalance.temperature !== 0 || adjustments.whiteBalance.tint !== 0) {
    parts.push(`白平衡 ${signed(adjustments.whiteBalance.temperature)}/${signed(adjustments.whiteBalance.tint)}`);
  }
  for (const { key, label } of CURVE_CHANNELS) {
    const curve = adjustments.toneCurve[key];
    const untouched =
      curve.length === 2 &&
      Math.abs(curve[0][1]) < 1e-6 &&
      Math.abs(curve[1][1] - 1) < 1e-6;
    if (!untouched) parts.push(`${label}曲线`);
  }
  if (adjustments.saturation.value !== 0) parts.push(`饱和 ${signed(adjustments.saturation.value)}`);
  return parts.length ? parts.join(' · ') : '未调整';
}

export function signed(value) {
  return `${value > 0 ? '+' : ''}${value}`;
}
