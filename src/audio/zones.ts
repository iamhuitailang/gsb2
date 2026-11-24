/**
 * 选样规则（纯函数，引擎与测试共用）：
 * 1. 按力度阈值选 soft/hard 层；该层整体不可用时回退另一层并在理由中标注。
 * 2. 在可用层里取根音距离最近的样本；距离相同时取低音根音。
 * 3. 用 playbackRate 把根音移调到目标音高，并给出可展示的理由。
 */
import type { LoadedSample, SampleChoice, VelocityLayer } from '../types.ts';
import { midiToName, playbackRateFor } from './notes.ts';

export function layerName(layer: VelocityLayer): string {
  return layer === 'soft' ? '轻敲' : '重敲';
}

export function zoneLabel(root: number, layer: VelocityLayer): string {
  return `${midiToName(root)} · ${layerName(layer)}`;
}

function nearestRoot(samples: LoadedSample[], note: number): LoadedSample {
  let best = samples[0];
  let bestDist = Math.abs(best.root - note);
  for (const s of samples.slice(1)) {
    const dist = Math.abs(s.root - note);
    // 距离相同优先低音根音，保证规则确定、可复现
    if (dist < bestDist || (dist === bestDist && s.root < best.root)) {
      best = s;
      bestDist = dist;
    }
  }
  return best;
}

export function chooseSample(
  note: number,
  velocity: number,
  samples: LoadedSample[],
  velocityThreshold: number,
): SampleChoice {
  if (samples.length === 0) throw new Error('没有任何可用样本');

  const wantedLayer: VelocityLayer = velocity <= velocityThreshold ? 'soft' : 'hard';
  const inLayer = samples.filter((s) => s.layer === wantedLayer);
  let layerFallback = false;
  let pool = inLayer;
  if (pool.length === 0) {
    layerFallback = true;
    pool = samples;
  }

  const chosen = nearestRoot(pool, note);
  const rate = playbackRateFor(chosen.root, note);
  const semitones = note - chosen.root;
  const parts: string[] = [];
  parts.push(`样本 ${midiToName(chosen.root)} ${layerName(chosen.layer)}层`);
  if (semitones === 0) {
    parts.push('根音精确匹配');
  } else {
    parts.push(
      `以倍率 ${rate.toFixed(3)} 移调 ${Math.abs(semitones)} 个半音（${semitones > 0 ? '上移' : '下移'}到 ${midiToName(note)}）`,
    );
  }
  if (layerFallback) {
    parts.push(`${layerName(wantedLayer)}层无可用样本，回退到${layerName(chosen.layer)}层`);
  } else if (chosen.layer !== wantedLayer) {
    parts.push(`回退到${layerName(chosen.layer)}层`);
  }

  return {
    sample: chosen,
    playbackRate: rate,
    usedRoot: chosen.root,
    usedLayer: chosen.layer,
    reason: parts.join('，'),
    fallback: layerFallback || semitones !== 0,
  };
}
