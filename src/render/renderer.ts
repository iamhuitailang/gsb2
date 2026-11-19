import type {
  BackgroundMode,
  EmitterConfig,
  Particle,
  SceneConfig,
  SimulationResult,
  TextureKind,
} from '../core/types.ts';
import { STAGE_HEIGHT, STAGE_WIDTH } from '../core/types.ts';
import { emitterPositionAt } from '../core/simulation.ts';
import { buildTextures } from './textures.ts';

export interface ViewTransform {
  scale: number;
  offsetX: number;
  offsetY: number;
}

export interface RenderOptions {
  scene: SceneConfig;
  emitters: EmitterConfig[];
  simulation: SimulationResult;
  time: number;
  showEmitterMarkers: boolean;
  showGrid: boolean;
  selectedEmitterId?: string | null;
}

export interface RenderOutput {
  drawMs: number;
  particleCount: number;
}

export interface SceneRenderer {
  resize(): void;
  render(options: RenderOptions): RenderOutput;
  readonly canvas: HTMLCanvasElement;
}

function currentDpr(): number {
  return Math.max(1, globalThis.devicePixelRatio || 1);
}

/** 画布像素坐标（含 DPR）→ 舞台坐标。 */
export function computeViewTransform(width: number, height: number, zoom = 1): ViewTransform {
  const dpr = currentDpr();
  const cssW = width / dpr;
  const cssH = height / dpr;
  const fit = Math.min(cssW / STAGE_WIDTH, cssH / STAGE_HEIGHT);
  const scale = fit * zoom * dpr;
  return {
    scale,
    offsetX: (width - STAGE_WIDTH * scale) / 2,
    offsetY: (height - STAGE_HEIGHT * scale) / 2,
  };
}

export function screenToWorld(
  clientX: number,
  clientY: number,
  rect: DOMRect,
  transform: ViewTransform,
): { x: number; y: number } {
  const dpr = currentDpr();
  return {
    x: ((clientX - rect.left) * dpr - transform.offsetX) / transform.scale,
    y: ((clientY - rect.top) * dpr - transform.offsetY) / transform.scale,
  };
}

/* ------------------------------------------------------------------ */
/* 粒子绘制（渲染器与序列图导出共用）                                   */
/* ------------------------------------------------------------------ */

const tintCache = new Map<string, HTMLCanvasElement>();
const TINT_CACHE_LIMIT = 768;

function tintedTexture(
  texture: TextureKind,
  variant: number,
  r: number,
  g: number,
  b: number,
): HTMLCanvasElement {
  const textures = buildTextures();
  const list = textures.white[texture];
  const index = Math.abs(variant) % list.length;
  const source = list[index];
  // 量化到 8 级（每通道 32 步进），肉眼几乎无差异但缓存命中率高。
  const qr = Math.min(255, Math.round(r / 32) * 32);
  const qg = Math.min(255, Math.round(g / 32) * 32);
  const qb = Math.min(255, Math.round(b / 32) * 32);
  const key = `${texture}:${index}:${qr},${qg},${qb}`;
  const hit = tintCache.get(key);
  if (hit) return hit;

  const off = document.createElement('canvas');
  off.width = source.width;
  off.height = source.height;
  const offCtx = off.getContext('2d');
  if (!offCtx) return source;
  offCtx.drawImage(source, 0, 0);
  offCtx.globalCompositeOperation = 'source-in';
  offCtx.fillStyle = `rgb(${qr}, ${qg}, ${qb})`;
  offCtx.fillRect(0, 0, off.width, off.height);

  if (tintCache.size >= TINT_CACHE_LIMIT) {
    const oldest = tintCache.keys().next().value;
    if (oldest !== undefined) tintCache.delete(oldest);
  }
  tintCache.set(key, off);
  return off;
}

function paintParticle(
  ctx: CanvasRenderingContext2D,
  particle: Particle,
  texture: TextureKind,
) {
  if (particle.alpha <= 0.004 || particle.size <= 0.05) return;
  const [r, g, b] = particle.color;
  const image = tintedTexture(texture, particle.variant, r, g, b);
  const size = particle.size;

  ctx.globalAlpha = particle.alpha;
  if (texture === 'spark' && (particle.vx !== 0 || particle.vy !== 0)) {
    ctx.save();
    ctx.translate(particle.x, particle.y);
    ctx.rotate(Math.atan2(particle.vy, particle.vx));
    // 火花贴图沿 +x 拉伸，长度取粒子大小的 2.4 倍。
    ctx.drawImage(image, -size * 1.2, -size * 0.5, size * 2.4, size);
    ctx.restore();
  } else {
    ctx.drawImage(image, particle.x - size / 2, particle.y - size / 2, size, size);
  }
  ctx.globalAlpha = 1;
}

/** 按发射器顺序绘制粒子，负责混合模式切换。 */
export function paintParticles(
  ctx: CanvasRenderingContext2D,
  emitters: EmitterConfig[],
  simulation: SimulationResult,
): number {
  const map = new Map(emitters.map((emitter) => [emitter.id, emitter]));
  ctx.imageSmoothingEnabled = true;
  let count = 0;

  for (const result of simulation.emitters) {
    const particles = result.particles;
    if (particles.length === 0) continue;
    const emitter = map.get(result.emitterId);
    if (!emitter) continue;
    ctx.globalCompositeOperation = emitter.blend === 'additive' ? 'lighter' : 'source-over';
    for (let i = 0; i < particles.length; i++) {
      paintParticle(ctx, particles[i], emitter.texture);
      count++;
    }
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  return count;
}

/** 在给定矩形内铺底；序列图导出时按格子调用。offset 是相对矩形左上角的偏移。 */
export function paintBackdrop(
  ctx: CanvasRenderingContext2D,
  rect: { x: number; y: number; w: number; h: number },
  mode: BackgroundMode,
  scale: number,
  offsetX: number,
  offsetY: number,
) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.w, rect.h);
  ctx.clip();
  ctx.clearRect(rect.x, rect.y, rect.w, rect.h);

  // 透明模式不铺底，页面用棋盘格衬底表现透明区域。
  if (mode === 'dark') {
    ctx.fillStyle = '#08090d';
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  } else if (mode === 'preview') {
    const grad = ctx.createLinearGradient(0, rect.y, 0, rect.y + rect.h);
    grad.addColorStop(0, '#171a20');
    grad.addColorStop(1, '#0b0c10');
    ctx.fillStyle = grad;
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  }

  ctx.translate(rect.x + offsetX, rect.y + offsetY);
  ctx.scale(scale, scale);
  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
  ctx.lineWidth = 1 / scale;
  ctx.strokeRect(0, 0, STAGE_WIDTH, STAGE_HEIGHT);
  ctx.restore();
}

/* ------------------------------------------------------------------ */
/* 交互式渲染器                                                        */
/* ------------------------------------------------------------------ */

export function createSceneRenderer(canvas: HTMLCanvasElement): SceneRenderer {
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) throw new Error('无法创建 2D 画布上下文');

  function resize() {
    const dpr = currentDpr();
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
  }

  function stageTransform() {
    const t = computeViewTransform(canvas.width, canvas.height, 1);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.translate(t.offsetX, t.offsetY);
    ctx.scale(t.scale, t.scale);
    return t;
  }

  function drawGrid() {
    const t = stageTransform();
    ctx.strokeStyle = 'rgba(255,255,255,0.055)';
    ctx.lineWidth = 1 / t.scale;
    ctx.beginPath();
    for (let x = 100; x < STAGE_WIDTH; x += 100) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, STAGE_HEIGHT);
    }
    for (let y = 100; y < STAGE_HEIGHT; y += 100) {
      ctx.moveTo(0, y);
      ctx.lineTo(STAGE_WIDTH, y);
    }
    ctx.stroke();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  function drawEmitterMarkers(emitters: EmitterConfig[], time: number, selectedId: string | null) {
    const t = stageTransform();
    const lineWidth = 1.5 / t.scale;

    for (const emitter of emitters) {
      if (!emitter.enabled) continue;
      const pos = emitterPositionAt(emitter, time);
      const radius = Math.max(7, emitter.spawnRadius);
      const selected = emitter.id === selectedId;

      ctx.beginPath();
      ctx.strokeStyle = selected ? 'rgba(122, 226, 255, 0.95)' : 'rgba(255,255,255,0.32)';
      ctx.lineWidth = selected ? lineWidth * 1.6 : lineWidth;
      ctx.arc(pos.x, pos.y, radius, 0, Math.PI * 2);
      ctx.stroke();

      ctx.beginPath();
      ctx.fillStyle = selected ? 'rgba(122, 226, 255, 0.9)' : 'rgba(255,255,255,0.42)';
      ctx.arc(pos.x, pos.y, 2.4 * lineWidth + 1, 0, Math.PI * 2);
      ctx.fill();

      const angle = (emitter.direction.angle * Math.PI) / 180;
      const arrow = radius + 18;
      ctx.beginPath();
      ctx.strokeStyle = selected ? 'rgba(122, 226, 255, 0.7)' : 'rgba(255,255,255,0.2)';
      ctx.lineWidth = lineWidth;
      ctx.moveTo(pos.x, pos.y);
      ctx.lineTo(pos.x + Math.cos(angle) * arrow, pos.y + Math.sin(angle) * arrow);
      ctx.stroke();
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  return {
    canvas,
    resize,
    render(options) {
      const started = performance.now();
      resize();
      const t = computeViewTransform(canvas.width, canvas.height, 1);
      paintBackdrop(
        ctx,
        { x: 0, y: 0, w: canvas.width, h: canvas.height },
        options.scene.background,
        t.scale,
        t.offsetX,
        t.offsetY,
      );
      ctx.setTransform(1, 0, 0, 1, 0, 0);

      if (options.showGrid) drawGrid();

      ctx.save();
      ctx.translate(t.offsetX, t.offsetY);
      ctx.scale(t.scale, t.scale);
      const particleCount = paintParticles(ctx, options.emitters, options.simulation);
      ctx.restore();

      if (options.showEmitterMarkers) {
        drawEmitterMarkers(options.emitters, options.time, options.selectedEmitterId ?? null);
      }
      return { drawMs: performance.now() - started, particleCount };
    },
  };
}
