import { findCycle } from './graph.ts';
import { NODE_DEF_MAP, getNodeDef } from './nodes.ts';
import type {
  Edge,
  NodeInstance,
  ParamDef,
  ParamValue,
  PreviewSettings,
  Project,
  ViewState,
} from './types.ts';

/**
 * Project validation + migration. Anything that fails here is reported to the
 * user and the currently open graph is left untouched.
 */

export class ProjectValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectValidationError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function fail(path: string, message: string): never {
  throw new ProjectValidationError(`${path}: ${message}`);
}

function asNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(path, '必须是数字');
  }
  return value;
}

function asString(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    fail(path, '必须是字符串');
  }
  return value;
}

function coerceParam(def: ParamDef, value: unknown, path: string): ParamValue {
  switch (def.kind) {
    case 'number': {
      const numeric = asNumber(value, path);
      const min = def.min ?? -Infinity;
      const max = def.max ?? Infinity;
      if (numeric < min || numeric > max) {
        fail(path, `数值 ${numeric} 超出范围 [${min}, ${max}]`);
      }
      return numeric;
    }
    case 'seed': {
      const numeric = asNumber(value, path);
      if (!Number.isInteger(numeric) || numeric < 0) {
        fail(path, '种子必须是非负整数');
      }
      return numeric;
    }
    case 'color': {
      const text = asString(value, path);
      if (!/^#[0-9a-fA-F]{6}$/.test(text)) {
        fail(path, `颜色 "${text}" 必须是 #rrggbb`);
      }
      return text.toLowerCase();
    }
    case 'select': {
      const text = asString(value, path);
      const allowed = (def.options ?? []).map((option) => option.value);
      if (!allowed.includes(text)) {
        fail(path, `选项 "${text}" 不在 ${allowed.join(' / ')} 之中`);
      }
      return text;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') {
        fail(path, '必须是布尔值');
      }
      return value;
    }
  }
}

function migrateSettings(raw: unknown): PreviewSettings {
  if (!isRecord(raw)) {
    return { resolution: 512, zoom: 1 };
  }
  const resolution = typeof raw['resolution'] === 'number' ? raw['resolution'] : 512;
  if (![128, 256, 384, 512, 768].includes(resolution)) {
    fail('preview.resolution', `${resolution} 不是受支持的预览尺寸`);
  }
  // 0 = fit to panel, positive numbers are explicit display scales.
  const zoomRaw = typeof raw['zoom'] === 'number' ? raw['zoom'] : 1;
  if (zoomRaw !== 0 && ![0.5, 1, 2, 4].includes(zoomRaw)) {
    fail('preview.zoom', `${zoomRaw} 不是受支持的缩放`);
  }
  return { resolution, zoom: zoomRaw };
}

function validateNode(raw: unknown, index: number, seen: Set<string>): NodeInstance {
  const path = `nodes[${index}]`;
  if (!isRecord(raw)) fail(path, '节点必须是对象');
  const id = asString(raw['id'], `${path}.id`);
  if (id.length === 0) fail(`${path}.id`, '不能为空');
  if (seen.has(id)) fail(`${path}.id`, `重复的节点 id "${id}"`);
  seen.add(id);

  const type = asString(raw['type'], `${path}.type`);
  const def = NODE_DEF_MAP.get(type);
  if (!def) fail(`${path}.type`, `未知节点类型 "${type}"`);

  const x = asNumber(raw['x'], `${path}.x`);
  const y = asNumber(raw['y'], `${path}.y`);
  const labelRaw = raw['label'];
  const label = typeof labelRaw === 'string' ? labelRaw : def.title;

  const rawParams = raw['params'];
  if (!isRecord(rawParams)) fail(`${path}.params`, '必须是对象');

  const params: Record<string, ParamValue> = {};
  for (const param of def.params) {
    const value = rawParams[param.key];
    if (value === undefined) {
      params[param.key] = param.default;
      continue;
    }
    params[param.key] = coerceParam(param, value, `${path}.params.${param.key}`);
  }

  return { id, type, label, x, y, params };
}

function validateEdges(raw: unknown, nodes: NodeInstance[]): Edge[] {
  if (!Array.isArray(raw)) fail('edges', '必须是数组');
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const usedInputs = new Set<string>();
  const edges: Edge[] = [];
  const seenIds = new Set<string>();

  raw.forEach((item, index) => {
    const path = `edges[${index}]`;
    if (!isRecord(item)) fail(path, '连线必须是对象');
    const id = asString(item['id'], `${path}.id`);
    if (seenIds.has(id)) fail(`${path}.id`, `重复的连线 id "${id}"`);
    seenIds.add(id);

    const from = item['from'];
    const to = item['to'];
    if (!isRecord(from)) fail(`${path}.from`, '必须是对象');
    if (!isRecord(to)) fail(`${path}.to`, '必须是对象');
    const fromNode = asString(from['node'], `${path}.from.node`);
    const fromPort = asString(from['port'], `${path}.from.port`);
    const toNode = asString(to['node'], `${path}.to.node`);
    const toPort = asString(to['port'], `${path}.to.port`);

    const source = nodeMap.get(fromNode);
    const target = nodeMap.get(toNode);
    if (!source) fail(`${path}.from.node`, `引用了不存在的节点 "${fromNode}"`);
    if (!target) fail(`${path}.to.node`, `引用了不存在的节点 "${toNode}"`);
    const sourceDef = getNodeDef(source.type);
    const targetDef = getNodeDef(target.type);
    const outPort = sourceDef.outputs.find((port) => port.key === fromPort);
    const inPort = targetDef.inputs.find((port) => port.key === toPort);
    if (!outPort) fail(`${path}.from.port`, `节点 "${source.id}" 没有输出 "${fromPort}"`);
    if (!inPort) fail(`${path}.to.port`, `节点 "${target.id}" 没有输入 "${toPort}"`);
    if (outPort.type !== inPort.type) {
      fail(`${path}`, `端口类型不兼容 (${outPort.type} → ${inPort.type})`);
    }
    const inputKey = `${toNode}.${toPort}`;
    if (usedInputs.has(inputKey)) {
      fail(`${path}`, `输入 "${inputKey}" 已被其他连线占用`);
    }
    usedInputs.add(inputKey);
    edges.push({
      id,
      from: { node: fromNode, port: fromPort },
      to: { node: toNode, port: toPort },
    });
  });

  // Reject cycles in the file rather than trying to repair them silently.
  const cycle = findCycle(nodes, edges);
  if (cycle) fail('edges', `存在循环依赖：${cycle.join(' → ')}`);

  return edges;
}

export function parseProject(raw: unknown): Project {
  if (!isRecord(raw)) fail('project', '必须是 JSON 对象');
  const version = raw['version'];
  if (version !== 1) fail('version', `不支持的版本 ${String(version)}`);
  const rawNodes = raw['nodes'];
  if (!Array.isArray(rawNodes)) fail('nodes', '必须是数组');
  if (rawNodes.length === 0) fail('nodes', '项目至少要有一个节点');

  const seen = new Set<string>();
  const nodes = rawNodes.map((item, index) => validateNode(item, index, seen));
  const edges = validateEdges(raw['edges'] ?? [], nodes);

  const name = typeof raw['name'] === 'string' && raw['name'].trim() ? raw['name'] : '未命名项目';

  const viewRaw = raw['view'];
  let view: ViewState = { x: 40, y: 40, zoom: 1 };
  if (isRecord(viewRaw)) {
    view = {
      x: asNumber(viewRaw['x'] ?? 40, 'view.x'),
      y: asNumber(viewRaw['y'] ?? 40, 'view.y'),
      zoom: asNumber(viewRaw['zoom'] ?? 1, 'view.zoom'),
    };
    if (view.zoom < 0.25 || view.zoom > 2.5) fail('view.zoom', '缩放必须在 0.25 到 2.5 之间');
  }

  const outputIds = nodes.filter((node) => node.type === 'output').map((node) => node.id);
  const activeRaw = raw['activeOutputId'];
  let activeOutputId: string | null = outputIds[0] ?? null;
  if (typeof activeRaw === 'string') {
    if (!outputIds.includes(activeRaw)) fail('activeOutputId', `"${activeRaw}" 不是输出节点`);
    activeOutputId = activeRaw;
  } else if (activeRaw !== null && activeRaw !== undefined) {
    fail('activeOutputId', '必须是字符串或 null');
  } else if (activeRaw === null) {
    activeOutputId = null;
  }

  return {
    version: 1,
    name,
    nodes,
    edges,
    view,
    preview: migrateSettings(raw['preview']),
    activeOutputId,
  };
}

export function serializeProject(project: Project): string {
  return JSON.stringify(project, null, 2);
}
