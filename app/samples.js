/** Load bundled sample pairs from public/samples/manifest.json. */
import { solveSimilarity } from '../src/core/alignment.js';
import { touchPair } from '../src/core/project.js';

const MANIFEST_URL = '/public/samples/manifest.json';

let cachedManifest = null;

export async function loadSampleManifest() {
  if (cachedManifest) return cachedManifest;
  const response = await fetch(MANIFEST_URL, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(
      `未能读取示例清单（${response.status}）。请先运行 npm run generate:samples`,
    );
  }
  const manifest = await response.json();
  if (!manifest?.scenes?.length) throw new Error('示例清单为空');
  cachedManifest = manifest;
  return manifest;
}

export async function fetchSampleBlob(file) {
  // Manifest entries are repo-relative ("samples/<id>/a.png"); the dev server
  // exposes the repo's public folder under /public.
  const path = file.startsWith('/') ? file : `/public/${file}`;
  const response = await fetch(path, { cache: 'force-cache' });
  if (!response.ok) throw new Error(`示例图片加载失败：${path}`);
  return response.blob();
}

/**
 * Import all sample scenes as pairs through the provided callbacks.
 * Corner points come pre-marked so the corner-fit flow can be tried straight
 * away; the recommended alignment is already applied.
 */
export async function importSamples({ store, withAlignment = true }) {
  const manifest = await loadSampleManifest();
  let created = 0;
  for (const scene of manifest.scenes) {
    const [blobA, blobB] = await Promise.all([
      fetchSampleBlob(scene.a.file),
      fetchSampleBlob(scene.b.file),
    ]);
    const imageA = await store.addImage(blobA, scene.a.name, { reuse: false });
    const imageB = await store.addImage(blobB, scene.b.name, { reuse: false });
    const alignment = withAlignment ? scene.recommendedAlignment : undefined;
    const pair = store.createPair({
      imageA,
      imageB,
      name: scene.title,
      versionA: scene.a.version,
      versionB: scene.b.version,
      alignment,
      alignmentMethod: withAlignment ? 'corners' : 'initial',
      notes: [
        `示例场景：${scene.description}`,
        '',
        '已知改动：',
        ...scene.changes.map((c, i) => `${i + 1}. ${c}`),
        '',
        `提示：四角已预置 ${scene.cornerPoints.length} 对配准标记点，切到「角点」工具可逐一核对；也可点「拟合对齐」重新用最小二乘求解。`,
      ].join('\n'),
    });
    if (withAlignment) {
      pair.cornerPoints = scene.cornerPoints.map((point) => ({ ...point }));
      // Derive the reported fit quality from the actual corner geometry rather
      // than claiming a perfect RMS.
      const fit = solveSimilarity(pair.cornerPoints);
      pair.cornerFit = {
        count: scene.cornerPoints.length,
        rms: fit.ok ? round(fit.rms, 3) : null,
        maxError: fit.ok ? round(fit.maxError, 3) : null,
        appliedAt: new Date().toISOString(),
      };
      touchPair(pair);
    }
    created += 1;
  }
  return { created, manifest };
}

function round(value, digits) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
