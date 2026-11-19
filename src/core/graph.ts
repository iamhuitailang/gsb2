import { createRaster, writePixel, readPixel } from './color.ts';
import { getNodeDef, defaultParams } from './nodes.ts';
import type {
  ConnectionResult,
  Edge,
  NodeDef,
  NodeInstance,
  PortRef,
  PortType,
  Project,
  RasterImage,
} from './types.ts';

export function nodeName(node: NodeInstance): string {
  return node.label || getNodeDef(node.type).title;
}

export function findNode(project: Project, id: string): NodeInstance | undefined {
  return project.nodes.find((node) => node.id === id);
}

export function portType(
  project: Project,
  ref: PortRef,
  direction: 'in' | 'out',
): PortType | undefined {
  const node = findNode(project, ref.node);
  if (!node) return undefined;
  const def = getNodeDef(node.type);
  const ports = direction === 'in' ? def.inputs : def.outputs;
  return ports.find((port) => port.key === ref.port)?.type;
}

/** Edges arriving at one input port. */
export function incomingEdges(project: Project, nodeId: string, port: string): Edge[] {
  return project.edges.filter((edge) => edge.to.node === nodeId && edge.to.port === port);
}

/** Edges leaving one output port. */
export function outgoingEdges(project: Project, nodeId: string, port?: string): Edge[] {
  return project.edges.filter(
    (edge) => edge.from.node === nodeId && (port === undefined || edge.from.port === port),
  );
}

/** Returns the cycle path (ids, first repeated at the end) or null when acyclic. */
export function findCycle(nodes: NodeInstance[], edges: Edge[]): string[] | null {
  const adjacency = new Map<string, string[]>();
  for (const node of nodes) adjacency.set(node.id, []);
  for (const edge of edges) {
    adjacency.get(edge.from.node)?.push(edge.to.node);
  }
  const state = new Map<string, 0 | 1 | 2>();
  const path: string[] = [];
  const visit = (id: string): string[] | null => {
    const current = state.get(id) ?? 0;
    if (current === 1) {
      const start = path.indexOf(id);
      return [...path.slice(start), id];
    }
    if (current === 2) return null;
    state.set(id, 1);
    path.push(id);
    for (const next of adjacency.get(id) ?? []) {
      const found = visit(next);
      if (found) return found;
    }
    path.pop();
    state.set(id, 2);
    return null;
  };
  for (const node of nodes) {
    const found = visit(node.id);
    if (found) return found;
  }
  return null;
}

/**
 * Check whether `from -> to` can be connected. Validates existence, direction,
 * port shape, type compatibility, cycle, and self-loop.
 */
export function validateConnection(
  project: Project,
  from: PortRef,
  to: PortRef,
): { ok: true } | { ok: false; reason: string } {
  if (from.node === to.node) {
    return { ok: false, reason: '不能把节点连接到自身' };
  }
  const source = findNode(project, from.node);
  const target = findNode(project, to.node);
  if (!source || !target) {
    return { ok: false, reason: '节点不存在' };
  }
  const sourceDef = getNodeDef(source.type);
  const targetDef = getNodeDef(target.type);
  const outPort = sourceDef.outputs.find((port) => port.key === from.port);
  const inPort = targetDef.inputs.find((port) => port.key === to.port);
  if (!outPort) {
    return { ok: false, reason: `「${nodeName(source)}」没有输出端口 ${from.port}` };
  }
  if (!inPort) {
    return { ok: false, reason: `「${nodeName(target)}」没有输入端口 ${to.port}` };
  }
  if (outPort.type !== inPort.type) {
    return {
      ok: false,
      reason: `类型不兼容：${outPort.type === 'color' ? '颜色' : '遮罩'} → ${
        inPort.type === 'color' ? '颜色' : '遮罩'
      }`,
    };
  }
  if (wouldCreateCycle(project, from.node, to.node)) {
    return { ok: false, reason: '会形成循环依赖' };
  }
  return { ok: true };
}

/** True when adding fromNode -> toNode would close a cycle. */
export function wouldCreateCycle(project: Project, fromNode: string, toNode: string): boolean {
  // Walk downstream from `toNode`; reaching `fromNode` means the new edge closes a loop.
  const stack = [toNode];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === fromNode) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const edge of project.edges) {
      if (edge.from.node === current) {
        stack.push(edge.to.node);
      }
    }
  }
  return false;
}

let edgeCounter = 0;
export function nextEdgeId(): string {
  edgeCounter += 1;
  return `e_${Date.now().toString(36)}_${edgeCounter.toString(36)}`;
}

/**
 * Build the edge to add, reporting any edge it would replace on the same input.
 * An input accepts only one upstream edge.
 */
export function connect(project: Project, from: PortRef, to: PortRef): ConnectionResult {
  const check = validateConnection(project, from, to);
  if (!check.ok) {
    return { ok: false, reason: check.reason };
  }
  const existing = incomingEdges(project, to.node, to.port);
  const duplicate = existing.find(
    (edge) => edge.from.node === from.node && edge.from.port === from.port,
  );
  if (duplicate) {
    return { ok: false, reason: '这两个端口已经连接' };
  }
  return {
    ok: true,
    edge: { id: nextEdgeId(), from: { ...from }, to: { ...to } },
    replaced: existing[0],
  };
}

/** Topological order over nodes, or an error naming the cycle participants. */
export function topoOrder(
  project: Project,
): { ok: true; order: string[] } | { ok: false; cycle: string[] } {
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const node of project.nodes) {
    indegree.set(node.id, 0);
    dependents.set(node.id, []);
  }
  for (const edge of project.edges) {
    if (!indegree.has(edge.from.node) || !indegree.has(edge.to.node)) continue;
    // Downstream depends on upstream: edge.from -> edge.to
    indegree.set(edge.to.node, (indegree.get(edge.to.node) ?? 0) + 1);
    dependents.get(edge.from.node)!.push(edge.to.node);
  }
  const queue = project.nodes.filter((node) => indegree.get(node.id) === 0).map((n) => n.id);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of dependents.get(id) ?? []) {
      const value = (indegree.get(next) ?? 1) - 1;
      indegree.set(next, value);
      if (value === 0) queue.push(next);
    }
  }
  if (order.length !== project.nodes.length) {
    const cycle = project.nodes.map((n) => n.id).filter((id) => !order.includes(id));
    return { ok: false, cycle };
  }
  return { ok: true, order };
}

/** All nodes upstream of (and including) the given roots. */
export function upstreamClosure(project: Project, roots: Iterable<string>): Set<string> {
  const byTarget = new Map<string, string[]>();
  for (const edge of project.edges) {
    const list = byTarget.get(edge.to.node) ?? [];
    list.push(edge.from.node);
    byTarget.set(edge.to.node, list);
  }
  const result = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (result.has(id)) continue;
    result.add(id);
    for (const parent of byTarget.get(id) ?? []) {
      stack.push(parent);
    }
  }
  return result;
}

/** Nodes that depended on the changed node and therefore must be recomputed. */
export function affectedNodes(project: Project, changed: Iterable<string>): Set<string> {
  const bySource = new Map<string, string[]>();
  for (const edge of project.edges) {
    const list = bySource.get(edge.from.node) ?? [];
    list.push(edge.to.node);
    bySource.set(edge.from.node, list);
  }
  const result = new Set<string>();
  const stack = [...changed];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (result.has(id)) continue;
    result.add(id);
    for (const child of bySource.get(id) ?? []) {
      stack.push(child);
    }
  }
  return result;
}

export interface EvaluateResult {
  images: Map<string, RasterImage>;
  /** Per-node error message, if that node failed on its own. */
  errors: Map<string, string>;
  /** Nodes skipped because an upstream node failed (not their own fault). */
  blocked: Set<string>;
  /** Nodes actually computed in this pass. */
  computed: string[];
  /** Nodes that were served from cache. */
  reused: string[];
}

interface CacheEntry {
  signature: string;
  outputs: Map<PortType, RasterImage>;
}

export interface EvaluatorOptions {
  width: number;
  height: number;
}

/** Hash-ish signature of a node's config + the identity of each upstream edge. */
function signatureOf(
  node: NodeInstance,
  upstream: Map<string, string>,
  width: number,
  height: number,
): string {
  const params = JSON.stringify(node.params);
  const parents = Array.from(upstream.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('|');
  return `${node.type}@${width}x${height}?${params}#${parents}`;
}

function maskFromColor(image: RasterImage): RasterImage {
  const mask = createRaster(image.width, image.height);
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const pixel = readPixel(image, x, y);
      const value = 0.2126 * pixel.r + 0.7152 * pixel.g + 0.0722 * pixel.b;
      writePixel(mask, x, y, value, value, value, pixel.a);
    }
  }
  return mask;
}

/**
 * Incremental evaluator. Every node's output is content-addressed: its config
 * signature includes the signatures of everything upstream, so changing one
 * node recomputes only that node and its descendants. Errors are contained: a
 * failing node records its message, keeps its previous output, and the rest of
 * the graph still evaluates.
 */
export class GraphEvaluator {
  private cache = new Map<string, CacheEntry>();

  evaluate(project: Project, options: EvaluatorOptions): EvaluateResult {
    const { width, height } = options;
    const result: EvaluateResult = {
      images: new Map(),
      errors: new Map(),
      blocked: new Set(),
      computed: [],
      reused: [],
    };
    const topo = topoOrder(project);
    if (!topo.ok) {
      const names = topo.cycle
        .map((id) => {
          const node = findNode(project, id);
          return node ? nodeName(node) : id;
        })
        .join('、');
      for (const id of topo.cycle) {
        result.errors.set(id, `循环依赖：${names}`);
      }
      this.rebuildImages(project, result);
      return result;
    }

    const signatures = new Map<string, string>();
    const outputs = new Map<string, Map<PortType, RasterImage>>();
    /** Nodes that failed outright or sit downstream of a failure. */
    const poisoned = new Set<string>();

    for (const id of topo.order) {
      const node = findNode(project, id);
      if (!node) continue;
      const def = getNodeDef(node.type);

      // Gather connected inputs by port, recording upstream signatures and
      // noting whether anything upstream is broken.
      const inputs: Record<string, RasterImage | undefined> = {};
      const inputSigs = new Map<string, string>();
      let blockedBy: string | null = null;
      for (const port of def.inputs) {
        const edge = project.edges.find(
          (candidate) => candidate.to.node === id && candidate.to.port === port.key,
        );
        if (!edge) {
          inputs[port.key] = undefined;
          continue;
        }
        if (poisoned.has(edge.from.node)) blockedBy = edge.from.node;
        const upstreamImage = outputs.get(edge.from.node)?.get(port.type);
        if (upstreamImage === undefined) blockedBy = edge.from.node;
        inputs[port.key] = upstreamImage;
        // Include the source port so switching noise.color -> noise.mask (or
        // rewiring to a different node) invalidates the cached signature.
        inputSigs.set(
          port.key,
          `${edge.from.node}:${edge.from.port}@${signatures.get(edge.from.node) ?? 'missing'}`,
        );
      }

      const signature = signatureOf(node, inputSigs, width, height);
      signatures.set(id, signature);

      // A node downstream of a failure is not itself at fault. Do not evaluate
      // it with stale or missing data: keep its last good output (if any) and
      // propagate the block downstream.
      if (blockedBy !== null) {
        poisoned.add(id);
        result.blocked.add(id);
        const previous = this.cache.get(id);
        if (previous) {
          outputs.set(id, previous.outputs);
          result.reused.push(id);
        }
        continue;
      }

      const cached = this.cache.get(id);
      if (cached && cached.signature === signature && cached.outputs.size > 0) {
        outputs.set(id, cached.outputs);
        result.reused.push(id);
        continue;
      }

      const defOutputs = new Map<PortType, RasterImage>();
      try {
        const produced = def.evaluate({ width, height, params: node.params, inputs });
        defOutputs.set('color', produced.color);
        if (produced.mask) {
          defOutputs.set('mask', produced.mask);
        } else if (def.outputs.some((port) => port.type === 'mask')) {
          defOutputs.set('mask', maskFromColor(produced.color));
        }
        this.cache.set(id, { signature, outputs: defOutputs });
        outputs.set(id, defOutputs);
        result.computed.push(id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.set(id, message);
        poisoned.add(id);
        // Retain this node's last good result; downstream keeps its own too.
        const previous = this.cache.get(id);
        if (previous) {
          outputs.set(id, previous.outputs);
          result.reused.push(id);
        }
      }
    }

    this.rebuildImages(project, result, outputs);
    // Drop cache entries for deleted nodes.
    const live = new Set(project.nodes.map((node) => node.id));
    for (const id of [...this.cache.keys()]) {
      if (!live.has(id)) this.cache.delete(id);
    }
    return result;
  }

  /** Last successfully computed outputs for a node, ignoring its current state. */
  lastGood(nodeId: string, port: PortType = 'color'): RasterImage | undefined {
    return this.cache.get(nodeId)?.outputs.get(port);
  }

  /** Forget a node so the next pass must recompute it. */
  invalidate(nodeId: string): void {
    this.cache.delete(nodeId);
  }

  /** Remove cache entries for nodes not in `keep`. */
  retainOnly(keep: Set<string>): void {
    for (const id of [...this.cache.keys()]) {
      if (!keep.has(id)) this.cache.delete(id);
    }
  }

  clear(): void {
    this.cache.clear();
  }

  private rebuildImages(
    project: Project,
    result: EvaluateResult,
    outputs?: Map<string, Map<PortType, RasterImage>>,
  ): void {
    if (!outputs) {
      // Cycle failure: surface cached images so the preview can stay usable.
      for (const node of project.nodes) {
        const entry = this.cache.get(node.id);
        if (entry) {
          const color = entry.outputs.get('color');
          if (color) result.images.set(node.id, color);
        }
      }
      return;
    }
    for (const node of project.nodes) {
      const current = outputs.get(node.id)?.get('color');
      if (current) {
        result.images.set(node.id, current);
      } else {
        const cached = this.cache.get(node.id)?.outputs.get('color');
        if (cached) result.images.set(node.id, cached);
      }
    }
  }
}

let nodeCounter = 0;
export function nextNodeId(type: string): string {
  nodeCounter += 1;
  return `${type}_${Date.now().toString(36)}${nodeCounter.toString(36)}`;
}

export function createNode(type: string, x: number, y: number): NodeInstance {
  const def = getNodeDef(type);
  return {
    id: nextNodeId(type),
    type,
    label: def.title,
    x,
    y,
    params: defaultParams(def),
  };
}

export function findOutputNodes(project: Project): NodeInstance[] {
  return project.nodes.filter((node) => node.type === 'output');
}

export function defaultOutput(project: Project): NodeInstance | undefined {
  return findOutputNodes(project)[0];
}

export function defOf(node: NodeInstance): NodeDef {
  return getNodeDef(node.type);
}
