import { normalizeBlock } from '../blocks';
import {
  DEFAULT_LANGUAGE,
  DEFAULT_SCENE,
  ITEMS,
  LANGUAGES,
  SCENES,
} from '../demoData';
import type {
  ExportDoc,
  ItemDef,
  LabConfig,
  LanguageDef,
  PackManifest,
  ProvenanceRow,
  SceneDef,
  Variant,
} from '../types';
import { analyzePacks } from './graph';
import { resolveItem } from './resolve';

/* ------------------------------ 来源清单 ------------------------------ */

export function buildProvenance(args: {
  items: ItemDef[];
  scenes: SceneDef[];
  languages: LanguageDef[];
  library: PackManifest[];
  enabled: Record<string, boolean>;
  priorities: Record<string, number>;
}): ProvenanceRow[] {
  const { items, scenes, languages, library, enabled, priorities } = args;
  const packNames = new Map(library.map((p) => [p.id, p.name]));
  const rows: ProvenanceRow[] = [];

  for (const scene of scenes) {
    for (const language of languages) {
      const analysis = analyzePacks(library, enabled, priorities);
      for (const item of items) {
        const r = resolveItem(
          item.id,
          { scene: scene.id, language: language.id },
          library,
          analysis,
        );
        const sourceId = r.winnerPackId ?? r.removedByPackId ?? null;
        rows.push({
          itemId: item.id,
          itemName: item.name,
          scene: scene.id,
          language: language.id,
          status: r.status,
          sourcePackId: sourceId,
          sourcePackName: sourceId ? (packNames.get(sourceId) ?? sourceId) : null,
          matchedSceneKey: r.winnerVariant?.scene ?? null,
          matchedLangKey: r.winnerVariant?.lang ?? null,
          removedByPackId: r.removedByPackId ?? null,
          conflictPackIds: r.conflict?.packIds ?? [],
          block: r.winnerVariant?.block ?? null,
        });
      }
    }
  }
  return rows;
}

/* -------------------------------- 导出 -------------------------------- */

export function buildExportDoc(args: {
  config: LabConfig;
  items: ItemDef[];
  scenes: SceneDef[];
  languages: LanguageDef[];
  library: PackManifest[];
  provenance: ProvenanceRow[];
}): ExportDoc {
  return {
    app: 'asset-pack-lab',
    schema: 1,
    exportedAt: new Date().toISOString(),
    config: args.config,
    items: args.items,
    scenes: args.scenes,
    languages: args.languages,
    library: args.library,
    provenance: args.provenance,
  };
}

export function downloadTextFile(
  filename: string,
  text: string,
  mime: string,
): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function timestampSlug(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function provenanceToCsv(rows: ProvenanceRow[]): string {
  const header = [
    'itemId',
    'itemName',
    'scene',
    'language',
    'status',
    'sourcePackId',
    'sourcePackName',
    'matchedSceneKey',
    'matchedLangKey',
    'removedByPackId',
    'conflictPackIds',
  ];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.itemId,
        r.itemName,
        r.scene,
        r.language,
        r.status,
        r.sourcePackId,
        r.sourcePackName,
        r.matchedSceneKey,
        r.matchedLangKey,
        r.removedByPackId,
        r.conflictPackIds.join('|'),
      ]
        .map(csvCell)
        .join(','),
    );
  }
  // 加 BOM，Excel 打开中文不乱码
  return '﻿' + lines.join('\n');
}

/* -------------------------------- 导入 -------------------------------- */

export interface VerificationReport {
  checked: number;
  consistent: number;
  mismatches: string[];
}

export interface ParsedImport {
  config: LabConfig;
  items: ItemDef[];
  scenes: SceneDef[];
  languages: LanguageDef[];
  library: PackManifest[];
  verification: VerificationReport | null;
  warnings: string[];
  exportedAt?: string;
}

export type ImportResult =
  | { ok: true; data: ParsedImport }
  | { ok: false; errors: string[] };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asStringArray(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) return null;
  return v as string[];
}

function sanitizeVariant(raw: unknown): Variant | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.scene !== 'string' || typeof raw.lang !== 'string') return null;
  const block = normalizeBlock(raw.block);
  if (!block) return null;
  return {
    scene: raw.scene,
    lang: raw.lang,
    block,
    ...(typeof raw.note === 'string' ? { note: raw.note } : {}),
  };
}

/** 严格但宽容地清洗导入的清单：坏条目丢弃并给警告，而不是执行任何内容 */
function sanitizeLibrary(raw: unknown): {
  library: PackManifest[] | null;
  warnings: string[];
} {
  const warnings: string[] = [];
  if (!Array.isArray(raw)) return { library: null, warnings };

  const library: PackManifest[] = [];
  const seenIds = new Set<string>();

  raw.forEach((entry, i) => {
    if (!isRecord(entry)) {
      warnings.push(`library[${i}] 不是对象，已跳过`);
      return;
    }
    if (typeof entry.id !== 'string' || !entry.id) {
      warnings.push(`library[${i}] 缺少字符串 id，已跳过`);
      return;
    }
    if (seenIds.has(entry.id)) {
      warnings.push(`包 id「${entry.id}」重复，已跳过后者`);
      return;
    }
    if (
      entry.kind !== 'base' &&
      entry.kind !== 'replace' &&
      entry.kind !== 'language'
    ) {
      warnings.push(`包「${entry.id}」kind 非法，已跳过`);
      return;
    }
    if (typeof entry.name !== 'string') {
      warnings.push(`包「${entry.id}」缺少 name，已跳过`);
      return;
    }

    const pack: PackManifest = {
      id: entry.id,
      name: entry.name,
      kind: entry.kind,
      version: typeof entry.version === 'string' ? entry.version : '0.0.0',
      priority:
        typeof entry.priority === 'number' && Number.isFinite(entry.priority)
          ? entry.priority
          : 0,
    };
    if (typeof entry.description === 'string') pack.description = entry.description;
    if (typeof entry.accent === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(entry.accent)) {
      pack.accent = entry.accent;
    }
    const deps = asStringArray(entry.dependencies);
    if (deps) pack.dependencies = deps;

    if (isRecord(entry.resources)) {
      const resources: Record<string, Variant[]> = {};
      for (const [itemId, list] of Object.entries(entry.resources)) {
        if (!Array.isArray(list)) continue;
        const variants = list
          .map(sanitizeVariant)
          .filter((v): v is Variant => v !== null);
        if (variants.length > 0) resources[itemId] = variants;
      }
      pack.resources = resources;
    }

    if (Array.isArray(entry.removals)) {
      const removals = [];
      for (const r of entry.removals) {
        if (!isRecord(r) || typeof r.item !== 'string') continue;
        removals.push({
          item: r.item,
          ...(typeof r.scene === 'string' ? { scene: r.scene } : {}),
          ...(typeof r.lang === 'string' ? { lang: r.lang } : {}),
          ...(typeof r.reason === 'string' ? { reason: r.reason } : {}),
        });
      }
      if (removals.length > 0) pack.removals = removals;
    }

    seenIds.add(pack.id);
    library.push(pack);
  });

  return { library, warnings };
}

function sanitizeItems(raw: unknown): ItemDef[] | null {
  if (!Array.isArray(raw)) return null;
  const items: ItemDef[] = [];
  for (const e of raw) {
    if (!isRecord(e) || typeof e.id !== 'string' || typeof e.name !== 'string') {
      continue;
    }
    items.push({
      id: e.id,
      name: e.name,
      category: typeof e.category === 'string' ? e.category : '其他',
    });
  }
  return items.length > 0 ? items : null;
}

function sanitizeScenes(raw: unknown): SceneDef[] | null {
  if (!Array.isArray(raw)) return null;
  const out: SceneDef[] = [];
  for (const e of raw) {
    if (isRecord(e) && typeof e.id === 'string' && typeof e.name === 'string') {
      out.push({ id: e.id, name: e.name });
    }
  }
  return out.length > 0 ? out : null;
}

function sanitizeLanguages(raw: unknown): LanguageDef[] | null {
  if (!Array.isArray(raw)) return null;
  const out: LanguageDef[] = [];
  for (const e of raw) {
    if (isRecord(e) && typeof e.id === 'string' && typeof e.name === 'string') {
      out.push({ id: e.id, name: e.name });
    }
  }
  return out.length > 0 ? out : null;
}

/** 校验并解析导入的 JSON 文本；任何致命结构问题都返回中文错误列表 */
export function parseImportText(text: string): ImportResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return {
      ok: false,
      errors: [`JSON 解析失败：${e instanceof Error ? e.message : String(e)}`],
    };
  }

  if (!isRecord(raw)) {
    return { ok: false, errors: ['文件顶层不是 JSON 对象'] };
  }
  if (raw.app !== 'asset-pack-lab') {
    return {
      ok: false,
      errors: ['不是本试验场导出的文件（缺少 app = "asset-pack-lab" 标识）'],
    };
  }
  if (raw.schema !== 1) {
    return { ok: false, errors: [`不支持的 schema 版本：${String(raw.schema)}`] };
  }
  if (!isRecord(raw.config)) {
    return { ok: false, errors: ['缺少 config 配置段'] };
  }

  const warnings: string[] = [];
  const { library: importedLibrary, warnings: libWarnings } = sanitizeLibrary(
    raw.library,
  );
  warnings.push(...libWarnings);

  // 配置型导入（无 library）时回退到当前内置演示库由调用方处理；
  // 这里先允许 library 为 null，但要求 config 引用的包至少……不做硬校验，
  // 因为调用方会在合并 fallback 后再校验。
  const items = sanitizeItems(raw.items) ?? ITEMS;
  const scenes = sanitizeScenes(raw.scenes) ?? SCENES;
  const languages = sanitizeLanguages(raw.languages) ?? LANGUAGES;

  const cfgRaw = raw.config;
  const queryRaw = isRecord(cfgRaw.query) ? cfgRaw.query : {};
  const scene =
    typeof queryRaw.scene === 'string' &&
    scenes.some((s) => s.id === queryRaw.scene)
      ? (queryRaw.scene as string)
      : (scenes[0]?.id ?? DEFAULT_SCENE);
  const language =
    typeof queryRaw.language === 'string' &&
    languages.some((l) => l.id === queryRaw.language)
      ? (queryRaw.language as string)
      : (languages[0]?.id ?? DEFAULT_LANGUAGE);

  const enabled: Record<string, boolean> = {};
  if (isRecord(cfgRaw.enabled)) {
    for (const [k, v] of Object.entries(cfgRaw.enabled)) {
      enabled[k] = Boolean(v);
    }
  }
  const priorities: Record<string, number> = {};
  if (isRecord(cfgRaw.priorities)) {
    for (const [k, v] of Object.entries(cfgRaw.priorities)) {
      if (typeof v === 'number' && Number.isFinite(v)) priorities[k] = v;
    }
  }

  const config: LabConfig = {
    query: { scene, language },
    selectedItemId:
      typeof cfgRaw.selectedItemId === 'string' ? cfgRaw.selectedItemId : items[0].id,
    enabled,
    priorities,
  };

  // 复算来源清单并与文件内快照逐行比对
  let verification: VerificationReport | null = null;
  const library = importedLibrary;
  if (library && Array.isArray(raw.provenance)) {
    const recomputed = buildProvenance({
      items,
      scenes,
      languages,
      library,
      enabled,
      priorities,
    });
    const recomputeMap = new Map(
      recomputed.map((r) => [`${r.itemId}|${r.scene}|${r.language}`, r]),
    );
    let consistent = 0;
    const mismatches: string[] = [];
    let checked = 0;

    for (const row of raw.provenance) {
      if (!isRecord(row)) continue;
      const key = `${String(row.itemId)}|${String(row.scene)}|${String(row.language)}`;
      const actual = recomputeMap.get(key);
      if (!actual) continue;
      checked += 1;
      const expectedSource =
        (row.sourcePackId as string | null) ??
        (row.removedByPackId as string | null) ??
        null;
      const actualSource = actual.sourcePackId;
      const same =
        row.status === actual.status && expectedSource === actualSource;
      if (same) {
        consistent += 1;
      } else {
        mismatches.push(
          `${key}：文件记录 ${String(row.status)}/${String(expectedSource)}，复算 ${actual.status}/${String(actualSource)}`,
        );
      }
    }
    verification = { checked, consistent, mismatches: mismatches.slice(0, 20) };
  }

  if (!library) {
    warnings.push('文件未包含完整 library，将尝试套用当前内置演示包库');
  }

  return {
    ok: true,
    data: {
      config,
      items,
      scenes,
      languages,
      // 由 main 在 config-only 情况下替换为内置库
      library: library ?? [],
      verification,
      warnings,
      exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : undefined,
    },
  };
}
