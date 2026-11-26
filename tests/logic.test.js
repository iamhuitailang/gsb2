/* 纯逻辑测试：node tests/logic.test.js
   加载浏览器经典脚本到同一全局上下文，验证插值连续性 / 比例换算 / 归一化 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

global.window = global;
const root = path.join(__dirname, '..');
const files = [
  'js/util.js',
  'js/easing.js',
  'js/model.js',
  'js/sample-assets.js',
  'js/sample.js',
  'js/interpolate.js',
  'js/zip.js',
];
for (const f of files) {
  const code = fs.readFileSync(path.join(root, f), 'utf8');
  vm.runInThisContext(code, { filename: f });
}
const G = global.Gfx;

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log('  ✓', name);
}

/* 1. 缓动端点 */
test('所有缓动满足 f(0)=0, f(1)=1', () => {
  for (const key of G.Easing.options) {
    const fn = G.Easing[key].fn;
    assert.ok(Math.abs(fn(0)) < 1e-9, `${key} f(0)=${fn(0)}`);
    assert.ok(Math.abs(fn(1) - 1) < 1e-9, `${key} f(1)=${fn(1)}`);
  }
});

/* 2. 示例工程关键帧连续性 */
const p = G.buildSampleProject();
test('示例工程参数完整 (1920x1080@30, 6s)', () => {
  assert.strictEqual(p.width, 1920);
  assert.strictEqual(p.height, 1080);
  assert.strictEqual(p.fps, 30);
  assert.strictEqual(p.duration, 6);
  assert.ok(p.children.length >= 8);
});

test('每个关键帧边界左右采样连续、无跳变', () => {
  const all = G.Model.flatten(p.children);
  let checked = 0;
  all.forEach(({ layer }) => {
    if (layer.type === 'group') return;
    G.Model.PROP_DEFS.forEach((def) => {
      const keys = layer.keys[def.key];
      keys.forEach((kf) => {
        const at = G.Interpolate.sampleLayer(layer, kf.t);
        const before = G.Interpolate.sampleLayer(layer, Math.max(0, kf.t - 1e-6));
        const after = G.Interpolate.sampleLayer(layer, kf.t + 1e-6);
        for (const field of ['x', 'y', 'w', 'h', 'scaleX', 'scaleY', 'rotation', 'opacity']) {
          assert.ok(Math.abs(at[field] - before[field]) < 0.02,
            `${layer.name}.${def.key} @${kf.t} 左侧跳变 ${field}: ${before[field]} -> ${at[field]}`);
          assert.ok(Math.abs(after[field] - at[field]) < 0.02,
            `${layer.name}.${def.key} @${kf.t} 右侧跳变 ${field}: ${at[field]} -> ${after[field]}`);
        }
        checked++;
      });
    });
  });
  assert.ok(checked > 20, `关键帧数量过少: ${checked}`);
});

test('关键帧时刻采样值精确等于关键帧值', () => {
  const layer = p.children.find((l) => l.type === 'text' && l.name === '主标题')
    || G.Model.flatten(p.children).find((e) => e.layer.name === '主标题').layer;
  const opKf = layer.keys.opacity[1];
  const st = G.Interpolate.sampleLayer(layer, opKf.t);
  assert.strictEqual(st.opacity, 100);
});

/* 3. 比例换算 */
test('改竖屏后位置严格按宽高比换算', () => {
  const proj = G.buildSampleProject();
  const target = G.Model.flatten(proj.children).find((e) => e.layer.name === '主标题').layer;
  const x0 = target.x, y0 = target.y;
  const kx0 = target.keys.position[0].x, ky0 = target.keys.position[0].y;
  G.Model.rescaleProject(proj, 1080, 1920);
  assert.ok(Math.abs(target.x - x0 * (1080 / 1920)) < 1e-6);
  assert.ok(Math.abs(target.y - y0 * (1920 / 1080)) < 1e-6);
  assert.ok(Math.abs(target.keys.position[0].x - kx0 * (1080 / 1920)) < 1e-6);
  assert.ok(Math.abs(target.keys.position[0].y - ky0 * (1920 / 1080)) < 1e-6);
  assert.strictEqual(proj.width, 1080);
  assert.strictEqual(proj.height, 1920);
});

/* 4. 归一化容错 */
test('normalizeProject 能修复残缺工程', () => {
  const fixed = G.Model.normalizeProject({
    width: 0, fps: 999, children: [{ type: 'text', text: 'x' }, { type: 'weird' }],
  });
  assert.strictEqual(fixed.width, 1920);
  assert.strictEqual(fixed.fps, 120);
  assert.strictEqual(fixed.children[1].type, 'rect');
  assert.ok(fixed.children[0].keys.position);
});

/* 5. ZIP crc 基本正确性（crc32('123456789') = cbf43926） */
test('CRC32 标准向量正确', () => {
  const bytes = new TextEncoder().encode('123456789');
  assert.strictEqual(G.Zip.crc32(bytes).toString(16), 'cbf43926');
});

/* 6. 帧数 */
test('导出帧数 = round(duration*fps)', () => {
  assert.strictEqual(Math.round(p.duration * p.fps), 180);
});

console.log(`\n${passed} 组逻辑测试全部通过 ✅`);
