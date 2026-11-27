import { describe, expect, it } from 'vitest';
import { builtinLevel, generateLevel } from '../src/core/generator';
import { Rng } from '../src/core/rng';
import { solve } from '../src/core/solver';
import { exportLevel } from '../src/core/io';

describe('确定性随机数', () => {
  it('同种子序列完全一致', () => {
    const a = new Rng(12345);
    const b = new Rng(12345);
    const seqA = Array.from({ length: 50 }, () => a.next());
    const seqB = Array.from({ length: 50 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it('不同种子序列不同', () => {
    const a = new Rng(1);
    const b = new Rng(2);
    expect(a.next()).not.toBe(b.next());
  });

  it('负数种子与大整数种子稳定归一化', () => {
    const a = new Rng(-7);
    const b = new Rng(-7 >>> 0);
    expect(a.next()).toBe(b.next());
  });
});

describe('内置唯一解样例', () => {
  for (const seed of [0, 1, 2, 3, 4, 5]) {
    it(`种子 ${seed} 对应样例经求解器复核为 unique`, async () => {
      const { level } = builtinLevel(seed);
      const report = await solve(level, {
        maxNodes: 1 << 20,
        maxMs: 5000,
        yieldEvery: 0,
      });
      expect(report.status).toBe('unique');
      expect(report.solutions).toHaveLength(1);
    });
  }

  it('同编号种子每次拿到同一布局', () => {
    const a = exportLevel(builtinLevel(42).level);
    const b = exportLevel(builtinLevel(42).level);
    expect(a).toBe(b);
  });
});

describe('随机生成', () => {
  it('生成的关卡始终有解且为唯一解(随机或内置兜底)', async () => {
    for (const seed of [1, 7, 99, 2024]) {
      const got = await generateLevel(seed, { size: 5, maxMirrors: 6, attempts: 12 });
      const report = await solve(got.level, {
        maxNodes: 1 << 20,
        maxMs: 5000,
        yieldEvery: 0,
      });
      expect(report.status, `种子 ${seed} 生成结果不是唯一解`).toBe('unique');
    }
  });

  it('同一种子两次生成结果一致', async () => {
    const a = await generateLevel(314, { size: 5, maxMirrors: 6, attempts: 10 });
    const b = await generateLevel(314, { size: 5, maxMirrors: 6, attempts: 10 });
    expect(exportLevel(a.level)).toBe(exportLevel(b.level));
    expect(a.source).toBe(b.source);
  }, 15000);
});
