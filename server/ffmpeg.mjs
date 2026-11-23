import { FFPROBE, FFMPEG, run } from './util.mjs';

const num = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

export function parseRate(rate) {
  if (!rate) return 0;
  const [a, b] = String(rate).split('/').map(Number);
  if (!b) return a || 0;
  return a / b;
}

export async function probeMedia(file) {
  const { stdout } = await run(FFPROBE, [
    '-v', 'error', '-print_format', 'json',
    '-show_format', '-show_streams', file,
  ]);
  const info = JSON.parse(stdout.toString());
  const v = (info.streams || []).find((s) => s.codec_type === 'video');
  const a = (info.streams || []).find((s) => s.codec_type === 'audio');
  const duration = num(info.format?.duration, 0) ||
    num(v?.duration, 0) || num(a?.duration, 0);
  return {
    file,
    duration,
    hasVideo: Boolean(v),
    hasAudio: Boolean(a),
    video: v ? {
      width: num(v.width), height: num(v.height),
      fps: parseRate(v.avg_frame_rate) || parseRate(v.r_frame_rate),
      rFps: parseRate(v.r_frame_rate),
      codec: v.codec_name,
      frames: num(v.nb_frames),
      start: num(v.start_time),
      duration: num(v.duration, duration),
    } : null,
    audio: a ? {
      sampleRate: num(a.sample_rate, 48000),
      channels: num(a.channels, 2),
      codec: a.codec_name,
      duration: num(a.duration, duration),
      start: num(a.start_time),
    } : null,
    format: info.format?.format_name,
  };
}

export async function countFrames(file) {
  try {
    const { stdout } = await run(FFPROBE, [
      '-v', 'error', '-select_streams', 'v:0', '-count_frames',
      '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file,
    ]);
    return num(stdout.toString().trim(), 0);
  } catch {
    return 0;
  }
}

// 导出单帧 PNG：t 为源文件内的绝对时间。用精确 seek（-ss 在 -i 之后），
// 帧号与时间线计算一致，不会退到关键帧。
export async function extractFrame(file, t, outPath, { width, height } = {}) {
  const args = ['-v', 'error', '-i', file, '-ss', String(Math.max(0, t)), '-frames:v', '1'];
  if (width && height) {
    args.push('-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`);
  }
  args.push('-y', outPath);
  await run(FFMPEG, args);
  return outPath;
}

// 批量抽取缩略图：用于时间线胶片条。times 为源文件内的绝对时间。
export async function extractThumbs(file, times, { width = 160, height = 90 } = {}) {
  const results = [];
  for (const t of times) {
    const tmp = file + `.thumb-${Math.round(t * 1000)}.jpg`;
    try {
      await run(FFMPEG, [
        '-v', 'error', '-i', file, '-ss', String(Math.max(0, t)), '-frames:v', '1',
        '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`,
        '-q:v', '4', '-y', tmp,
      ]);
      results.push(tmp);
    } catch {
      results.push(null);
    }
  }
  return results;
}
