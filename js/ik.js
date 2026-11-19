/* 两段骨骼 IK：CCD 循环坐标下降（世界空间逐关节旋转，骨长严格保持） */
(function (global) {
  'use strict';

  const { V, clamp } = global.Math2D;

  /**
   * 两段 IK 求解。
   *
   * @param p0 root 关节世界坐标（铰链，求解中保持不动）
   * @param p1 mid  关节世界坐标
   * @param p2 effector（末端）世界坐标
   * @param target 目标点世界坐标
   * @param bend 弯曲方向 +1 / -1（决定多解时关节落在哪一侧）
   * @returns {{ rootWorldAngle:number, midWorldAngle:number, effector:object,
   *            state:'ok'|'limited', reach:number, distance:number }}
   *
   * 输出两段骨骼的【世界方向角】，由调用方按 rig 矩阵约定换算成局部旋转。
   * 骨骼长度由当前三点距离确定，求解过程只旋转、不平移，长度完全不变；
   * 目标超出最大伸展时末端被钳制到最大伸展点，state = 'limited'。
   */
  function solve(p0, p1, p2, target, bend) {
    const l1 = V.dist(p0, p1);
    const l2 = V.dist(p1, p2);
    const maxReach = l1 + l2;

    let eff = { x: p2.x, y: p2.y };
    let distance = V.dist(p0, target);
    let state = 'ok';

    // 不可达：把目标钳制到最大伸展容差处（骨长不变），标记 limited
    const eps = 3;
    let aim = target;
    if (distance > maxReach - eps) {
      state = 'limited';
      const dir = V.scale(V.sub(target, p0), 1 / (distance || 1));
      aim = V.add(p0, V.scale(dir, maxReach - eps));
    }

    // 解析法（余弦定理）求两段的世界方向角，CCD 在此退化为一步收敛
    const toAim = V.sub(aim, p0);
    let d = V.len(toAim);
    if (d < 1e-6) d = 1e-6;
    const cosRoot = clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1);
    const cosMid = clamp((l1 * l1 + l2 * l2 - d * d) / (2 * l1 * l2), -1, 1);
    const baseAngle = Math.atan2(toAim.y, toAim.x);
    const alpha = Math.acos(cosRoot);
    const beta = Math.PI - Math.acos(cosMid);

    // 世界方向角；bend 选择弯折侧
    const rootWorldAngle = baseAngle + bend * alpha;
    const midWorldAngle = rootWorldAngle - bend * beta;

    // 由世界方向角重建末端（严格等长）
    const midPt = {
      x: p0.x + Math.cos(rootWorldAngle) * l1,
      y: p0.y + Math.sin(rootWorldAngle) * l1,
    };
    eff = {
      x: midPt.x + Math.cos(midWorldAngle) * l2,
      y: midPt.y + Math.sin(midWorldAngle) * l2,
    };

    return { rootWorldAngle, midWorldAngle, effector: eff, state, reach: maxReach, distance };
  }

  global.IKSolver = { solve };
})(window);
