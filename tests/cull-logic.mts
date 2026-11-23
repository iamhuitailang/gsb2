// 视锥剔除的纯逻辑验证：构造已知相机，检查屏内/屏外实例判定
import { InstanceStore } from '../src/store.ts';
import { matPerspective, matLookAt, matMultiply } from '../src/math.ts';

const store = new InstanceStore();
store.createBatch([
  { position: [0, 0, 0], color: [1, 0, 0] },       // 原点，屏内
  { position: [100, 0, 0], color: [0, 1, 0] },     // 极右，屏外
  { position: [-100, 0, 0], color: [0, 0, 1] },    // 极左，屏外
  { position: [0, 100, 0], color: [1, 1, 0] },     // 极上，屏外
  { position: [0, 0, -50], color: [1, 0, 1] },     // 相机前方 60 单位、视野内，保留
  { position: [0, 0, 50], color: [0, 1, 1] },      // 相机背后，剔除
]);
const proj = matPerspective(Math.PI / 4, 1, 0.1, 200);
const view = matLookAt([0, 0, 10], [0, 0, 0], [0, 1, 0]);
const mvp = matMultiply(proj, view);

const list = store.buildDrawList(true, mvp);
const kept = list.map((d) => d.id).sort();
console.log('剔除后保留的 id:', kept);

const fail = [];
const expected = [1, 5];
if (kept.length !== expected.length || kept.some((id, i) => id !== expected[i])) {
  fail.push(`应保留 ${JSON.stringify(expected)}，实际 ${JSON.stringify(kept)}`);
}

// 关闭剔除时应全部保留
const all = store.buildDrawList(false, mvp);
if (all.length !== 6) fail.push(`关闭剔除应保留 6 个，实际 ${all.length}`);

// 相机绕到侧面后，原来在屏外的侧面实例进入视锥
const viewSide = matLookAt([100, 5, 0], [0, 0, 0], [0, 1, 0]);
const mvpSide = matMultiply(proj, viewSide);
const sideList = store.buildDrawList(true, mvpSide);
console.log('侧视后保留的 id:', sideList.map((d) => d.id).sort());
if (sideList.length < 2) fail.push('侧视后应能看到多个实例');

if (fail.length) {
  console.error('失败:', fail.join('; '));
  process.exit(1);
}
console.log('视锥剔除逻辑验证通过');
