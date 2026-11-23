/**
 * 导出后读回校验。
 *
 * 不只数轨道：语言标记、default 标记、时长、每条字幕轨的实际起止时间
 * 都从成品文件里重新读出来，再和导出计划逐项比对。
 * 任何一项对不上都写进 checks，整体 ok=false，前端会红色标出是哪条轨。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { probeMedia, runFfmpeg } from './ffmpeg.js';
import { parseSubtitles, subtitleDuration } from '../public/shared/subtitles.js';
import { languageTag } from '../public/shared/languages.js';
import { offsetFromTitle } from '../public/shared/alignment.js';

const TIME_TOLERANCE = 0.12;
const DURATION_TOLERANCE = 0.25;

function check(checks, id, label, ok, detail = null) {
  checks.push({ id, label, ok, detail });
  return ok;
}

export async function extractSubtitleStream(videoPath, streamIndex, outPath) {
  await runFfmpeg([
    '-hide_banner',
    '-nostdin',
    '-y',
    '-i',
    videoPath,
    '-map',
    `0:${streamIndex}`,
    '-c:s',
    'srt',
    '-f',
    'srt',
    outPath,
  ]);
}

/**
 * verifyOutput({outputPath, configPath, config, plan, expected})
 * expected: Map(trackId -> {cues, count, duration}) 由导出时生成。
 */
export async function verifyOutput({ outputPath, configPath, config, plan, expected }) {
  const checks = [];
  const issues = [];
  const probe = await probeMedia(outputPath);

  const expectedAudio = plan.audioTracks.filter((track) => track.enabled && track.supported);
  const expectedSubs = plan.subtitleTracks.filter((track) => track.enabled && track.supported);

  const audioStreams = probe.streams.filter((stream) => stream.codecType === 'audio');
  const subtitleStreams = probe.streams.filter((stream) => stream.codecType === 'subtitle');
  const videoStreams = probe.streams.filter((stream) => stream.codecType === 'video');
  check(checks, 'video-stream', '成品含 1 条视频流', videoStreams.length === 1, {
    actual: videoStreams.length,
  });

  check(
    checks,
    'audio-count',
    `音频轨数量为 ${expectedAudio.length}`,
    audioStreams.length === expectedAudio.length,
    { expected: expectedAudio.length, actual: audioStreams.length },
  );

  check(
    checks,
    'subtitle-count',
    `字幕轨数量为 ${expectedSubs.length}`,
    subtitleStreams.length === expectedSubs.length,
    { expected: expectedSubs.length, actual: subtitleStreams.length },
  );

  for (let i = 0; i < expectedAudio.length; i += 1) {
    const expectedTrack = expectedAudio[i];
    const stream = audioStreams[i];
    if (!stream) {
      issues.push({
        code: 'missing-audio',
        trackId: expectedTrack.id,
        trackName: expectedTrack.name,
        message: `缺少第 ${i + 1} 条音轨「${expectedTrack.name}」`,
      });
      continue;
    }
    const wantTag = languageTag(expectedTrack.language);
    const gotTag = stream.language || 'und';
    const languageOk = gotTag === wantTag;
    check(checks, `audio-${i}-language`, `音轨 ${i + 1}「${expectedTrack.name}」语言为 ${wantTag}`, languageOk, {
      expected: wantTag,
      actual: gotTag,
    });
    if (!languageOk) {
      issues.push({
        code: 'language-mismatch',
        trackId: expectedTrack.id,
        trackName: expectedTrack.name,
        kind: 'audio',
        message: `音轨「${expectedTrack.name}」语言应为 ${wantTag}，读回为 ${gotTag}`,
      });
    }

    const readOffset = offsetFromTitle(stream.title);
    const offsetOk =
      readOffset != null && Math.abs(readOffset - expectedTrack.offset) <= 0.0005;
    check(
      checks,
      `audio-${i}-offset`,
      `音轨 ${i + 1}「${expectedTrack.name}」偏移读回 ${expectedTrack.offset.toFixed(3)}s`,
      offsetOk,
      { expected: expectedTrack.offset, actual: readOffset },
    );
    if (!offsetOk) {
      issues.push({
        code: 'offset-mismatch',
        trackId: expectedTrack.id,
        trackName: expectedTrack.name,
        kind: 'audio',
        message: `音轨「${expectedTrack.name}」偏移应读回 ${expectedTrack.offset.toFixed(3)}s，实际 ${readOffset ?? '缺失'}`,
      });
    }
  }

  for (let i = 0; i < expectedSubs.length; i += 1) {
    const expectedTrack = expectedSubs[i];
    const stream = subtitleStreams[i];
    if (!stream) {
      issues.push({
        code: 'missing-subtitle',
        trackId: expectedTrack.id,
        trackName: expectedTrack.name,
        message: `缺少第 ${i + 1} 条字幕「${expectedTrack.name}」`,
      });
      continue;
    }
    const wantTag = languageTag(expectedTrack.language);
    const gotTag = stream.language || 'und';
    const languageOk = gotTag === wantTag;
    check(checks, `subtitle-${i}-language`, `字幕 ${i + 1}「${expectedTrack.name}」语言为 ${wantTag}`, languageOk, {
      expected: wantTag,
      actual: gotTag,
    });
    if (!languageOk) {
      issues.push({
        code: 'language-mismatch',
        trackId: expectedTrack.id,
        trackName: expectedTrack.name,
        kind: 'subtitle',
        message: `字幕「${expectedTrack.name}」语言应为 ${wantTag}，读回为 ${gotTag}`,
      });
    }

    const readOffset = offsetFromTitle(stream.title);
    const offsetOk =
      readOffset != null && Math.abs(readOffset - expectedTrack.offset) <= 0.0005;
    check(
      checks,
      `subtitle-${i}-offset`,
      `字幕 ${i + 1}「${expectedTrack.name}」偏移读回 ${expectedTrack.offset.toFixed(3)}s`,
      offsetOk,
      { expected: expectedTrack.offset, actual: readOffset },
    );
    if (!offsetOk) {
      issues.push({
        code: 'offset-mismatch',
        trackId: expectedTrack.id,
        trackName: expectedTrack.name,
        kind: 'subtitle',
        message: `字幕「${expectedTrack.name}」偏移应读回 ${expectedTrack.offset.toFixed(3)}s，实际 ${readOffset ?? '缺失'}`,
      });
    }
  }

  // default 标记
  const defaultAudio = audioStreams.filter((stream) => stream.disposition.default);
  const defaultSubs = subtitleStreams.filter((stream) => stream.disposition.default);
  check(checks, 'default-audio', '恰好 1 条默认音轨', defaultAudio.length === 1, {
    actual: defaultAudio.length,
  });
  check(checks, 'default-subtitle', '恰好 1 条默认字幕', defaultSubs.length === 1, {
    actual: defaultSubs.length,
  });

  if (defaultAudio.length === 1) {
    const wantedIndex = expectedAudio.findIndex((track) => track.default);
    const actualIndex = audioStreams.indexOf(defaultAudio[0]);
    const ok = wantedIndex === actualIndex;
    check(checks, 'default-audio-match', `默认音轨是「${expectedAudio[wantedIndex]?.name}」`, ok, {
      expected: wantedIndex,
      actual: actualIndex,
    });
    if (!ok) {
      issues.push({
        code: 'default-mismatch',
        trackId: expectedAudio[wantedIndex]?.id ?? null,
        kind: 'audio',
        message: `默认音轨应为「${expectedAudio[wantedIndex]?.name}」，读回是第 ${actualIndex + 1} 条`,
      });
    }
  }

  if (defaultSubs.length === 1) {
    const wantedIndex = expectedSubs.findIndex((track) => track.default);
    const actualIndex = subtitleStreams.indexOf(defaultSubs[0]);
    const ok = wantedIndex === actualIndex;
    check(checks, 'default-subtitle-match', `默认字幕是「${expectedSubs[wantedIndex]?.name}」`, ok, {
      expected: wantedIndex,
      actual: actualIndex,
    });
    if (!ok) {
      issues.push({
        code: 'default-mismatch',
        trackId: expectedSubs[wantedIndex]?.id ?? null,
        kind: 'subtitle',
        message: `默认字幕应为「${expectedSubs[wantedIndex]?.name}」，读回是第 ${actualIndex + 1} 条`,
      });
    }
  }

  // 成品总时长应等于视频时长
  const duration = probe.duration ?? null;
  const durationOk =
    duration != null && Math.abs(duration - plan.video.duration) <= Math.max(DURATION_TOLERANCE, plan.video.duration * 0.002);
  check(checks, 'duration', `成品时长与视频一致（${plan.video.duration.toFixed(2)}s）`, durationOk, {
    expected: plan.video.duration,
    actual: duration,
  });
  if (!durationOk) {
    issues.push({
      code: 'duration-mismatch',
      trackId: null,
      kind: 'video',
      message: `成品时长 ${duration ?? '未知'}s 与视频 ${plan.video.duration.toFixed(2)}s 不一致`,
    });
  }

  // 字幕实际时间轴：从成品里抽出来重新解析
  if (expected && subtitleStreams.length) {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'trackweave-verify-'));
    try {
      for (let i = 0; i < expectedSubs.length; i += 1) {
        const track = expectedSubs[i];
        const stream = subtitleStreams[i];
        if (!stream) continue;
        const expectedInfo = expected.get(track.id);
        if (!expectedInfo) continue;
        const srtPath = path.join(tempDir, `sub-${i}.srt`);
        try {
          await extractSubtitleStream(outputPath, stream.index, srtPath);
          const text = readFileSync(srtPath, 'utf8');
          const parsed = parseSubtitles(text, { fileName: 'x.srt', format: 'srt' });
          const firstActual = parsed.cues[0]?.start ?? null;
          const firstExpected = expectedInfo.cues[0]?.start ?? null;
          const lastActual = subtitleDuration(parsed.cues);
          const lastExpected = expectedInfo.duration;
          const countOk = parsed.cues.length === expectedInfo.count;
          const startOk =
            firstActual != null && firstExpected != null && Math.abs(firstActual - firstExpected) <= TIME_TOLERANCE;
          const endOk =
            Math.abs(lastActual - lastExpected) <= Math.max(TIME_TOLERANCE, 0.2);

          check(
            checks,
            `subtitle-${i}-timing`,
            `字幕 ${i + 1}「${track.name}」时间轴与计划一致（${expectedInfo.count} 条）`,
            countOk && startOk && endOk,
            {
              expected: { count: expectedInfo.count, first: firstExpected, last: lastExpected },
              actual: { count: parsed.cues.length, first: firstActual, last: lastActual },
            },
          );
          if (!(countOk && startOk && endOk)) {
            issues.push({
              code: 'subtitle-timing-mismatch',
              trackId: track.id,
              trackName: track.name,
              kind: 'subtitle',
              message: `字幕「${track.name}」读回时间轴与计划不符（期望 ${expectedInfo.count} 条 / ${firstExpected?.toFixed(2)}–${lastExpected?.toFixed(2)}s，实际 ${parsed.cues.length} 条 / ${firstActual?.toFixed(2)}–${lastActual?.toFixed(2)}s）`,
            });
          }
        } catch (error) {
          check(checks, `subtitle-${i}-timing`, `字幕 ${i + 1} 可读回`, false, { error: error.message });
          issues.push({
            code: 'subtitle-unreadable',
            trackId: track.id,
            trackName: track.name,
            kind: 'subtitle',
            message: `字幕「${track.name}」无法从成品读回：${error.message}`,
          });
        }
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  // 可编辑配置
  if (configPath) {
    try {
      const raw = readFileSync(configPath, 'utf8');
      const parsed = JSON.parse(raw);
      const configOk =
        parsed.format === 'trackweave-project' &&
        Array.isArray(parsed.audioTracks) &&
        Array.isArray(parsed.subtitleTracks) &&
        parsed.audioTracks.filter((track) => track.enabled).length === expectedAudio.length &&
        parsed.subtitleTracks.filter((track) => track.enabled).length === expectedSubs.length;
      check(checks, 'config', '轨道配置可读且启用轨数量一致', configOk, {
        path: configPath,
        audio: parsed.audioTracks?.filter((track) => track.enabled).length,
        subtitles: parsed.subtitleTracks?.filter((track) => track.enabled).length,
      });
      if (!configOk) {
        issues.push({
          code: 'config-mismatch',
          trackId: null,
          kind: 'config',
          message: '轨道配置文件内容与导出轨数不一致',
        });
      }
    } catch (error) {
      check(checks, 'config', '轨道配置可读', false, { error: error.message });
      issues.push({
        code: 'config-unreadable',
        trackId: null,
        kind: 'config',
        message: `轨道配置无法解析：${error.message}`,
      });
    }
  }

  // 偏移记录在配置里（容器元数据只存显示名），这里再核对一遍
  if (config?.output) {
    for (const track of config.output.audio || []) {
      const source = expectedAudio.find((item) => item.id === track.id);
      if (!source) continue;
      const ok = Math.abs(source.offset - track.offset) < 1e-6;
      check(checks, `offset-audio-${track.id}`, `音轨「${track.name}」偏移已写入配置`, ok, {
        expected: source.offset,
        actual: track.offset,
      });
    }
    for (const track of config.output.subtitles || []) {
      const source = expectedSubs.find((item) => item.id === track.id);
      if (!source) continue;
      const ok = Math.abs(source.offset - track.offset) < 1e-6;
      check(checks, `offset-subtitle-${track.id}`, `字幕「${track.name}」偏移已写入配置`, ok, {
        expected: source.offset,
        actual: track.offset,
      });
    }
  }

  const failed = checks.filter((item) => !item.ok);
  return {
    ok: failed.length === 0,
    checks,
    failedChecks: failed,
    issues,
    readBack: {
      format: probe.formatName,
      duration,
      videoStreams: videoStreams.length,
      audioTracks: audioStreams.map((stream, i) => ({
        index: i,
        language: stream.language || 'und',
        title: stream.title || '',
        codec: stream.codecName,
        channels: stream.channels,
        default: stream.disposition.default,
        expectedName: expectedAudio[i]?.name ?? null,
      })),
      subtitleTracks: subtitleStreams.map((stream, i) => ({
        index: i,
        language: stream.language || 'und',
        title: stream.title || '',
        codec: stream.codecName,
        default: stream.disposition.default,
        expectedName: expectedSubs[i]?.name ?? null,
      })),
      defaultAudioIndex: defaultAudio.length === 1 ? audioStreams.indexOf(defaultAudio[0]) : null,
      defaultSubtitleIndex: defaultSubs.length === 1 ? subtitleStreams.indexOf(defaultSubs[0]) : null,
    },
  };
}
