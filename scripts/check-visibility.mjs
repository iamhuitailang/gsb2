import { buildScene } from '../src/scene.js';
import { computeVisibility, getDrawList, summarizeDrawList } from '../src/visibility.js';
import { PRESETS, presetCamera } from '../src/presets.js';

const scene = buildScene();
const aspect = Number(process.argv[2] || 1.25);
let failures = 0;

for (const preset of PRESETS) {
  const camera = presetCamera(preset);
  const doorOpen = preset.doors();
  const vis = computeVisibility(scene, camera, { aspect, doorOpen });
  const list = getDrawList(scene, 'partition', vis);
  const stats = summarizeDrawList(list);
  const fullStats = summarizeDrawList(scene.meshes);

  console.log(`\n[${preset.id}] ${preset.name}`);
  console.log(`  pos=${camera.position.map((v) => v.toFixed(2)).join(',')} yaw=${camera.yaw.toFixed(2)} rooms=${vis.cameraRoomIds.join('+')} visible=${vis.visibleRoomIds.join(',')}`);
  console.log(`  partition=${stats.meshes} meshes / ${stats.propCount} props; full=${fullStats.meshes} / ${fullStats.propCount}`);

  const interesting = vis.evaluations
    .filter((e) => e.status !== 'cycle')
    .sort((a, b) => a.seq - b.seq);
  for (const e of interesting) {
    const extra = e.projection?.rect ? ` rect=[${e.projection.rect.x0},${e.projection.rect.x1}] d=${e.projection.minEndpointDistance ?? ''}` : '';
    console.log(`   ${e.status.padEnd(9)} ${e.path.join('>')} --${e.portalShort}--> ${e.toRoom}${extra}`);
  }

  for (const expected of preset.expect || []) {
    let ok = false;
    if (expected.status === 'root') ok = vis.cameraRoomIds.includes(expected.roomId);
    else if (expected.status === 'visible') ok = vis.visibleRoomIds.includes(expected.roomId);
    else if (expected.status === 'hidden') ok = !vis.visibleRoomIds.includes(expected.roomId);
    else {
      ok = vis.evaluations.some((e) => e.portalId === expected.portalId && e.status === expected.status);
    }
    if (!ok) {
      failures++;
      console.error(`  ✗ expectation failed: ${JSON.stringify(expected)}`);
    } else {
      console.log(`  ✓ ${JSON.stringify(expected)}`);
    }
  }
}

console.log(`\nScene: ${scene.meshes.length} meshes, ${scene.propIds.length} props, ${scene.colliders.length} colliders, ${scene.wallSegments.length} wall segments`);
if (failures) {
  console.error(`${failures} expectation(s) failed at aspect ${aspect}`);
  process.exit(1);
}
console.log(`All preset expectations passed at aspect ${aspect}`);
