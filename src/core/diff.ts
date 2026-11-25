import type { DiffReport, DiffRow, SnapshotRow, TriggerSample } from './types.ts';
import type { RenderDeps } from './render.ts';
import { renderSample } from './render.ts';

/** 对同一组触发样例在指定语言下做渲染快照 */
export function snapshotSamples(
  deps: RenderDeps,
  samples: TriggerSample[],
  locale: string,
): SnapshotRow[] {
  return samples.map((sample) => {
    const r = renderSample(deps, sample, locale);
    return {
      sampleId: sample.id,
      sampleLabel: sample.label,
      eventId: sample.eventId,
      entryId: sample.entryId,
      locale,
      text: r.text,
      sourceSignature: r.source.signature,
      sourceLabel: r.source.label + (r.source.via !== 'exact' ? `（${viaText(r.source.via)}）` : ''),
      ok: r.ok,
    };
  });
}

export function viaText(via: string): string {
  switch (via) {
    case 'exact':
      return '精确命中';
    case 'generic-form':
      return '通用句式回退';
    case 'count-fallback':
      return '数量式回退';
    case 'locale-fallback':
      return '跨语言回退';
    case 'missing':
      return '文案缺失';
    default:
      return via;
  }
}

/**
 * 对比两份同 key 快照：
 * - text-changed   渲染文字不同（来源可能也变了）
 * - source-only    文字逐字相同，只有来源坐标/回退状态变了
 * - status-changed 文字与来源都相同，但成功/出错状态变化
 */
export function diffSnapshots(
  before: SnapshotRow[],
  after: SnapshotRow[],
  locale: string,
  now: string = new Date().toISOString(),
): DiffReport {
  const beforeMap = new Map(before.map((r) => [r.sampleId, r]));
  const rows: DiffRow[] = [];

  for (const a of after) {
    const b = beforeMap.get(a.sampleId);
    if (!b) continue;
    let status: DiffRow['status'];
    if (b.text !== a.text) status = 'text-changed';
    else if (b.sourceSignature !== a.sourceSignature || b.sourceLabel !== a.sourceLabel)
      status = 'source-only';
    else if (b.ok !== a.ok) status = 'status-changed';
    else status = 'unchanged';

    rows.push({
      key: a.sampleId,
      sampleId: a.sampleId,
      sampleLabel: a.sampleLabel,
      eventId: a.eventId,
      entryId: a.entryId,
      status,
      before: b,
      after: a,
    });
  }

  return {
    locale,
    generatedAt: now,
    total: rows.length,
    textChanged: rows.filter((r) => r.status === 'text-changed'),
    sourceOnly: rows.filter((r) => r.status === 'source-only'),
    statusChanged: rows.filter((r) => r.status === 'status-changed'),
    unchangedCount: rows.filter((r) => r.status === 'unchanged').length,
    rows,
  };
}
