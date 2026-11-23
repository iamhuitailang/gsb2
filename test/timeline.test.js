import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveAudioTimeline,
  resolveSubtitleTimeline,
  videoTimeToSourceTime,
  formatSigned,
  summarizeWarnings,
} from '../public/shared/timeline.js';
import { buildAudioFilter } from '../public/shared/alignment.js';

const near = (actual, expected, tolerance = 0.001) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} ≉ ${expected}`);

test('正偏移：开头补静音，结尾不变', () => {
  const timeline = resolveAudioTimeline({ offset: 2, sourceDuration: 10, videoDuration: 15 });
  near(timeline.headSilence, 2);
  near(timeline.headTrim, 0);
  near(timeline.tailSilence, 3);
  near(timeline.effectiveStart, 2);
  near(timeline.effectiveEnd, 12);
  near(timeline.effectiveDuration, 10);
  assert.ok(timeline.warnings.some((warning) => warning.code === 'late-start'));
  assert.ok(timeline.warnings.some((warning) => warning.code === 'early-end'));
});

test('负偏移：裁掉源开头', () => {
  const timeline = resolveAudioTimeline({ offset: -2, sourceDuration: 10, videoDuration: 8 });
  near(timeline.headTrim, 2);
  near(timeline.headSilence, 0);
  near(timeline.effectiveStart, 0);
  near(timeline.effectiveEnd, 8);
  near(timeline.overflow, 0);
  assert.ok(timeline.warnings.some((warning) => warning.code === 'trimmed-head'));
});

test('超出视频末尾：给出 overflow 与截断提醒', () => {
  const timeline = resolveAudioTimeline({ offset: 0, sourceDuration: 30, videoDuration: 26 });
  near(timeline.overflow, 4);
  near(timeline.effectiveEnd, 26);
  near(timeline.effectiveDuration, 26);
  const warning = timeline.warnings.find((item) => item.code === 'overflow-tail');
  assert.ok(warning);
  assert.equal(warning.severity, 'warning');
});

test('完全落在视频外：标记 fullyOutside 与错误提醒', () => {
  const timeline = resolveAudioTimeline({ offset: 100, sourceDuration: 5, videoDuration: 26 });
  assert.equal(timeline.fullyOutside, true);
  assert.ok(timeline.warnings.some((warning) => warning.severity === 'error'));
});

test('源比视频短且无偏移：末尾补静音', () => {
  const timeline = resolveAudioTimeline({ offset: 0, sourceDuration: 10, videoDuration: 26 });
  near(timeline.tailSilence, 16);
  near(timeline.overflow, 0);
});

test('videoTimeToSourceTime 与偏移互逆，越界返回 null', () => {
  const timeline = resolveAudioTimeline({ offset: 1.5, sourceDuration: 10, videoDuration: 20 });
  near(videoTimeToSourceTime(1.5, timeline), 0);
  near(videoTimeToSourceTime(5, timeline), 3.5);
  assert.equal(videoTimeToSourceTime(0.5, timeline), null);
  assert.equal(videoTimeToSourceTime(12, timeline), null);
});

test('resolveSubtitleTimeline 按同一规则平移并给出首末时间', () => {
  const cues = [
    { start: 1, end: 3, text: 'a' },
    { start: 5, end: 7, text: 'b' },
  ];
  const timeline = resolveSubtitleTimeline({ offset: 1, cues, videoDuration: 10 });
  near(timeline.effectiveStart, 2);
  near(timeline.effectiveEnd, 8);
  assert.equal(timeline.cueCount, 2);
  assert.ok(timeline.warnings.some((warning) => warning.code === 'early-end'));
});

test('resolveSubtitleTimeline 把超出视频的字幕裁到末尾', () => {
  const cues = [{ start: 4, end: 8, text: 'a' }];
  const timeline = resolveSubtitleTimeline({ offset: 0, cues, videoDuration: 5 });
  assert.equal(timeline.cues[0].end, 5);
  assert.equal(timeline.droppedCueCount, 0);
});

test('buildAudioFilter 对正偏移使用 adelay、负偏移使用 atrim', () => {
  const positive = buildAudioFilter({ offset: 1.25, videoDuration: 26, inputLabel: '[1:a]', outputLabel: '[out]' });
  assert.match(positive, /adelay=1250:all=1/);
  assert.doesNotMatch(positive, /atrim=start=/);
  assert.match(positive, /atrim=0:26/);

  const negative = buildAudioFilter({ offset: -0.8, videoDuration: 26, inputLabel: '[1:a]', outputLabel: '[out]' });
  assert.match(negative, /atrim=start=0.8/);
  assert.doesNotMatch(negative, /adelay/);
  assert.match(negative, /apad/);
});

test('formatSigned 与 summarizeWarnings', () => {
  assert.equal(formatSigned(1.2), '+1.20s');
  assert.equal(formatSigned(-1.2), '−1.20s');
  assert.equal(formatSigned(0), '0.00s');
  const counts = summarizeWarnings([
    { severity: 'error' },
    { severity: 'warning' },
    { severity: 'warning' },
    {},
  ]);
  assert.deepEqual(counts, { info: 1, warning: 2, error: 1 });
});
