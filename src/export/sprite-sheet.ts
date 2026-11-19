import type { EmitterConfig, Project, SimulationResult } from '../core/types.ts';
import { STAGE_HEIGHT, STAGE_WIDTH } from '../core/types.ts';
import { simulateScene } from '../core/simulation.ts';
import { paintBackdrop, paintParticles } from '../render/renderer.ts';

export interface SheetOptions {
  /** 取样帧数，默认 12 */
  frameCount?: number;
  /** 单格缩放，默认 0.5 */
  cellScale?: number;
  /** 每行列数，默认 4 */
  columns?: number;
  /** 是否绘制帧标签 */
  labels?: boolean;
}

export interface SheetResult {
  blob: Blob;
  width: number;
  height: number;
  frameCount: number;
  /** 每帧仿真耗时（毫秒） */
  frameTimes: number[];
  totalParticles: number;
}

export const DEFAULT_SHEET_OPTIONS: Required<SheetOptions> = {
  frameCount: 12,
  cellScale: 0.5,
  columns: 4,
  labels: true,
};

/**
 * 离线渲染粒子序列图。
 *
 * 每个采样帧都调用同一个无状态仿真，因此序列图与预览在同一时刻
 * 完全一致（预算裁剪也一致）。
 */
export async function renderSpriteSheet(
  project: Project,
  overrides: SheetOptions = {},
): Promise<SheetResult> {
  const options = {
    frameCount: overrides.frameCount ?? DEFAULT_SHEET_OPTIONS.frameCount,
    cellScale: overrides.cellScale ?? DEFAULT_SHEET_OPTIONS.cellScale,
    columns: overrides.columns ?? DEFAULT_SHEET_OPTIONS.columns,
    labels: overrides.labels ?? DEFAULT_SHEET_OPTIONS.labels,
  };
  const frameCount = Math.max(1, Math.min(64, Math.round(options.frameCount)));
  const columns = Math.max(1, Math.min(frameCount, Math.round(options.columns)));
  const rows = Math.ceil(frameCount / columns);
  const scale = Math.max(0.15, Math.min(1, options.cellScale));
  const cellWidth = Math.round(STAGE_WIDTH * scale);
  const cellHeight = Math.round(STAGE_HEIGHT * scale);
  const gap = 8;
  const labelHeight = options.labels ? 20 : 0;

  const width = columns * cellWidth + (columns + 1) * gap;
  const height = rows * (cellHeight + labelHeight) + (rows + 1) * gap;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建导出画布');

  if (project.scene.background !== 'transparent') {
    ctx.fillStyle = '#0a0b0f';
    ctx.fillRect(0, 0, width, height);
  }

  const frameTimes: number[] = [];
  let totalParticles = 0;
  const duration = Math.max(0.05, project.scene.duration);
  const fps = project.scene.fps;
  // 让首末帧正好覆盖时间轴。
  const denominator = Math.max(1, frameCount - 1);

  for (let i = 0; i < frameCount; i++) {
    const time = frameCount === 1 ? 0 : (duration * i) / denominator;
    const col = i % columns;
    const row = Math.floor(i / columns);
    const originX = gap + col * (cellWidth + gap);
    const originY = gap + row * (cellHeight + labelHeight + gap);

    const started = performance.now();
    const simulation = simulateScene(project.scene, project.emitters, time);
    frameTimes.push(performance.now() - started);
    totalParticles += simulation.total;

    drawCell(
      ctx,
      { x: originX, y: originY, w: cellWidth, h: cellHeight },
      project.scene.background,
      scale,
      project.emitters,
      simulation,
    );

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    ctx.strokeRect(originX + 0.5, originY + 0.5, cellWidth - 1, cellHeight - 1);

    if (options.labels) {
      ctx.fillStyle = 'rgba(214, 244, 255, 0.78)';
      ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const frameIndex = Math.round(time * fps);
      ctx.fillText(
        `#${String(i + 1).padStart(2, '0')}  ${time.toFixed(2)}s · 帧 ${frameIndex} · ${simulation.total} 粒子`,
        originX + 2,
        originY + cellHeight + labelHeight / 2,
      );
    }
    ctx.restore();
  }

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('导出 PNG 失败');

  return {
    blob,
    width,
    height,
    frameCount,
    frameTimes,
    totalParticles,
  };
}

function drawCell(
  ctx: CanvasRenderingContext2D,
  rect: { x: number; y: number; w: number; h: number },
  background: Project['scene']['background'],
  scale: number,
  emitters: EmitterConfig[],
  simulation: SimulationResult,
) {
  // offset 是相对格子左上角的居中偏移。
  const offsetX = (rect.w - STAGE_WIDTH * scale) / 2;
  const offsetY = (rect.h - STAGE_HEIGHT * scale) / 2;

  paintBackdrop(ctx, rect, background, scale, offsetX, offsetY);

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.w, rect.h);
  ctx.clip();
  ctx.translate(rect.x + offsetX, rect.y + offsetY);
  ctx.scale(scale, scale);
  paintParticles(ctx, emitters, simulation);
  ctx.restore();
}

/** 逐帧统计，用于导出前预估开销。 */
export function scanFrameCosts(
  project: Project,
  frameCount = 12,
): { time: number; count: number; ms: number }[] {
  const out: { time: number; count: number; ms: number }[] = [];
  const duration = Math.max(0.05, project.scene.duration);
  for (let i = 0; i < frameCount; i++) {
    const time = frameCount === 1 ? 0 : (duration * i) / (frameCount - 1);
    const started = performance.now();
    const sim = simulateScene(project.scene, project.emitters, time);
    out.push({ time, count: sim.total, ms: performance.now() - started });
  }
  return out;
}
