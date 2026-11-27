import test from 'node:test';
import assert from 'node:assert/strict';
import { createArmProject } from '../src/core/modelFactory.js';
import {
  buildSingleVertexFix,
  findDiagnostics,
  fixOnlyVertex,
  groupDiagnostics,
} from '../src/core/diagnostics.js';

test('generated rig contains locatable zero, invalid and far-weight cases', () => {
  const project = createArmProject();
  const diagnostics = findDiagnostics(project);
  const groups = groupDiagnostics(diagnostics);
  assert.ok(groups.zero.length >= 1, 'expected zero-weight diagnostic');
  assert.ok(groups.invalid.length >= 1, 'expected invalid-bone diagnostic');
  assert.ok(groups.far.length >= 1, 'expected far-influence diagnostic');

  for (const d of diagnostics) {
    assert.ok(Number.isInteger(d.vertexId));
    assert.ok(project.mesh.vertices[d.vertexId]);
  }
});

test('single-point repair changes only selected vertex and leaves adjusted neighbour intact', () => {
  let project = createArmProject();
  const targetId = project.mesh.namedVertices.qaInvalid;
  const neighborId = project.mesh.namedVertices.seamBadUpper;

  // Simulate an already adjusted/locked neighbour.
  project.mesh.vertices[neighborId].influences = [
    { bone: 1, weight: 0.2 },
    { bone: 2, weight: 0.8 },
  ];
  project.mesh.vertices[neighborId].locks = { 2: 0.8 };
  const neighborBefore = structuredClone(project.mesh.vertices[neighborId]);

  const beforeCount = findDiagnostics(project).length;
  const result = fixOnlyVertex(project, targetId);
  assert.equal(result.ok, true);
  assert.equal(result.fix.ok, true);
  project = result.project;

  const target = project.mesh.vertices[targetId];
  assert.equal(target.influences.some((inf) => Number(inf.bone) === 99), false);
  assert.ok(Math.abs(target.influences.reduce((s, inf) => s + inf.weight, 0) - 1) < 1e-6);

  assert.deepEqual(project.mesh.vertices[neighborId], neighborBefore);
  assert.equal(project.mesh.vertices[neighborId].locks[2], 0.8);
  assert.ok(findDiagnostics(project).length < beforeCount);
});

test('zero-weight fix binds nearest bone and produces normalized weights', () => {
  const project = createArmProject();
  const id = project.mesh.namedVertices.qaZero;
  const fix = buildSingleVertexFix(project, id);
  assert.equal(fix.ok, true);
  assert.ok(fix.influences.length >= 1);
  assert.ok(Math.abs(fix.influences.reduce((s, i) => s + i.weight, 0) - 1) < 1e-6);
});
