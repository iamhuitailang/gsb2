import type { UniformKind, UniformMeta, UniformValue } from '../types';
import { BUILTIN_UNIFORMS } from './shaders';

/**
 * 支持的注解写法（写在 uniform 上一行或行尾）：
 *   // @range(min, max[, step])
 *   // @default(...)
 * 例：
 *   uniform float uStrength; // @range(0, 2, 0.01) @default(0.8)
 *   uniform vec3 uColor;     // @default(1.0, 0.5, 0.2)
 *   uniform sampler2D uTex;
 */

const UNIFORM_RE =
  /^\s*uniform\s+(float|int|bool|vec[234]|sampler2D)\s+([A-Za-z_]\w*)\s*;/;
const RANGE_RE = /@range\s*\(\s*([-\d.eE+]+)\s*,\s*([-\d.eE+]+)\s*(?:,\s*([-\d.eE+]+)\s*)?\)/;
const DEFAULT_RE = /@default\s*\(([^)]*)\)/;

const VEC_SIZE: Record<string, number> = {
  float: 1,
  int: 1,
  bool: 1,
  vec2: 2,
  vec3: 3,
  vec4: 4,
};

function parseNumberList(raw: string): number[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => Number(s));
}

function kindFor(glslType: string, name: string): UniformKind {
  if (glslType === 'sampler2D') return 'texture';
  if (glslType === 'float') return 'float';
  if (glslType === 'int') return 'int';
  if (glslType === 'bool') return 'bool';
  // 颜色启发式：vec3/vec4 且名字里带 color/colour
  if (/colou?r/i.test(name)) return 'color';
  return glslType as UniformKind;
}

export function defaultFor(meta: UniformMeta): UniformValue {
  if (meta.default !== undefined) return meta.default;
  switch (meta.kind) {
    case 'bool':
      return false;
    case 'int':
      return 0;
    case 'float':
      return meta.min ?? 0;
    case 'color':
    case 'vec2':
    case 'vec3':
    case 'vec4': {
      const arr = new Array(meta.size).fill(0);
      if (meta.kind === 'color' && meta.size >= 3) {
        arr[0] = 1; arr[1] = 1; arr[2] = 1;
      }
      return arr;
    }
    case 'texture':
      return '';
  }
}

/** 解析用户 fragment 源码中的 uniform 声明（跳过引擎内置项） */
export function parseUniforms(source: string): UniformMeta[] {
  const lines = source.split('\n');
  const result: UniformMeta[] = [];
  let pendingComment = '';

  for (const line of lines) {
    const m = line.match(UNIFORM_RE);
    if (!m) {
      const trimmed = line.trim();
      if (trimmed.startsWith('//')) {
        pendingComment = trimmed;
      } else if (trimmed.length > 0) {
        pendingComment = '';
      }
      continue;
    }

    const glslType = m[1];
    const name = m[2];
    const comment = `${pendingComment} ${line.slice(line.indexOf(';') + 1)}`;
    pendingComment = '';

    if (BUILTIN_UNIFORMS.has(name)) continue;

    const meta: UniformMeta = {
      name,
      glslType,
      kind: kindFor(glslType, name),
      size: VEC_SIZE[glslType] ?? 1,
    };

    const rangeMatch = comment.match(RANGE_RE);
    if (rangeMatch) {
      meta.min = Number(rangeMatch[1]);
      meta.max = Number(rangeMatch[2]);
      if (rangeMatch[3] !== undefined) meta.step = Number(rangeMatch[3]);
    }

    const defaultMatch = comment.match(DEFAULT_RE);
    if (defaultMatch) {
      const nums = parseNumberList(defaultMatch[1]);
      if (meta.kind === 'bool') {
        meta.default = nums.some((v) => v !== 0);
      } else if (meta.size === 1) {
        meta.default = nums[0] ?? 0;
      } else {
        const vals = new Array(meta.size).fill(0);
        nums.slice(0, meta.size).forEach((v, i) => (vals[i] = v));
        meta.default = vals;
      }
    }

    result.push(meta);
  }

  return result;
}

/**
 * 合并旧值：同名同类型的 uniform 尽量保留上一次的值。
 * 旧表里存在、但当前声明列表里没有的名字先保留（后处理 pass 稍后会再合并一次），
 * 由状态层在签名确定后自行清理已消失的 uniform。
 */
export function reconcileUniforms(
  metas: UniformMeta[],
  previous: Record<string, UniformValue>,
): Record<string, UniformValue> {
  const next: Record<string, UniformValue> = { ...previous };
  for (const meta of metas) {
    const old = previous[meta.name];
    if (old === undefined) {
      next[meta.name] = defaultFor(meta);
      continue;
    }
    if (meta.kind === 'texture') {
      next[meta.name] = typeof old === 'string' ? old : '';
    } else if (meta.kind === 'bool') {
      next[meta.name] = Boolean(old);
    } else if (meta.size === 1) {
      next[meta.name] = typeof old === 'number' ? old : defaultFor(meta);
    } else if (Array.isArray(old) && old.length === meta.size) {
      next[meta.name] = old.slice();
    } else {
      next[meta.name] = defaultFor(meta);
    }
  }
  return next;
}
