import {
  createRaster,
  hexToRgba,
  blendChannel,
  clamp01,
  writePixel,
  readPixel,
  type BlendMode,
} from './color.ts';
import { fbm2D } from './noise.ts';
import type { EvalContext, NodeDef, NodeOutput, ParamValue, RasterImage } from './types.ts';

function num(params: Record<string, ParamValue>, key: string): number {
  const value = params[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function str(params: Record<string, ParamValue>, key: string): string {
  const value = params[key];
  return typeof value === 'string' ? value : '';
}

function requiredImage(ctx: EvalContext, port: string, portLabel: string): RasterImage {
  const image = ctx.inputs[port];
  if (!image) {
    throw new Error(`输入端口「${portLabel}」未连接`);
  }
  return image;
}

/** Nearest-neighbor sample with clamped UV. */
function sample(
  image: RasterImage,
  u: number,
  v: number,
): [number, number, number, number] {
  const x = Math.min(image.width - 1, Math.max(0, Math.floor(clamp01(u) * image.width)));
  const y = Math.min(image.height - 1, Math.max(0, Math.floor(clamp01(v) * image.height)));
  const pixel = readPixel(image, x, y);
  return [pixel.r, pixel.g, pixel.b, pixel.a];
}

/** Nearest-neighbor sample with wrapping UV (tileable transforms). */
function sampleWrapped(
  image: RasterImage,
  u: number,
  v: number,
): [number, number, number, number] {
  const wrappedU = ((u % 1) + 1) % 1;
  const wrappedV = ((v % 1) + 1) % 1;
  const x = Math.min(image.width - 1, Math.floor(wrappedU * image.width));
  const y = Math.min(image.height - 1, Math.floor(wrappedV * image.height));
  const pixel = readPixel(image, x, y);
  return [pixel.r, pixel.g, pixel.b, pixel.a];
}

function noiseValue(
  x: number,
  y: number,
  width: number,
  height: number,
  seed: number,
  scale: number,
  octaves: number,
  contrast: number,
): number {
  const u = (x + 0.5) / width;
  const v = (y + 0.5) / height;
  const raw = fbm2D(u * scale, v * scale, seed, octaves, 0.5);
  return clamp01((raw - 0.5) * contrast + 0.5);
}

/** Shared UV resampling for the transform node; color and mask are produced together. */
function applyTransform(ctx: EvalContext): NodeOutput {
  const input = requiredImage(ctx, 'input', '输入');
  const offsetX = num(ctx.params, 'offsetX');
  const offsetY = num(ctx.params, 'offsetY');
  const scaleX = num(ctx.params, 'scaleX') || 1;
  const scaleY = num(ctx.params, 'scaleY') || 1;
  const rotation = (num(ctx.params, 'rotation') * Math.PI) / 180;
  const repeat = str(ctx.params, 'wrap') !== 'clamp';
  const image = createRaster(ctx.width, ctx.height);
  const mask = createRaster(ctx.width, ctx.height);
  const cos = Math.cos(-rotation);
  const sin = Math.sin(-rotation);
  for (let y = 0; y < ctx.height; y += 1) {
    for (let x = 0; x < ctx.width; x += 1) {
      const u = (x + 0.5) / ctx.width - 0.5;
      const v = (y + 0.5) / ctx.height - 0.5;
      const rotatedU = u * cos - v * sin;
      const rotatedV = u * sin + v * cos;
      const sourceU = rotatedU / scaleX + 0.5 + offsetX;
      const sourceV = rotatedV / scaleY + 0.5 + offsetY;
      const [r, g, b, a] = repeat
        ? sampleWrapped(input, sourceU, sourceV)
        : sample(input, sourceU, sourceV);
      writePixel(image, x, y, r, g, b, a);
      const value = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      writePixel(mask, x, y, value, value, value, 1);
    }
  }
  return { color: image, mask };
}

export const NODE_DEFS: NodeDef[] = [
  {
    type: 'solid',
    title: '纯色',
    category: '生成器',
    description: '输出单一颜色，作为调色的基底。',
    inputs: [],
    outputs: [{ key: 'color', label: '颜色', type: 'color' }],
    params: [
      { key: 'color', label: '颜色', kind: 'color', default: '#e2574c' },
      { key: 'alpha', label: '不透明度', kind: 'number', default: 1, min: 0, max: 1, step: 0.01 },
    ],
    evaluate(ctx) {
      const color = hexToRgba(str(ctx.params, 'color'));
      const alpha = clamp01(num(ctx.params, 'alpha'));
      const image = createRaster(ctx.width, ctx.height);
      for (let y = 0; y < ctx.height; y += 1) {
        for (let x = 0; x < ctx.width; x += 1) {
          writePixel(image, x, y, color.r, color.g, color.b, color.a * alpha);
        }
      }
      return { color: image };
    },
  },
  {
    type: 'gradient',
    title: '渐变',
    category: '生成器',
    description: '在两个颜色之间做线性或径向插值。',
    inputs: [],
    outputs: [{ key: 'color', label: '颜色', type: 'color' }],
    params: [
      { key: 'start', label: '起点颜色', kind: 'color', default: '#ffd36b' },
      { key: 'end', label: '终点颜色', kind: 'color', default: '#2e6bc4' },
      {
        key: 'mode',
        label: '类型',
        kind: 'select',
        default: 'linear',
        options: [
          { value: 'linear', label: '线性' },
          { value: 'radial', label: '径向' },
        ],
      },
      {
        key: 'angle',
        label: '角度',
        kind: 'number',
        default: 0,
        min: 0,
        max: 360,
        step: 1,
        help: '单位：度，0° 为从左到右',
        visible: (params) => str(params, 'mode') === 'linear',
      },
      {
        key: 'repeat',
        label: '重复次数',
        kind: 'number',
        default: 1,
        min: 1,
        max: 16,
        step: 1,
      },
    ],
    evaluate(ctx) {
      const start = hexToRgba(str(ctx.params, 'start'));
      const end = hexToRgba(str(ctx.params, 'end'));
      const mode = str(ctx.params, 'mode');
      const angle = (num(ctx.params, 'angle') * Math.PI) / 180;
      const repeat = Math.max(1, Math.round(num(ctx.params, 'repeat')));
      const image = createRaster(ctx.width, ctx.height);
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      for (let y = 0; y < ctx.height; y += 1) {
        for (let x = 0; x < ctx.width; x += 1) {
          const u = (x + 0.5) / ctx.width;
          const v = (y + 0.5) / ctx.height;
          const centeredU = u - 0.5;
          const centeredV = v - 0.5;
          const coordinate =
            mode === 'radial'
              ? Math.hypot(centeredU, centeredV) * 2 * repeat
              : (centeredU * cos + centeredV * sin + 0.5) * repeat;
          const t = clamp01(((coordinate % 1) + 1) % 1);
          writePixel(
            image,
            x,
            y,
            start.r + (end.r - start.r) * t,
            start.g + (end.g - start.g) * t,
            start.b + (end.b - start.b) * t,
            start.a + (end.a - start.a) * t,
          );
        }
      }
      return { color: image };
    },
  },
  {
    type: 'noise',
    title: '噪声',
    category: '生成器',
    description: '固定种子的分形值噪声，可输出彩色或灰度，并附带遮罩。',
    inputs: [],
    outputs: [
      { key: 'color', label: '颜色', type: 'color' },
      { key: 'mask', label: '遮罩', type: 'mask' },
    ],
    params: [
      {
        key: 'seed',
        label: '种子',
        kind: 'seed',
        default: 1337,
        min: 0,
        max: 2147483646,
        step: 1,
        help: '相同种子始终生成相同图像',
      },
      { key: 'scale', label: '缩放', kind: 'number', default: 4, min: 0.25, max: 64, step: 0.25 },
      { key: 'octaves', label: '分形层数', kind: 'number', default: 4, min: 1, max: 8, step: 1 },
      { key: 'contrast', label: '对比度', kind: 'number', default: 1, min: 0.1, max: 4, step: 0.05 },
      { key: 'low', label: '低值颜色', kind: 'color', default: '#0b1026' },
      { key: 'high', label: '高值颜色', kind: 'color', default: '#f4f1de' },
      { key: 'colored', label: '输出彩色', kind: 'boolean', default: true, help: '关闭时只输出灰度值' },
    ],
    evaluate(ctx) {
      const seed = Math.floor(num(ctx.params, 'seed'));
      const scale = Math.max(0.25, num(ctx.params, 'scale'));
      const octaves = Math.max(1, Math.round(num(ctx.params, 'octaves')));
      const contrast = Math.max(0.05, num(ctx.params, 'contrast'));
      const low = hexToRgba(str(ctx.params, 'low'));
      const high = hexToRgba(str(ctx.params, 'high'));
      const colored = ctx.params['colored'] !== false;
      const image = createRaster(ctx.width, ctx.height);
      const mask = createRaster(ctx.width, ctx.height);
      for (let y = 0; y < ctx.height; y += 1) {
        for (let x = 0; x < ctx.width; x += 1) {
          const shaped = noiseValue(x, y, ctx.width, ctx.height, seed, scale, octaves, contrast);
          if (colored) {
            writePixel(
              image,
              x,
              y,
              low.r + (high.r - low.r) * shaped,
              low.g + (high.g - low.g) * shaped,
              low.b + (high.b - low.b) * shaped,
              1,
            );
          } else {
            writePixel(image, x, y, shaped, shaped, shaped, 1);
          }
          writePixel(mask, x, y, shaped, shaped, shaped, 1);
        }
      }
      return { color: image, mask };
    },
  },
  {
    type: 'transform',
    title: '平移缩放',
    category: '处理',
    description: '对输入纹理做 UV 平移、缩放与旋转，遮罩输出为结果的亮度。',
    inputs: [{ key: 'input', label: '输入', type: 'color', required: true }],
    outputs: [
      { key: 'color', label: '颜色', type: 'color' },
      { key: 'mask', label: '遮罩', type: 'mask' },
    ],
    params: [
      { key: 'offsetX', label: 'X 平移', kind: 'number', default: 0, min: -1, max: 1, step: 0.01 },
      { key: 'offsetY', label: 'Y 平移', kind: 'number', default: 0, min: -1, max: 1, step: 0.01 },
      { key: 'scaleX', label: 'X 缩放', kind: 'number', default: 1, min: 0.05, max: 8, step: 0.05 },
      { key: 'scaleY', label: 'Y 缩放', kind: 'number', default: 1, min: 0.05, max: 8, step: 0.05 },
      { key: 'rotation', label: '旋转', kind: 'number', default: 0, min: -180, max: 180, step: 1 },
      {
        key: 'wrap',
        label: '边缘',
        kind: 'select',
        default: 'repeat',
        options: [
          { value: 'repeat', label: '平铺' },
          { value: 'clamp', label: '拉伸' },
        ],
      },
    ],
    evaluate: applyTransform,
  },
  {
    type: 'blend',
    title: '混合',
    category: '合成',
    description: '按混合模式合成两层颜色，并用遮罩控制混合区域。',
    inputs: [
      { key: 'base', label: '底层', type: 'color', required: true },
      { key: 'blend', label: '上层', type: 'color', required: true },
      { key: 'mask', label: '遮罩', type: 'mask', required: false },
    ],
    outputs: [{ key: 'color', label: '颜色', type: 'color' }],
    params: [
      {
        key: 'mode',
        label: '模式',
        kind: 'select',
        default: 'multiply',
        options: [
          { value: 'normal', label: '正常' },
          { value: 'multiply', label: '正片叠底' },
          { value: 'screen', label: '滤色' },
          { value: 'overlay', label: '叠加' },
          { value: 'add', label: '相加' },
          { value: 'difference', label: '差值' },
        ],
      },
      { key: 'opacity', label: '混合程度', kind: 'number', default: 1, min: 0, max: 1, step: 0.01 },
      {
        key: 'invertMask',
        label: '反转遮罩',
        kind: 'boolean',
        default: false,
        help: '仅当遮罩输入已连接时生效',
      },
    ],
    evaluate(ctx) {
      const base = requiredImage(ctx, 'base', '底层');
      const upper = requiredImage(ctx, 'blend', '上层');
      const mask = ctx.inputs['mask'];
      const mode = str(ctx.params, 'mode') as BlendMode;
      const opacity = clamp01(num(ctx.params, 'opacity'));
      const invertMask = ctx.params['invertMask'] === true;
      const image = createRaster(ctx.width, ctx.height);
      for (let y = 0; y < ctx.height; y += 1) {
        for (let x = 0; x < ctx.width; x += 1) {
          const basePixel = readPixel(base, x, y);
          const upperPixel = readPixel(upper, x, y);
          let factor = opacity;
          if (mask) {
            const maskPixel = sample(mask, (x + 0.5) / ctx.width, (y + 0.5) / ctx.height);
            const maskValue =
              0.2126 * (maskPixel[0] ?? 0) + 0.7152 * (maskPixel[1] ?? 0) + 0.0722 * (maskPixel[2] ?? 0);
            factor *= invertMask ? 1 - maskValue : maskValue;
          }
          const r = basePixel.r + (blendChannel(basePixel.r, upperPixel.r, mode) - basePixel.r) * factor;
          const g = basePixel.g + (blendChannel(basePixel.g, upperPixel.g, mode) - basePixel.g) * factor;
          const b = basePixel.b + (blendChannel(basePixel.b, upperPixel.b, mode) - basePixel.b) * factor;
          const a = Math.max(basePixel.a, upperPixel.a);
          writePixel(image, x, y, clamp01(r), clamp01(g), clamp01(b), clamp01(a));
        }
      }
      return { color: image };
    },
  },
  {
    type: 'output',
    title: '输出',
    category: '输出',
    description: '预览与导出的终点。一个项目可以有多个输出。',
    inputs: [{ key: 'input', label: '输入', type: 'color', required: true }],
    outputs: [],
    params: [],
    evaluate(ctx) {
      return { color: requiredImage(ctx, 'input', '输入') };
    },
  },
];

export const NODE_DEF_MAP: ReadonlyMap<string, NodeDef> = new Map(
  NODE_DEFS.map((def) => [def.type, def]),
);

export function getNodeDef(type: string): NodeDef {
  const def = NODE_DEF_MAP.get(type);
  if (!def) {
    throw new Error(`未知节点类型 "${type}"`);
  }
  return def;
}

export function defaultParams(def: NodeDef): Record<string, ParamValue> {
  const params: Record<string, ParamValue> = {};
  for (const param of def.params) {
    params[param.key] = param.default;
  }
  return params;
}
