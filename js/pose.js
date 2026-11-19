/* 姿势求值：关键帧采样（连续插值）、FK 正运动学、IK 联动 */
(function (global) {
  'use strict';

  const { M, V, localMatrix, lerp, lerpAngle, clamp, ease, normalizeAngle } = global.Math2D;

  /** 在关键帧数组中采样，frame 为可能循环包裹后的时间；返回插值后的通道值 */
  function sampleChannel(keys, frame, frameCount, loop, restValue, channel, isAngle) {
    if (!keys || keys.length === 0) return restValue;
    const sorted = keys; // putKey 保证按 frame 升序
    if (keys.length === 1) {
      const v = keys[0][channel];
      return v === undefined ? restValue : v;
    }
    // 找到 frame 所在区间 [k0, k1]
    let k0 = null, k1 = null;
    for (let i = 0; i < sorted.length - 1; i += 1) {
      if (frame >= sorted[i].frame && frame <= sorted[i + 1].frame) {
        k0 = sorted[i]; k1 = sorted[i + 1]; break;
      }
    }
    if (!k0) {
      // 落在关键帧范围之外
      if (frame < sorted[0].frame) {
        const v = sorted[0][channel];
        return v === undefined ? restValue : v;
      }
      if (loop) {
        // 末帧 -> 首帧循环段
        k0 = sorted[sorted.length - 1];
        k1 = { ...sorted[0], frame: sorted[0].frame + frameCount };
      } else {
        const v = sorted[sorted.length - 1][channel];
        return v === undefined ? restValue : v;
      }
    }
    const v0 = k0[channel], v1 = k1[channel];
    if (v0 === undefined) return restValue;
    if (v1 === undefined) return v0;
    const span = k1.frame - k0.frame;
    const t = span <= 0 ? 0 : ease(k0.easing || 'linear', (frame - k0.frame) / span);
    return isAngle ? lerpAngle(v0, v1, t) : lerp(v0, v1, t);
  }

  /** 求某骨骼在指定帧的局部 TRS（未关键帧化的通道回退到静止姿势） */
  function sampleBoneLocal(project, anim, frame, bone) {
    const keys = anim && anim.keys[bone.id];
    const r = bone.rest;
    return {
      x: sampleChannel(keys, frame, anim.frameCount, anim.loop, r.x, 'x', false),
      y: sampleChannel(keys, frame, anim.frameCount, anim.loop, r.y, 'y', false),
      rotation: sampleChannel(keys, frame, anim.frameCount, anim.loop, r.rotation, 'rotation', true),
      scaleX: sampleChannel(keys, frame, anim.frameCount, anim.loop, r.scaleX, 'scaleX', false),
      scaleY: sampleChannel(keys, frame, anim.frameCount, anim.loop, r.scaleY, 'scaleY', false),
    };
  }

  /** IK 目标点采样（世界坐标，循环包裹） */
  function sampleIKTarget(anim, constraint, frame, loopFrame) {
    const keys = anim && anim.ikKeys[constraint.id];
    if (!keys || keys.length === 0) return { ...constraint.target };
    // 复用通道采样逻辑，构造伪 key 结构
    const fx = sampleChannel(keys, loopFrame, anim.frameCount, anim.loop, constraint.target.x, 'x', false);
    const fy = sampleChannel(keys, loopFrame, anim.frameCount, anim.loop, constraint.target.y, 'y', false);
    return { x: fx, y: fy };
  }

  /**
   * 一次完整 FK（两级节点 rig）。
   * 每根骨骼拆成两个逻辑节点：
   *   joint 节点 = 父级 rotNode · T(局部平移)  —— 决定关节世界位置，只受父级旋转影响；
   *   rotNode    = joint · R(局部旋转)·S(缩放) —— 决定本骨朝向，只影响子级关节。
   * 这样自身旋转不会移动自己的关节（避免双重旋转），骨长 = rest 平移的模恒定。
   * world 存 rotNode 矩阵（部件/子骨挂接用），worldPos 存关节世界坐标。
   */
  function forwardKinematics(project, locals) {
    const world = {};
    const worldPos = {};
    global.Model.walkBones(project, (bone) => {
      const t = locals[bone.id];
      const parentRot = bone.parentId ? world[bone.parentId] : M.identity();
      const joint = M.multiply(parentRot, M.translate(t.x, t.y));
      const rotNode = M.multiply(joint, M.multiply(M.rotate(t.rotation), M.scale(t.scaleX, t.scaleY)));
      world[bone.id] = rotNode;
      worldPos[bone.id] = M.getTranslation(joint);
    });
    return { world, worldPos };
  }

  /**
   * 完整姿势求值。
   * @param loopFrame 已按 loop 包裹到 [0, frameCount) 的帧（可带小数）
   */
  function evaluatePose(project, anim, loopFrame) {
    const locals = {};
    for (const bone of project.bones) {
      locals[bone.id] = sampleBoneLocal(project, anim, loopFrame, bone);
    }

    let fk = forwardKinematics(project, locals);
    const ikStates = {};
    const ikEffector = {};

    if (anim) {
      // IK 求解：世界空间解析法，逐约束处理，每次回写后重算 FK；两轮以覆盖链式依赖
      for (let pass = 0; pass < 2; pass += 1) {
        for (const c of project.ik) {
          if (!c.enabled) { ikStates[c.id] = 'disabled'; continue; }
          const root = global.Model.getBone(project, c.rootBoneId);
          const mid = global.Model.getBone(project, c.midBoneId);
          const eff = global.Model.getBone(project, c.effBoneId);
          if (!root || !mid || !eff) { ikStates[c.id] = 'invalid'; continue; }

          const targetWorld = sampleIKTarget(anim, c, loopFrame, loopFrame);
          const result = global.IKSolver.solve(
            fk.worldPos[root.id], fk.worldPos[mid.id], fk.worldPos[eff.id], targetWorld, c.bend
          );
          ikStates[c.id] = result.state;
          ikEffector[c.id] = result.effector;

          // 两级节点 rig（笛卡尔平移）。
          // 骨段方向 = 父 rotNode 世界角 + 本骨局部旋转 + 本骨静止平移方向角。
          // root 段（root→mid）的平移存在 mid.rest；mid 段（mid→eff）的平移存在 eff.rest。
          const rootParentAngle = root.parentId ? M.getRotation(fk.world[root.parentId]) : 0;
          const rootSegDir = Math.atan2(mid.rest.y, mid.rest.x);
          const midSegDir = Math.atan2(eff.rest.y, eff.rest.x);
          // 令 root 段世界方向 = rootWorldAngle
          locals[root.id].rotation = normalizeAngle(
            result.rootWorldAngle - rootParentAngle - rootSegDir
          );
          fk = forwardKinematics(project, locals);
          // root 旋转节点新世界角，作为 mid 的父级参考；令 mid 段世界方向 = midWorldAngle
          const rootRotWorldAfter = M.getRotation(fk.world[root.id]);
          locals[mid.id].rotation = normalizeAngle(
            result.midWorldAngle - rootRotWorldAfter - midSegDir
          );
          fk = forwardKinematics(project, locals);
        }
      }
    }

    // 部件世界矩阵
    const partWorld = {};
    for (const part of project.parts) {
      const parentWorld = part.boneId && fk.world[part.boneId]
        ? fk.world[part.boneId] : M.identity();
      partWorld[part.id] = M.multiply(parentWorld, localMatrix(part.offset));
    }

    return { locals, world: fk.world, worldPos: fk.worldPos, partWorld, ikStates, ikEffector };
  }

  /** 静止姿势求值（Setup 模式直接用 rest） */
  function evaluateRest(project) {
    const locals = {};
    for (const bone of project.bones) locals[bone.id] = { ...bone.rest };
    const fk = forwardKinematics(project, locals);
    const partWorld = {};
    for (const part of project.parts) {
      const parentWorld = part.boneId && fk.world[part.boneId]
        ? fk.world[part.boneId] : M.identity();
      partWorld[part.id] = M.multiply(parentWorld, localMatrix(part.offset));
    }
    return { locals, world: fk.world, worldPos: fk.worldPos, partWorld };
  }

  /** 循环包裹：把任意（含小数）帧映射到 [0, frameCount) */
  function wrapFrame(frame, frameCount, loop) {
    if (frameCount <= 0) return 0;
    if (!loop) return clamp(frame, 0, frameCount - 1);
    return ((frame % frameCount) + frameCount) % frameCount;
  }

  global.Pose = {
    sampleChannel, sampleBoneLocal, sampleIKTarget,
    forwardKinematics, evaluatePose, evaluateRest, wrapFrame,
  };
})(window);
