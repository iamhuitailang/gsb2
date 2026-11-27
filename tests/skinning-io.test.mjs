import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createArmProject, createSeamReproProject } from '../src/core/modelFactory.js';
import { deformProject, evaluateVertex } from '../src/core/skinning.js';
import { compareCapsAtPoses } from '../src/core/compare.js';
import { parseProject, serializeProject, verifyRoundtrip } from '../src/core/io.js';

test('rest pose leaves every vertex at its rest position', () => {
  const project = createArmProject();
  const deformed = deformProject(project, 'rest');
  let max = 0;
  for (let i = 0; i < project.mesh.restPositions.length; i += 1) {
    const p = project.mesh.restPositions[i];
    max = Math.max(
      max,
      Math.abs(deformed.positions[i * 3] - p[0]),
      Math.abs(deformed.positions[i * 3 + 1] - p[1]),
      Math.abs(deformed.positions[i * 3 + 2] - p[2]),
    );
  }
  assert.ok(max < 1e-8);
});

test('seam sample has coincident rest points that separate in strong bend', () => {
  const project = createSeamReproProject();
  const restA = evaluateVertex(project, 0, 'rest');
  const restB = evaluateVertex(project, 1, 'rest');
  assert.deepEqual(restA.rest.map((n) => n.toFixed(6)), restB.rest.map((n) => n.toFixed(6)));

  const aStrong = evaluateVertex(project, 0, 'strong');
  const bStrong = evaluateVertex(project, 1, 'strong');
  assert.ok(aStrong.distance > 0.1);
  assert.ok(bStrong.distance < aStrong.distance);

  const deformed = deformProject(project, 'strong');
  const separation = Math.hypot(
    deformed.positions[0] - deformed.positions[3],
    deformed.positions[1] - deformed.positions[4],
    deformed.positions[2] - deformed.positions[5],
  );
  assert.ok(separation > 0.12, `expected visible seam split, got ${separation}`);
});

test('cap two and cap four produce measurable differences in bent poses', () => {
  const project = createArmProject();
  const cmp = compareCapsAtPoses(project, ['rest', 'slight', 'strong']);
  assert.ok(cmp.poses.strong.cap2VsCap4.max > 0.001);
  assert.ok(cmp.poses.strong.cap2VsCap4.max >= cmp.poses.rest.cap2VsCap4.max);

  const tieReport = cmp.cap2.reports.get(project.mesh.namedVertices.tieBoundary);
  assert.ok(tieReport.discarded.length >= 1 || tieReport.tieGroup.length > 1);
});

test('exported JSON reads back and matches rest plus representative bends', () => {
  const project = createArmProject();
  const json = serializeProject(project);
  const restored = parseProject(json);
  assert.equal(restored.mesh.vertices.length, project.mesh.vertices.length);
  assert.equal(restored.skeleton.length, project.skeleton.length);

  const result = verifyRoundtrip(project);
  assert.equal(result.ok, true);
  assert.ok(result.rest.max < 1e-8);
  assert.ok(result.strong.max < 1e-7);
});

test('shipped seam-repro JSON imports and still reproduces the split', () => {
  const json = fs.readFileSync(new URL('../examples/seam-repro.json', import.meta.url), 'utf8');
  const project = parseProject(json);
  const result = verifyRoundtrip(project);
  assert.equal(result.ok, true);

  const deformed = deformProject(project, 'strong');
  const separation = Math.hypot(
    deformed.positions[0] - deformed.positions[3],
    deformed.positions[1] - deformed.positions[4],
    deformed.positions[2] - deformed.positions[5],
  );
  assert.ok(separation > 0.12);
});
