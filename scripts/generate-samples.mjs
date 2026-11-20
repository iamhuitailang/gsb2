// @ts-check
// Generates checked-in example project files from the sample builders.
// Runs after `npm run build` so it can reuse the compiled modules in dist/.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PathSpline } from '../dist/core/curve.js';
import { Timeline } from '../dist/core/timeline.js';
import { normalizeProject } from '../dist/core/project.js';
import { SAMPLES } from '../dist/samples/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'public', 'samples');

function summarize(project) {
  const spline = new PathSpline(project.path.points.map((p) => p.position), project.path.closed);
  const timeline = new Timeline(project.timeline, spline.totalLength, project.path.closed);
  return {
    name: project.name,
    points: project.path.points.length,
    closed: project.path.closed,
    length: Number(spline.totalLength.toFixed(2)),
    duration: Number(timeline.duration.toFixed(2)),
    keys: project.timeline.keys.length,
    objects: project.objects.length,
  };
}

async function main() {
  await fs.mkdir(outDir, { recursive: true });
  for (const sample of SAMPLES) {
    const project = normalizeProject(sample.build());
    const file = {
      format: 'camera-path-editor-project',
      formatVersion: 1,
      savedAt: '2026-01-01T00:00:00.000Z',
      project,
    };
    const json = JSON.stringify(file, null, 2);
    const fileName = `${sample.id}.camera.json`;
    await fs.writeFile(path.join(outDir, fileName), json, 'utf8');
    console.log(fileName, JSON.stringify(summarize(project)));
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
