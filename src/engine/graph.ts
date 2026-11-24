import type {
  CycleInfo,
  PackManifest,
  PackStatus,
  PackIssue,
} from '../types';

export interface Analysis {
  /** 按有效优先级降序、同优先级按 id 升序的包 id 顺序（确定性） */
  order: string[];
  statuses: PackStatus[];
  byId: Map<string, PackStatus>;
  cycles: CycleInfo[];
  priorityOf: Map<string, number>;
}

export function effectivePriority(
  pack: PackManifest,
  overrides?: Record<string, number>,
): number {
  const v = overrides?.[pack.id];
  return typeof v === 'number' && Number.isFinite(v) ? v : pack.priority;
}

/** Tarjan SCC：找出所有大小 > 1 或自依赖的环，并生成可读环路径 */
export function findCycles(
  ids: Set<string>,
  depsOf: (id: string) => string[],
): CycleInfo[] {
  let serial = 0;
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cycles: CycleInfo[] = [];

  const describeCycle = (scc: string[]): string => {
    const inScc = new Set(scc);
    const start = scc[0];
    // 在 SCC 内 DFS 一条回到 start 的路径用于展示
    const path: string[] = [start];
    const dfs = (cur: string): boolean => {
      for (const next of depsOf(cur)) {
        if (!inScc.has(next)) continue;
        if (next === start && path.length >= 1) {
          path.push(start);
          return true;
        }
        if (path.includes(next)) continue;
        path.push(next);
        if (dfs(next)) return true;
        path.pop();
      }
      return false;
    };
    dfs(start);
    return path.join(' → ');
  };

  const strongConnect = (v: string): void => {
    indices.set(v, serial);
    low.set(v, serial);
    serial += 1;
    stack.push(v);
    onStack.add(v);

    for (const w of depsOf(v)) {
      if (!ids.has(w)) continue; // 不存在的依赖由 missing-dependency 报告
      if (!indices.has(w)) {
        strongConnect(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, indices.get(w)!));
      }
    }

    if (low.get(v) === indices.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);

      const selfLoop = scc.length === 1 && depsOf(v).includes(v);
      if (scc.length > 1 || selfLoop) {
        cycles.push({ nodes: scc, path: describeCycle(scc) });
      }
    }
  };

  for (const id of ids) {
    if (!indices.has(id)) strongConnect(id);
  }
  return cycles;
}

/**
 * 分析整包库：
 * 1. 清单级问题（库中缺依赖、依赖成环）——无论包是否开启都展示；
 * 2. 运行时问题（依赖未开启、依赖自身不可用）——仅对开启的包有阻断意义；
 * 3. 产出确定的包顺序与每个包的 usable 标记。
 */
export function analyzePacks(
  library: PackManifest[],
  enabled: Record<string, boolean>,
  priorities: Record<string, number> = {},
): Analysis {
  const manifestById = new Map(library.map((p) => [p.id, p]));
  const ids = new Set(manifestById.keys());
  const depsOf = (id: string): string[] =>
    (manifestById.get(id)?.dependencies ?? []).filter((d) => ids.has(d));

  const cycles = findCycles(ids, depsOf);
  const cyclePathById = new Map<string, string>();
  for (const c of cycles) {
    for (const node of c.nodes) cyclePathById.set(node, c.path);
  }

  const priorityOf = new Map<string, number>();
  for (const p of library) priorityOf.set(p.id, effectivePriority(p, priorities));

  const order = [...library]
    .sort(
      (a, b) =>
        (priorityOf.get(b.id)! - priorityOf.get(a.id)!) ||
        a.id.localeCompare(b.id),
    )
    .map((p) => p.id);

  // 第一遍：清单级问题 + 基础状态
  const statuses: PackStatus[] = library.map((pack) => {
    const manifestIssues: PackIssue[] = [];

    for (const depId of pack.dependencies ?? []) {
      if (!manifestById.has(depId)) {
        manifestIssues.push({
          code: 'missing-dependency',
          depId,
          message: `依赖的包「${depId}」不在资源库中，任何配置下都不可用`,
        });
      }
    }

    const cyclePath = cyclePathById.get(pack.id);
    if (cyclePath) {
      manifestIssues.push({
        code: 'cycle',
        cyclePath,
        message: `依赖成环：${cyclePath}`,
      });
    }

    return {
      pack,
      enabled: enabled[pack.id] ?? false,
      manifestIssues,
      runtimeIssues: [],
      usable: false, // 第二遍填充
    };
  });

  const byId = new Map(statuses.map((s) => [s.pack.id, s]));
  const manifestErrorIds = new Set(
    statuses.filter((s) => s.manifestIssues.length > 0).map((s) => s.pack.id),
  );

  // 第二遍：递归检查已开启包的依赖运行时状态（结果记忆化）
  const runtimeCache = new Map<string, PackIssue[]>();
  const checkRuntime = (id: string, visiting: Set<string>): PackIssue[] => {
    const cached = runtimeCache.get(id);
    if (cached) return cached;
    if (visiting.has(id)) return []; // 环已在清单级报告
    visiting.add(id);

    const status = byId.get(id);
    const issues: PackIssue[] = [];
    if (status) {
      for (const depId of status.pack.dependencies ?? []) {
        const depStatus = byId.get(depId);
        if (!depStatus) continue; // missing-dependency 已报告
        if (!depStatus.enabled) {
          issues.push({
            code: 'dependency-disabled',
            depId,
            message: `依赖包「${depStatus.pack.name}」(${depId}) 未开启`,
          });
        } else if (manifestErrorIds.has(depId)) {
          issues.push({
            code: 'dependency-invalid',
            depId,
            message: `依赖包「${depStatus.pack.name}」自身缺依赖或处于环中，不可用`,
          });
        } else if (checkRuntime(depId, visiting).length > 0) {
          issues.push({
            code: 'dependency-invalid',
            depId,
            message: `依赖包「${depStatus.pack.name}」存在未解决的依赖问题`,
          });
        }
      }
    }

    visiting.delete(id);
    runtimeCache.set(id, issues);
    return issues;
  };

  for (const s of statuses) {
    if (s.enabled) s.runtimeIssues = checkRuntime(s.pack.id, new Set());
    s.usable =
      s.enabled &&
      s.manifestIssues.length === 0 &&
      s.runtimeIssues.length === 0;
  }

  return { order, statuses, byId, cycles, priorityOf };
}

/** 汇总一个状态下所有「已开启但不可用」的包及其阻断原因（批量应用预检用） */
export function collectBlockingPacks(analysis: Analysis): {
  packId: string;
  packName: string;
  reasons: string[];
}[] {
  const blockers: { packId: string; packName: string; reasons: string[] }[] = [];
  for (const s of analysis.statuses) {
    if (!s.enabled) continue;
    const reasons = [
      ...s.manifestIssues.map((i) => i.message),
      ...s.runtimeIssues.map((i) => i.message),
    ];
    if (reasons.length > 0) {
      blockers.push({ packId: s.pack.id, packName: s.pack.name, reasons });
    }
  }
  return blockers;
}
