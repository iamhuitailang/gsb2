import type { PackKind, ResolveStatus } from '../types';
import { h, type Child } from './dom';

export const STATUS_META: Record<
  ResolveStatus,
  { label: string; cls: string; hint: string }
> = {
  found: { label: '正常命中', cls: 'st-found', hint: '有可用资源包提供图片' },
  conflict: { label: '同级冲突', cls: 'st-conflict', hint: '多个同优先级包替换同一道具，当前为确定性临时结果' },
  removed: { label: '显式移除', cls: 'st-removed', hint: '某个包用 removals 明确移除了该资源，不是缺图' },
  missing: { label: '缺图', cls: 'st-missing', hint: '所有可用包的所有回退层级都没有该资源' },
};

export const KIND_META: Record<PackKind, { label: string; cls: string }> = {
  base: { label: '基础包', cls: 'kind-base' },
  replace: { label: '替换包', cls: 'kind-replace' },
  language: { label: '语言包', cls: 'kind-language' },
};

export function statusBadge(status: ResolveStatus): HTMLElement {
  const meta = STATUS_META[status];
  return h('span', { class: `badge status-badge ${meta.cls}`, title: meta.hint, text: meta.label });
}

export function kindChip(kind: PackKind): HTMLElement {
  const meta = KIND_META[kind];
  return h('span', { class: `chip kind-chip ${meta.cls}`, text: meta.label });
}

export function issueBadge(code: string, text: string, title?: string): HTMLElement {
  const cls =
    code === 'cycle'
      ? 'issue-cycle'
      : code.startsWith('dependency')
        ? 'issue-dep'
        : 'issue-conflict';
  return h('span', { class: `badge issue-badge ${cls}`, text, ...(title ? { title } : {}) });
}

/** 缺图占位（虚线灰盒 + 图标文字） */
export function missingPlaceholder(size: 'md' | 'lg' = 'lg'): HTMLElement {
  return h('div', { class: `ph ph-missing ph-${size}` }, [
    h('span', { class: 'ph-icon', text: '?' }),
    h('span', { class: 'ph-label', text: 'MISSING · 缺图' }),
  ]);
}

/** 显式移除占位（红色虚线 + 禁止符），与缺图明确区分 */
export function removedPlaceholder(size: 'md' | 'lg' = 'lg', byName?: string): HTMLElement {
  return h('div', { class: `ph ph-removed ph-${size}`, title: byName ? `由 ${byName} 移除` : '显式移除' }, [
    h('span', { class: 'ph-icon', text: '⊘' }),
    h('span', { class: 'ph-label', text: 'REMOVED · 已移除' }),
  ]);
}

export function sourceChip(name: string, id: string): HTMLElement {
  return h('span', { class: 'source-chip', title: id }, [
    h('span', { class: 'source-dot' }),
    h('span', { text: name }),
    h('code', { text: id }),
  ]);
}

export function sectionTitle(title: string, sub?: string, extra?: Child): HTMLElement {
  return h('div', { class: 'section-title-row' }, [
    h('div', {}, [
      h('h2', { class: 'section-title', text: title }),
      sub ? h('p', { class: 'section-sub', text: sub }) : null,
    ]),
    extra ? h('div', { class: 'section-extra' }, Array.isArray(extra) ? extra : [extra]) : null,
  ]);
}
