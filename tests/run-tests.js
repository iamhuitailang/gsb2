/*
 * Node 环境下的纯逻辑测试：解析容错、SRT/VTT 往返、特殊字符、帧率换算无漂移、校验器。
 * 运行：node tests/run-tests.js
 */
'use strict';
const path = require('path');
const fs = require('fs');
const root = globalThis;
require(path.join(__dirname, '..', 'js', 'time.js'));
require(path.join(__dirname, '..', 'js', 'serializer.js'));
require(path.join(__dirname, '..', 'js', 'parser.js'));
require(path.join(__dirname, '..', 'js', 'history.js'));
require(path.join(__dirname, '..', 'js', 'validator.js'));

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('  ✓ ' + msg); }
  else { failed++; console.error('  ✗ ' + msg); }
}
function eq(a, b, msg) { assert(a === b, `${msg}（得到 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}）`); }

// ---------- 时间模块 ----------
console.log('[time]');
eq(Time.msToSrt(3661500), '01:01:01,500', '毫秒转 SRT 时间戳');
eq(Time.msToVtt(3661500), '01:01:01.500', '毫秒转 VTT 时间戳');
eq(Time.parseTime('01:01:01,500'), 3661500, '解析 SRT 时间戳');
eq(Time.parseTime('01:01.500'), 61500, '解析 MM:SS 短格式');
eq(Time.parseTime('garbage'), null, '非法时间戳返回 null');
eq(Time.frameToMs(1, 25), 40, '25fps 一帧 = 40ms');
eq(Time.msToFrame(40, 25), 1, '40ms 在 25fps 下为 1 帧');
eq(Time.msToFrameCode(3661500, 25), '01:01:01:13', '毫秒转帧码（91537.5 帧四舍五入到 13）');
eq(Time.parseFrameCode('01:01:01:13', 25), 3661520, '帧码转回毫秒（视图层往返）');

// ---------- 解析：正常 SRT ----------
console.log('[parser] 正常 SRT');
const srtSrc = fs.readFileSync(path.join(__dirname, '..', 'samples', 'sample.srt'), 'utf-8');
const srt = Parser.parse(srtSrc, 'sample.srt');
eq(srt.format, 'srt', '按扩展名识别为 SRT');
eq(srt.cues.length, 4, '解析出 4 条字幕');
eq(srt.errors.length, 0, '样例 SRT 无错误');
eq(srt.cues[0].start, 500, '第一条起点 500ms');
assert(srt.cues[1].text.includes('c & d'), '原文特殊字符 & 原样保留（SRT 不转义）');
assert(srt.cues[0].text.includes('<欢迎语>'), '原文尖括号原样保留');

// ---------- 解析：正常 VTT ----------
console.log('[parser] 正常 VTT');
const vttSrc = fs.readFileSync(path.join(__dirname, '..', 'samples', 'sample.vtt'), 'utf-8');
const vtt = Parser.parse(vttSrc, 'sample.vtt');
eq(vtt.format, 'vtt', '识别为 VTT');
eq(vtt.cues.length, 4, '解析出 4 条 VTT 字幕');
eq(vtt.cues[0].settings, 'line:85%', '保留 cue 设置');
assert(vtt.cues[1].text.includes('c & d'), 'VTT 实体 &amp; 反转义为 &');
assert(vtt.cues[0].text.includes('<欢迎语>'), 'VTT 实体 &lt;&gt; 反转义为尖括号');
assert(vtt.cues[1].text.includes('引号"x"'), 'VTT 实体 &quot; 反转义为引号');

// ---------- 解析：错误样例 ----------
console.log('[parser] 格式错误容错');
const bad = Parser.parse(fs.readFileSync(path.join(__dirname, '..', 'samples', 'malformed.srt'), 'utf-8'), 'malformed.srt');
assert(bad.cues.length >= 3, `坏块不影响其他条目（导入 ${bad.cues.length} 条）`);
assert(bad.errors.some((e) => e.level === 'error' && e.line === 6), '第 6 行错误箭头被单独报告');
assert(bad.errors.some((e) => e.level === 'warning' && /空/.test(e.message)), '空文本块给出警告且仍导入');
assert(bad.errors.some((e) => /句点/.test(e.message)), '句点时间戳给出警告但照常解析');
eq(Parser.parse('完全无法识别的内容\n没有任何时间轴', 'x.srt').cues.length, 0, '全坏文件不产生假条目');
assert(Parser.parse('完全无法识别的内容', 'x.srt').errors.length === 1, '全坏文件至少有一条错误提示，不读成空白');

// ---------- 序列化往返 ----------
console.log('[round-trip] SRT 导出再导入');
const srtOut = Serializer.toSrt(srt.cues);
const srt2 = Parser.parse(srtOut, 'rt.srt');
eq(srt2.cues.length, srt.cues.length, 'SRT 往返条目数一致');
srt.cues.forEach((c, i) => {
  eq(srt2.cues[i].start, c.start, `SRT 往返 #${i + 1} 起点一致`);
  eq(srt2.cues[i].end, c.end, `SRT 往返 #${i + 1} 终点一致`);
  eq(srt2.cues[i].text, c.text, `SRT 往返 #${i + 1} 文本（含特殊字符）一致`);
});

console.log('[round-trip] VTT 导出再导入');
const vttOut = Serializer.toVtt(vtt.cues);
const vtt2 = Parser.parse(vttOut, 'rt.vtt');
eq(vtt2.cues.length, vtt.cues.length, 'VTT 往返条目数一致');
vtt.cues.forEach((c, i) => {
  eq(vtt2.cues[i].start, c.start, `VTT 往返 #${i + 1} 起点一致`);
  eq(vtt2.cues[i].end, c.end, `VTT 往返 #${i + 1} 终点一致`);
  eq(vtt2.cues[i].text, c.text, `VTT 往返 #${i + 1} 文本（实体反转义后）一致`);
  eq(vtt2.cues[i].settings, c.settings, `VTT 往返 #${i + 1} cue 设置一致`);
});
assert(vttOut.includes('&amp;') && vttOut.includes('&lt;'), 'VTT 导出时重新转义特殊字符');

// 交叉格式：SRT 导成 VTT 再导回 SRT，时间不变
console.log('[round-trip] 跨格式时间不漂移');
const cross = Parser.parse(Serializer.toVtt(srt.cues), 'x.vtt');
const back = Parser.parse(Serializer.toSrt(cross.cues), 'x.srt');
srt.cues.forEach((c, i) => {
  eq(back.cues[i].start, c.start, `跨格式往返 #${i + 1} 起点无漂移`);
  eq(back.cues[i].end, c.end, `跨格式往返 #${i + 1} 终点无漂移`);
});

// 帧编辑往返：在 24fps 下把每条起点改成整帧，再导出再导入
console.log('[round-trip] 帧率编辑不漂移');
const fps = 24;
const edited = srt.cues.map((c) => ({ ...c }));
edited.forEach((c) => {
  const frame = Time.msToFrame(c.start, fps);
  c.start = Time.frameToMs(frame, fps); // 视图层换算回毫秒
});
const editedOut = Serializer.toSrt(edited);
const editedBack = Parser.parse(editedOut, 'fps.srt');
edited.forEach((c, i) => eq(editedBack.cues[i].start, c.start, `帧编辑后 #${i + 1} 起点毫秒级一致`));

// ---------- 校验器 ----------
console.log('[validator]');
const cues = [
  { id: 'a', start: 0, end: 1000, text: '正常' },
  { id: 'b', start: 800, end: 900, text: '倒置' },       // 倒置且与 a 重叠
  { id: 'c', start: 2000, end: 2000, text: '' },          // 零时长 + 空文本
  { id: 'd', start: 11000, end: 13000, text: '超时' },    // 视频 12s
];
const v = Validator.validate(cues, 12, new Set());
const types = v.issues.map((i) => i.type).sort();
assert(types.includes('inverted'), '检出时间倒置');
assert(types.includes('overlap'), '检出字幕重叠');
assert(types.includes('empty'), '检出空文本');
assert(types.includes('overflow'), '检出超出视频时长');

// 有意重叠：加入忽略集合后级别变 ignored
const overlapKey = v.issues.find((i) => i.type === 'overlap').key;
const v2 = Validator.validate(cues, 12, new Set([overlapKey]));
const ignored = v2.issues.filter((i) => i.type === 'overlap');
assert(ignored.every((i) => i.level === 'ignored'), '标记后重叠变为“有意忽略”，校对说明可保留');
const v3 = Validator.validate(cues, 0, new Set());
assert(!v3.issues.some((i) => i.type === 'overflow'), '视频时长未知时不做超时检查');

// ---------- 历史栈 ----------
console.log('[history] 文字/时间双栈隔离');
const th = new History.HistoryStack('text');
const ti = new History.HistoryStack('time');
th.push('改文字', [{ cueId: 'a', prop: 'text', old: 'x', new: 'y' }]);
ti.push('改时间', [{ cueId: 'a', prop: 'start', old: 0, new: 100 }]);
assert(th.canUndo() && ti.canUndo(), '两个栈各自记录');
let restored;
th.undo((c, val) => { restored = val; });
eq(restored, 'x', '文字栈撤销恢复旧文本');
assert(ti.canUndo(), '撤销文字不影响时间栈');
ti.undo((c, val) => { restored = val; });
eq(restored, 0, '时间栈撤销恢复旧时间');

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
