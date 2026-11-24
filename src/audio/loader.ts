/**
 * 加载 manifest 中声明的全部样本。
 * 坏样本（404 / 解码失败）只记入 failures，不影响其他键区发声。
 */
import type { LoadedSample, LoadResult, SampleFailure, SampleManifest } from '../types.ts';
import { zoneLabel } from './zones.ts';

async function fetchArrayBuffer(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  // dev 服务器对缺失文件可能回退 index.html（200 + text/html），需显式识别
  const type = res.headers.get('content-type') ?? '';
  if (type.includes('text/html')) throw new Error('HTTP 404（服务器回退到了 HTML 页面）');
  return res.arrayBuffer();
}

export async function loadSamples(
  manifestUrl: string,
  audioContext: BaseAudioContext,
): Promise<LoadResult> {
  const res = await fetch(manifestUrl);
  if (!res.ok) throw new Error(`manifest 加载失败：HTTP ${res.status}`);
  const manifest = (await res.json()) as SampleManifest;
  const baseUrl = new URL(manifestUrl, window.location.href);

  const samples: LoadedSample[] = [];
  const failures: SampleFailure[] = [];

  await Promise.all(
    manifest.samples.map(async (entry) => {
      const url = new URL(entry.file, baseUrl);
      const keyZone = zoneLabel(entry.root, entry.layer);
      try {
        const data = await fetchArrayBuffer(url.href);
        const buffer = await audioContext.decodeAudioData(data);
        const loopStart = entry.loopStart ?? 0;
        const loopEnd = entry.loopEnd ?? 0;
        if (entry.loopStart !== undefined && entry.loopEnd !== undefined) {
          if (
            loopStart < 0 ||
            loopEnd <= loopStart ||
            loopEnd > buffer.length
          ) {
            throw new Error(
              `循环点越界：loopStart=${loopStart}, loopEnd=${loopEnd}, length=${buffer.length}`,
            );
          }
        }
        samples.push({
          root: entry.root,
          layer: entry.layer,
          buffer,
          loopStart,
          loopEnd,
          get loopLength() {
            return this.loopEnd > this.loopStart ? this.loopEnd - this.loopStart : 0;
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const kind =
          message.startsWith('HTTP 404') || message.includes('404')
            ? 'missing'
            : message.startsWith('HTTP')
              ? 'decode-failed'
              : 'corrupt';
        failures.push({
          root: entry.root,
          layer: entry.layer,
          file: entry.file,
          kind,
          keyZone,
          message,
        });
      }
    }),
  );

  samples.sort((a, b) => a.root - b.root || a.layer.localeCompare(b.layer));
  failures.sort((a, b) => a.root - b.root || a.layer.localeCompare(b.layer));
  return { manifest, samples, failures };
}
