/* 核心逻辑冒烟测试（Node 环境，桩掉浏览器对象；不进仓库主流程，放 tests/） */
global.window = global;
global.document = { createElement: function () { return {}; } };
global.console = console;
const _store = {};
global.localStorage = {
  getItem: function (k) { return Object.prototype.hasOwnProperty.call(_store, k) ? _store[k] : null; },
  setItem: function (k, v) { _store[k] = String(v); },
  removeItem: function (k) { delete _store[k]; }
};

const fs = require('fs');
const path = require('path');
['math.js', 'geometry.js', 'pattern.js', 'render.js', 'state.js'].forEach(function (f) {
  const code = fs.readFileSync(path.join(__dirname, '..', 'js', f), 'utf8');
  eval(code);
});

const PCAL = global.PCAL;
let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log('  ✓ ' + msg); }
  else { failures++; console.error('  ✗ ' + msg); }
}

/* 1. 单应：已知透视四边形，正反映射往返误差应极小 */
const unit = [{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}];
const tilted = [{x:0.04,y:0.12},{x:0.55,y:0.20},{x:0.55,y:0.82},{x:0.04,y:0.90}];
const H = PCAL.math.findHomography(unit, tilted);
assert(!!H, '单应矩阵求解成功');
const invH = PCAL.math.invert3(H);
let maxErr = 0;
for (let i = 0; i < 100; i++) {
  const u = Math.random(), v = Math.random();
  const f = PCAL.math.applyH(H, u, v);
  const b = PCAL.math.applyH(invH, f.x, f.y);
  maxErr = Math.max(maxErr, Math.hypot(b.x - u, b.y - v));
}
assert(maxErr < 1e-10, '100 个随机点单应往返误差 < 1e-10（实测 ' + maxErr.toExponential(2) + '）');

/* 四角必须精确落到给定像素 */
const cornerErr = unit.map((p, i) => Math.hypot(PCAL.math.applyH(H, p.x, p.y).x - tilted[i].x,
                                                PCAL.math.applyH(H, p.x, p.y).y - tilted[i].y));
assert(Math.max(...cornerErr) < 1e-12, '单应四角精确映射');

/* 2. 非法四边形判定 */
const good = PCAL.geometry.validateQuad(tilted);
assert(good.valid, '倾斜凸四边形判定有效');
const crossed = PCAL.geometry.validateQuad([{x:0,y:0},{x:1,y:0},{x:0,y:1},{x:1,y:1}]);
assert(!crossed.valid && /自交|交叉/.test(crossed.reason), '自交四边形被拒绝：' + crossed.reason);
const folded = PCAL.geometry.validateQuad([{x:0,y:0},{x:1,y:0},{x:0.4,y:0.4},{x:0,y:1}]);
assert(!folded.valid && /反向|凹折/.test(folded.reason), '凹折反向四边形被拒绝：' + folded.reason);
const degenerate = PCAL.geometry.validateQuad([{x:0,y:0},{x:1,y:0},{x:2,y:0},{x:0.5,y:1}]);
assert(!degenerate.valid && /共线|退化/.test(degenerate.reason), '三点共线退化被拒绝：' + degenerate.reason);
const dup = PCAL.geometry.validateQuad([{x:0,y:0},{x:0,y:0},{x:1,y:1},{x:0,y:1}]);
assert(!dup.valid && /重合/.test(dup.reason), '重合角点被拒绝：' + dup.reason);

/* 3. 点在多边形内 */
assert(PCAL.geometry.pointInPolygon(0.2, 0.5, tilted) === true, '多边形内部点命中');
assert(PCAL.geometry.pointInPolygon(0.9, 0.5, tilted) === false, '多边形外部点不命中');

/* 4. 融合权重：示例初始 gamma=0.45 应偏亮（带内权重和 >1），gamma=1 线性互补和=1 */
const left = { a: 0.7, b: 0.95, side: 'right' };
const right = { a: 0.05, b: 0.3, side: 'left' };
let sumLowGamma = 0, sumLinear = 0;
for (let i = 0; i <= 20; i++) {
  const u = 0.7 + 0.25 * i / 20;
  sumLowGamma += PCAL.render.bandWeight(u, left, 0.45) + PCAL.render.bandWeight(u, {a:0.05,b:0.3,side:'left'}, 0.45);
  // 同一条带、线性曲线时左右幕互补
  const band = { a: 0.3, b: 0.7 };
  sumLinear += PCAL.render.bandWeight(u > 0.7 ? 0.7 : u, band, 1) +
               PCAL.render.bandWeight(u > 0.7 ? 0.7 : u, Object.assign({}, band, {side:'left'}), 1);
}
assert(sumLowGamma / 21 > 1.05, '低 gamma 示例初始状态重叠偏亮（平均权重和 ' + (sumLowGamma/21).toFixed(3) + '）');
let linearDev = 0;
for (let i = 0; i <= 50; i++) {
  const u = 0.3 + 0.4 * i / 50;
  const s = PCAL.render.bandWeight(u, {a:0.3,b:0.7,side:'right'}, 1) +
            PCAL.render.bandWeight(u, {a:0.3,b:0.7,side:'left'}, 1);
  linearDev = Math.max(linearDev, Math.abs(s - 1));
}
assert(linearDev < 1e-12, 'gamma=1 线性融合带内权重和恒为 1（偏差 ' + linearDev.toExponential(1) + '）');

/* 5. 状态：规范坐标在不同输出尺寸下相对位置不变 */
const st = PCAL.state.defaultState();
const d1 = PCAL.state.outputDimensions(st);
st.output.presetId = '4k';
const d2 = PCAL.state.outputDimensions(st);
assert(d1.w === 1920 && d2.w === 3840, '输出尺寸切换 ' + d1.w + ' → ' + d2.w);
const models1080 = PCAL.render.buildScreenModels(st.screens, 1920, 1080);
const models4k = PCAL.render.buildScreenModels(st.screens, 3840, 2160);
let coordErr = 0;
models1080[0].quadNorm.forEach((p, i) => {
  coordErr += Math.hypot(p.x - models4k[0].quadNorm[i].x, p.y - models4k[0].quadNorm[i].y);
});
assert(coordErr === 0, '角点规范坐标不随输出尺寸改变');

/* 6. 双线性采样边界不越界 */
const size = 8;
const data = new Uint8ClampedArray(size * size * 4);
for (let i = 0; i < size * size; i++) { data[i*4] = data[i*4+1] = data[i*4+2] = 100; }
const s0 = PCAL.render.sampleBilinear(data, size, 0, 0);
const s1 = PCAL.render.sampleBilinear(data, size, 1, 1);
assert(s0[0] === 100 && s1[2] === 100, '双线性采样在 (0,0)/(1,1) 边界不越界');

/* 7. 持久化往返 */
PCAL.state.save(st);
const loaded = PCAL.state.load();
assert(JSON.stringify(loaded.screens) === JSON.stringify(st.screens), 'localStorage 配置存取一致');

console.log(failures === 0 ? '\n全部通过' : '\n有 ' + failures + ' 项失败');
process.exit(failures === 0 ? 0 : 1);
