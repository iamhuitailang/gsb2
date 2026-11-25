import type { FormWhen, ParamSpec, TemplatePart, VarType, VarValue } from './types.ts';

const PLACEHOLDER_RE = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;

/** 取出模板里的全部占位符变量名（保序、去重） */
export function extractPlaceholders(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(PLACEHOLDER_RE)) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      out.push(m[1]);
    }
  }
  return out;
}

export function typeMatches(spec: VarType, value: unknown): boolean {
  if (value === null || value === undefined) return false;
  switch (spec) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    default:
      return true;
  }
}

export function describeValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  return String(value);
}

export function typeNameOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function stringifyValue(value: VarValue): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

/**
 * 把模板切成片段并做变量替换。
 * - 缺值：渲染成 ⟨缺失:name⟩，片段状态 missing
 * - 类型不合：仍把值显示出来，但片段状态 bad-type
 * 该函数本身不抛异常，保证一条台词坏掉不会拖垮整组对话。
 */
export function renderTemplate(
  text: string,
  values: Record<string, unknown>,
  params?: Record<string, ParamSpec>,
): { parts: TemplatePart[]; text: string } {
  const parts: TemplatePart[] = [];
  let plain = '';
  let last = 0;
  PLACEHOLDER_RE.lastIndex = 0;
  for (const match of text.matchAll(PLACEHOLDER_RE)) {
    const idx = match.index ?? 0;
    if (idx > last) {
      const t = text.slice(last, idx);
      parts.push({ type: 'text', value: t });
      plain += t;
    }
    const name = match[1];
    const has = Object.prototype.hasOwnProperty.call(values, name);
    const raw = values[name] as VarValue;
    if (!has || raw === undefined || raw === null || raw === '') {
      const shown = `⟨缺失:${name}⟩`;
      parts.push({ type: 'var', value: match[0], varName: name, state: 'missing', shown });
      plain += shown;
    } else {
      const spec = params?.[name];
      const badType = spec ? !typeMatches(spec.type, raw) : false;
      const shown = stringifyValue(raw as VarValue);
      parts.push({
        type: 'var',
        value: match[0],
        varName: name,
        state: badType ? 'bad-type' : 'ok',
        shown,
      });
      plain += shown;
    }
    last = idx + match[0].length;
  }
  if (last < text.length) {
    const t = text.slice(last);
    parts.push({ type: 'text', value: t });
    plain += t;
  }
  return { parts, text: plain };
}

/** 稳定的条件序列化，用作来源坐标 / React 风格 key */
export function whenSignature(when: FormWhen | null | undefined): string {
  if (!when) return '∅';
  const bits: string[] = [];
  if (when.count !== undefined) bits.push(`count=${when.count}`);
  if (when.address !== undefined) bits.push(`address=${when.address}`);
  if (when.category !== undefined) bits.push(`category=${when.category}`);
  return bits.length ? bits.join('&') : '*';
}

export function whenLabel(when: FormWhen | null | undefined): string {
  if (!when) return '无条件通用句';
  const bits: string[] = [];
  if (when.count) bits.push(`数量=${when.count}`);
  if (when.address) bits.push(`称呼=${when.address}`);
  if (when.category) bits.push(`类别=${when.category}`);
  return bits.length ? bits.join('，') : '无条件通用句';
}
