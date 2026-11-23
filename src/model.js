// 文档模型：图层树（group/path）、节点操作、拆分/合并/闭合、样式
import {
  V, sub, add, mul, dist, pathToD, parsePathD, pathBounds,
  transformSubpaths, mid, anchor,
} from './geometry.js';

let idSeq = 0;
export const uid = (prefix = 'n') => `${prefix}_${Date.now().toString(36)}_${(idSeq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export const DEFAULT_STYLE = () => ({
  fill: '#3b82f6',
  fillRule: 'nonzero',
  fillOpacity: 1,
  stroke: '#111827',
  strokeWidth: 2,
  strokeOpacity: 1,
  strokeDash: 'none',
  strokeLinecap: 'butt',
  strokeLinejoin: 'round',
  opacity: 1,
});

export function createPath(subpaths, style = {}, name = '路径') {
  return {
    id: uid('path'),
    type: 'path',
    name,
    visible: true,
    locked: false,
    subpaths: subpaths.map((sp) => ({
      closed: !!sp.closed,
      anchors: sp.anchors.map((a) => anchor(
        a.x, a.y,
        V(a.hIn?.dx || 0, a.hIn?.dy || 0),
        V(a.hOut?.dx || 0, a.hOut?.dy || 0),
        !!a.smooth,
      )),
    })),
    style: { ...DEFAULT_STYLE(), ...style },
  };
}

export function createGroup(children = [], name = '组') {
  return { id: uid('group'), type: 'group', name, visible: true, locked: false, children };
}

export function createDoc(width = 800, height = 600) {
  return { version: 1, width, height, layers: [] };
}

// ---------- 树遍历 ----------
export function walk(nodes, fn, parent = null) {
  for (const node of nodes) {
    fn(node, parent);
    if (node.type === 'group') walk(node.children, fn, node);
  }
}

export function findNode(nodes, id) {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (node.type === 'group') {
      const hit = findNode(node.children, id);
      if (hit) return hit;
    }
  }
  return null;
}

export function findParent(nodes, id, parent = null) {
  for (const node of nodes) {
    if (node.id === id) return parent;
    if (node.type === 'group') {
      const hit = findParent(node.children, id, node);
      if (hit) return hit;
    }
  }
  return null;
}

// 返回节点所在数组与其下标
export function locate(nodes, id) {
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].id === id) return { list: nodes, index: i, node: nodes[i] };
    if (nodes[i].type === 'group') {
      const hit = locate(nodes[i].children, id);
      if (hit) return hit;
    }
  }
  return null;
}

export const collectPaths = (nodes, includeHidden = false) => {
  const out = [];
  walk(nodes, (node) => {
    if (node.type === 'path' && (includeHidden || node.visible)) out.push(node);
  });
  return out;
};

// 节点自身或其祖先是否锁定/隐藏
export function isEffectiveLocked(doc, id) {
  let locked = false;
  const chain = ancestorChain(doc.layers, id);
  for (const n of chain) locked = locked || n.locked;
  return locked;
}
export function isEffectiveVisible(doc, id) {
  const chain = ancestorChain(doc.layers, id);
  return chain.every((n) => n.visible);
}
export function ancestorChain(nodes, id) {
  const path = [];
  const go = (list) => {
    for (const n of list) {
      path.push(n);
      if (n.id === id) return true;
      if (n.type === 'group' && go(n.children)) return true;
      path.pop();
    }
    return false;
  };
  go(nodes);
  return path;
}

// ---------- 增 / 删 / 复制 / 排序 ----------
export function insertNode(doc, node, targetParentId = null, index = -1) {
  const list = targetParentId ? findNode(doc.layers, targetParentId)?.children : doc.layers;
  if (!list) return;
  if (index < 0 || index > list.length) list.push(node);
  else list.splice(index, 0, node);
}

export function removeNode(doc, id) {
  const loc = locate(doc.layers, id);
  if (!loc) return null;
  loc.list.splice(loc.index, 1);
  return loc.node;
}

export function cloneNode(node, nameSuffix = ' 副本') {
  const copy = JSON.parse(JSON.stringify(node));
  const reId = (n) => {
    n.id = uid(n.type);
    n.name = n.name + nameSuffix;
    if (n.type === 'group') n.children.forEach(reId);
  };
  reId(copy);
  return copy;
}

// 上移/下移/置顶/置底（在所在数组内）
export function reorder(doc, id, mode) {
  const loc = locate(doc.layers, id);
  if (!loc) return;
  const { list, index } = loc;
  const swap = (i, j) => { [list[i], list[j]] = [list[j], list[i]]; };
  if (mode === 'up' && index < list.length - 1) swap(index, index + 1);
  if (mode === 'down' && index > 0) swap(index, index - 1);
  if (mode === 'top') { const [n] = list.splice(index, 1); list.push(n); }
  if (mode === 'bottom') { const [n] = list.splice(index, 1); list.unshift(n); }
}

// ---------- 分组 / 解组 ----------
export function groupNodes(doc, ids, name = '组') {
  if (ids.length < 1) return null;
  // 取这些节点的最近公共数组；只支持同一父级下分组（UI 按此约束提供入口）
  const first = locate(doc.layers, ids[0]);
  if (!first) return null;
  const parentList = first.list;
  const picked = parentList.filter((n) => ids.includes(n.id));
  if (picked.length !== ids.length) return null;
  const idx = parentList.indexOf(picked[0]);
  const g = createGroup([], name);
  parentList.splice(idx, 0, g);
  for (const n of picked) {
    const i = parentList.indexOf(n);
    parentList.splice(i, 1);
    g.children.push(n);
  }
  return g;
}

export function ungroup(doc, groupId) {
  const loc = locate(doc.layers, groupId);
  if (!loc || loc.node.type !== 'group') return [];
  const g = loc.node;
  loc.list.splice(loc.index, 1, ...g.children);
  return g.children;
}

// ---------- 路径结构操作 ----------
// 在选中锚点处拆分；无选中锚点时按每个子路径独立成新路径
export function splitPath(doc, pathId, anchorKeys = []) {
  const loc = locate(doc.layers, pathId);
  if (!loc || loc.node.type !== 'path') return [];
  const node = loc.node;
  const pieces = [];

  if (!anchorKeys.length) {
    for (const sp of node.subpaths) {
      pieces.push({ closed: sp.closed, anchors: JSON.parse(JSON.stringify(sp.anchors)) });
    }
  } else {
    const keyOf = (si, ai) => `${si}:${ai}`;
    node.subpaths.forEach((sp, si) => {
      const cutIdx = sp.anchors
        .map((_, ai) => ai)
        .filter((ai) => anchorKeys.includes(keyOf(si, ai)))
        .sort((a, b) => a - b);
      if (!cutIdx.length) {
        pieces.push({ closed: sp.closed, anchors: JSON.parse(JSON.stringify(sp.anchors)) });
        return;
      }
      const a = sp.anchors;
      if (sp.closed) {
        // 闭合路径：在每个切点断开，切点在相邻两段各保留一份
        const cuts = cutIdx;
        for (let k = 0; k < cuts.length; k++) {
          const start = cuts[k], end = cuts[(k + 1) % cuts.length];
          const seg = [];
          for (let ai = start; ; ai = (ai + 1) % a.length) {
            seg.push(JSON.parse(JSON.stringify(a[ai])));
            if (ai === end) break;
          }
          if (seg.length > 1) pieces.push({ closed: false, anchors: seg });
        }
      } else {
        const bounds = [0, ...cutIdx, a.length - 1];
        for (let k = 0; k < bounds.length - 1; k++) {
          const s = bounds[k], e = bounds[k + 1];
          const seg = [];
          for (let ai = s; ai <= e; ai++) seg.push(JSON.parse(JSON.stringify(a[ai])));
          if (seg.length > 1 || k === 0) pieces.push({ closed: false, anchors: seg });
        }
      }
    });
  }

  const made = pieces
    .filter((sp) => sp.anchors.length > 0)
    .map((sp, i) => createPath([sp], { ...node.style }, `${node.name} 拆分${i + 1}`));
  if (!made.length) return [];
  loc.list.splice(loc.index, 1, ...made);
  return made;
}

// 合并多个路径（保留各自轮廓作为子路径；样式取首个路径，位置跟随最上层节点）
export function mergePaths(doc, ids, name = '合并路径') {
  const nodes = ids.map((id) => findNode(doc.layers, id)).filter((n) => n && n.type === 'path');
  if (nodes.length < 2) return null;
  const top = locate(doc.layers, nodes[nodes.length - 1].id);
  const subpaths = [];
  for (const n of nodes) for (const sp of n.subpaths) subpaths.push(JSON.parse(JSON.stringify(sp)));
  const merged = createPath(subpaths, { ...nodes[0].style }, name);
  const insertAt = top.index;
  const parentList = top.list;
  for (const n of nodes) {
    const loc = locate(doc.layers, n.id);
    loc.list.splice(loc.index, 1);
  }
  parentList.splice(Math.min(insertAt, parentList.length), 0, merged);
  return merged;
}

// 闭合 / 打开：作用于指定子路径（不给定则全部切换为闭合）
export function toggleClose(node, subIndex = null) {
  if (node.type !== 'path') return;
  node.subpaths.forEach((sp, i) => {
    if (subIndex === null || subIndex === i) {
      if (sp.anchors.length >= 2) sp.closed = !sp.closed;
    }
  });
}

// ---------- 锚点编辑 ----------
export function setAnchorPoint(node, si, ai, p) {
  const a = node.subpaths[si].anchors[ai];
  a.x = p.x; a.y = p.y;
}

// 移动锚点。控制柄以相对本点的偏移存储，锚点移动后偏移不变即“控制柄跟随平移”
export function moveAnchor(node, si, ai, delta, _keepHandles) {
  const a = node.subpaths[si].anchors[ai];
  a.x += delta.x; a.y += delta.y;
}

// 拖动控制柄：which = 'in' | 'out'；平滑锚点联动对侧（保持共线、镜像）
export function moveHandle(node, si, ai, which, newHandleAbs, breakSmooth) {
  const a = node.subpaths[si].anchors[ai];
  const setOne = (side, hp) => {
    const d = sub(hp, V(a.x, a.y));
    if (side === 'in') a.hIn = { dx: d.x, dy: d.y };
    else a.hOut = { dx: d.x, dy: d.y };
  };
  setOne(which, newHandleAbs);
  if (a.smooth && !breakSmooth) {
    const d = sub(newHandleAbs, V(a.x, a.y));
    const other = add(V(a.x, a.y), mul(d, -1));
    setOne(which === 'in' ? 'out' : 'in', other);
  } else if (breakSmooth) {
    a.smooth = false;
  }
}

// 角点 <-> 平滑点：平滑时把控制柄调整为共线镜像
export function setSmooth(node, si, ai, smooth) {
  const sp = node.subpaths[si];
  const a = sp.anchors[ai];
  a.smooth = smooth;
  if (!smooth) return;
  const prev = sp.anchors[ai - 1] || (sp.closed ? sp.anchors[sp.anchors.length - 1] : null);
  const next = sp.anchors[(ai + 1) % sp.anchors.length] || (sp.closed ? sp.anchors[0] : null);
  const inLen = Math.hypot(a.hIn.dx, a.hIn.dy);
  const outLen = Math.hypot(a.hOut.dx, a.hOut.dy);
  // 无现成控制柄时，按到相邻点距离的 1/3 估算（Catmull-Rom 转 Bezier 比例）
  const dPrev = prev ? dist(V(a.x, a.y), V(prev.x, prev.y)) : 0;
  const dNext = next ? dist(V(a.x, a.y), V(next.x, next.y)) : 0;
  const ri = inLen || dPrev / 3 || 20;
  const ro = outLen || dNext / 3 || 20;
  if (prev && next) {
    const dir = sub(next, prev);
    const l = Math.hypot(dir.x, dir.y) || 1;
    const u = V(dir.x / l, dir.y / l);
    a.hIn = { dx: -u.x * ri, dy: -u.y * ri };
    a.hOut = { dx: u.x * ro, dy: u.y * ro };
  } else if (next) {
    const dir = sub(next, a); const l = Math.hypot(dir.x, dir.y) || 1;
    const u = V(dir.x / l, dir.y / l);
    a.hIn = { dx: -u.x * ri, dy: -u.y * ri };
    a.hOut = { dx: u.x * ro, dy: u.y * ro };
  } else if (prev) {
    const dir = sub(a, prev); const l = Math.hypot(dir.x, dir.y) || 1;
    const u = V(dir.x / l, dir.y / l);
    a.hIn = { dx: -u.x * ri, dy: -u.y * ri };
    a.hOut = { dx: u.x * ro, dy: u.y * ro };
  }
}

// 删除锚点（两点子路径删点后整条子路径移除）
export function deleteAnchor(node, si, ai) {
  const sp = node.subpaths[si];
  if (sp.anchors.length <= 2) {
    node.subpaths.splice(si, 1);
    return;
  }
  sp.anchors.splice(ai, 1);
}

// 在某条三次曲线段上按参数 t 插入锚点
export function insertAnchorOnSegment(node, si, ai, t) {
  const sp = node.subpaths[si];
  const a0 = sp.anchors[ai];
  const a1 = sp.anchors[(ai + 1) % sp.anchors.length];
  const p0 = V(a0.x, a0.y);
  const p1 = add(p0, a0.hOut);
  const p2 = add(V(a1.x, a1.y), a1.hIn);
  const p3 = V(a1.x, a1.y);
  // 动态 import 会让调用变复杂，这里用 de Casteljau 手算
  const p01 = mid(p0, p1), p12 = mid(p1, p2), p23 = mid(p2, p3);
  const p012 = mid(p01, p12), p123 = mid(p12, p23);
  const pm = mid(p012, p123);
  const na = anchor(pm.x, pm.y, sub(p012, pm), sub(p123, pm), false);
  a0.hOut = { dx: sub(p012, p0).x, dy: sub(p012, p0).y };
  a1.hIn = { dx: sub(p123, p3).x, dy: sub(p123, p3).y };
  sp.anchors.splice(ai + 1, 0, na);
  return { si, ai: ai + 1 };
}

// ---------- 选择集剪枝（删除/结构变化后调用） ----------
export function pruneSelection(doc, selected) {
  const alive = new Set();
  walk(doc.layers, (n) => alive.add(n.id));
  return selected.filter((id) => alive.has(id.id || id));
}

// ---------- 序列化 ----------
export function serializeDoc(doc) {
  return JSON.stringify(doc, null, 2);
}

export function deserializeDoc(text) {
  const data = typeof text === 'string' ? JSON.parse(text) : text;
  if (!data || !Array.isArray(data.layers)) throw new Error('文件结构不是有效的编辑器文档');
  // 补全缺省字段，保证旧文件/手工文件可打开
  data.width = Number(data.width) || 800;
  data.height = Number(data.height) || 600;
  const fix = (node) => {
    if (!node.id) node.id = uid(node.type);
    node.visible = node.visible !== false;
    node.locked = !!node.locked;
    node.name = node.name || (node.type === 'group' ? '组' : '路径');
    if (node.type === 'path') {
      node.style = { ...DEFAULT_STYLE(), ...(node.style || {}) };
      for (const sp of node.subpaths) {
        sp.closed = !!sp.closed;
        for (const a of sp.anchors) {
          a.hIn = { dx: a.hIn?.dx || 0, dy: a.hIn?.dy || 0 };
          a.hOut = { dx: a.hOut?.dx || 0, dy: a.hOut?.dy || 0 };
          a.smooth = !!a.smooth;
        }
      }
    } else if (node.type === 'group') {
      node.children.forEach(fix);
    }
  };
  data.layers.forEach(fix);
  return data;
}

// 节点包围盒（路径采样；组为子节点并集）
export function nodeBounds(node) {
  if (node.type === 'path') return pathBounds(node.subpaths);
  let b = null;
  for (const c of node.children) {
    const cb = nodeBounds(c);
    if (!cb) continue;
    if (!b) b = { ...cb };
    else {
      const x = Math.min(b.x, cb.x), y = Math.min(b.y, cb.y);
      const r = Math.max(b.x + b.w, cb.x + cb.w), bo = Math.max(b.y + b.h, cb.y + cb.h);
      b = { x, y, w: r - x, h: bo - y };
    }
  }
  return b;
}

export { pathToD, parsePathD, transformSubpaths };
