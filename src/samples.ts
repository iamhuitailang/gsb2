import { defaultParams, getNodeDef } from './core/nodes.ts';
import type { Edge, NodeInstance, ParamValue, Project } from './core/types.ts';

interface NodeSpec {
  id: string;
  type: string;
  x: number;
  y: number;
  label?: string;
  params?: Record<string, ParamValue>;
}

interface EdgeSpec {
  from: [string, string];
  to: [string, string];
}

function makeNode(spec: NodeSpec): NodeInstance {
  return {
    id: spec.id,
    type: spec.type,
    label: spec.label ?? getNodeDef(spec.type).title,
    x: spec.x,
    y: spec.y,
    params: { ...defaultParams(getNodeDef(spec.type)), ...(spec.params ?? {}) },
  };
}

function makeEdges(specs: EdgeSpec[]): Edge[] {
  return specs.map((spec, index) => ({
    id: `sample_edge_${index + 1}`,
    from: { node: spec.from[0], port: spec.from[1] },
    to: { node: spec.to[0], port: spec.to[1] },
  }));
}

function makeProject(
  name: string,
  nodes: NodeSpec[],
  edges: EdgeSpec[],
  outputId: string,
): Project {
  return {
    version: 1,
    name,
    nodes: nodes.map(makeNode),
    edges: makeEdges(edges),
    view: { x: 32, y: 24, zoom: 0.85 },
    preview: { resolution: 512, zoom: 0 },
    activeOutputId: outputId,
  };
}

export interface SampleProject {
  id: string;
  name: string;
  description: string;
  build: () => Project;
}

export const SAMPLES: SampleProject[] = [
  {
    id: 'noise-terrain',
    name: '噪声地形',
    description: '渐变打底，噪声颜色与遮罩一起参与叠加混合。',
    build: () =>
      makeProject(
        '噪声地形',
        [
          {
            id: 'grad_sky',
            type: 'gradient',
            x: 40,
            y: 60,
            label: '天空渐变',
            params: {
              start: '#16324f',
              end: '#f2b880',
              mode: 'linear',
              angle: 90,
              repeat: 1,
            },
          },
          {
            id: 'noise_hills',
            type: 'noise',
            x: 40,
            y: 380,
            label: '丘陵噪声',
            params: {
              seed: 20260214,
              scale: 3.5,
              octaves: 5,
              contrast: 1.6,
              low: '#0b1026',
              high: '#f4f1de',
              colored: false,
            },
          },
          {
            id: 'blend_terrain',
            type: 'blend',
            x: 330,
            y: 170,
            label: '天地混合',
            params: { mode: 'overlay', opacity: 0.85 },
          },
          {
            id: 'out_main',
            type: 'output',
            x: 620,
            y: 250,
            label: '主输出',
          },
        ],
        [
          { from: ['grad_sky', 'color'], to: ['blend_terrain', 'base'] },
          { from: ['noise_hills', 'color'], to: ['blend_terrain', 'blend'] },
          { from: ['noise_hills', 'mask'], to: ['blend_terrain', 'mask'] },
          { from: ['blend_terrain', 'color'], to: ['out_main', 'input'] },
        ],
        'out_main',
      ),
  },
  {
    id: 'sunset-mask',
    name: '日落遮罩',
    description: '径向渐变 + 纯色 + 平移旋转后的噪声遮罩，展示遮罩混合。',
    build: () =>
      makeProject(
        '日落遮罩',
        [
          {
            id: 'grad_sun',
            type: 'gradient',
            x: 30,
            y: 40,
            label: '径向光晕',
            params: {
              start: '#fff2b2',
              end: '#c0392b',
              mode: 'radial',
              repeat: 1,
            },
          },
          {
            id: 'solid_sea',
            type: 'solid',
            x: 30,
            y: 330,
            label: '海面',
            params: { color: '#0d3b66', alpha: 1 },
          },
          {
            id: 'noise_waves',
            type: 'noise',
            x: 30,
            y: 520,
            label: '波纹噪声',
            params: {
              seed: 778899,
              scale: 6,
              octaves: 3,
              contrast: 2.2,
              low: '#000000',
              high: '#ffffff',
              colored: false,
            },
          },
          {
            id: 'xf_waves',
            type: 'transform',
            x: 320,
            y: 520,
            label: '拉伸波纹',
            params: {
              offsetX: 0.1,
              offsetY: 0,
              scaleX: 2.5,
              scaleY: 0.6,
              rotation: -18,
              wrap: 'repeat',
            },
          },
          {
            id: 'blend_sea',
            type: 'blend',
            x: 340,
            y: 250,
            label: '海面反光',
            params: { mode: 'screen', opacity: 0.7, invertMask: false },
          },
          {
            id: 'out_sunset',
            type: 'output',
            x: 630,
            y: 120,
            label: '主输出',
          },
        ],
        [
          { from: ['grad_sun', 'color'], to: ['blend_sea', 'base'] },
          { from: ['solid_sea', 'color'], to: ['blend_sea', 'blend'] },
          { from: ['noise_waves', 'color'], to: ['xf_waves', 'input'] },
          { from: ['xf_waves', 'mask'], to: ['blend_sea', 'mask'] },
          { from: ['blend_sea', 'color'], to: ['out_sunset', 'input'] },
        ],
        'out_sunset',
      ),
  },
  {
    id: 'marble-tile',
    name: '大理石拼贴',
    description: '噪声多次平移缩放后与渐变相乘，再叠一层纯色，体现可复现的程序纹理。',
    build: () =>
      makeProject(
        '大理石拼贴',
        [
          {
            id: 'grad_marble',
            type: 'gradient',
            x: 20,
            y: 40,
            label: '底色渐变',
            params: {
              start: '#f6f2ea',
              end: '#c8c1b6',
              mode: 'linear',
              angle: 35,
              repeat: 2,
            },
          },
          {
            id: 'noise_marble',
            type: 'noise',
            x: 20,
            y: 330,
            label: '大理石噪声',
            params: {
              seed: 424242,
              scale: 5,
              octaves: 6,
              contrast: 1.8,
              low: '#3a3a3a',
              high: '#ffffff',
              colored: false,
            },
          },
          {
            id: 'xf_marble_a',
            type: 'transform',
            x: 300,
            y: 330,
            label: '拉伸 A',
            params: {
              offsetX: 0,
              offsetY: 0,
              scaleX: 3.2,
              scaleY: 0.7,
              rotation: 24,
              wrap: 'repeat',
            },
          },
          {
            id: 'xf_marble_b',
            type: 'transform',
            x: 300,
            y: 600,
            label: '拉伸 B',
            params: {
              offsetX: 0.35,
              offsetY: 0.12,
              scaleX: 0.8,
              scaleY: 2.6,
              rotation: -12,
              wrap: 'repeat',
            },
          },
          {
            id: 'blend_marble',
            type: 'blend',
            x: 580,
            y: 250,
            label: '纹理叠加',
            params: { mode: 'multiply', opacity: 0.55 },
          },
          {
            id: 'blend_vignette',
            type: 'blend',
            x: 580,
            y: 470,
            label: '暗角',
            params: { mode: 'multiply', opacity: 0.35 },
          },
          {
            id: 'solid_vignette',
            type: 'solid',
            x: 300,
            y: 810,
            label: '暗角颜色',
            params: { color: '#1a1a2e', alpha: 1 },
          },
          {
            id: 'out_marble',
            type: 'output',
            x: 870,
            y: 330,
            label: '主输出',
          },
        ],
        [
          { from: ['grad_marble', 'color'], to: ['blend_marble', 'base'] },
          { from: ['noise_marble', 'color'], to: ['xf_marble_a', 'input'] },
          { from: ['noise_marble', 'color'], to: ['xf_marble_b', 'input'] },
          { from: ['xf_marble_a', 'color'], to: ['blend_marble', 'blend'] },
          { from: ['xf_marble_b', 'mask'], to: ['blend_marble', 'mask'] },
          { from: ['blend_marble', 'color'], to: ['blend_vignette', 'base'] },
          { from: ['solid_vignette', 'color'], to: ['blend_vignette', 'blend'] },
          { from: ['blend_vignette', 'color'], to: ['out_marble', 'input'] },
        ],
        'out_marble',
      ),
  },
];

export function buildSample(id: string): Project | undefined {
  return SAMPLES.find((sample) => sample.id === id)?.build();
}
