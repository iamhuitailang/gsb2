import type {
  CharacterDef,
  ItemDef,
  QaIssue,
  TriggerSample,
} from './types.ts';
import { buildContext } from './context.ts';
import { resolveWithin, resolveWithFallback } from './resolve.ts';
import { extractPlaceholders, typeMatches, whenSignature } from './template.ts';
import { exampleCountForBucket } from './plural.ts';
import type { RenderDeps } from './render.ts';

export interface CheckDeps extends RenderDeps {
  referenceLocale: string;
  samples: TriggerSample[];
}

function triggerOf(sample: TriggerSample): Record<string, unknown> {
  const t: Record<string, unknown> = {};
  if (sample.characterId) t.characterId = sample.characterId;
  if (sample.itemId) t.itemId = sample.itemId;
  if (typeof sample.count === 'number') t.count = sample.count;
  if (sample.vars && Object.keys(sample.vars).length) t.vars = sample.vars;
  return t;
}

function baseIssue(
  partial: Pick<QaIssue, 'kind' | 'code' | 'severity' | 'locale' | 'entryId' | 'message'> &
    Partial<QaIssue>,
  sample: TriggerSample,
): QaIssue {
  return {
    sampleId: sample.id,
    sampleLabel: sample.label,
    eventId: sample.eventId,
    trigger: triggerOf(sample),
    ...partial,
  } as QaIssue;
}

/** 由句式条件反推一个能走到它的具体样例，用于“未走到句式”的修复建议 */
function suggestTrigger(
  when: QaIssue['when'],
  characters: Record<string, CharacterDef>,
  items: Record<string, ItemDef>,
  siblingWhens: Array<QaIssue['when']> = [],
): string {
  const parts: string[] = [];
  const w = when ?? {};

  if (w.count) {
    const count = exampleCountForBucket(w.count);
    if (count !== undefined) parts.push(`count=${count}`);
  }
  if (w.address) {
    const c = Object.values(characters).find((x) => x.address === w.address);
    parts.push(c ? `characterId=${c.id}` : `address=${w.address}`);
  }
  if (w.category) {
    const it = Object.values(items).find((x) => x.category === w.category);
    parts.push(it ? `itemId=${it.id}` : `category=${w.category}`);
  }

  // 该句式没限定、但兄弟句式有限定的维度：挑一个绕开所有兄弟值的上下文，
  // 否则会被更具体的兄弟句抢走（例如通用任务提醒句需要一个非 captain 角色）。
  if (!w.address && siblingWhens.some((x) => x?.address)) {
    const used = new Set(siblingWhens.map((x) => x?.address).filter(Boolean));
    const c = Object.values(characters).find((x) => !used.has(x.address));
    if (c) parts.push(`characterId=${c.id}（address=${c.address}，避开专用句式）`);
  }
  if (!w.category && siblingWhens.some((x) => x?.category)) {
    const used = new Set(siblingWhens.map((x) => x?.category).filter(Boolean));
    const it = Object.values(items).find((x) => !used.has(x.category));
    if (it) parts.push(`itemId=${it.id}（category=${it.category}）`);
  }
  if (!w.count && siblingWhens.some((x) => x?.count)) {
    const used = new Set(siblingWhens.map((x) => x?.count).filter(Boolean));
    const bucket = (['zero', 'one', 'other'] as const).find((b) => !used.has(b));
    const count = exampleCountForBucket(bucket);
    if (count !== undefined) parts.push(`count=${count}（走未限定数量的通用句）`);
  }

  return parts.length ? parts.join('，') : '任意上下文（无条件通用句）';
}

/**
 * 对全部“语言 × 条目 × 触发样例”跑上下文检查。
 * 输出未经聚合的问题列表（同一缺陷可能被多个样例触发），
 * UI / 清单层再用 aggregateIssues 合并。
 */
export function runChecks(deps: CheckDeps): QaIssue[] {
  const { packs, referenceLocale, samples, characters, items } = deps;
  const issues: QaIssue[] = [];
  const refPack = packs[referenceLocale];

  /** key = locale:entryId:formIndex，标记哪些句式被样例走到了 */
  const reachedForms = new Set<string>();
  const referencedEntries = new Set<string>();

  for (const sample of samples) {
    referencedEntries.add(sample.entryId);
    const refEntry = refPack?.entries[sample.entryId];
    const params = refEntry?.params;

    // ---- 1) 事件样例数据本身：必传变量缺失 / 类型不合（各语言共用） ----
    if (refPack && params) {
      const refCtx = buildContext(sample, referenceLocale, refPack, characters, items);
      for (const [name, spec] of Object.entries(params)) {
        const has = Object.prototype.hasOwnProperty.call(refCtx.values, name);
        const value = refCtx.values[name];
        const empty = value === undefined || value === null || value === '';
        if (spec.required !== false && (!has || empty)) {
          issues.push(
            baseIssue(
              {
                kind: 'var-missing',
                code: 'required-value-missing',
                severity: 'error',
                locale: '*',
                entryId: sample.entryId,
                message: `事件没有提供必需变量 {${name}}`,
                expected: spec.type,
                actual: 'undefined',
              },
              sample,
            ),
          );
          continue;
        }
        if (has && !empty && !typeMatches(spec.type, value)) {
          issues.push(
            baseIssue(
              {
                kind: 'type-mismatch',
                code: 'param-type-mismatch',
                severity: 'error',
                locale: '*',
                entryId: sample.entryId,
                message: `变量 {${name}} 应为 ${spec.type}，样例实际传入 ${typeName(value)}`,
                expected: spec.type,
                actual: typeName(value),
              },
              sample,
            ),
          );
        }
      }
    }

    // ---- 2) 每种语言的实际句式：漏变量 / 多变量 / 陈旧变量 ----
    const refCtx = refPack
      ? buildContext(sample, referenceLocale, refPack, characters, items)
      : undefined;
    const refWithin = refPack ? resolveWithin(refPack, sample.entryId, refCtx!.match) : null;
    const referencePlaceholders = refWithin
      ? extractPlaceholders(refWithin.form.text)
      : Object.keys(params ?? {});

    for (const [locale, pack] of Object.entries(packs)) {
      const ctx = buildContext(sample, locale, pack, characters, items);
      const within = resolveWithin(pack, sample.entryId, ctx.match);

      // 回退 / 缺失单独记录
      const resolved = resolveWithFallback(packs, locale, sample.entryId, ctx.match);
      if (resolved.source.via === 'missing') {
        issues.push(
          baseIssue(
            {
              kind: 'missing-entry',
              code: 'entry-unresolved',
              severity: 'error',
              locale,
              entryId: sample.entryId,
              message: '整条回退链都找不到可用文案',
            },
            sample,
          ),
        );
      } else if (resolved.source.locale !== locale) {
        issues.push(
          baseIssue(
            {
              kind: 'fallback-used',
              code: 'locale-fallback',
              severity: 'warning',
              locale,
              entryId: sample.entryId,
              when: resolved.source.when ?? undefined,
              message: `本语言缺少可用条目/句式，试玩文本回退自 ${resolved.source.locale}`,
              expected: locale,
              actual: resolved.source.locale,
            },
            sample,
          ),
        );
      }

      if (!within) continue;
      reachedForms.add(`${locale}:${sample.entryId}:${within.index}`);

      const targetPH = extractPlaceholders(within.form.text);
      const targetSet = new Set(targetPH);
      const when = within.form.when ?? {};

      // 2a) 基准句式用了、译文句式没用 -> 翻译漏放变量
      for (const name of referencePlaceholders) {
        if (!targetSet.has(name)) {
          issues.push(
            baseIssue(
              {
                kind: 'var-missing',
                code: 'placeholder-dropped',
                severity: 'error',
                locale,
                entryId: sample.entryId,
                when,
                message: `译文句式漏掉了基准句式中的变量 {${name}}`,
                expected: `应包含 {${name}}`,
                actual: within.form.text,
              },
              sample,
            ),
          );
        }
      }

      // 2b) 译文用了契约/基准之外的变量 -> 多出（通常是拼写错误）
      const allowed = new Set([...Object.keys(params ?? {}), ...referencePlaceholders]);
      for (const name of targetPH) {
        if (!allowed.has(name)) {
          issues.push(
            baseIssue(
              {
                kind: 'var-extra',
                code: 'placeholder-undeclared',
                severity: 'error',
                locale,
                entryId: sample.entryId,
                when,
                message: `译文使用了契约和基准句式中都不存在的变量 {${name}}，疑似拼写错误`,
                expected: [...allowed].map((x) => `{${x}}`).join(', ') || '(无)',
                actual: `{${name}}`,
              },
              sample,
            ),
          );
        }
      }

      // 2c) 样例 vars 传了，但实际选中的句式根本不用 -> 多出的陈旧数据
      for (const key of Object.keys(sample.vars ?? {})) {
        if (!targetSet.has(key)) {
          issues.push(
            baseIssue(
              {
                kind: 'var-extra',
                code: 'value-unused',
                severity: 'warning',
                locale,
                entryId: sample.entryId,
                when,
                message: `样例传入的变量 {${key}} 在命中句式中没有被使用`,
                actual: key,
              },
              sample,
            ),
          );
        }
      }
    }
  }

  // ---- 3) 没走到的句式：被语言包定义，但所有触发样例都没选中它 ----
  for (const [locale, pack] of Object.entries(packs)) {
    for (const entry of Object.values(pack.entries)) {
      if (!referencedEntries.has(entry.id)) continue;
      entry.forms.forEach((form, index) => {
        if (reachedForms.has(`${locale}:${entry.id}:${index}`)) return;
        const when = form.when ?? {};
        issues.push({
          kind: 'unreached-form',
          code: 'form-never-selected',
          severity: 'warning',
          locale,
          entryId: entry.id,
          when,
          message: '该句式没有被任何事件/矩阵样例触发，可能是死文案或条件写错',
          actual: form.text,
          suggestedTrigger: suggestTrigger(
            when,
            characters,
            items,
            entry.forms.map((f) => f.when ?? {}),
          ),
        });
      });
    }
  }

  return issues;
}

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * 把同一缺陷在多个样例上的触发合并为一条，
 * 保留 relatedSampleIds，报告里既能聚合阅读又能追到具体样例。
 */
export function aggregateIssues(issues: QaIssue[]): QaIssue[] {
  const groups = new Map<string, QaIssue & { relatedSampleIds: string[] }>();

  for (const issue of issues) {
    const key = JSON.stringify([
      issue.kind,
      issue.code,
      issue.locale,
      issue.entryId,
      whenSignature(issue.when ?? null),
      issue.message,
      issue.expected ?? '',
      issue.actual ?? '',
      issue.suggestedTrigger ?? '',
      issue.severity,
    ]);
    const existing = groups.get(key);
    if (existing) {
      existing.sampleCount = (existing.sampleCount ?? 1) + 1;
      if (issue.sampleId) existing.relatedSampleIds.push(issue.sampleId);
    } else {
      groups.set(key, {
        ...issue,
        sampleCount: 1,
        relatedSampleIds: issue.sampleId ? [issue.sampleId] : [],
      });
    }
  }

  const severityRank = { error: 0, warning: 1, info: 2 } as const;
  const kindRank = {
    'var-missing': 0,
    'type-mismatch': 1,
    'var-extra': 2,
    'missing-entry': 3,
    'fallback-used': 4,
    'unreached-form': 5,
  } as const;

  return [...groups.values()].sort((a, b) => {
    const s = severityRank[a.severity] - severityRank[b.severity];
    if (s) return s;
    const k = kindRank[a.kind] - kindRank[b.kind];
    if (k) return k;
    return `${a.locale}${a.entryId}`.localeCompare(`${b.locale}${b.entryId}`);
  });
}

export function summarizeIssues(issues: QaIssue[]): Record<QaIssue['kind'], number> & {
  errors: number;
  warnings: number;
  total: number;
} {
  const summary = {
    'var-missing': 0,
    'var-extra': 0,
    'type-mismatch': 0,
    'unreached-form': 0,
    'fallback-used': 0,
    'missing-entry': 0,
    errors: 0,
    warnings: 0,
    total: issues.length,
  };
  for (const i of issues) {
    summary[i.kind] += 1;
    if (i.severity === 'error') summary.errors += 1;
    if (i.severity === 'warning') summary.warnings += 1;
  }
  return summary;
}
