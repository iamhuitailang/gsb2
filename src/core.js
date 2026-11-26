// Pure deterministic circuit graph + three-valued simulation core.
// This module runs in both the browser and Node's built-in test runner.

export const HIGH = 1;
export const LOW = 0;
export const UNKNOWN = null;
export const CONFLICT = 'conflict';

export const TICK_MS = 500;
export const MAX_ENUM_VARS = 20;

export const COMPONENT_DEFS = {
  switch: {
    label: '开关',
    palette: '输入',
    inputs: [],
    outputs: [{ id: 'out', label: 'Q', dataType: 'binary-signal' }],
    defaults: { value: false },
  },
  constant: {
    label: '常量',
    palette: '输入',
    inputs: [],
    outputs: [{ id: 'out', label: 'Q', dataType: 'binary-signal' }],
    defaults: { value: false },
  },
  and: {
    label: '与门 AND',
    palette: '组合逻辑',
    inputs: [
      { id: 'a', label: 'A', dataType: 'binary-signal' },
      { id: 'b', label: 'B', dataType: 'binary-signal' },
    ],
    outputs: [{ id: 'out', label: 'Q', dataType: 'binary-signal' }],
    defaults: {},
  },
  or: {
    label: '或门 OR',
    palette: '组合逻辑',
    inputs: [
      { id: 'a', label: 'A', dataType: 'binary-signal' },
      { id: 'b', label: 'B', dataType: 'binary-signal' },
    ],
    outputs: [{ id: 'out', label: 'Q', dataType: 'binary-signal' }],
    defaults: {},
  },
  xor: {
    label: '异或 XOR',
    palette: '组合逻辑',
    inputs: [
      { id: 'a', label: 'A', dataType: 'binary-signal' },
      { id: 'b', label: 'B', dataType: 'binary-signal' },
    ],
    outputs: [{ id: 'out', label: 'Q', dataType: 'binary-signal' }],
    defaults: {},
  },
  not: {
    label: '非门 NOT',
    palette: '组合逻辑',
    inputs: [{ id: 'in', label: 'In', dataType: 'binary-signal' }],
    outputs: [{ id: 'out', label: 'Q', dataType: 'binary-signal' }],
    defaults: {},
  },
  delay: {
    label: '延时器',
    palette: '时序',
    inputs: [{ id: 'in', label: 'D', dataType: 'binary-signal' }],
    outputs: [{ id: 'out', label: 'Q', dataType: 'binary-signal' }],
    defaults: { delayTicks: 2, initialValue: UNKNOWN },
  },
  lamp: {
    label: '显示灯',
    palette: '输出',
    inputs: [{ id: 'in', label: 'In', dataType: 'binary-signal' }],
    outputs: [],
    defaults: {},
  },
};

export const PALETTE_ORDER = [
  'switch',
  'constant',
  'and',
  'or',
  'xor',
  'not',
  'delay',
  'lamp',
];

let localSerial = 0;

export function uid(prefix = 'id') {
  localSerial += 1;
  const rand = globalThis.crypto?.randomUUID?.().slice(0, 8)
    ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return `${prefix}_${localSerial.toString(36)}_${rand}`;
}

export function cloneGraph(graph) {
  return structuredClone(graph);
}

export function createComponent(type, x, y, props = {}, id = uid(type)) {
  const def = COMPONENT_DEFS[type];
  if (!def) throw new Error(`Unknown component type: ${type}`);
  return {
    id,
    type,
    x: Math.round(x),
    y: Math.round(y),
    name: props.name ?? def.label,
    props: { ...structuredClone(def.defaults), ...props },
  };
}

export function createEmptyGraph() {
  return { version: 1, components: [], connections: [] };
}

export function getComponent(graph, componentId) {
  return graph.components.find((c) => c.id === componentId) ?? null;
}

export function getPortDefinition(component, portId) {
  const def = COMPONENT_DEFS[component?.type];
  if (!def) return null;
  return [...def.inputs, ...def.outputs].find((p) => p.id === portId) ?? null;
}

export function getPortDirection(component, portId) {
  const def = COMPONENT_DEFS[component?.type];
  if (!def) return null;
  if (def.inputs.some((p) => p.id === portId)) return 'input';
  if (def.outputs.some((p) => p.id === portId)) return 'output';
  return null;
}

function endpointLabel(graph, endpoint) {
  const c = getComponent(graph, endpoint.componentId);
  if (!c) return endpoint.componentId;
  return `${c.name}.${endpoint.portId}`;
}

function inferPortId(component, endpoint, otherComponent, otherEndpoint) {
  if (endpoint.portId) return endpoint.portId;
  const def = COMPONENT_DEFS[component?.type];
  if (!def) return endpoint.portId;

  const otherDirection = otherEndpoint?.portId
    ? getPortDirection(otherComponent, otherEndpoint.portId)
    : otherEndpoint?.direction ?? null;

  if (otherDirection === 'input' && def.outputs.length === 1) return def.outputs[0].id;
  if (otherDirection === 'output' && def.inputs.length === 1) return def.inputs[0].id;
  if (def.outputs.some((port) => port.id === 'out')) return 'out';
  if (def.inputs.length === 1) return def.inputs[0].id;
  return endpoint.portId;
}

/**
 * Validate a proposed wire. Endpoints may be supplied in either direction.
 * Returns { ok:true, output, input } or { ok:false, code,message,... }.
 */
export function validateConnection(graph, endpointA, endpointB) {
  const ca = getComponent(graph, endpointA?.componentId);
  const cb = getComponent(graph, endpointB?.componentId);
  if (!ca || !cb) {
    return { ok: false, code: 'PORT_NOT_FOUND', message: '接口不存在，无法连线' };
  }

  const portA = inferPortId(ca, endpointA, cb, endpointB);
  const portB = inferPortId(cb, endpointB, ca, endpointA);
  endpointA = { ...endpointA, portId: portA };
  endpointB = { ...endpointB, portId: portB };

  const da = getPortDirection(ca, endpointA.portId);
  const db = getPortDirection(cb, endpointB.portId);
  if (!da || !db) {
    return { ok: false, code: 'PORT_NOT_FOUND', message: '接口不存在，无法连线' };
  }
  if (da === db) {
    const message = da === 'input'
      ? '两个输入端不能直接相连：每个输入只能有一个驱动来源'
      : '两个输出端不能直接相连';
    return { ok: false, code: 'DIRECTION', message };
  }

  const output = da === 'output' ? endpointA : endpointB;
  const input = da === 'input' ? endpointA : endpointB;
  const outComp = getComponent(graph, output.componentId);
  const inComp = getComponent(graph, input.componentId);
  const outPort = getPortDefinition(outComp, output.portId);
  const inPort = getPortDefinition(inComp, input.portId);

  if (outPort.dataType !== inPort.dataType) {
    return {
      ok: false,
      code: 'TYPE_MISMATCH',
      message: `接口类型不兼容：${outPort.dataType} → ${inPort.dataType}`,
    };
  }

  const existing = graph.connections.find(
    (wire) => wire.to.componentId === input.componentId && wire.to.portId === input.portId,
  );
  if (existing) {
    if (
      existing.from.componentId === output.componentId
      && existing.from.portId === output.portId
    ) {
      return {
        ok: false,
        code: 'DUPLICATE',
        connectionId: existing.id,
        message: '这根连线已经存在',
      };
    }
    return {
      ok: false,
      code: 'INPUT_OCCUPIED',
      connectionId: existing.id,
      message: `接入失败：${endpointLabel(graph, input)} 已由 ${endpointLabel(graph, existing.from)} 驱动；相斥来源不能同时接入`,
    };
  }

  return { ok: true, output: { ...output }, input: { ...input } };
}

export function connect(graph, endpointA, endpointB) {
  const check = validateConnection(graph, endpointA, endpointB);
  if (!check.ok) return check;
  const connection = { id: uid('wire'), from: check.output, to: check.input };
  return {
    ok: true,
    connection,
    graph: { ...graph, connections: [...graph.connections, connection] },
  };
}

export function addConnection(graph, endpointA, endpointB) {
  const result = connect(graph, endpointA, endpointB);
  return result.ok ? result.graph : graph;
}

export function deleteConnection(graph, connectionId) {
  return {
    ...graph,
    connections: graph.connections.filter((w) => w.id !== connectionId),
  };
}

export function deleteComponent(graph, componentId) {
  return {
    ...graph,
    components: graph.components.filter((c) => c.id !== componentId),
    connections: graph.connections.filter(
      (w) => w.from.componentId !== componentId && w.to.componentId !== componentId,
    ),
  };
}

export function updateComponent(graph, componentId, patch = {}) {
  return {
    ...graph,
    components: graph.components.map((c) => {
      if (c.id !== componentId) return c;
      const next = { ...c, ...patch };
      if (patch.props) next.props = { ...c.props, ...patch.props };
      return next;
    }),
  };
}

/** Electrical identity excludes position/name and run metadata. */
export function electricalSignature(graph) {
  const components = graph.components
    .map((c) => ({ id: c.id, type: c.type, props: c.props }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const connections = graph.connections
    .map((w) => ({ from: w.from, to: w.to }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return JSON.stringify({ components, connections });
}

export function sameCircuit(a, b) {
  return electricalSignature(a) === electricalSignature(b);
}

export function valueLabel(value) {
  if (value === HIGH || value === 1 || value === true) return '1 / 高电平';
  if (value === LOW || value === 0 || value === false) return '0 / 低电平';
  if (value === CONFLICT) return '冲突 / 不稳定';
  return '未知';
}

export function shortValue(value) {
  if (value === HIGH) return '1';
  if (value === LOW) return '0';
  if (value === CONFLICT) return '!';
  return '?';
}

/* ----------------------------- Graph groups ----------------------------- */

export function findCircuitGroups(graph) {
  const ids = graph.components.map((c) => c.id);
  const adjacency = new Map(ids.map((id) => [id, new Set()]));
  for (const wire of graph.connections) {
    const a = wire.from.componentId;
    const b = wire.to.componentId;
    if (!adjacency.has(a) || !adjacency.has(b)) continue;
    adjacency.get(a).add(b);
    adjacency.get(b).add(a);
  }

  const seen = new Set();
  const groups = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    const stack = [id];
    const group = [];
    seen.add(id);
    while (stack.length) {
      const current = stack.pop();
      group.push(current);
      for (const next of adjacency.get(current) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    group.sort((a, b) => a.localeCompare(b));
    groups.push(group);
  }
  return groups;
}

/* ------------------------------ Evaluation ------------------------------ */

function normalizeBit(value) {
  if (value === true || value === HIGH) return HIGH;
  if (value === false || value === LOW) return LOW;
  return value;
}

export function evaluateGate(type, inputValues) {
  const values = inputValues.map(normalizeBit);
  const hasConflict = values.some((v) => v === CONFLICT);
  const hasUnknown = values.some((v) => v === UNKNOWN || v === undefined);

  switch (type) {
    case 'and': {
      if (values.includes(LOW)) return LOW;
      if (hasConflict) return CONFLICT;
      if (hasUnknown) return UNKNOWN;
      return HIGH;
    }
    case 'or': {
      if (values.includes(HIGH)) return HIGH;
      if (hasConflict) return CONFLICT;
      if (hasUnknown) return UNKNOWN;
      return LOW;
    }
    case 'xor': {
      if (hasConflict) return CONFLICT;
      if (hasUnknown) return UNKNOWN;
      return values[0] === values[1] ? LOW : HIGH;
    }
    case 'not': {
      const v = values[0];
      if (v === CONFLICT) return CONFLICT;
      if (v === UNKNOWN || v === undefined) return UNKNOWN;
      return v === HIGH ? LOW : HIGH;
    }
    default:
      return UNKNOWN;
  }
}

function incomingWireIndex(graph) {
  const byInput = new Map();
  for (const wire of graph.connections) {
    byInput.set(`${wire.to.componentId}:${wire.to.portId}`, wire);
  }
  return byInput;
}

function tarjanScc(nodes, edges) {
  const adjacency = new Map(nodes.map((id) => [id, []]));
  for (const [from, to] of edges) {
    if (adjacency.has(from) && adjacency.has(to)) adjacency.get(from).push(to);
  }

  let index = 0;
  const indices = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const result = [];

  function strongConnect(v) {
    indices.set(v, index);
    low.set(v, index);
    index += 1;
    stack.push(v);
    onStack.add(v);

    for (const w of adjacency.get(v) ?? []) {
      if (!indices.has(w)) {
        strongConnect(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v), indices.get(w)));
      }
    }

    if (low.get(v) === indices.get(v)) {
      const component = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      result.push(component);
    }
  }

  for (const id of nodes) {
    if (!indices.has(id)) strongConnect(id);
  }
  return result;
}

function orderSccsTopologically(sccs, edges) {
  const compOf = new Map();
  sccs.forEach((scc, index) => scc.forEach((id) => compOf.set(id, index)));
  const indegree = sccs.map(() => 0);
  const outgoing = sccs.map(() => new Set());

  for (const [from, to] of edges) {
    const a = compOf.get(from);
    const b = compOf.get(to);
    if (a === undefined || b === undefined || a === b || outgoing[a].has(b)) continue;
    outgoing[a].add(b);
    indegree[b] += 1;
  }

  const queue = indegree.map((d, i) => (d === 0 ? i : -1)).filter((i) => i >= 0);
  const order = [];
  while (queue.length) {
    const i = queue.shift();
    order.push(sccs[i]);
    for (const next of outgoing[i]) {
      indegree[next] -= 1;
      if (indegree[next] === 0) queue.push(next);
    }
  }
  // Tarjan should normally make this complete. Keep a deterministic fallback.
  if (order.length !== sccs.length) {
    return [...sccs].sort((a, b) => a[0].localeCompare(b[0]));
  }
  return order;
}

function isCyclicScc(memberIds, edges) {
  if (memberIds.length > 1) return true;
  const id = memberIds[0];
  return edges.some(([from, to]) => from === id && to === id);
}

function makeFaultId(tick, memberIds) {
  return `fault_t${tick}_${memberIds.slice().sort().join('_')}`;
}

/**
 * Settle combinational gates for one disconnected circuit group.
 * `values` already contains switch/constant/delay outputs and is mutated.
 */
function settleGroup(graph, groupIds, values, wireByInput, tick) {
  const groupSet = new Set(groupIds);
  const components = groupIds.map((id) => getComponent(graph, id)).filter(Boolean);
  const gates = components.filter((c) => ['and', 'or', 'xor', 'not'].includes(c.type));
  const gateIds = gates.map((c) => c.id);
  const gateSet = new Set(gateIds);

  const readInput = (componentId, portId, assignment = null) => {
    if (assignment) {
      const assignmentKey = `input:${componentId}:${portId}`;
      if (Object.prototype.hasOwnProperty.call(assignment, assignmentKey)) {
        return assignment[assignmentKey];
      }
    }
    const wire = wireByInput.get(`${componentId}:${portId}`);
    if (!wire) return UNKNOWN;
    if (assignment && Object.prototype.hasOwnProperty.call(assignment, wire.from.componentId)) {
      return assignment[wire.from.componentId];
    }
    const value = values[wire.from.componentId];
    return value === undefined ? UNKNOWN : value;
  };

  const computeGate = (component, assignment = null) => {
    const def = COMPONENT_DEFS[component.type];
    const inputValues = def.inputs.map((port) => readInput(component.id, port.id, assignment));
    return evaluateGate(component.type, inputValues);
  };

  const edges = [];
  for (const gate of gates) {
    for (const port of COMPONENT_DEFS[gate.type].inputs) {
      const wire = wireByInput.get(`${gate.id}:${port.id}`);
      if (wire && gateSet.has(wire.from.componentId)) {
        edges.push([wire.from.componentId, gate.id]);
      }
    }
  }

  const sccs = orderSccsTopologically(tarjanScc(gateIds, edges), edges);
  const newFaults = [];

  for (const scc of sccs) {
    if (!isCyclicScc(scc, edges)) {
      const gate = getComponent(graph, scc[0]);
      values[gate.id] = computeGate(gate);
      continue;
    }

    const memberSet = new Set(scc);
    const variableKeys = new Set();
    const inputDescriptors = [];

    for (const memberId of scc) {
      const member = getComponent(graph, memberId);
      for (const port of COMPONENT_DEFS[member.type].inputs) {
        const wire = wireByInput.get(`${memberId}:${port.id}`);
        if (!wire) {
          const key = `free:${memberId}:${port.id}`;
          variableKeys.add(key);
          inputDescriptors.push({ memberId, portId: port.id, key });
          continue;
        }

        const sourceId = wire.from.componentId;
        if (memberSet.has(sourceId)) {
          inputDescriptors.push({ memberId, portId: port.id, key: sourceId, internal: true });
        } else {
          const sourceValue = values[sourceId];
          if (sourceValue === UNKNOWN || sourceValue === undefined) {
            const key = `external:${sourceId}`;
            variableKeys.add(key);
            inputDescriptors.push({ memberId, portId: port.id, key });
          } else {
            inputDescriptors.push({ memberId, portId: port.id, fixed: sourceValue });
          }
        }
      }
    }

    const variableList = [...scc, ...variableKeys];
    let fixedPointCount = 0;
    const consensus = new Map(scc.map((id) => [id, { mixed: false, value: undefined }]));
    let enumerated = false;

    if (variableList.length <= MAX_ENUM_VARS) {
      enumerated = true;
      const total = 2 ** variableList.length;
      for (let mask = 0; mask < total; mask += 1) {
        const assignment = {};
        variableList.forEach((key, bitIndex) => {
          assignment[key] = (mask >> bitIndex) & 1 ? HIGH : LOW;
        });
        const inputAssignment = {};
        for (const descriptor of inputDescriptors) {
          const inputKey = `input:${descriptor.memberId}:${descriptor.portId}`;
          inputAssignment[inputKey] = descriptor.fixed !== undefined
            ? descriptor.fixed
            : assignment[descriptor.key];
        }

        let stable = true;
        for (const memberId of scc) {
          const member = getComponent(graph, memberId);
          const actual = computeGate(member, inputAssignment);
          if (actual !== assignment[memberId]) {
            stable = false;
            break;
          }
        }
        if (!stable) continue;

        fixedPointCount += 1;
        for (const memberId of scc) {
          const bit = assignment[memberId];
          const current = consensus.get(memberId);
          if (current.value === undefined) current.value = bit;
          else if (current.value !== bit) current.mixed = true;
        }
      }
    }

    if (enumerated && fixedPointCount === 0) {
      const internalWireIds = graph.connections
        .filter((w) => memberSet.has(w.from.componentId) && memberSet.has(w.to.componentId))
        .map((w) => w.id);
      const fault = {
        id: makeFaultId(tick, scc),
        kind: 'COMBINATIONAL_LOOP',
        firstTick: tick,
        groupId: groupIds[0],
        componentIds: [...scc].sort(),
        connectionIds: internalWireIds,
        message: '组合反馈在同一时步内无法稳定；该电路组已暂停。请在反馈回路中加入延时器，或移除矛盾反馈。',
      };
      newFaults.push(fault);
      for (const id of scc) values[id] = CONFLICT;
    } else {
      for (const id of scc) {
        const result = consensus.get(id);
        values[id] = result.mixed || result.value === undefined ? UNKNOWN : result.value;
      }
    }
  }

  // Lamps are sinks; their displayed value is the connected input value.
  for (const component of components.filter((c) => c.type === 'lamp')) {
    values[component.id] = readInput(component.id, 'in');
  }

  return { faults: newFaults, readInput };
}

/* ------------------------------- Simulation ------------------------------ */

export function createRun(graph, options = {}) {
  const run = {
    id: options.id ?? uid('run'),
    number: options.number ?? 1,
    name: options.name ?? `运行 ${options.number ?? 1}`,
    createdAt: options.createdAt ?? new Date().toISOString(),
    graph: cloneGraph(graph),
    events: options.events ? structuredClone(options.events) : [],
    ticks: [],
    delayState: {},
    switchValues: {},
    groupStatus: {},
    faults: [],
    status: 'active',
  };

  for (const component of run.graph.components) {
    if (component.type === 'switch') {
      run.switchValues[component.id] = component.props.value ? HIGH : LOW;
    }
    if (component.type === 'delay') {
      const ticks = Math.max(1, Math.floor(component.props.delayTicks ?? 1));
      const initial = component.props.initialValue === HIGH || component.props.initialValue === LOW
        ? component.props.initialValue
        : UNKNOWN;
      run.delayState[component.id] = Array.from({ length: ticks }, () => initial);
    }
  }

  for (const group of findCircuitGroups(run.graph)) {
    run.groupStatus[group[0]] = 'active';
  }

  run.events.sort((a, b) => a.tick - b.tick || a.componentId.localeCompare(b.componentId));
  advanceRun(run, 1);
  return run;
}

export function scheduleSwitch(run, tick, componentId, value) {
  const component = getComponent(run.graph, componentId);
  if (!component || component.type !== 'switch') {
    return { ok: false, code: 'NOT_SWITCH', message: '只能给开关安排输入事件' };
  }
  if (!Number.isInteger(tick) || tick < run.ticks.length) {
    return {
      ok: false,
      code: 'TICK_ALREADY_RECORDED',
      message: `第 ${tick} 步已经记录，输入事件只能安排在尚未计算的时步`,
    };
  }
  run.events = run.events.filter(
    (e) => !(e.tick === tick && e.componentId === componentId),
  );
  run.events.push({ tick, componentId, value: value ? HIGH : LOW });
  run.events.sort((a, b) => a.tick - b.tick || a.componentId.localeCompare(b.componentId));
  return { ok: true };
}

function applyDueEvents(run, tick) {
  for (const event of run.events.filter((e) => e.tick === tick)) {
    if (getComponent(run.graph, event.componentId)?.type === 'switch') {
      run.switchValues[event.componentId] = normalizeBit(event.value);
    }
  }
}

function buildWireValues(graph, values) {
  const wires = {};
  for (const wire of graph.connections) {
    const value = values[wire.from.componentId];
    wires[wire.id] = value === undefined ? UNKNOWN : value;
  }
  return wires;
}

function advanceOneTick(run) {
  const graph = run.graph;
  const tick = run.ticks.length;
  applyDueEvents(run, tick);

  const wireByInput = incomingWireIndex(graph);
  const groups = findCircuitGroups(graph);
  const values = {};
  const activeFaultIds = [];

  for (const group of groups) {
    const groupKey = group[0];
    const priorFault = run.faults.find((f) => f.groupId === groupKey);

    if (run.groupStatus[groupKey] === 'fault' || priorFault) {
      run.groupStatus[groupKey] = 'fault';
      if (priorFault) activeFaultIds.push(priorFault.id);
      const previous = run.ticks[run.ticks.length - 1];
      for (const componentId of group) {
        values[componentId] = previous?.componentValues?.[componentId] ?? UNKNOWN;
      }
      continue;
    }

    for (const componentId of group) {
      const component = getComponent(graph, componentId);
      if (component.type === 'switch') {
        values[componentId] = run.switchValues[componentId] ?? LOW;
      } else if (component.type === 'constant') {
        values[componentId] = component.props.value ? HIGH : LOW;
      } else if (component.type === 'delay') {
        values[componentId] = run.delayState[componentId]?.[0] ?? UNKNOWN;
      }
    }

    const result = settleGroup(graph, group, values, wireByInput, tick);
    if (result.faults.length > 0) {
      for (const fault of result.faults) {
        run.faults.push(fault);
        activeFaultIds.push(fault.id);
      }
      run.groupStatus[groupKey] = 'fault';
      run.status = 'has-fault';
    } else {
      // Delay inputs are sampled at the end of a stable combinational step.
      for (const componentId of group) {
        const component = getComponent(graph, componentId);
        if (component.type !== 'delay') continue;
        const inputValue = result.readInput(componentId, 'in');
        const queue = run.delayState[componentId];
        run.delayState[componentId] = [...queue.slice(1), inputValue];
      }
    }
  }

  const trace = {
    tick,
    componentValues: values,
    wireValues: buildWireValues(graph, values),
    faultIds: activeFaultIds,
  };
  run.ticks.push(trace);
  return trace;
}

export function advanceRun(run, count = 1) {
  for (let i = 0; i < count; i += 1) advanceOneTick(run);
  return run;
}

export function getTrace(run, tickIndex) {
  if (!run?.ticks?.length) return null;
  const index = Math.max(0, Math.min(tickIndex, run.ticks.length - 1));
  return run.ticks[index];
}

export function getWireValueAt(run, wireId, tickIndex) {
  return getTrace(run, tickIndex)?.wireValues?.[wireId] ?? UNKNOWN;
}

/* ------------------------------ Provenance ------------------------------ */

function valueNode(value) {
  return { value: value === undefined ? UNKNOWN : value };
}

export function explainInput(run, componentId, portId, tickIndex, stack = new Set()) {
  const graph = run.graph;
  const trace = getTrace(run, tickIndex);
  const wire = graph.connections.find(
    (w) => w.to.componentId === componentId && w.to.portId === portId,
  );
  if (!wire) {
    return {
      kind: 'unconnected',
      label: `${componentId}.${portId}`,
      text: '未连接，按未知输入处理',
      value: UNKNOWN,
      children: [],
    };
  }
  return {
    kind: 'wire',
    label: '连线',
    wireId: wire.id,
    value: trace?.wireValues?.[wire.id] ?? UNKNOWN,
    children: [explainOutput(run, wire.from.componentId, tickIndex, stack)],
  };
}

export function explainOutput(run, componentId, tickIndex, stack = new Set()) {
  const graph = run.graph;
  const component = getComponent(graph, componentId);
  const trace = getTrace(run, tickIndex);
  const value = trace?.componentValues?.[componentId] ?? UNKNOWN;
  if (!component) return { kind: 'missing', label: componentId, value: UNKNOWN, children: [] };

  const key = `${tickIndex}:${componentId}`;
  if (stack.has(key)) {
    return {
      kind: 'cycle',
      label: component.name,
      text: '溯源再次进入同一元件，说明存在组合反馈环',
      value: CONFLICT,
      children: [],
    };
  }
  const nextStack = new Set(stack);
  nextStack.add(key);

  const base = {
    kind: component.type,
    componentId,
    label: component.name,
    value,
    children: [],
  };

  if (component.type === 'switch') {
    const event = run.events
      .filter((e) => e.componentId === componentId && e.tick <= tickIndex)
      .sort((a, b) => b.tick - a.tick)[0];
    base.text = event
      ? `第 ${event.tick} 步输入事件将开关设为 ${event.value ? '高电平' : '低电平'}`
      : `初始开关状态：${component.props.value ? '高电平' : '低电平'}`;
    if (event) base.children.push({ kind: 'event', label: `输入事件 @${event.tick}`, value: event.value, children: [] });
    return base;
  }

  if (component.type === 'constant') {
    base.text = `固定常量 ${component.props.value ? 1 : 0}`;
    return base;
  }

  if (component.type === 'delay') {
    const n = Math.max(1, component.props.delayTicks ?? 1);
    if (tickIndex < n) {
      base.text = `延时 ${n} 步：第 ${tickIndex} 步仍输出初始状态`;
      base.children.push({
        kind: 'state',
        label: '延时器初始状态',
        value: component.props.initialValue === HIGH || component.props.initialValue === LOW
          ? component.props.initialValue
          : UNKNOWN,
        children: [],
      });
    } else {
      const originTick = tickIndex - n;
      base.text = `延时 ${n} 步：当前输出来自第 ${originTick} 步采样的 D 输入`;
      base.children.push(explainInput(run, componentId, 'in', originTick, nextStack));
    }
    return base;
  }

  if (component.type === 'lamp') {
    base.text = '显示灯只读取输入，不产生新状态';
    base.children.push(explainInput(run, componentId, 'in', tickIndex, nextStack));
    return base;
  }

  const formula = {
    and: 'Q = A AND B（有 0 出 0，全 1 出 1，否则未知）',
    or: 'Q = A OR B（有 1 出 1，全 0 出 0，否则未知）',
    xor: 'Q = A XOR B（两值确定且不同才为 1）',
    not: 'Q = NOT In',
  }[component.type];
  base.text = formula;
  for (const port of COMPONENT_DEFS[component.type].inputs) {
    base.children.push(explainInput(run, componentId, port.id, tickIndex, nextStack));
  }
  return base;
}

export function explainWire(run, wireId, tickIndex) {
  const wire = run.graph.connections.find((w) => w.id === wireId);
  if (!wire) return null;
  const fromName = getComponent(run.graph, wire.from.componentId)?.name ?? wire.from.componentId;
  const toName = getComponent(run.graph, wire.to.componentId)?.name ?? wire.to.componentId;
  return {
    kind: 'wire',
    wireId,
    label: `${fromName}.${wire.from.portId} → ${toName}.${wire.to.portId}`,
    value: getWireValueAt(run, wireId, tickIndex),
    children: [explainOutput(run, wire.from.componentId, tickIndex)],
  };
}

/* ----------------------------- Compare helpers --------------------------- */

export function getLampSignals(run) {
  return run.graph.components
    .filter((c) => c.type === 'lamp')
    .sort((a, b) => a.x - b.x || a.y - b.y || a.id.localeCompare(b.id));
}

export function compareLampRuns(runA, runB) {
  const lampsA = getLampSignals(runA);
  const lampsB = getLampSignals(runB);
  const rows = [];
  const usedB = new Set();

  for (const lampA of lampsA) {
    let lampB = lampsB.find((l) => l.id === lampA.id);
    if (lampB) usedB.add(lampB.id);
    else lampB = lampsB.find((l) => !usedB.has(l.id) && l.name === lampA.name) ?? null;
    if (lampB) usedB.add(lampB.id);
    rows.push(buildComparisonRow(runA, runB, lampA, lampB));
  }

  for (const lampB of lampsB) {
    if (usedB.has(lampB.id)) continue;
    rows.push(buildComparisonRow(runA, runB, null, lampB));
  }
  return rows;
}

function buildComparisonRow(runA, runB, lampA, lampB) {
  const length = Math.max(runA.ticks.length, runB.ticks.length);
  const points = [];
  let mismatches = 0;
  let unknownA = 0;
  let unknownB = 0;
  let faultA = 0;
  let faultB = 0;

  for (let tick = 0; tick < length; tick += 1) {
    const rawA = lampA && tick < runA.ticks.length
      ? runA.ticks[tick]?.componentValues?.[lampA.id]
      : undefined;
    const rawB = lampB && tick < runB.ticks.length
      ? runB.ticks[tick]?.componentValues?.[lampB.id]
      : undefined;
    const a = rawA === undefined ? undefined : rawA;
    const b = rawB === undefined ? undefined : rawB;
    if (a === UNKNOWN) unknownA += 1;
    if (b === UNKNOWN) unknownB += 1;
    if (a === CONFLICT) faultA += 1;
    if (b === CONFLICT) faultB += 1;
    const mismatch = a === HIGH || a === LOW
      ? (b === HIGH || b === LOW) && a !== b
      : false;
    if (mismatch) mismatches += 1;
    points.push({ tick, a, b, mismatch });
  }

  return {
    key: lampB?.id ?? lampA?.id ?? 'signal',
    name: lampB?.name ?? lampA?.name ?? '未知信号',
    lampA,
    lampB,
    points,
    mismatches,
    unknownA,
    unknownB,
    faultA,
    faultB,
  };
}
