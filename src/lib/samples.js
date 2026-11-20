/**
 * Bundled samples.
 *
 * The sample photographs live in `samples/` as ordinary local files with a
 * manifest (`npm run generate:samples`). They are loaded over HTTP like any
 * user import, so the demo exercises the real decode → orient → adjust →
 * export path.
 *
 * Sample references are also re-resolvable: reopening a project that used the
 * bundled samples silently re-attaches them instead of asking the user to
 * re-link, which keeps the demo's "reopen and continue" flow intact.
 */

export const SAMPLE_MANIFEST_URL = './samples/manifest.json';
const SAMPLE_EPOCH = 1700000000000;

let manifestPromise = null;

function fileFromBlob(blob, name, type) {
  if (typeof File === 'function') {
    return new File([blob], name, { type, lastModified: SAMPLE_EPOCH });
  }
  const fallback = blob.slice(0, blob.size, type);
  fallback.name = name;
  fallback.lastModified = SAMPLE_EPOCH;
  return fallback;
}

export function loadSampleManifest() {
  if (!manifestPromise) {
    manifestPromise = (async () => {
      const response = await fetch(SAMPLE_MANIFEST_URL, { cache: 'no-store' });
      if (!response.ok) {
        throw new Error(`样例清单不可用（HTTP ${response.status}）。请先运行 npm run generate:samples。`);
      }
      const manifest = await response.json();
      if (!Array.isArray(manifest)) throw new Error('样例清单格式无效。');
      return manifest;
    })().catch((error) => {
      manifestPromise = null;
      throw error;
    });
  }
  return manifestPromise;
}

async function fetchSample(entry) {
  const response = await fetch(`./samples/${encodeURIComponent(entry.file)}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`无法读取样例 ${entry.file}（HTTP ${response.status}）。`);
  const blob = await response.blob();
  const type = blob.type || (entry.format === 'png' ? 'image/png' : 'image/jpeg');
  return { file: fileFromBlob(blob, entry.file, type), handle: null, sample: entry };
}

export async function loadAllSamples() {
  const manifest = await loadSampleManifest();
  const files = [];
  for (const entry of manifest) files.push(await fetchSample(entry));
  return files;
}

/**
 * Match project image records against bundled samples by file name + size.
 * Returns Map<imageId, {file, handle}> for confirmed matches only.
 */
export async function resolveBundledSamples(images) {
  const matches = new Map();
  let manifest;
  try {
    manifest = await loadSampleManifest();
  } catch {
    return matches;
  }
  const byName = new Map(manifest.map((entry) => [entry.file, entry]));
  for (const image of images) {
    const ref = image.fileRef || {};
    const entry = byName.get(ref.name);
    if (!entry) continue;
    if (Number.isFinite(ref.size) && ref.size > 0 && entry.bytes !== ref.size) continue;
    try {
      const fetched = await fetchSample(entry);
      matches.set(image.id, fetched);
    } catch {
      // Sample missing on disk: fall through to the manual re-link flow.
    }
  }
  return matches;
}
