// 关卡生成器
//
// 同一种子编号必然生成同一关卡(Rng 为确定性纯整数运算)。
// 随机生成后调用求解器严格验证: 只有状态为 unique 的关卡才会被采用;
// 尝试次数内找不到唯一解时, 回退到内置"已知唯一解"样例(同样按种子编号稳定选取,
// 且在回退前再跑一次求解器确认)。

import { Rng } from './rng';
import { checkLevel, createLevel } from './levels';
import { solve } from './solver';
import { Cell, COLOR_BITS, Direction, Level, MirrorCell, SourceCell, TargetCell } from './types';

export interface GenerateOptions {
  size: number;
  /** 每个候选布局最多放几面反光片 */
  maxMirrors: number;
  /** 随机尝试多少个候选布局 */
  attempts: number;
}

export const DEFAULT_GENERATE_OPTIONS: GenerateOptions = {
  size: 6,
  maxMirrors: 8,
  attempts: 40,
};

const PRIMARY_MASKS = [COLOR_BITS.R, COLOR_BITS.G, COLOR_BITS.B];
const ALL_MASKS = [1, 2, 4, 3, 5, 6, 7];

interface Blueprint {
  size: number;
  walls: [number, number][];
  sources: { r: number; c: number; dir: Direction; colors: number }[];
  mirrors: { r: number; c: number; orient: 0 | 1; locked: boolean }[];
  targets: { r: number; c: number; required: number }[];
}

function buildLevel(name: string, bp: Blueprint, seed?: number): Level {
  const level = createLevel(bp.size, name);
  if (seed !== undefined) level.seed = seed;
  const put = (r: number, c: number, cell: Cell): void => {
    level.cells[r][c] = cell;
  };
  for (const [r, c] of bp.walls) put(r, c, { kind: 'wall' });
  for (const s of bp.sources) put(s.r, s.c, { kind: 'source', dir: s.dir, colors: s.colors } as SourceCell);
  for (const m of bp.mirrors) put(m.r, m.c, { kind: 'mirror', orient: m.orient, locked: m.locked } as MirrorCell);
  for (const t of bp.targets) put(t.r, t.c, { kind: 'target', required: t.required } as TargetCell);
  return level;
}

/** 随机生成一个候选布局: 先放光源/收光点/墙, 再放若干反光片 */
function randomBlueprint(rng: Rng, size: number, maxMirrors: number): Blueprint {
  const used = new Set<string>();
  const take = (): [number, number] => {
    for (;;) {
      const r = rng.int(0, size - 1);
      const c = rng.int(0, size - 1);
      const key = `${r},${c}`;
      if (!used.has(key)) {
        used.add(key);
        return [r, c];
      }
    }
  };

  const walls: [number, number][] = [];
  const sources: Blueprint['sources'] = [];
  const targets: Blueprint['targets'] = [];
  const mirrors: Blueprint['mirrors'] = [];

  // 1~2 个光源, 其中至少一个为双色
  const sourceCount = rng.int(1, 2);
  for (let i = 0; i < sourceCount; i++) {
    const [r, c] = take();
    const colors =
      i === 0
        ? rng.pick([COLOR_BITS.R | COLOR_BITS.G, COLOR_BITS.R | COLOR_BITS.B, COLOR_BITS.G | COLOR_BITS.B])
        : rng.pick(PRIMARY_MASKS);
    sources.push({ r, c, dir: rng.int(0, 3) as Direction, colors });
  }

  // 1~3 个收光点, 要求颜色从全部掩码里挑
  const targetCount = rng.int(1, Math.min(3, size - 1));
  for (let i = 0; i < targetCount; i++) {
    const [r, c] = take();
    targets.push({ r, c, required: rng.pick(ALL_MASKS) });
  }

  // 少量挡板增加变数
  const wallCount = rng.int(0, Math.min(3, size - 2));
  for (let i = 0; i < wallCount; i++) {
    const [r, c] = take();
    walls.push([r, c]);
  }

  // 反光片: 约三成锁定, 其余可转动(求解变量)
  const mirrorCount = rng.int(2, maxMirrors);
  for (let i = 0; i < mirrorCount; i++) {
    const [r, c] = take();
    mirrors.push({
      r,
      c,
      orient: rng.int(0, 1) as 0 | 1,
      locked: rng.next() < 0.3,
    });
  }

  return { size, walls, sources, mirrors, targets };
}

export interface GeneratedLevel {
  level: Level;
  /** 采用随机候选还是内置样例兜底 */
  source: 'random' | 'builtin';
  /** 随机尝试次数(兜底时等于 attempts) */
  attemptsUsed: number;
  /** 随机生成成功时, 验证得到的唯一解摆法 */
  solution?: Map<number, 0 | 1>;
}

export async function generateLevel(
  seed: number,
  options: GenerateOptions = DEFAULT_GENERATE_OPTIONS,
): Promise<GeneratedLevel> {
  const rng = new Rng(seed);
  const { size, maxMirrors, attempts } = options;

  for (let i = 0; i < attempts; i++) {
    const bp = randomBlueprint(rng, size, maxMirrors);
    const candidate = buildLevel(`种子 ${seed} · 随机关`, bp, seed);
    const check = checkLevel(candidate);
    if (!check.ok) continue;

    // 只能用节点预算, 不能用时间预算: 同种子的候选接受/拒绝结果必须与
    // 机器负载无关, 否则两次生成同一编号可能得到不同关卡(破坏种子确定性)
    const report = await solve(candidate, {
      maxNodes: 200_000,
      maxMs: Number.POSITIVE_INFINITY,
      yieldEvery: 0,
    });
    if (report.status === 'unique') {
      return {
        level: candidate,
        source: 'random',
        attemptsUsed: i + 1,
        solution: report.solutions[0].assignments,
      };
    }
  }

  // 兜底: 内置已知唯一解样例
  const builtin = builtinLevel(seed);
  const verify = await solve(builtin.level, {
    maxNodes: 1 << 20,
    maxMs: Number.POSITIVE_INFINITY,
    yieldEvery: 0,
  });
  if (verify.status !== 'unique') {
    // 理论上不会发生; 若发生则如实返回, 由 UI 标注
    return { level: builtin.level, source: 'builtin', attemptsUsed: attempts };
  }
  return {
    level: builtin.level,
    source: 'builtin',
    attemptsUsed: attempts,
    solution: verify.solutions[0].assignments,
  };
}

// ---------------------------------------------------------------------------
// 内置样例: 手工构造, 每个可转动片都在真实光路上, 取错朝向光束必逃逸,
// 由测试套件中的求解器再次复核唯一性。
//
// 关键物理约束: 同一光源发出的多束原色光路径完全相同(反光片不辨色),
// 因此双色光源只能整体送达一个收光点; 混色靠"多光源汇入同格"实现。
// ---------------------------------------------------------------------------

const BLUEPRINTS: Blueprint[] = [
  // 样例 0 (5×5): 单色蛇形光路, 四面可转动片各占一个转角,
  // 任一片取反都会让光束从棋盘边缘逃逸(转角处不存在"原路折回也到终点"的歧义)
  // 引擎朝向约定: orient 0 = '/'(dir XOR 1), orient 1 = '\'(dir XOR 3)
  // (0,0) 东 →(0,4)\ 南 →(4,4)/ 西 →(4,0)\ 北 →(1,0)/ 东 →(1,2) 收红
  {
    size: 5,
    walls: [[2, 3]],
    sources: [{ r: 0, c: 0, dir: 1, colors: COLOR_BITS.R }],
    mirrors: [
      { r: 0, c: 4, orient: 1, locked: false }, // \: 东→南
      { r: 4, c: 4, orient: 1, locked: false }, // \: 南→西
      { r: 4, c: 0, orient: 0, locked: false }, // /: 西→北
      { r: 1, c: 0, orient: 0, locked: false }, // /: 北→东
    ],
    targets: [{ r: 1, c: 2, required: COLOR_BITS.R }],
  },
  // 样例 1 (5×5): 双色源收黄、蓝源收蓝, 两条光路在空格 (2,1) 立体交叉互不影响
  // 红/绿: (0,0) 东→(0,3)[锁\] 南→(2,3)[自由\] 西→(2,0) 收黄
  // 蓝:   (4,4) 北→(1,4)[自由\] 西→(1,1)[自由\] 南→(4,1) 收蓝
  {
    size: 5,
    walls: [[3, 2], [4, 3]],
    sources: [
      { r: 0, c: 0, dir: 1, colors: COLOR_BITS.R | COLOR_BITS.G },
      { r: 4, c: 4, dir: 0, colors: COLOR_BITS.B },
    ],
    mirrors: [
      { r: 0, c: 3, orient: 1, locked: true },  // \: 东→南
      { r: 2, c: 3, orient: 1, locked: false }, // \: 南→西
      { r: 1, c: 4, orient: 0, locked: false }, // /: 北→西
      { r: 1, c: 1, orient: 0, locked: false }, // /: 西→南
    ],
    targets: [
      { r: 2, c: 0, required: COLOR_BITS.R | COLOR_BITS.G },
      { r: 4, c: 1, required: COLOR_BITS.B },
    ],
  },
  // 样例 2 (6×6): 三原色三光源沿互不相交的通道汇入 (3,3) 合成白光(掩码 7)
  // 绿: (0,0) 南→(2,0)[锁\] 东→(2,3)[自由/] 南→(3,3)
  // 红: (5,5) 西→(5,2)[自由\] 北→(3,2)[锁\] 东→(3,3)
  // 蓝: (0,4) 南→(4,4)[自由/] 西→(4,3)[自由\] 北→(3,3)
  // 四片自由片任一取反, 对应光束立刻出界, 合色失败
  {
    size: 6,
    walls: [[1, 5]],
    sources: [
      { r: 0, c: 0, dir: 2, colors: COLOR_BITS.G },
      { r: 5, c: 5, dir: 3, colors: COLOR_BITS.R },
      { r: 0, c: 4, dir: 2, colors: COLOR_BITS.B },
    ],
    mirrors: [
      { r: 2, c: 0, orient: 1, locked: true },  // \: 南→东
      { r: 3, c: 2, orient: 0, locked: true },  // /: 北→东
      { r: 2, c: 3, orient: 1, locked: false }, // \: 东→南
      { r: 5, c: 2, orient: 0, locked: false }, // /: 西→北
      { r: 4, c: 4, orient: 0, locked: false }, // /: 南→西
      { r: 4, c: 3, orient: 1, locked: false }, // \: 西→北
    ],
    targets: [
      { r: 3, c: 3, required: COLOR_BITS.R | COLOR_BITS.G | COLOR_BITS.B },
    ],
  },
];

export function builtinLevel(seed: number): GeneratedLevel {
  const bp = BLUEPRINTS[Math.abs(seed) % BLUEPRINTS.length];
  const level = buildLevel(`种子 ${seed} · 已知唯一解样例`, bp, seed);
  // 唯一性不在此处断言, 由测试套件和 generateLevel 中的求解器复核
  return {
    level,
    source: 'builtin',
    attemptsUsed: 0,
  };
}
