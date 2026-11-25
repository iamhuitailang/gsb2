import type {
  CharacterDef,
  ItemDef,
  LanguagePack,
  QaIssue,
  RenderResult,
  TriggerSample,
} from './types.ts';
import { buildContext } from './context.ts';
import { resolveWithFallback } from './resolve.ts';
import { renderTemplate, typeMatches } from './template.ts';

export interface RenderDeps {
  packs: Record<string, LanguagePack>;
  characters: Record<string, CharacterDef>;
  items: Record<string, ItemDef>;
}

/**
 * 渲染一条触发样例在指定语言下的结果。
 * 任何变量问题都收敛到 parts / issues 中，不抛异常，
 * 这样页面上一句翻译坏掉时，同组其他台词照常显示。
 */
export function renderSample(deps: RenderDeps, sample: TriggerSample, locale: string): RenderResult {
  const pack = deps.packs[locale] ?? deps.packs['zh-CN'];
  const ctx = buildContext(sample, locale, pack, deps.characters, deps.items);
  const resolved = resolveWithFallback(deps.packs, locale, sample.entryId, ctx.match);

  // 变量契约优先取实际来源语言条目，缺失时回落到基准语言条目
  const sourceEntry = resolved.pack?.entries[sample.entryId];
  const refEntry = deps.packs['zh-CN']?.entries[sample.entryId];
  const params = sourceEntry?.params ?? refEntry?.params;

  const { parts, text } = renderTemplate(resolved.text, ctx.values, params);
  const placeholders = parts.filter((p) => p.type === 'var').map((p) => p.varName!);

  const issues: QaIssue[] = [];

  if (resolved.source.via === 'missing') {
    issues.push({
      kind: 'missing-entry',
      code: 'entry-unresolved',
      severity: 'error',
      locale,
      entryId: sample.entryId,
      sampleId: sample.id,
      sampleLabel: sample.label,
      eventId: sample.eventId,
      message: '回退链上找不到任何可用文案',
      trigger: { ...sample.vars, characterId: sample.characterId, itemId: sample.itemId, count: sample.count },
    });
  } else if (resolved.source.locale !== locale) {
    issues.push({
      kind: 'fallback-used',
      code: 'locale-fallback',
      severity: 'warning',
      locale: resolved.source.locale,
      entryId: sample.entryId,
      sampleId: sample.id,
      sampleLabel: sample.label,
      eventId: sample.eventId,
      when: resolved.source.when ?? undefined,
      message: `${locale} 未翻译该条目，试玩文本来自 ${resolved.source.locale}`,
    });
  }

  for (const part of parts) {
    if (part.type !== 'var' || !part.varName) continue;
    const spec = params?.[part.varName];
    const raw = ctx.values[part.varName];
    if (part.state === 'missing') {
      issues.push({
        kind: 'var-missing',
        code: 'value-missing-at-render',
        severity: 'error',
        locale: resolved.source.locale,
        entryId: sample.entryId,
        sampleId: sample.id,
        sampleLabel: sample.label,
        eventId: sample.eventId,
        message: `模板变量 {${part.varName}} 没有拿到值`,
      });
    } else if (part.state === 'bad-type' && spec) {
      issues.push({
        kind: 'type-mismatch',
        code: 'value-type-mismatch-at-render',
        severity: 'error',
        locale: '*',
        entryId: sample.entryId,
        sampleId: sample.id,
        sampleLabel: sample.label,
        eventId: sample.eventId,
        message: `变量 {${part.varName}} 应为 ${spec.type}，实际为 ${typeLabel(raw)}`,
        expected: spec.type,
        actual: typeLabel(raw),
      });
    }
  }

  const ok = !issues.some((i) => i.severity === 'error');

  return {
    sampleId: sample.id,
    eventId: sample.eventId,
    lineId: sample.lineId,
    entryId: sample.entryId,
    locale,
    ok,
    text,
    parts,
    source: resolved.source,
    issues,
    values: ctx.values,
    placeholders,
  };
}

function typeLabel(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

export { typeMatches };
