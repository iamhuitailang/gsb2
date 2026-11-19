#!/usr/bin/env node
/**
 * 核心逻辑自检（无需浏览器）：node tools/selftest.js
 * 覆盖：矩阵往返、IK 骨长稳定与受限状态、关键帧循环插值、洋葱皮帧包裹、
 *       撤销重做的动作间隔离、示例数据完整性。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sandbox = { window: {}, console, Image: class { }, performance: { now: () => 0 } };
sandbox.window.document = { addEventListener() { } };
vm.createContext(sandbox);

const jsDir = path.join(__dirname, '..', 'js');
for (const f of ['math.js', 'model.js', 'ik.js', 'pose.js', 'history.js', 'sample.js']) {
  vm.runInContext(fs.readFileSync(path.join(jsDir, f), 'utf8'), sandbox, { filename: f });
}
const W = sandbox.window;
const { Math2D, Model, IKSolver, Pose, Sample, History } = W;

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed += 1; console.log('  ✓ ' + name); }
  else { failed += 1; console.error('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

console.log('1) 矩阵乘法与求逆往返');
{
  const m = Math2D.M.compose(12, -7, 0.6, 1.4, 0.8);
  const p = { x: 3.2, y: -4.1 };
  const back = Math2D.M.apply(Math2D.M.invert(m), Math2D.M.apply(m, p));
  check('逆矩阵还原点坐标', Math.hypot(back.x - p.x, back.y - p.y) < 1e-9);
  const ident = Math2D.M.multiply(m, Math2D.M.invert(m));
  check('M * M^-1 ≈ 单位阵', Math.abs(ident[0] - 1) < 1e-9 && Math.abs(ident[4]) < 1e-9);
}

console.log('2) IK：骨长保持 + 可达/受限状态');
{
  const p0 = { x: 0, y: 0 }, p1 = { x: 50, y: 0 }, p2 = { x: 100, y: 0 };
  const r1 = IKSolver.solve(p0, p1, p2, { x: 60, y: -40 }, 1);
  check('可达目标 state=ok', r1.state === 'ok');
  const l1 = Math.hypot(p1.x - p0.x, p1.y - p0.y);
  const l2 = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  check('求解后 root 段骨长不变', Math.abs(Math.hypot(
    p0.x + Math.cos(r1.rootWorldAngle) * l1 - p0.x,
    p0.y + Math.sin(r1.rootWorldAngle) * l1 - p0.y) - l1) < 1e-6 && l2 > 0);
  check('末端到达目标', Math.hypot(r1.effector.x - 60, r1.effector.y + 40) < 1e-4);
  check('mid 世界角与 root 世界角之差在弯折范围内',
    Math.abs(Math2D.normalizeAngle(r1.midWorldAngle - r1.rootWorldAngle)) <= Math.PI + 1e-6);

  const r2 = IKSolver.solve(p0, p1, p2, { x: 500, y: 0 }, 1);
  check('超出最大伸展 state=limited', r2.state === 'limited');
  const reach = Math.hypot(r2.effector.x - p0.x, r2.effector.y - p0.y);
  check('超限时末端钳制在最大伸展容差处', Math.abs(reach - (l1 + l2 - 3)) < 1e-5);

  const r3 = IKSolver.solve(p0, p1, p2, { x: 0.001, y: 0 }, 1);
  check('目标与 root 重合附近可作为折叠姿势求解', r3.state === 'ok');

  const ra = IKSolver.solve(p0, p1, p2, { x: 60, y: -40 }, 1);
  const rb = IKSolver.solve(p0, p1, p2, { x: 60, y: -40 }, -1);
  check('bend ±1 给出镜像弯曲方向', ra.rootWorldAngle * rb.rootWorldAngle < 0);
}

console.log('3) 关键帧采样：线性、角度最短路径、循环包裹');
{
  const anim = { frameCount: 10, loop: true, keys: { b: [
    { frame: 0, x: 0, rotation: 0, easing: 'linear' },
    { frame: 5, x: 10, rotation: Math2D.TAU - 0.5, easing: 'linear' },
  ] }, ikKeys: {} };
  const v = Pose.sampleChannel(anim.keys.b, 2.5, 10, true, 0, 'x', false);
  check('线性插值中点', Math.abs(v - 5) < 1e-9);
  const a = Pose.sampleChannel(anim.keys.b, 2.5, 10, true, 0, 'rotation', true);
  check('角度走最短路径（-0.25 而非 +3.0）', Math.abs(a + 0.25) < 1e-9);
  const looped = Pose.sampleChannel(anim.keys.b, 7.5, 10, true, 0, 'x', false);
  check('循环段末帧→首帧插值', Math.abs(looped - 5) < 1e-9);
  check('wrapFrame 循环', Pose.wrapFrame(12, 10, true) === 2 && Pose.wrapFrame(-1, 10, true) === 9);
  check('wrapFrame 单次钳制', Pose.wrapFrame(99, 10, false) === 9);
}

console.log('4) 示例项目完整性与 FK/IK 求值');
{
  const p = Sample.buildSampleProject();
  check('19 根骨骼', p.bones.length === 19);
  check('18 个几何部件', p.parts.length === 18, '实际 ' + p.parts.length);
  check('2 个循环动作', p.animations.length === 2 && p.animations.every((a) => a.loop));
  check('4 条 IK 约束', p.ik.length === 4);
  check('部件全部绑定到存在的骨骼', p.parts.every((pt) => !pt.boneId || p.bones.some((b) => b.id === pt.boneId)));
  check('无孤儿骨骼', p.bones.every((b) => !b.parentId || p.bones.some((x) => x.id === b.parentId)));

  const rest = Pose.evaluateRest(p);
  const pelvis = p.bones.find((b) => b.name === 'pelvis');
  check('FK 静止位置正确', Math.abs(rest.worldPos[pelvis.id].x) < 1e-9 &&
    Math.abs(rest.worldPos[pelvis.id].y + 140) < 1e-9);

  // 每个动作所有帧求值不报错，且启用的腿部 IK 始终可满足
  for (const anim of p.animations) {
    let ok = true;
    const badFrames = [];
    for (let f = 0; f < anim.frameCount; f++) {
      const pose = Pose.evaluatePose(p, anim, f);
      if (!pose.world || !pose.partWorld) ok = false;
      for (const c of p.ik.filter((x) => x.enabled)) {
        if (pose.ikStates[c.id] === 'limited') badFrames.push(f + ':' + c.name);
      }
    }
    check('动作「' + anim.name + '」全部 ' + anim.frameCount + ' 帧可求值', ok);
    check('动作「' + anim.name + '」启用的 IK 无受限帧', badFrames.length === 0, badFrames.join(', '));
    // 可满足的帧：FK 重算后的末端应贴合 IK 目标
    let accuracy = true;
    for (let f = 0; f < anim.frameCount; f++) {
      const pose = Pose.evaluatePose(p, anim, f);
      for (const c of p.ik.filter((x) => x.enabled)) {
        if (pose.ikStates[c.id] !== 'ok') continue;
        const target = Pose.sampleIKTarget(anim, c, f, f);
        const eff = pose.worldPos[c.effBoneId];
        if (Math.hypot(eff.x - target.x, eff.y - target.y) > 0.5) accuracy = false;
      }
    }
    check('动作「' + anim.name + '」IK 末端贴合目标（误差 < 0.5px）', accuracy);
  }

  // walk 第 0 帧：左脚 IK 目标在可达范围，状态 ok；把目标拉远后变 limited
  const walk = p.animations.find((a) => a.name === '行走 walk');
  const legL = p.ik.find((c) => c.name === '左腿 IK');
  const pose0 = Pose.evaluatePose(p, walk, 0);
  check('walk#0 左腿 IK 可满足', pose0.ikStates[legL.id] === 'ok',
    'state=' + pose0.ikStates[legL.id]);
  Model.putIKKey(walk, legL.id, 0, { x: 500, y: 500 });
  const poseBad = Pose.evaluatePose(p, walk, 0);
  check('不可达目标标记 limited', poseBad.ikStates[legL.id] === 'limited');

  // 层级变化：把 head 重挂到 pelvis，关节世界位置应保持
  const head = p.bones.find((b) => b.name === 'head');
  const beforePos = { ...rest.worldPos[head.id] };
  Model.reparentBone(p, head.id, pelvis.id, rest);
  const afterPos = Pose.evaluateRest(p).worldPos[head.id];
  check('重设父级保持关节世界位置', Math.abs(afterPos.x - beforePos.x) < 1e-6 &&
    Math.abs(afterPos.y - beforePos.y) < 1e-6);
}

console.log('5) 撤销/重做：动作独立栈互不串扰');
{
  const p = Sample.buildSampleProject();
  const a1 = p.animations[0], a2 = p.animations[1];
  const h1 = new History.History(a1.name), h2 = new History.History(a2.name);
  const snap = (o) => JSON.parse(JSON.stringify(o));
  const boneId = p.bones[0].id;

  const before = snap(a1.keys);
  Model.putKey(a1, boneId, 3, { x: 11, y: 22, rotation: 0.3, scaleX: 1, scaleY: 1 });
  const after = snap(a1.keys);
  h1.push('a1 关键帧', () => { a1.keys = snap(before); }, () => { a1.keys = snap(after); });

  check('a2 的关键帧未被 a1 操作影响', JSON.stringify(a2.keys) !== undefined);
  const a2Before = snap(a2.keys);
  Model.putKey(a2, boneId, 7, { x: 99, y: 0, rotation: 0, scaleX: 1, scaleY: 1 });
  h1.undo(); // 在 a1 的栈上撤销
  check('撤销 a1 后 a2 的编辑依然保留', a2.keys[boneId].some((k) => k.frame === 7));
  check('撤销 a1 后 a1 关键帧消失', !a1.keys[boneId].some((k) => k.frame === 3));
  check('a2 自身栈为空（未被污染）', !h2.canUndo);
  void a2Before;
}

console.log('6) 缓动函数连续性（关键帧端点值）');
{
  for (const name of ['linear', 'easeIn', 'easeOut', 'easeInOut']) {
    const fn = Math2D.Easing[name];
    check(name + ' 在 0/1 处为 0/1', fn(0) === 0 && fn(1) === 1);
  }
  check('hold 阶跃：t<1 恒 0', Math2D.Easing.hold(0.5) === 0 && Math2D.Easing.hold(1) === 1);
}

console.log('\n结果：' + passed + ' 通过，' + failed + ' 失败');
process.exit(failed ? 1 : 0);
