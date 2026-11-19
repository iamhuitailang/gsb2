import type { Project, ResourceMeta } from './types';
import { uid } from './utils/helpers';

/** 内置示例资源：由 scripts/generate-samples.mjs 生成到 public/samples/ */
export const SAMPLE_RESOURCES: Record<string, ResourceMeta> = {
  drumLoopA: {
    id: 'drumLoopA',
    name: '鼓组循环 A（8 秒）',
    duration: 8,
    kind: 'sample',
    url: './samples/drum-loop-a.wav',
  },
  drumLoopB: {
    id: 'drumLoopB',
    name: '鼓组循环 B（8 秒）',
    duration: 8,
    kind: 'sample',
    url: './samples/drum-loop-b.wav',
  },
  bassLineA: {
    id: 'bassLineA',
    name: '贝斯线条 A（6 秒）',
    duration: 6,
    kind: 'sample',
    url: './samples/bass-line-a.wav',
  },
  bassLineB: {
    id: 'bassLineB',
    name: '贝斯线条 B（6 秒）',
    duration: 6,
    kind: 'sample',
    url: './samples/bass-line-b.wav',
  },
};

/**
 * 示例工程：两条轨道，片段之间存在重叠、间隔与被静音的片段，
 * 两条轨道各有多个音量自动化关键点。
 */
export function createSampleProject(): Project {
  const tracks = [
    {
      id: uid('track'),
      name: '鼓组',
      volume: 0.9,
      muted: false,
      solo: false,
      clips: [
        {
          id: uid('clip'),
          name: '鼓 A · 开头',
          resourceId: 'drumLoopA',
          start: 0,
          offset: 0,
          duration: 8,
          muted: false,
        },
        {
          id: uid('clip'),
          name: '鼓 A · 重叠切入',
          resourceId: 'drumLoopA',
          // 与第一个片段末尾重叠 1 秒，形成重叠区
          start: 7,
          offset: 0,
          duration: 5,
          muted: false,
        },
        {
          id: uid('clip'),
          name: '鼓 B · 静音段（间隔后）',
          resourceId: 'drumLoopB',
          // 14 秒处留 2 秒间隔，且该片段被静音，验证导出对静音片段的处理
          start: 14,
          offset: 0,
          duration: 4,
          muted: true,
        },
      ],
      automation: [
        { id: uid('auto'), time: 0, value: 0.55 },
        { id: uid('auto'), time: 3, value: 1 },
        { id: uid('auto'), time: 9, value: 1 },
        { id: uid('auto'), time: 11, value: 0.45 },
        { id: uid('auto'), time: 13.5, value: 0.45 },
      ],
    },
    {
      id: uid('track'),
      name: '贝斯',
      volume: 0.8,
      muted: false,
      solo: false,
      clips: [
        {
          id: uid('clip'),
          name: '贝斯 A · 开头',
          resourceId: 'bassLineA',
          start: 1,
          offset: 0,
          duration: 6,
          muted: false,
        },
        {
          id: uid('clip'),
          name: '贝斯 B · 裁切片段',
          resourceId: 'bassLineB',
          // 与前一段重叠 1 秒；offset 非零，演示源内裁切
          start: 6,
          offset: 1,
          duration: 5,
          muted: false,
        },
        {
          id: uid('clip'),
          name: '贝斯 A · 间隔后再现',
          resourceId: 'bassLineA',
          // 与前一段之间留 1 秒间隔
          start: 12,
          offset: 0,
          duration: 6,
          muted: false,
        },
      ],
      automation: [
        { id: uid('auto'), time: 1, value: 0.3 },
        { id: uid('auto'), time: 4, value: 0.9 },
        { id: uid('auto'), time: 8, value: 0.6 },
        { id: uid('auto'), time: 10, value: 0.2 },
        { id: uid('auto'), time: 13, value: 0.85 },
        { id: uid('auto'), time: 17.5, value: 0.85 },
      ],
    },
  ];

  return {
    version: 1,
    name: '示例工程 · 两轨编排',
    tracks,
    resources: { ...SAMPLE_RESOURCES },
    tailFade: 1.5,
    length: 18,
  };
}
