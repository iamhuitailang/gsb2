#!/usr/bin/env node
/**
 * Direct command-line reproduction for the coincident elbow seam sample.
 * Run: npm run sample
 */
import { createSeamReproProject } from '../src/core/modelFactory.js';
import { deformProject, evaluateVertex } from '../src/core/skinning.js';

const project = createSeamReproProject();
const pose = 'strong';

console.log('Pose:', project.meta.poses[pose].label);
for (const id of [0, 1, 2]) {
  const result = evaluateVertex(project, id, pose);
  console.log(`\n${id === 0 ? 'A (bad forearm pull)' : id === 1 ? 'B (reference upper)' : 'neighbour'} V${String(id).padStart(3, '0')}`);
  console.log('  rest :', result.rest.map((n) => n.toFixed(4)).join(', '));
  console.log('  posed:', result.posed.map((n) => n.toFixed(4)).join(', '));
  console.log('  delta:', result.delta.map((n) => n.toFixed(4)).join(', '), ` length=${result.distance.toFixed(4)}`);
}

const deformed = deformProject(project, pose);
const dx = deformed.positions[0] - deformed.positions[3];
const dy = deformed.positions[1] - deformed.positions[4];
const dz = deformed.positions[2] - deformed.positions[5];
const seamDistance = Math.hypot(dx, dy, dz);

console.log('\nCoincident A/B seam separation after bend:', seamDistance.toFixed(4));
if (seamDistance < 0.05) {
  console.error('Expected a visible seam split, but the sample did not reproduce it.');
  process.exit(1);
}
console.log('OK: the two independent coincident vertices separate, reproducing the seam issue.');
