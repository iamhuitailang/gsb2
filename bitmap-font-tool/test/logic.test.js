// 逻辑自测：在 DOM 桩下加载 app.js，验证排版与排布核心逻辑
const fs = require('fs');
const path = require('path');

const noop = () => {};
function makeCtx() {
  return new Proxy({}, {
    get: (t, k) => (k in t ? t[k] : noop),
    set: (t, k, v) => { t[k] = v; return true; },
  });
}
function makeEl() {
  const el = {
    style: {}, children: [], value: '1', checked: true, textContent: '',
    appendChild(c) { this.children.push(c); return c; },
    addEventListener: noop,
    querySelector() { return makeEl(); },
    getContext() { return makeCtx(); },
    click: noop,
  };
  Object.defineProperty(el, 'innerHTML', { get: () => '', set: noop });
  return el;
}
const elCache = new Map();
global.document = {
  getElementById(id) {
    if (!elCache.has(id)) elCache.set(id, makeEl());
    return elCache.get(id);
  },
  createElement() { return makeEl(); },
};
global.window = { devicePixelRatio: 1 };

let src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

const test = `
;(function runTests() {
  const assert = (cond, msg) => { if (!cond) { console.error('FAIL: ' + msg); process.exitCode = 1; } else console.log('ok: ' + msg); };

  const fakeGlyph = (ch, w, h) => ({
    char: ch, code: ch.codePointAt(0), fileName: ch + '.png', dataUrl: '', img: {},
    w, h, blank: false, padding: 1, baseline: h, advance: w,
  });
  state.glyphs.set('A', fakeGlyph('A', 20, 30));
  state.glyphs.set('i', fakeGlyph('i', 6, 30));
  state.glyphs.set('W', fakeGlyph('W', 34, 30));
  state.glyphs.set('中', fakeGlyph('中', 32, 32));
  state.glyphs.set(' ', fakeGlyph(' ', 10, 4));
  state.settings.charSpacing = 2;

  // 1. 换行：每行宽度不超过排版宽度（单字超宽除外）
  const maxW = 100;
  const lines = layoutText('AA WW 中中 AAiiAA WW', maxW);
  assert(lines.length > 1, '长句发生了换行（' + lines.length + ' 行）');
  for (const [i, l] of lines.entries()) {
    assert(l.width <= maxW || l.tokens.length === 1,
      '第 ' + i + ' 行宽度 ' + l.width + ' 未超排版宽度 ' + maxW);
  }

  // 2. 测量与渲染一致：渲染步进同样用 cellW，逐字累加应等于行宽
  for (const [i, l] of lines.entries()) {
    let pen = 0;
    for (const t of l.tokens) for (const ch of t.text) pen += cellW(ch);
    assert(pen === l.width, '第 ' + i + ' 行渲染步进与测量宽度一致（' + pen + '）');
  }

  // 3. 空格不会出现在行首
  for (const [i, l] of lines.entries()) {
    assert(!(l.tokens.length && l.tokens[0].kind === 'space'), '第 ' + i + ' 行不以空格开头');
  }

  // 4. 排布确定性：两次排布结果相同
  state.settings.edgePadding = 4;
  const p1 = packGlyphs(64), p2 = packGlyphs(64);
  assert(JSON.stringify([...p1.placements]) === JSON.stringify([...p2.placements]), '排布结果确定（重排不改变位置）');

  // 5. 排布边界与重叠检查
  const rects = [...p1.placements.values()];
  for (const r of rects) {
    assert(r.x >= 4 && r.y >= 4 && r.x + r.w <= 60 && r.y + r.h <= 60, '单元格在边缘留白内');
  }
  let overlap = false;
  for (let a = 0; a < rects.length; a++) for (let b = a + 1; b < rects.length; b++) {
    const A = rects[a], B = rects[b];
    if (A.x < B.x + B.w && B.x < A.x + A.w && A.y < B.y + B.h && B.y < A.y + A.h) overlap = true;
  }
  assert(!overlap, '排布无重叠');

  // 6. 放不下的字形被指出
  state.glyphs.set('巨', fakeGlyph('巨', 200, 200));
  const p3 = packGlyphs(64);
  assert(p3.unplaced.includes('巨'), '超出尺寸的字形列入无法放入清单');
  state.glyphs.delete('巨');

  // 7. 换图集尺寸重排后度量（xadvance）不变
  state.settings.atlasSize = 64; state.packing = packGlyphs(64);
  const m1 = metricsData();
  state.settings.atlasSize = 128; state.packing = packGlyphs(128);
  const m2 = metricsData();
  const adv = (m) => Object.fromEntries(m.chars.map((c) => [c.char, c.xadvance]));
  assert(JSON.stringify(adv(m1)) === JSON.stringify(adv(m2)), '重新排布后映射与前进宽度不变');

  // 8. 缺字度量：未导入字符使用缺字宽度
  assert(advanceOf('λ') === state.settings.fallbackAdvance, '缺字使用缺字宽度');
})();
`;

eval(src + test);
console.log(process.exitCode ? '存在失败用例' : '全部通过');
