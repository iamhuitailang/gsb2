#!/usr/bin/env node
/*
 * 核心逻辑测试（无需浏览器）：
 *   node test/run-tests.js
 * 用桩 canvas 提供确定性的测量结果，验证字形切分、容错解析、
 * 换行/避头尾/溢出定位、导出数据结构与逐字播放器。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ---- 浏览器全局桩 ----
const sandbox = {
  console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  Date, Math, JSON, Map, Set, Intl, RegExp, Number, String, Array, Object, Boolean
};
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
vm.createContext(sandbox);

function load(rel) {
  const code = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  vm.runInContext(code, sandbox, { filename: rel });
}

// 确定性测量：CJK/emoji 按字号宽，拉丁按 0.55 字号，空格 0.3
function makeStubCanvas(fontSize) {
  return {
    getContext() {
      return {
        _font: '',
        set font(v) { this._font = v; },
        get font() { return this._font; },
        set letterSpacing(_v) {},
        measureText(g) {
          const size = fontSize;
          let w;
          if (/[぀-ヿ一-鿿가-힯]/u.test(g)) w = size;
          else if (/\p{Extended_Pictographic}/u.test(g) || /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(g)) w = size * 1.1;
          else if (g === ' ') w = size * 0.3;
          else w = size * 0.55;
          return { width: w };
        }
      };
    }
  };
}

load('js/grapheme.js');
load('js/parser.js');
load('js/layout.js');
load('js/player.js');
load('js/exporter.js');

const TT = sandbox.TT;
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    failed++;
    console.error('  ✗ ' + name);
    console.error('    ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n    ') : e));
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
function assertEq(a, b, msg) {
  if (a !== b) throw new Error((msg || 'not equal') + ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
}

console.log('\n[1] 字形切分');
test('组合字符 café 是 4 个字形', () => {
  assertEq(TT.grapheme.length('café'), 4);
});
test('ZWJ emoji 家族是 1 个字形', () => {
  assertEq(TT.grapheme.length('👨‍👩‍👧'), 1);
});
test('带肤色 emoji 是 1 个字形', () => {
  assertEq(TT.grapheme.length('🙋🏽‍♀️'), 1);
});
test('国旗 emoji 是 1 个字形', () => {
  assertEq(TT.grapheme.length('🇨🇳'), 1);
});
test('中英混排计数', () => {
  assertEq(TT.grapheme.length('你好world'), 7);
});

console.log('\n[2] 容错解析');
test('正常样式与停顿解析', () => {
  const r = TT.parser.parse('[b]Hi[/b] [wait=300] there');
  assertEq(r.errors.length, 0, 'should have no errors');
  assert(r.markers.some((m) => m.type === 'wait' && m.duration === 300));
  assertEq(r.charCount, 9);
  assert(r.units.find((u) => u.type === 'char' && u.text === 'H').style.bold);
});
test('未闭合标记报错但文字保留', () => {
  const r = TT.parser.parse('[b]abc');
  assert(r.errors.length >= 1);
  assert(r.errors[0].line === 1 && r.errors[0].col === 1);
  assertEq(r.charCount, 3);
});
test('多余闭合标记报错', () => {
  const r = TT.parser.parse('abc[/i]');
  assert(r.errors.some((e) => e.message.includes('多余的闭合')));
  // [/i] 回退为 4 个字面量字符，正文 abc 完整保留
  assertEq(r.charCount, 7);
  assert(r.units.some((u) => u.type === 'char' && u.text === 'a'));
});
test('错误颜色值报错且不吞掉文字', () => {
  const r = TT.parser.parse('[color=bad]x[/color]');
  assert(r.errors.some((e) => e.message.includes('颜色')));
  // 标记整体回退为字面量：[color=bad](11) + x(1) + [/color](8) = 20
  assertEq(r.charCount, 20);
  const plain = r.units.filter((u) => u.type === 'char').map((u) => u.text).join('');
  assert(plain.includes('x'));
});
test('行列定位正确', () => {
  const r = TT.parser.parse('第一行\n[b]第二行问题');
  const e = r.errors[0];
  assertEq(e.line, 2);
  assertEq(e.col, 1);
});
test('转义 [[ 输出字面量 [', () => {
  const r = TT.parser.parse('a[[b');
  assertEq(r.errors.length, 0);
  assert(r.units.some((u) => u.type === 'char' && u.text === '['));
});
test('wait 缺时长报错', () => {
  const r = TT.parser.parse('[wait]');
  assert(r.errors.some((e) => e.message.includes('时长')));
});

console.log('\n[3] 排版引擎');
const canvas = makeStubCanvas(18);
test('CJK 在窄行宽下逐字换行且无溢出', () => {
  const r = TT.parser.parse('一二三四五六七八九十');
  const lay = TT.layout.layout(r, { fontSize: 18, lineWidth: 54, letterSpacing: 0, lineHeight: 1.5 }, canvas);
  assertEq(lay.overflows.length, 0);
  // 每行 3 个 CJK（18px each, 54px）
  assert(lay.pages[0].lines.length >= 3, 'should wrap to multiple lines, got ' + lay.pages[0].lines.length);
  assert(lay.pages[0].lines.every((ln) => ln.units.length <= 3));
});
test('拉丁长词整体换行，必要时逐字溢出并定位', () => {
  const r = TT.parser.parse('abc Supercalifragilistic');
  const lay = TT.layout.layout(r, { fontSize: 18, lineWidth: 60, letterSpacing: 0, lineHeight: 1.5 }, canvas);
  assert(lay.overflows.length > 0, 'long word must overflow a 60px line');
  const o = lay.overflows[0];
  assert(typeof o.srcStart === 'number' && typeof o.line === 'number');
  assert(o.reason.includes('wider-than-line'));
});
test('长词 warning 带原文位置', () => {
  const r = TT.parser.parse('Supercalifragilisticexpialidocious');
  const lay = TT.layout.layout(r, { fontSize: 18, lineWidth: 800, letterSpacing: 0 }, canvas);
  assert(lay.warnings.some((w) => w.type === 'long-word' && w.srcStart === 0));
});
test('emoji 整体移动，从不拆分', () => {
  const r = TT.parser.parse('a👨‍👩‍👧b');
  const lay = TT.layout.layout(r, { fontSize: 18, lineWidth: 200, letterSpacing: 0 }, canvas);
  const texts = lay.placements.map((p) => p.text);
  assert(texts.includes('👨‍👩‍👧'), 'emoji must be one placement');
  assertEq(texts.length, 3);
});
test('避头尾：句号不会出现在行首', () => {
  // 4 字一行，构造句末标点
  const r = TT.parser.parse('一二三四。五六');
  const lay = TT.layout.layout(r, { fontSize: 18, lineWidth: 72, letterSpacing: 0, lineHeight: 1.5 }, canvas);
  for (const ln of lay.pages[0].lines) {
    assert(ln.units[0].text !== '。', 'line must not start with 。');
  }
});
test('换行符产生独立行', () => {
  const r = TT.parser.parse('abc\ndef');
  const lay = TT.layout.layout(r, { fontSize: 18, lineWidth: 400, letterSpacing: 0 }, canvas);
  assertEq(lay.pages[0].lines.length, 2);
});
test('分页产生多个 page', () => {
  const r = TT.parser.parse('aaa[page]bbb');
  const lay = TT.layout.layout(r, { fontSize: 18, lineWidth: 400, letterSpacing: 0 }, canvas);
  assertEq(lay.pages.length, 2);
  assertEq(lay.pages[1].lines[0].units[0].text, 'b');
});
test('停顿锚定到前面的字形', () => {
  const r = TT.parser.parse('ab[wait=200]c');
  const lay = TT.layout.layout(r, { fontSize: 18, lineWidth: 400, letterSpacing: 0 }, canvas);
  const marker = r.markers[0];
  const anchor = lay.markerAt.get(marker.unitIndex);
  assertEq(anchor.charIndex, 1); // a=0, b=1
});
test('每个字形都有 placement（含空格）', () => {
  const r = TT.parser.parse('a b c');
  const lay = TT.layout.layout(r, { fontSize: 18, lineWidth: 400, letterSpacing: 0 }, canvas);
  assertEq(lay.placements.length, r.charCount);
});

console.log('\n[4] 导出');
test('导出结构包含每页文字/行/停顿', () => {
  const r = TT.parser.parse('[b]你好[/b][wait=100]\n世界[page]第二页');
  const lay = TT.layout.layout(r, { fontSize: 18, lineWidth: 200, letterSpacing: 0 }, canvas);
  const data = TT.exporter.buildExport(r, lay);
  assertEq(data.version, 1);
  assertEq(data.pages.length, 2);
  assert(data.pages[0].lines.length >= 2);
  assert(data.pages[0].lines[0].chars[0].x === 0);
  assert(data.markers.some((m) => m.type === 'wait' && m.durationMs === 100));
  assert(data.markers.some((m) => m.type === 'page'));
  const json = JSON.stringify(data);
  JSON.parse(json); // 必须可序列化
});
test('导出包含错误与溢出定位', () => {
  const r = TT.parser.parse('[b]oops Supercalifragilisticexpialidocious');
  const lay = TT.layout.layout(r, { fontSize: 18, lineWidth: 60, letterSpacing: 0 }, canvas);
  const data = TT.exporter.buildExport(r, lay);
  assert(data.errors.length >= 1);
  assert(data.overflows.length >= 1);
  assert(typeof data.overflows[0].srcStart === 'number');
});

console.log('\n[5] 逐字播放器');
test('播放逐步显示，wait 产生等待状态', async () => {
  const r = TT.parser.parse('ab[wait=50]c');
  const ticks = [];
  const p = TT.player.create(r, {
    charIntervalMs: 5,
    defaultWaitMs: 50,
    onTick: (n) => ticks.push(n)
  });
  p.play();
  await new Promise((res) => setTimeout(res, 220));
  const st = p.getState();
  assertEq(st.state, 'done');
  assertEq(st.revealed, 3);
  assert(ticks.includes(1) && ticks.includes(2) && ticks.includes(3));
});
test('seek 跳到指定字并暂停', () => {
  const r = TT.parser.parse('abcdef');
  const p = TT.player.create(r, { charIntervalMs: 5 });
  p.seekTo(3);
  assertEq(p.getState().revealed, 3);
  assertEq(p.getState().state, 'paused');
  p.showAll();
  assertEq(p.getState().revealed, 6);
  assertEq(p.getState().state, 'done');
});
test('重建排版后进度仍可对应（charIndex 稳定）', () => {
  const text = '一二三四五六七八';
  const r1 = TT.parser.parse(text);
  const lay1 = TT.layout.layout(r1, { fontSize: 18, lineWidth: 72, letterSpacing: 0 }, canvas);
  const r2 = TT.parser.parse(text);
  const lay2 = TT.layout.layout(r2, { fontSize: 24, lineWidth: 120, letterSpacing: 2 }, canvas);
  assertEq(r1.charCount, r2.charCount);
  const idx = 5;
  const p1 = lay1.placements.find((z) => z.charIndex === idx);
  const p2 = lay2.placements.find((z) => z.charIndex === idx);
  assert(p1.text === p2.text && p2.text === '六');
});

(async function main() {
  // 等待异步测试完成
  await new Promise((res) => setTimeout(res, 300));
  console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
  process.exit(failed ? 1 : 0);
})();
