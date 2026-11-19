import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  GraphEvaluator,
  connect,
  createNode,
  findCycle,
  topoOrder,
  validateConnection,
  wouldCreateCycle,
} from '../src/core/graph.ts';
import { parseProject, serializeProject, ProjectValidationError } from '../src/core/project.ts';
import { defaultParams, getNodeDef, NODE_DEFS } from '../src/core/nodes.ts';
import { fbm2D, hash01 } from '../src/core/noise.ts';
import type { Project } from '../src/core/types.ts';

function project(nodes: ReturnType<typeof createNode>[], edges: Project['edges'] = []): Project {
  const output = nodes.find((node) => node.type === 'output');
  return {
    version: 1,
    name: 'test',
    nodes,
    edges,
    view: { x: 0, y: 0, zoom: 1 },
    preview: { resolution: 128, zoom: 0 },
    activeOutputId: output?.id ?? null,
  };
}

function solidOutput(color = '#e2574c') {
  const solid = createNode('solid', 0, 0);
  solid.params['color'] = color;
  const output = createNode('output', 300, 0);
  return project(
    [solid, output],
    [{ id: 'e1', from: { node: solid.id, port: 'color' }, to: { node: output.id, port: 'input' } }],
  );
}

test('noise is deterministic for the same seed and differs for another seed', () => {
  assert.equal(hash01(12, 34, 7), hash01(12, 34, 7));
  assert.notEqual(hash01(12, 34, 7), hash01(12, 34, 8));

  const a = fbm2D(0.3, 0.7, 99, 4, 0.5);
  const b = fbm2D(0.3, 0.7, 99, 4, 0.5);
  const c = fbm2D(0.3, 0.7, 100, 4, 0.5);
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.ok(a >= 0 && a <= 1);
});

test('node catalog covers the required generator types and typed ports', () => {
  const types = NODE_DEFS.map((def) => def.type);
  for (const required of ['solid', 'gradient', 'noise', 'transform', 'blend', 'output']) {
    assert.ok(types.includes(required), `missing node type ${required}`);
  }
  const blend = getNodeDef('blend');
  assert.deepEqual(
    blend.inputs.map((port) => [port.key, port.type]),
    [
      ['base', 'color'],
      ['blend', 'color'],
      ['mask', 'mask'],
    ],
  );
  const noise = getNodeDef('noise');
  assert.ok(noise.outputs.some((port) => port.type === 'mask'));
});

test('type-incompatible connections are rejected', () => {
  const noise = createNode('noise', 0, 0);
  const blend = createNode('blend', 300, 0);
  const p = project([noise, blend, createNode('output', 600, 0)]);

  const wrong = validateConnection(
    p,
    { node: noise.id, port: 'color' },
    { node: blend.id, port: 'mask' },
  );
  assert.equal(wrong.ok, false);

  const right = validateConnection(
    p,
    { node: noise.id, port: 'mask' },
    { node: blend.id, port: 'mask' },
  );
  assert.equal(right.ok, true);
});

test('cycles are rejected and detected in files', () => {
  const a = createNode('transform', 0, 0);
  const b = createNode('transform', 200, 0);
  const p = project([a, b, createNode('output', 500, 0)]);
  const first = connect(p, { node: a.id, port: 'color' }, { node: b.id, port: 'input' });
  assert.ok(first.ok);
  p.edges.push(first.edge!);

  const second = connect(p, { node: b.id, port: 'color' }, { node: a.id, port: 'input' });
  assert.equal(second.ok, false);
  assert.match(second.reason ?? '', /循环/);

  assert.equal(wouldCreateCycle(p, b.id, a.id), true);
  assert.equal(findCycle(p.nodes, p.edges), null);
  const cycleEdges = [
    ...p.edges,
    { id: 'loop', from: { node: b.id, port: 'color' }, to: { node: a.id, port: 'input' } },
  ];
  assert.notEqual(findCycle(p.nodes, cycleEdges), null);
  assert.equal(topoOrder({ ...p, edges: cycleEdges }).ok, false);
});

test('self connection and duplicate edges are rejected', () => {
  const n = createNode('transform', 0, 0);
  const p = project([n, createNode('output', 400, 0)]);
  const self = connect(p, { node: n.id, port: 'color' }, { node: n.id, port: 'input' });
  assert.equal(self.ok, false);

  const other = createNode('transform', 0, 300);
  const p2 = project([n, other, createNode('output', 400, 0)]);
  const ok = connect(p2, { node: n.id, port: 'color' }, { node: other.id, port: 'input' });
  assert.ok(ok.ok);
  p2.edges.push(ok.edge!);
  const dup = connect(p2, { node: n.id, port: 'color' }, { node: other.id, port: 'input' });
  assert.equal(dup.ok, false);
});

test('evaluator recomputes only affected nodes', () => {
  const noise = createNode('noise', 0, 0);
  const transform = createNode('transform', 200, 0);
  const output = createNode('output', 400, 0);
  const solid = createNode('solid', 0, 300);
  const p = project(
    [noise, transform, output, solid],
    [
      { id: 'e1', from: { node: noise.id, port: 'color' }, to: { node: transform.id, port: 'input' } },
      { id: 'e2', from: { node: transform.id, port: 'color' }, to: { node: output.id, port: 'input' } },
    ],
  );
  const evaluator = new GraphEvaluator();
  const first = evaluator.evaluate(p, { width: 16, height: 16 });
  assert.equal(first.computed.length, 4);
  assert.equal(first.errors.size, 0);

  // Unchanged graph -> everything reused.
  const second = evaluator.evaluate(p, { width: 16, height: 16 });
  assert.equal(second.computed.length, 0);
  assert.equal(second.reused.length, 4);

  // Change the transform only: noise and solid stay cached.
  transform.params = { ...transform.params, scaleX: 2 };
  const third = evaluator.evaluate(p, { width: 16, height: 16 });
  assert.deepEqual(third.computed.sort(), [transform.id, output.id].sort());
  assert.deepEqual(third.reused.sort(), [noise.id, solid.id].sort());

  // Change the noise seed: everything downstream recomputes, solid does not.
  noise.params = { ...noise.params, seed: 5 };
  const fourth = evaluator.evaluate(p, { width: 16, height: 16 });
  assert.deepEqual(fourth.computed.sort(), [noise.id, transform.id, output.id].sort());
  assert.deepEqual(fourth.reused, [solid.id]);
});

test('evaluation errors name the node and keep the last good output', () => {
  const noise = createNode('noise', 0, 0);
  const blend = createNode('blend', 200, 0);
  const output = createNode('output', 400, 0);
  const solid = createNode('solid', 0, 200);
  const p = project(
    [noise, blend, output, solid],
    [
      { id: 'e1', from: { node: solid.id, port: 'color' }, to: { node: blend.id, port: 'base' } },
      { id: 'e2', from: { node: noise.id, port: 'color' }, to: { node: blend.id, port: 'blend' } },
      { id: 'e3', from: { node: blend.id, port: 'color' }, to: { node: output.id, port: 'input' } },
    ],
  );
  const evaluator = new GraphEvaluator();
  const ok = evaluator.evaluate(p, { width: 8, height: 8 });
  const goodImage = ok.images.get(output.id);
  assert.ok(goodImage);

  // Disconnect the upper layer: blend must fail with a message about that node.
  p.edges = p.edges.filter((edge) => edge.id !== 'e2');
  const broken = evaluator.evaluate(p, { width: 8, height: 8 });
  assert.ok(broken.errors.has(blend.id));
  assert.match(broken.errors.get(blend.id) ?? '', /上层/);
  assert.equal(broken.errors.has(noise.id), false);
  // Output keeps its previously good image rather than becoming blank.
  assert.equal(broken.images.get(output.id), goodImage);
});

test('output preview resolution changes recompute the graph', () => {
  const p = solidOutput();
  const evaluator = new GraphEvaluator();
  const small = evaluator.evaluate(p, { width: 16, height: 16 });
  assert.equal(small.images.get(p.activeOutputId!)?.width, 16);
  const big = evaluator.evaluate(p, { width: 64, height: 64 });
  assert.equal(big.images.get(p.activeOutputId!)?.width, 64);
  assert.ok(big.computed.length > 0);
});

test('project round-trips node positions, edges, params and seeds', () => {
  const noise = createNode('noise', 12, 34);
  noise.params['seed'] = 123456;
  noise.params['scale'] = 7.5;
  const output = createNode('output', 400, 100);
  const p = project(
    [noise, output],
    [{ id: 'e1', from: { node: noise.id, port: 'color' }, to: { node: output.id, port: 'input' } }],
  );
  p.view = { x: -30, y: 22, zoom: 1.4 };
  p.preview = { resolution: 256, zoom: 2 };

  const json = serializeProject(p);
  const restored = parseProject(JSON.parse(json));
  assert.deepEqual(restored, p);

  // Same seed after reopening -> identical pixels.
  const a = new GraphEvaluator().evaluate(p, { width: 24, height: 24 });
  const b = new GraphEvaluator().evaluate(restored, { width: 24, height: 24 });
  assert.deepEqual(
    Array.from(a.images.get(p.activeOutputId!)!.data),
    Array.from(b.images.get(p.activeOutputId!)!.data),
  );
});

test('invalid project files are rejected without side effects', () => {
  const valid = JSON.parse(serializeProject(solidOutput()));
  const cases: unknown[] = [
    null,
    {},
    { ...valid, version: 99 },
    { ...valid, nodes: [] },
    { ...valid, nodes: 'nope' },
    { ...valid, nodes: [{ ...valid.nodes[0], type: 'nope' }] },
    { ...valid, nodes: [{ ...valid.nodes[0], params: { color: 'red' } }] },
    {
      ...valid,
      nodes: [{ ...valid.nodes[0], params: { ...defaultParams(getNodeDef('solid')), color: 'nothex' } }],
    },
    { ...valid, edges: [{ id: 'x', from: { node: 'missing', port: 'color' }, to: valid.edges[0].to }] },
    {
      ...valid,
      edges: [
        ...valid.edges,
        { id: 'x', from: valid.edges[0].from, to: { node: valid.nodes[0].id, port: 'input' } },
      ],
    },
    { ...valid, preview: { resolution: 999, zoom: 0 } },
  ];
  for (const candidate of cases) {
    assert.throws(() => parseProject(candidate), ProjectValidationError);
  }
});

test('a valid project with mixed edge types is rejected on parse', () => {
  const noise = createNode('noise', 0, 0);
  const blend = createNode('blend', 200, 0);
  const output = createNode('output', 400, 0);
  const p = solidOutput();
  p.nodes.push(noise, blend);
  // solid.color -> blend.mask is a type mismatch and must fail validation.
  p.edges.push({ id: 'bad', from: { node: noise.id, port: 'color' }, to: { node: blend.id, port: 'mask' } });
  p.edges.push({ id: 'bad2', from: { node: output.id, port: 'input' }, to: { node: output.id, port: 'input' } });
  assert.throws(() => parseProject(JSON.parse(serializeProject(p))), ProjectValidationError);
});
