import { describe, expect, it } from 'vitest';
import { solve, SolverOptions } from '../src/core/solver';
import { createLevel } from '../src/core/levels';
import { Cell, COLOR_BITS } from '../src/core/types';

const TIGHT: SolverOptions = { maxNodes: 1 << 20, maxMs: 5000, yieldEvery: 0 };

function set(level: ReturnType<typeof createLevel>, r: number, c: number, cell: Cell): void {
  level.cells[r][c] = cell;
}

describe('求解器状态', () => {
  it('无解布局报 unsat', () => {
    const level = createLevel(4);
    // 光源朝东, 收光点放在照不到的位置, 没有反光片
    set(level, 1, 0, { kind: 'source', dir: 1, colors: COLOR_BITS.R });
    set(level, 3, 3, { kind: 'target', required: COLOR_BITS.R });
    return solve(level, TIGHT).then((report) => {
      expect(report.status).toBe('unsat');
      expect(report.stoppedEarly).toBe(false);
      expect(report.solutions).toHaveLength(0);
    });
  });

  it('单自由片且只有一种朝向可行 -> unique', () => {
    const level = createLevel(4);
    set(level, 0, 0, { kind: 'source', dir: 1, colors: COLOR_BITS.R });
    set(level, 0, 2, { kind: 'mirror', orient: 1, locked: false });
    // '\' 把东行光折向南, 收光点 (2,2); 另一种朝向会折向北出界
    set(level, 2, 2, { kind: 'target', required: COLOR_BITS.R });
    return solve(level, TIGHT).then((report) => {
      expect(report.status).toBe('unique');
      expect(report.solutions).toHaveLength(1);
      expect(report.solutions[0].assignments.get(0)).toBe(1);
    });
  });

  it('两个自由片互不影响且各自两解 -> multi, 且两组摆法真正不同', () => {
    // 每个自由片有两个朝向都能把光送到本块唯一目标(两条支路在锁定片引导下汇合),
    // 两个独立块 => 2x2=4 组解。单块布局已在诊断脚本中逐格验证。
    const level = createLevel(8);

    // 块 A(左上 5×5 区域): 源 (2,0) 东 -> 自由片 (2,2) -> 目标 (3,4)
    set(level, 2, 0, { kind: 'source', dir: 1, colors: COLOR_BITS.R });
    set(level, 2, 2, { kind: 'mirror', orient: 0, locked: false });
    set(level, 4, 2, { kind: 'mirror', orient: 1, locked: true });
    set(level, 4, 4, { kind: 'mirror', orient: 0, locked: true });
    set(level, 0, 2, { kind: 'mirror', orient: 0, locked: true });
    set(level, 0, 4, { kind: 'mirror', orient: 1, locked: true });
    set(level, 3, 4, { kind: 'target', required: 0 });

    // 块 B(右下区域, 行列偏移 +3): 源 (5,3) 东 -> 自由片 (5,5) -> 目标 (6,7)
    set(level, 5, 3, { kind: 'source', dir: 1, colors: COLOR_BITS.G });
    set(level, 5, 5, { kind: 'mirror', orient: 0, locked: false });
    set(level, 7, 5, { kind: 'mirror', orient: 1, locked: true });
    set(level, 7, 7, { kind: 'mirror', orient: 0, locked: true });
    set(level, 3, 5, { kind: 'mirror', orient: 0, locked: true });
    set(level, 3, 7, { kind: 'mirror', orient: 1, locked: true });
    set(level, 6, 7, { kind: 'target', required: 0 });

    return solve(level, TIGHT).then((report) => {
      expect(report.status).toBe('multi');
      expect(report.solutions.length).toBeGreaterThanOrEqual(2);
      const a = report.solutions[0].assignments;
      const b = report.solutions[1].assignments;
      const differs = [...a.keys()].some((k) => a.get(k) !== b.get(k));
      expect(differs).toBe(true);
    });
  });

  it('预算极低导致没搜完 -> incomplete, 绝不能报 unique', () => {
    const level = createLevel(5);
    set(level, 0, 0, { kind: 'source', dir: 1, colors: COLOR_BITS.R });
    // 放 12 个自由片 => 4096 种摆法, 但让它们大多不在光路上
    for (let i = 0; i < 12; i++) {
      const r = 3 + Math.floor(i / 6);
      const c = i % 6;
      set(level, r, c, { kind: 'mirror', orient: 0, locked: false });
    }
    set(level, 0, 4, { kind: 'target', required: COLOR_BITS.R });
    return solve(level, { maxNodes: 5, maxMs: 5000, yieldEvery: 0 }).then((report) => {
      expect(report.stoppedEarly).toBe(true);
      expect(report.status).toBe('incomplete');
    });
  });

  it('时间预算 maxMs=0 立即触发 incomplete(不依赖调度精度)', () => {
    const level = createLevel(8);
    set(level, 0, 0, { kind: 'source', dir: 1, colors: COLOR_BITS.R });
    set(level, 0, 7, { kind: 'target', required: COLOR_BITS.R });
    // 20 个不在光路上的自由片 => 约 100 万种摆法
    let placed = 0;
    for (let r = 2; r < 8 && placed < 20; r++) {
      for (let c = 0; c < 8 && placed < 20; c++) {
        set(level, r, c, { kind: 'mirror', orient: 0, locked: false });
        placed++;
      }
    }
    return solve(level, { maxNodes: 1 << 30, maxMs: 0, yieldEvery: 128 }).then((report) => {
      expect(report.status).toBe('incomplete');
      expect(report.stoppedEarly).toBe(true);
      expect(report.nodes).toBeLessThan(report.totalCombinations);
    });
  });

  it('外部取消 -> incomplete 且标记 canceled', () => {
    const level = createLevel(5);
    set(level, 0, 0, { kind: 'source', dir: 1, colors: COLOR_BITS.R });
    set(level, 0, 4, { kind: 'target', required: COLOR_BITS.R });
    for (let c = 0; c < 5; c++) {
      for (let r = 2; r < 4; r++) {
        set(level, r, c, { kind: 'mirror', orient: 0, locked: false });
      }
    }
    return solve(level, {
      maxNodes: 1 << 30,
      maxMs: 5000,
      yieldEvery: 0,
      shouldCancel: () => true,
    }).then((report) => {
      expect(report.status).toBe('incomplete');
      expect(report.canceled).toBe(true);
    });
  });

  it('锁定反光片不产生变量', () => {
    const level = createLevel(4);
    set(level, 0, 0, { kind: 'source', dir: 1, colors: COLOR_BITS.R });
    set(level, 0, 2, { kind: 'mirror', orient: 1, locked: true });
    set(level, 2, 2, { kind: 'target', required: COLOR_BITS.R });
    return solve(level, TIGHT).then((report) => {
      expect(report.variableCount).toBe(0);
      expect(report.totalCombinations).toBe(1);
      expect(report.status).toBe('unique');
    });
  });
});
