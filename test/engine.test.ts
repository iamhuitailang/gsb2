import { describe, expect, it } from 'vitest';
import { simulate, isSolution } from '../src/core/engine';
import { createLevel } from '../src/core/levels';
import { Cell, COLOR_BITS, Direction } from '../src/core/types';

function set(level: ReturnType<typeof createLevel>, r: number, c: number, cell: Cell): void {
  level.cells[r][c] = cell;
}

const source = (dir: Direction, colors: number): Cell => ({ kind: 'source', dir, colors });
const mirror = (orient: 0 | 1, locked = false): Cell => ({ kind: 'mirror', orient, locked });
const target = (required: number): Cell => ({ kind: 'target', required });

describe('反光片转向数学', () => {
  it('/ 片: 北<->东, 南<->西', () => {
    const level = createLevel(3);
    // 光源 (1,0) 向东, (1,1) 放 '/', 应转向北到 (0,1)
    set(level, 1, 0, source(1, COLOR_BITS.R));
    set(level, 1, 1, mirror(0));
    set(level, 0, 1, target(COLOR_BITS.R));
    const res = simulate(level);
    expect(res.beams).toHaveLength(1);
    expect(res.beams[0].end).toBe('target');
    expect(res.allTargetsSatisfied).toBe(true);
  });

  it('\\ 片: 北<->西, 南<->东', () => {
    const level = createLevel(3);
    // 光源 (0,1) 向南, (1,1) 放 '\\', 应转向东到 (1,2)
    set(level, 0, 1, source(2, COLOR_BITS.G));
    set(level, 1, 1, mirror(1));
    set(level, 1, 2, target(COLOR_BITS.G));
    const res = simulate(level);
    expect(res.beams[0].end).toBe('target');
    expect(res.allTargetsSatisfied).toBe(true);
  });
});

describe('终止情形', () => {
  it('出界逃逸', () => {
    const level = createLevel(3);
    set(level, 1, 1, source(1, COLOR_BITS.R));
    set(level, 0, 0, target(COLOR_BITS.R)); // 光束照不到的收光点
    const res = simulate(level);
    expect(res.beams[0].end).toBe('escape');
    expect(isSolution(res)).toBe(false);
  });

  it('撞墙终止', () => {
    const level = createLevel(3);
    set(level, 1, 0, source(1, COLOR_BITS.R));
    set(level, 1, 2, { kind: 'wall' });
    const res = simulate(level);
    expect(res.beams[0].end).toBe('wall');
  });

  it('射到光源本体被挡住', () => {
    const level = createLevel(4);
    set(level, 1, 0, source(1, COLOR_BITS.R));
    set(level, 1, 2, source(3, COLOR_BITS.G));
    const res = simulate(level);
    const red = res.beams.find((b) => b.color === COLOR_BITS.R)!;
    expect(red.end).toBe('source');
  });
});

describe('回路检测', () => {
  it('四面反光片组成矩形回路时停下并标出回路', () => {
    const level = createLevel(5);
    // 光源 (2,0) 向东; (2,2)\ 向南 -> (4,2)/ 向西 -> (4,0)\ 向北 -> (2,0)?
    // 改用精确闭合环: 光源射入后由 4 面镜子组成环
    set(level, 0, 0, source(1, COLOR_BITS.R));
    set(level, 0, 2, mirror(1)); // \: 东->南
    set(level, 2, 2, mirror(0)); // /: 南->西
    set(level, 2, 0, mirror(1)); // \: 西->北
    set(level, 0, 0, { kind: 'source', dir: 1, colors: COLOR_BITS.R });
    // 光路: (0,0)->(0,2) 南 ->(2,2) 西 ->(2,0) 北 ->(0,0) 东: 状态重现成环
    const res = simulate(level);
    expect(res.loopCount).toBe(1);
    expect(res.beams[0].end).toBe('loop');
    expect(res.beams[0].loopStart).toBeGreaterThanOrEqual(0);
    // 回路的光到不了收光点, 不算解
    expect(isSolution(res)).toBe(false);
  });
});

describe('收光点合并规则', () => {
  it('同格多束按位或合并: 红+绿=黄, 恰好匹配才算满足', () => {
    const level = createLevel(5);
    // 两个光源都打到 (2,2)
    set(level, 0, 2, source(2, COLOR_BITS.R)); // 向南
    set(level, 4, 2, source(0, COLOR_BITS.G)); // 向北
    set(level, 2, 2, target(COLOR_BITS.R | COLOR_BITS.G));
    const res = simulate(level);
    const st = [...res.targets.values()][0];
    expect(st.got).toBe(COLOR_BITS.R | COLOR_BITS.G);
    expect(st.beamIds).toHaveLength(2);
    expect(st.satisfied).toBe(true);
  });

  it('要求白(7)只收到黄(3): 缺色不满足', () => {
    const level = createLevel(5);
    set(level, 0, 2, source(2, COLOR_BITS.R | COLOR_BITS.G));
    set(level, 2, 2, target(7));
    const res = simulate(level);
    const st = [...res.targets.values()][0];
    expect(st.got).toBe(3);
    expect(st.satisfied).toBe(false);
  });

  it('要求红(1)却收到黄(3): 多色也不满足', () => {
    const level = createLevel(5);
    set(level, 0, 2, source(2, COLOR_BITS.R | COLOR_BITS.G));
    set(level, 2, 2, target(COLOR_BITS.R));
    const res = simulate(level);
    expect([...res.targets.values()][0].satisfied).toBe(false);
  });

  it('required=0 时任意光到达即可, 无光则失败', () => {
    const level = createLevel(4);
    set(level, 0, 0, source(1, COLOR_BITS.B));
    set(level, 0, 2, target(0));
    const ok = simulate(level);
    expect([...ok.targets.values()][0].satisfied).toBe(true);

    const level2 = createLevel(4);
    set(level2, 0, 0, source(1, COLOR_BITS.B));
    set(level2, 2, 2, target(0)); // 光照不到
    const bad = simulate(level2);
    expect([...bad.targets.values()][0].satisfied).toBe(false);
  });
});

describe('双色光源', () => {
  it('每个原色位各发一束, 路径相同颜色不同', () => {
    const level = createLevel(4);
    set(level, 1, 0, source(1, COLOR_BITS.R | COLOR_BITS.B));
    set(level, 1, 3, target(COLOR_BITS.R | COLOR_BITS.B));
    const res = simulate(level);
    expect(res.beams).toHaveLength(2);
    expect(res.beams.map((b) => b.color).sort()).toEqual([1, 4]);
    expect(res.allTargetsSatisfied).toBe(true);
  });
});
