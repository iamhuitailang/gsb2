// 依赖图：按 Node 解析顺序把依赖名解析到实际安装位置，建出有向边；
// 据此判定直接/传递/不可达，并给出从根到目标包的依赖路径。

const ROOT_KEY = '';

// 生成 Node 风格的候选位置：自身 node_modules → 逐级向上 → 根 node_modules。
function candidateLocations(fromKey, depName, keySet) {
  const candidates = [];
  if (fromKey === ROOT_KEY) {
    candidates.push(`node_modules/${depName}`);
    return candidates;
  }
  // fromKey 形如 node_modules/a/node_modules/b
  let base = fromKey;
  candidates.push(`${base}/node_modules/${depName}`);
  while (base.includes('/node_modules/')) {
    base = base.slice(0, base.lastIndexOf('/node_modules/'));
    candidates.push(base === '' ? `node_modules/${depName}` : `${base}/node_modules/${depName}`);
  }
  candidates.push(`node_modules/${depName}`);
  return candidates;
}

function resolveLocation(fromKey, depName, keySet) {
  for (const candidate of candidateLocations(fromKey, depName, keySet)) {
    if (keySet.has(candidate)) return candidate;
  }
  return null;
}

export function buildGraph(parsed) {
  const { records, rawDeps, rootKey } = parsed;
  const keySet = new Set(records.keys());
  const edgesOut = new Map();
  const edgesIn = new Map();
  const dangling = [];

  for (const key of records.keys()) {
    edgesOut.set(key, new Set());
    edgesIn.set(key, new Set());
  }

  for (const [fromKey, deps] of rawDeps) {
    if (!edgesOut.has(fromKey)) continue;
    for (const [depName, spec] of deps) {
      const target = resolveLocation(fromKey, depName, keySet);
      if (target === null) {
        dangling.push({ from: fromKey, depName, spec });
        continue;
      }
      if (target === fromKey) continue;
      edgesOut.get(fromKey).add(target);
      edgesIn.get(target).add(fromKey);
    }
  }

  // BFS 从根标记可达性：根直接出边指向的是 direct，其余可达是 transitive。
  const relationship = new Map();
  const shortest = new Map();
  for (const key of records.keys()) relationship.set(key, 'unreachable');
  relationship.set(rootKey, 'root');
  shortest.set(rootKey, [rootKey]);

  const queue = [rootKey];
  const visited = new Set([rootKey]);
  while (queue.length > 0) {
    const cur = queue.shift();
    for (const next of edgesOut.get(cur) ?? []) {
      if (!visited.has(next)) {
        visited.add(next);
        relationship.set(next, cur === rootKey ? 'direct' : 'transitive');
        shortest.set(next, [...(shortest.get(cur) ?? [cur]), next]);
        queue.push(next);
      } else if (cur === rootKey) {
        // 经由其它路径先到达，但根也直接依赖它 → 仍算 direct
        relationship.set(next, 'direct');
      }
    }
  }

  for (const [key, rel] of relationship) {
    const rec = records.get(key);
    if (rec) rec.relationship = rel;
  }

  return { edgesOut, edgesIn, dangling, relationship, shortestPaths: shortest, rootKey };
}

// 枚举根到目标的简单路径（DFS，带条数与深度上限），用于 UI 展开查看。
export function allPathsTo(target, graph, { maxPaths = 20, maxDepth = 50 } = {}) {
  const { edgesOut, rootKey } = graph;
  const results = [];
  let truncated = false;

  const dfs = (node, path, seen) => {
    if (results.length >= maxPaths) {
      truncated = true;
      return;
    }
    if (path.length > maxDepth) {
      truncated = true;
      return;
    }
    if (node === target) {
      results.push([...path]);
      return;
    }
    for (const next of edgesOut.get(node) ?? []) {
      if (seen.has(next)) continue; // 防环
      seen.add(next);
      path.push(next);
      dfs(next, path, seen);
      path.pop();
      seen.delete(next);
      if (results.length >= maxPaths) {
        truncated = true;
        return;
      }
    }
  };

  dfs(rootKey, [rootKey], new Set([rootKey]));
  return { paths: results, truncated };
}
