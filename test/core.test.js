import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CONFLICT,
  HIGH,
  LOW,
  UNKNOWN,
  addConnection,
  advanceRun,
  compareLampRuns,
  createComponent,
  createEmptyGraph,
  createRun,
  deleteConnection,
  electricalSignature,
  explainWire,
  scheduleSwitch,
  validateConnection,
} from '../src/core.js';
import { createSeededProject, delayedFeedbackGraph, illegalFeedbackGraph } from '../src/examples.js';

function twoSwitchCircuit() {
  let graph = createEmptyGraph();
  graph.components = [
    createComponent('switch', 0, 0, { value: false }, 's1'),
    createComponent('switch', 0, 100, { value: false }, 's2'),
    createComponent('and', 200, 40, {}, 'g1'),
    createComponent('delay', 400, 40, { delayTicks: 2, initialValue: LOW }, 'd1'),
    createComponent('lamp', 600, 40, {}, 'l1'),
  ];
  graph = addConnection(graph, { componentId: 's1' }, { componentId: 'g1', portId: 'a' });
  graph = addConnection(graph, { componentId: 's2' }, { componentId: 'g1', portId: 'b' });
  graph = addConnection(graph, { componentId: 'g1' }, { componentId: 'd1', portId: 'in' });
  graph = addConnection(graph, { componentId: 'd1' }, { componentId: 'l1', portId: 'in' });
  return graph;
}

test('connection validation checks direction, type and occupied inputs', () => {
  let graph = createEmptyGraph();
  graph.components = [
    createComponent('switch', 0, 0, {}, 's1'),
    createComponent('switch', 0, 0, {}, 's2'),
    createComponent('and', 0, 0, {}, 'g1'),
  ];

  assert.equal(
    validateConnection(graph, { componentId: 's1' }, { componentId: 'g1', portId: 'a' }).ok,
    true,
  );

  const sameDirection = validateConnection(
    graph,
    { componentId: 'g1', portId: 'a' },
    { componentId: 'g1', portId: 'b' },
  );
  assert.equal(sameDirection.ok, false);
  assert.equal(sameDirection.code, 'DIRECTION');

  graph = addConnection(graph, { componentId: 's1' }, { componentId: 'g1', portId: 'a' });
  const occupied = validateConnection(
    graph,
    { componentId: 's2' },
    { componentId: 'g1', portId: 'a' },
  );
  assert.equal(occupied.ok, false);
  assert.equal(occupied.code, 'INPUT_OCCUPIED');

  const fanout = validateConnection(graph, { componentId: 's1' }, { componentId: 'g1', portId: 'b' });
  assert.equal(fanout.ok, true);
});

test('unconnected inputs and delay power-up are unknown/configurable', () => {
  let graph = createEmptyGraph();
  graph.components = [
    createComponent('and', 0, 0, {}, 'and'),
    createComponent('lamp', 200, 0, {}, 'lamp'),
  ];
  graph = addConnection(graph, { componentId: 'and' }, { componentId: 'lamp', portId: 'in' });
  const run = createRun(graph);
  assert.equal(run.ticks[0].componentValues.and, UNKNOWN);
  assert.equal(run.ticks[0].componentValues.lamp, UNKNOWN);
});

test('same circuit and events produce identical deterministic timing', () => {
  const graph = twoSwitchCircuit();

  const runA = createRun(graph);
  scheduleSwitch(runA, 1, 's1', HIGH);
  scheduleSwitch(runA, 3, 's2', HIGH);
  advanceRun(runA, 8);

  const runB = createRun(graph);
  scheduleSwitch(runB, 1, 's1', HIGH);
  scheduleSwitch(runB, 3, 's2', HIGH);
  advanceRun(runB, 8);

  assert.deepEqual(runA.ticks, runB.ticks);

  // t3: both switches are high after the event, AND is high.
  assert.equal(runA.ticks[3].componentValues.g1, HIGH);
  // Delay=2 initialized low: high sampled at t3 appears at t5.
  assert.equal(runA.ticks[4].componentValues.l1, LOW);
  assert.equal(runA.ticks[5].componentValues.l1, HIGH);
});

test('delayed feedback is legal and advances deterministically each tick', () => {
  const graph = delayedFeedbackGraph();
  const run = createRun(graph);
  advanceRun(run, 5);

  assert.deepEqual(
    run.ticks.map((tick) => tick.componentValues.dly_lamp),
    [HIGH, LOW, HIGH, LOW, HIGH, LOW],
  );
  assert.equal(run.faults.length, 0);
});

test('combinational NOT self-loop is marked and its group freezes', () => {
  const graph = illegalFeedbackGraph();
  const run = createRun(graph);

  assert.equal(run.faults.length, 1);
  assert.equal(run.faults[0].kind, 'COMBINATIONAL_LOOP');
  assert.deepEqual(run.faults[0].componentIds, ['bad_not']);
  assert.match(run.faults[0].connectionIds[0], /bad_w_1/);
  assert.equal(run.ticks[0].componentValues.bad_not, CONFLICT);
  assert.equal(run.groupStatus[run.faults[0].groupId], 'fault');

  advanceRun(run, 3);
  assert.equal(run.faults.length, 1);
  assert.equal(run.ticks.at(-1).componentValues.bad_not, CONFLICT);
});

test('two-input contradictory feedback is also detected', () => {
  let graph = createEmptyGraph();
  graph.components = [
    createComponent('constant', 0, 0, { value: HIGH }, 'one'),
    createComponent('xor', 220, 0, {}, 'xor'),
  ];
  graph = addConnection(graph, { componentId: 'one' }, { componentId: 'xor', portId: 'b' });
  graph = addConnection(graph, { componentId: 'xor' }, { componentId: 'xor', portId: 'a' });

  const run = createRun(graph);
  assert.equal(run.faults.length, 1);
  assert.equal(run.faults[0].componentIds[0], 'xor');
  assert.equal(run.ticks[0].componentValues.xor, CONFLICT);
});

test('a fault in one disconnected group does not stop another group', () => {
  let graph = twoSwitchCircuit();
  graph.components.push(createComponent('not', 900, 0, { name: 'bad' }, 'bad'));
  graph = addConnection(graph, { componentId: 'bad' }, { componentId: 'bad', portId: 'in' });

  const run = createRun(graph);
  scheduleSwitch(run, 1, 's1', true);
  scheduleSwitch(run, 1, 's2', true);
  advanceRun(run, 5);

  assert.equal(run.faults.length, 1);
  assert.equal(run.faults[0].componentIds[0], 'bad');
  assert.equal(run.ticks.at(-1).componentValues.g1, HIGH);
  assert.equal(run.ticks.at(-1).componentValues.l1, HIGH);
});

test('provenance follows delayed output back to the sampled input state', () => {
  const graph = twoSwitchCircuit();
  const run = createRun(graph);
  scheduleSwitch(run, 1, 's1', HIGH);
  scheduleSwitch(run, 1, 's2', HIGH);
  advanceRun(run, 5);

  const wireToLamp = graph.connections.find((w) => w.to.componentId === 'l1');
  const explanation = explainWire(run, wireToLamp.id, 5);
  assert.equal(explanation.value, HIGH);

  const text = JSON.stringify(explanation);
  assert.match(text, /第 3 步采样/);
  assert.match(text, /输入事件 @1/);
});

test('run comparison reports timing mismatches', () => {
  const project = createSeededProject();
  const rows = compareLampRuns(project.runs[0], project.runs[1]);
  const unlock = rows.find((row) => row.name === '解锁执行');
  assert.ok(unlock);
  assert.ok(unlock.mismatches > 0);
  assert.equal(unlock.points.length, 11);
});

test('electrical signature ignores position but catches wiring changes', () => {
  const a = twoSwitchCircuit();
  const b = structuredClone(a);
  b.components[0].x += 50;
  assert.equal(electricalSignature(a), electricalSignature(b));

  const c = deleteConnection(a, a.connections[0].id);
  assert.notEqual(electricalSignature(a), electricalSignature(c));
});
