// 同步导出：用 OfflineAudioContext 逐段调度源缓冲，
// 每段按锚点（或 offset+漂移）映射设置 playbackRate，实现连续的时间校正。
import { sourceTimeFromAnchors, sourceTimeSimple } from './dsp.js';
import { encodeWav } from './audio.js';
import { buildZip } from './zip.js';

const SEG_SEC = 2.0;

function mapSource(track, pSec) {
  if (track.anchors && track.anchors.length > 0) return sourceTimeFromAnchors(pSec, track.anchors);
  return sourceTimeSimple(pSec, track.offsetSec || 0, track.driftPpm || 0);
}

async function renderTrack(track, projectDuration, targetRate, applyGain) {
  const src = track.buffer;
  const ch = src.numberOfChannels;
  const totalFrames = Math.ceil(projectDuration * targetRate);
  const off = new OfflineAudioContext(ch, totalFrames, targetRate);
  const gain = off.createGain();
  gain.gain.value = applyGain && track.gainDb !== undefined ? 10 ** (track.gainDb / 20) : 1;
  gain.connect(off.destination);

  let p = 0;
  while (p < projectDuration) {
    const pDur = Math.min(SEG_SEC, projectDuration - p);
    const s0 = mapSource(track, p);
    const s1 = mapSource(track, p + pDur);
    const srcDur = s1 - s0;
    if (srcDur > 0 && s0 < src.duration && s0 + srcDur > 0) {
      const node = off.createBufferSource();
      node.buffer = src;
      node.connect(gain);
      const rate = Math.max(0.0625, Math.min(16, srcDur / pDur));
      let when = p;
      let start = s0;
      let dur = pDur;
      if (s0 < 0) {
        const skip = -s0 / rate;
        when += skip;
        dur -= skip;
        start = 0;
      }
      if (start + dur * rate > src.duration) {
        dur = (src.duration - start) / rate;
      }
      if (dur > 0) node.start(when, start, dur);
    }
    p += pDur;
  }
  return off.startRendering();
}

function safeName(name) {
  return name.replace(/[\\/:*?"<>|\s]+/g, '_').replace(/\.wav$/i, '');
}

function buildManifest(tracks, projectDuration, sampleRate) {
  const rows = tracks.map((t, i) => {
    const row = {
      index: i,
      trackId: t.id,
      fileName: t.name,
      mode: t.anchors && t.anchors.length > 0 ? 'anchors' : 'offset+drift',
      offsetSecAtZero: mapSource(t, 0),
      offsetMsAtZero: +(mapSource(t, 0) * 1000).toFixed(3),
      driftPpm: t.anchors && t.anchors.length > 0 ? null : (t.driftPpm || 0),
      gainDb: t.gainDb || 0,
      anchors: (t.anchors || []).map((a) => ({
        projectSec: +a.projectSec.toFixed(6),
        sourceSec: +a.sourceSec.toFixed(6),
        localOffsetMs: +((a.sourceSec - a.projectSec) * 1000).toFixed(3),
      })),
    };
    return row;
  });
  return {
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    projectDurationSec: +projectDuration.toFixed(6),
    sampleRate,
    convention: 'sourceSec = map(projectSec)；正值表示该设备录制内容晚于参考时间轴',
    tracks: rows,
  };
}

function toCsv(manifest) {
  const lines = [
    'index,trackId,fileName,mode,offsetSecAtZero,offsetMsAtZero,driftPpm,gainDb,anchorCount',
  ];
  for (const t of manifest.tracks) {
    lines.push([
      t.index, t.trackId, `"${t.fileName.replace(/"/g, '""')}"`, t.mode,
      t.offsetSecAtZero.toFixed(6), t.offsetMsAtZero.toFixed(3),
      t.driftPpm === null ? '' : t.driftPpm.toFixed(3),
      t.gainDb.toFixed(2), t.anchors.length,
    ].join(','));
  }
  for (const t of manifest.tracks) {
    for (const a of t.anchors) {
      lines.push(`# anchor track=${t.trackId} projectSec=${a.projectSec} sourceSec=${a.sourceSec} localOffsetMs=${a.localOffsetMs}`);
    }
  }
  return lines.join('\n');
}

// options: { sampleRate, skipMuted, applyGain, asZip }
export async function exportAligned(tracks, projectDuration, options, downloadBlob) {
  const sr = options.sampleRate;
  const manifest = buildManifest(tracks, projectDuration, sr);
  const files = [];
  for (const t of tracks) {
    if (options.skipMuted && t.muted) continue;
    const rendered = await renderTrack(t, projectDuration, sr, options.applyGain);
    const wav = await encodeWav(rendered);
    files.push({
      name: `aligned_${String(t.index + 1).padStart(2, '0')}_${safeName(t.name)}.wav`,
      data: new Uint8Array(await wav.arrayBuffer()),
    });
  }
  const jsonName = 'offsets.json';
  const csvName = 'offsets.csv';
  files.push({ name: jsonName, data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)) });
  files.push({ name: csvName, data: new TextEncoder().encode(toCsv(manifest)) });

  if (options.asZip) {
    const zip = buildZip(files);
    downloadBlob(zip, 'aligned_export.zip');
  } else {
    for (const f of files) {
      const type = f.name.endsWith('.wav') ? 'audio/wav'
        : f.name.endsWith('.json') ? 'application/json' : 'text/csv';
      downloadBlob(new Blob([f.data], { type }), f.name);
    }
  }
  return manifest;
}
