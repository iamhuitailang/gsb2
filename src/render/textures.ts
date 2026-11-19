/**
 * 程序化贴图：所有粒子素材都由 Canvas 2D 在启动时生成，
 * 不依赖外部图片，示例资源完全由程序产生。
 */

import type { TextureKind } from '../core/types.ts';

export const TEXTURE_SIZE = 96;
export const TEXTURE_VARIANTS = 3;

export type TextureAtlas = Record<TextureKind, HTMLCanvasElement[]>;

function makeCanvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 2D 画布上下文');
  return [canvas, ctx];
}

/** 固定的伪随机，保证每次生成的贴图一致。 */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function radialSoft(size: number, variant: number): HTMLCanvasElement {
  const [canvas, ctx] = makeCanvas(size);
  const rnd = seeded(0x51ed + variant * 97);
  const r = size / 2;
  ctx.clearRect(0, 0, size, size);

  // 外层柔光
  const halo = ctx.createRadialGradient(r, r, 0, r, r, r);
  halo.addColorStop(0, 'rgba(255,255,255,1)');
  halo.addColorStop(0.28, `rgba(255,255,255,${0.72 + rnd() * 0.08})`);
  halo.addColorStop(0.62, 'rgba(255,255,255,0.16)');
  halo.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(r, r, r, 0, Math.PI * 2);
  ctx.fill();

  // 内核
  const core = ctx.createRadialGradient(r, r, 0, r, r, r * 0.3);
  core.addColorStop(0, 'rgba(255,255,255,0.95)');
  core.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(r, r, r * 0.3, 0, Math.PI * 2);
  ctx.fill();

  return canvas;
}

function smokePuff(size: number, variant: number): HTMLCanvasElement {
  const [canvas, ctx] = makeCanvas(size);
  const rnd = seeded(0x5ee0 + variant * 131);
  const r = size / 2;
  ctx.clearRect(0, 0, size, size);
  ctx.globalCompositeOperation = 'lighter';

  const blobs = 5 + Math.floor(rnd() * 3);
  for (let i = 0; i < blobs; i++) {
    const angle = rnd() * Math.PI * 2;
    const dist = rnd() * r * 0.32;
    const bx = r + Math.cos(angle) * dist;
    const by = r + Math.sin(angle) * dist;
    const br = r * (0.42 + rnd() * 0.3);
    const gradient = ctx.createRadialGradient(bx, by, br * 0.1, bx, by, br);
    gradient.addColorStop(0, 'rgba(255,255,255,0.42)');
    gradient.addColorStop(0.55, 'rgba(255,255,255,0.16)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(bx, by, br, 0, Math.PI * 2);
    ctx.fill();
  }

  // 用 destination-in 做圆形羽化，避免贴图边缘出现硬边。
  ctx.globalCompositeOperation = 'destination-in';
  const mask = ctx.createRadialGradient(r, r, r * 0.35, r, r, r);
  mask.addColorStop(0, 'rgba(255,255,255,1)');
  mask.addColorStop(0.78, 'rgba(255,255,255,0.85)');
  mask.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = mask;
  ctx.beginPath();
  ctx.arc(r, r, r, 0, Math.PI * 2);
  ctx.fill();

  return canvas;
}

function sparkStreak(size: number, variant: number): HTMLCanvasElement {
  const [canvas, ctx] = makeCanvas(size);
  ctx.clearRect(0, 0, size, size);

  // 火花沿 +x 方向拉伸；渲染时按速度方向旋转。
  const length = size * (0.8 + variant * 0.05);
  const thickness = size * 0.2;
  ctx.save();
  ctx.translate(0, size / 2);
  const gradient = ctx.createLinearGradient(0, 0, length, 0);
  gradient.addColorStop(0, 'rgba(255,255,255,0)');
  gradient.addColorStop(0.45, 'rgba(255,255,255,0.55)');
  gradient.addColorStop(0.82, 'rgba(255,255,255,0.95)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.ellipse(length * 0.52, 0, length * 0.48, thickness * 0.5, 0, 0, Math.PI * 2);
  ctx.fill();

  const core = ctx.createRadialGradient(length * 0.62, 0, 0, length * 0.62, 0, thickness * 0.7);
  core.addColorStop(0, 'rgba(255,255,255,1)');
  core.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(length * 0.62, 0, thickness * 0.7, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  return canvas;
}

function tint(canvas: HTMLCanvasElement, color: string): HTMLCanvasElement {
  const [out, ctx] = makeCanvas(canvas.width);
  ctx.drawImage(canvas, 0, 0);
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  return out;
}

export interface TextureSet {
  /** 已染成白色的原图，渲染时用 globalCompositeOperation 叠加 */
  white: TextureAtlas;
  /** 带颜色的版本，开发面板中展示 */
  previews: Record<TextureKind, string>;
}

let cached: TextureSet | null = null;

export function buildTextures(): TextureSet {
  if (cached) return cached;

  const white: TextureAtlas = {
    soft: [radialSoft(TEXTURE_SIZE, 0), radialSoft(TEXTURE_SIZE, 1), radialSoft(TEXTURE_SIZE, 2)],
    smoke: [smokePuff(TEXTURE_SIZE, 0), smokePuff(TEXTURE_SIZE, 1), smokePuff(TEXTURE_SIZE, 2)],
    spark: [sparkStreak(TEXTURE_SIZE, 0), sparkStreak(TEXTURE_SIZE, 1), sparkStreak(TEXTURE_SIZE, 2)],
  };

  const previewColors: Record<TextureKind, string> = {
    soft: '#ffe08a',
    smoke: '#9a9694',
    spark: '#ff8a2b',
  };

  const previews = {} as Record<TextureKind, string>;
  for (const kind of Object.keys(white) as TextureKind[]) {
    previews[kind] = tint(white[kind][0], previewColors[kind]).toDataURL('image/png');
  }

  cached = { white, previews };
  return cached;
}

/** 用于离线导出序列图：独立于页面 DPR 的 1:1 版本。 */
export function textureVersion(kind: TextureKind, variant: number): HTMLCanvasElement {
  const set = buildTextures();
  const list = set.white[kind];
  return list[Math.abs(variant) % list.length];
}
