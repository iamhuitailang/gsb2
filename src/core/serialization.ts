import type { EmitterConfig, Project } from './types.ts';
import { PROJECT_VERSION } from './types.ts';
import { normalizeProject } from './project.ts';

export const PROJECT_MAGIC = 'particle-studio-project';
const MAX_FILE_BYTES = 4 * 1024 * 1024;

export interface ParseResult {
  ok: boolean;
  project?: Project;
  warnings: string[];
  error?: string;
}

/** 需要写入文件的内容（不含运行期字段）。 */
export function serializeProject(project: Project): string {
  const payload = {
    magic: PROJECT_MAGIC,
    version: PROJECT_VERSION,
    name: project.name,
    scene: project.scene,
    emitters: project.emitters.map((emitter) => sanitizeEmitterForExport(emitter)),
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

function sanitizeEmitterForExport(emitter: EmitterConfig): EmitterConfig {
  return {
    ...emitter,
    sizeCurve: {
      points: emitter.sizeCurve.points.map((p) => ({ t: round(p.t, 4), v: round(p.v, 3) })),
      interpolation: emitter.sizeCurve.interpolation,
    },
    alphaCurve: {
      points: emitter.alphaCurve.points.map((p) => ({ t: round(p.t, 4), v: round(p.v, 4) })),
      interpolation: emitter.alphaCurve.interpolation,
    },
    gradient: {
      stops: emitter.gradient.stops.map((s) => ({ t: round(s.t, 4), color: s.color })),
    },
  };
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function parseProjectText(input: string): ParseResult {
  const warnings: string[] = [];
  if (typeof input !== 'string' || input.trim().length === 0) {
    return { ok: false, warnings, error: '文件为空。' };
  }
  if (new TextEncoder().encode(input).length > MAX_FILE_BYTES) {
    return { ok: false, warnings, error: '文件超过 4 MB，已拒绝载入。' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (error) {
    return {
      ok: false,
      warnings,
      error: `JSON 解析失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, warnings, error: '文件内容不是工程对象。' };
  }
  const record = parsed as Record<string, unknown>;
  if (record.magic !== undefined && record.magic !== PROJECT_MAGIC) {
    return { ok: false, warnings, error: '不认识的工程文件类型。' };
  }
  if (!record.scene && !record.emitters) {
    return { ok: false, warnings, error: '缺少 scene / emitters 字段，无法识别为粒子工程。' };
  }

  try {
    const normalized = normalizeProject(record);
    warnings.push(...normalized.warnings);
    return { ok: true, project: normalized.project, warnings };
  } catch (error) {
    return {
      ok: false,
      warnings,
      error: `工程校验失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** 导出给游戏引擎使用的扁平配置。 */
export function exportRuntimeConfig(project: Project): string {
  const payload = {
    name: project.name,
    seed: project.scene.seed,
    duration: project.scene.duration,
    fps: project.scene.fps,
    gravity: project.scene.gravity,
    maxParticles: project.scene.maxParticles,
    emitters: project.emitters
      .filter((emitter) => emitter.enabled)
      .map((emitter) => ({
        id: emitter.id,
        name: emitter.name,
        space: emitter.space,
        texture: emitter.texture,
        blend: emitter.blend,
        position: emitter.position,
        motion: emitter.motion,
        emission: emitter.emission,
        speed: emitter.speed,
        direction: emitter.direction,
        spawnRadius: emitter.spawnRadius,
        lifetime: emitter.lifetime,
        sizeCurve: {
          interpolation: emitter.sizeCurve.interpolation,
          keys: emitter.sizeCurve.points,
        },
        alphaCurve: {
          interpolation: emitter.alphaCurve.interpolation,
          keys: emitter.alphaCurve.points,
        },
        gradient: emitter.gradient.stops,
        alpha: emitter.alpha,
        gravityScale: emitter.gravityScale,
      })),
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}
