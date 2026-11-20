import type { Project } from '../core/types.js';
import { buildCanyonRun } from './canyonRun.js';
import { buildGalleryHold } from './galleryHold.js';
import { buildTrackingLoop } from './trackingLoop.js';

export interface SampleDescriptor {
  id: string;
  name: string;
  description: string;
  build: () => Project;
}

export const SAMPLES: SampleDescriptor[] = [
  {
    id: 'canyon-run',
    name: '峡谷弯道',
    description: '开放路径 · 连续 S 弯 · 切向跟随 · 弯心停留',
    build: buildCanyonRun,
  },
  {
    id: 'gallery-hold',
    name: '停留长廊',
    description: '闭合环形 · 四段长停留 · 速度起伏明显',
    build: buildGalleryHold,
  },
  {
    id: 'tracking-loop',
    name: '追焦环线',
    description: '闭合环形 · 跟随移动目标 · 切向/目标双模式',
    build: buildTrackingLoop,
  },
];

export function sampleById(id: string): SampleDescriptor | undefined {
  return SAMPLES.find((s) => s.id === id);
}

export function defaultProject(): Project {
  return SAMPLES[0].build();
}
