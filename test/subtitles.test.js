import test from 'node:test';
import assert from 'node:assert/strict';

import {
  analyzeSubtitleText,
  detectSubtitleFormat,
  parseSubtitles,
  parseTimestamp,
  formatSubtitleTime,
  serializeSrt,
  shiftAndClipCues,
  activeCues,
} from '../public/shared/subtitles.js';

const SRT = `1
00:00:01,000 --> 00:00:03,500
第一句

2
00:00:04,000 --> 00:00:06,000
第二句
`;

const VTT = `WEBVTT

00:00:01.000 --> 00:00:03.500 align:start
First line
second line

00:00:04.000 --> 00:00:06.000
Second cue
`;

const ASS = `[Script Info]
Title: test

[V4+ Styles]
Format: Name, Fontname
Style: Default,Arial

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,{\\b1}第一句{\\b0}
Dialogue: 0,0:00:04.00,0:00:06.00,Default,,0,0,0,,第二句\\N换行
`;

test('parseTimestamp 支持逗号、点和省略小时', () => {
  assert.equal(parseTimestamp('00:00:01,500'), 1.5);
  assert.equal(parseTimestamp('00:00:01.500'), 1.5);
  assert.equal(parseTimestamp('1:02.250'), 62.25);
  assert.equal(parseTimestamp('2:00:00.000'), 7200);
  assert.equal(parseTimestamp('bad'), null);
});

test('formatSubtitleTime 四舍五入到毫秒且不进位到 1000', () => {
  assert.equal(formatSubtitleTime(1.5), '00:00:01,500');
  assert.equal(formatSubtitleTime(59.9999), '00:01:00,000');
  assert.equal(formatSubtitleTime(-1), '00:00:00,000');
});

test('detectSubtitleFormat 依据扩展名与内容', () => {
  assert.equal(detectSubtitleFormat('a.srt', SRT), 'srt');
  assert.equal(detectSubtitleFormat('a.txt', VTT), 'vtt');
  assert.equal(detectSubtitleFormat('a.ass', ASS), 'ass');
  assert.equal(detectSubtitleFormat('a.txt', 'plain text'), null);
});

test('SRT 解析出两条字幕并清理空行', () => {
  const parsed = parseSubtitles(SRT, { fileName: 'a.srt' });
  assert.equal(parsed.format, 'srt');
  assert.equal(parsed.cues.length, 2);
  assert.equal(parsed.cues[0].text, '第一句');
  assert.equal(parsed.cues[1].start, 4);
});

test('VTT 解析多行字幕并去掉行内标签', () => {
  const parsed = parseSubtitles(VTT, { fileName: 'a.vtt' });
  assert.equal(parsed.format, 'vtt');
  assert.equal(parsed.cues.length, 2);
  assert.equal(parsed.cues[0].text, 'First line\nsecond line');
});

test('ASS 解析 Dialogue 并剥离样式标签', () => {
  const parsed = parseSubtitles(ASS, { fileName: 'a.ass' });
  assert.equal(parsed.format, 'ass');
  assert.equal(parsed.cues.length, 2);
  assert.equal(parsed.cues[0].text, '第一句');
  assert.equal(parsed.cues[1].text, '第二句\n换行');
  assert.equal(parsed.styleLost, true);
});

test('无字幕条目时抛 no-cues', () => {
  assert.throws(
    () => parseSubtitles('nothing here', { fileName: 'a.srt' }),
    (error) => error.code === 'no-cues',
  );
});

test('shiftAndClipCues 正偏移后移并裁掉视频尾部', () => {
  const parsed = parseSubtitles(SRT, { fileName: 'a.srt' });
  const { cues, warnings, summary } = shiftAndClipCues(parsed.cues, {
    offset: 1,
    videoDuration: 6,
  });
  assert.equal(cues[0].start, 2);
  assert.equal(cues[0].end, 4.5);
  assert.equal(cues[1].start, 5);
  assert.equal(cues[1].end, 6);
  assert.equal(summary.clippedTail, 1);
  assert.ok(warnings.some((warning) => warning.code === 'cue-clipped-tail'));
});

test('shiftAndClipCues 负偏移裁掉视频开头之前的字幕', () => {
  const parsed = parseSubtitles(SRT, { fileName: 'a.srt' });
  const { cues, warnings, summary } = shiftAndClipCues(parsed.cues, {
    offset: -2,
    videoDuration: 10,
  });
  assert.equal(cues.length, 2);
  assert.equal(cues[0].start, 0);
  assert.equal(cues[0].end, 1.5);
  assert.equal(cues[0].clippedHead, true);
  assert.equal(summary.clippedHead, 1);
  assert.ok(warnings.some((warning) => warning.code === 'cue-clipped-head'));
});

test('shiftAndClipCues 丢弃完全落在视频外的字幕', () => {
  const parsed = parseSubtitles(SRT, { fileName: 'a.srt' });
  const { cues, summary } = shiftAndClipCues(parsed.cues, { offset: 100, videoDuration: 10 });
  assert.equal(cues.length, 0);
  assert.equal(summary.droppedAfter, 2);
});

test('activeCues 使用左闭右开区间', () => {
  const cues = [
    { start: 1, end: 2, text: 'a' },
    { start: 2, end: 3, text: 'b' },
  ];
  assert.deepEqual(activeCues(cues, 1).map((cue) => cue.text), ['a']);
  assert.deepEqual(activeCues(cues, 2).map((cue) => cue.text), ['b']);
  assert.deepEqual(activeCues(cues, 3), []);
});

test('serializeSrt 输出可被重新解析', () => {
  const parsed = parseSubtitles(SRT, { fileName: 'a.srt' });
  const shifted = shiftAndClipCues(parsed.cues, { offset: 0.5, videoDuration: 20 });
  const text = serializeSrt(shifted.cues);
  const reparsed = parseSubtitles(text, { fileName: 'x.srt' });
  assert.equal(reparsed.cues.length, 2);
  assert.equal(reparsed.cues[0].start, 1.5);
});

test('analyzeSubtitleText 一站式返回裁剪后的条目', () => {
  const result = analyzeSubtitleText(SRT, {
    fileName: 'a.srt',
    offset: -1,
    videoDuration: 5,
  });
  assert.equal(result.cues.length, 2);
  assert.equal(result.cues[0].start, 0);
  assert.equal(result.cues[0].end, 2.5);
  assert.equal(result.cues[1].end, 5);
  assert.equal(result.format, 'srt');
});
