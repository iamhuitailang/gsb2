/* 项目数据模型：纯 JSON 结构、层级工具、ID 生成、增删改查 */
(function (global) {
  'use strict';

  const { M } = global.Math2D;

  let _idCounter = 1;
  function uid(prefix) {
    _idCounter += 1;
    return prefix + '_' + Date.now().toString(36) + '_' + _idCounter;
  }

  function createProject() {
    return {
      formatVersion: 1,
      name: '未命名项目',
      bones: [],      // 骨骼数组，数组顺序同时决定同级绘制顺序（zOrder）
      parts: [],      // 图片/几何部件
      images: [],     // 内嵌图片资源（dataURL）
      ik: [],         // IK 约束
      animations: [],
      activeAnimId: null,
    };
  }

  function createBone(name, parentId) {
    return {
      id: uid('bone'),
      name: name || '骨骼',
      parentId: parentId || null,
      // 静止姿势（Setup 模式编辑的基准姿势），相对父骨骼的局部变换
      rest: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
      // 关节显示半径（编辑器用）
      jointRadius: 6,
    };
  }

  function createPart(name, boneId) {
    return {
      id: uid('part'),
      name: name || '部件',
      boneId: boneId || null,
      shape: {
        type: 'rect',                 // rect | circle | polygon | image
        width: 60,
        height: 60,
        radius: 30,                   // circle 用
        points: [],                   // polygon 用，局部坐标
        imageId: null,                // image 用，引用 project.images[].id
      },
      // 相对所绑骨骼的局部偏移
      offset: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
      fill: '#4aa3ff',
      stroke: '#dceaff',
      visible: true,
      opacity: 1,
    };
  }

  function createImage(name, src, width, height) {
    return { id: uid('img'), name: name || '图片', src, width, height };
  }

  function createAnimation(name) {
    return {
      id: uid('anim'),
      name: name || '新动作',
      frameRate: 24,
      frameCount: 24,
      loop: true,
      // 每骨骼每帧的关键帧：keys[boneId] = [{frame, x,y,rotation,scaleX,scaleY, easing}]
      keys: {},
      // IK 目标关键帧：ikKeys[constraintId] = [{frame, x, y, easing}]（世界坐标）
      ikKeys: {},
    };
  }

  function createIK(name, rootBoneId, midBoneId, effBoneId) {
    return {
      id: uid('ik'),
      name: name || 'IK 约束',
      rootBoneId,
      midBoneId,
      effBoneId,
      enabled: true,
      bend: 1,                 // 1 或 -1，弯曲方向
      target: { x: 0, y: 0 },  // 静止姿势下的目标点（世界坐标）
      // 最近一次求解的状态：ok | limited（无法满足时为 limited）
      state: 'ok',
    };
  }

  /* ---------------- 层级工具 ---------------- */

  function getBone(project, id) {
    return project.bones.find((b) => b.id === id) || null;
  }

  function childrenOf(project, parentId) {
    return project.bones.filter((b) => b.parentId === parentId);
  }

  function rootBones(project) {
    return project.bones.filter((b) => !b.parentId);
  }

  /** 深度优先的骨骼遍历（父先于子） */
  function walkBones(project, cb) {
    function visit(parentId) {
      for (const b of childrenOf(project, parentId)) {
        cb(b);
        visit(b.id);
      }
    }
    visit(null);
  }

  /** 从根到该骨骼的祖先链（含自身） */
  function boneChain(project, boneId) {
    const chain = [];
    let cur = getBone(project, boneId);
    while (cur) {
      chain.unshift(cur);
      cur = cur.parentId ? getBone(project, cur.parentId) : null;
    }
    return chain;
  }

  function isDescendant(project, ancestorId, boneId) {
    let cur = getBone(project, boneId);
    while (cur) {
      if (cur.id === ancestorId) return true;
      cur = cur.parentId ? getBone(project, cur.parentId) : null;
    }
    return false;
  }

  /**
   * 重设父级：保持关节世界位置不变（newParentId 为 null 表示挂到根）。
   * 两级节点 rig：joint = 父 rotNode · T(rest.x, rest.y)，
   * 新局部平移即父 rotNode 逆变换后的笛卡尔坐标；旋转/缩放独立保留。
   */
  function reparentBone(project, boneId, newParentId, fkResult) {
    const bone = getBone(project, boneId);
    if (!bone || bone.id === newParentId) return;
    if (newParentId && isDescendant(project, boneId, newParentId)) return;
    const worldPos = fkResult.worldPos[boneId] || { x: 0, y: 0 };
    const parentRotNode = newParentId ? fkResult.world[newParentId] : M.identity();
    const local = M.apply(M.invert(parentRotNode), worldPos);
    const keepRotation = bone.rest.rotation;
    const keepScaleX = bone.rest.scaleX;
    const keepScaleY = bone.rest.scaleY;
    bone.parentId = newParentId;
    bone.rest = {
      x: local.x, y: local.y,
      rotation: newParentId ? keepRotation : 0,
      scaleX: keepScaleX, scaleY: keepScaleY,
    };
  }

  /** 同级内调整顺序（zOrder / 绘制顺序） */
  function reorderBone(project, boneId, dir) {
    const b = getBone(project, boneId);
    if (!b) return;
    const siblings = childrenOf(project, b.parentId);
    const i = siblings.findIndex((s) => s.id === boneId);
    const j = i + dir;
    if (j < 0 || j >= siblings.length) return;
    const ai = project.bones.indexOf(b);
    const bj = siblings[j];
    const aj = project.bones.indexOf(bj);
    project.bones.splice(ai, 1);
    project.bones.splice(aj, 0, b);
  }

  function removeBone(project, boneId) {
    // 子骨骼提升到被删骨骼的父级
    const bone = getBone(project, boneId);
    if (!bone) return;
    for (const child of childrenOf(project, boneId)) {
      child.parentId = bone.parentId;
    }
    project.bones = project.bones.filter((b) => b.id !== boneId);
    // 绑定到该骨骼的部件改绑到父骨骼（无父则置空）
    for (const p of project.parts) {
      if (p.boneId === boneId) p.boneId = bone.parentId;
    }
    // 引用该骨骼的 IK 约束一并删除
    project.ik = project.ik.filter(
      (c) => c.rootBoneId !== boneId && c.midBoneId !== boneId && c.effBoneId !== boneId
    );
    for (const anim of project.animations) {
      delete anim.keys[boneId];
    }
  }

  function getPart(project, id) {
    return project.parts.find((p) => p.id === id) || null;
  }

  function removePart(project, partId) {
    project.parts = project.parts.filter((p) => p.id !== partId);
  }

  /* ---------------- 关键帧工具 ---------------- */

  function getKeys(anim, boneId) {
    if (!anim.keys[boneId]) anim.keys[boneId] = [];
    return anim.keys[boneId];
  }

  function findKeyIndex(keys, frame) {
    return keys.findIndex((k) => k.frame === frame);
  }

  /** 写入/更新某骨骼在某帧的关键帧，channels 为部分通道对象 */
  function putKey(anim, boneId, frame, channels) {
    const keys = getKeys(anim, boneId);
    let i = findKeyIndex(keys, frame);
    if (i < 0) {
      i = 0;
      while (i < keys.length && keys[i].frame < frame) i += 1;
      keys.splice(i, 0, { frame, easing: 'linear', ...channels });
    } else {
      Object.assign(keys[i], channels);
    }
    return keys[i];
  }

  function removeKeyAt(anim, boneId, frame) {
    const keys = getKeys(anim, boneId);
    const i = findKeyIndex(keys, frame);
    if (i >= 0) keys.splice(i, 1);
  }

  function getIKKeys(anim, constraintId) {
    if (!anim.ikKeys[constraintId]) anim.ikKeys[constraintId] = [];
    return anim.ikKeys[constraintId];
  }

  function putIKKey(anim, constraintId, frame, target) {
    const keys = getIKKeys(anim, constraintId);
    let i = keys.findIndex((k) => k.frame === frame);
    if (i < 0) {
      i = 0;
      while (i < keys.length && keys[i].frame < frame) i += 1;
      keys.splice(i, 0, { frame, x: target.x, y: target.y, easing: 'linear' });
    } else {
      keys[i].x = target.x;
      keys[i].y = target.y;
    }
  }

  function removeIKKeyAt(anim, constraintId, frame) {
    const keys = getIKKeys(anim, constraintId);
    const i = keys.findIndex((k) => k.frame === frame);
    if (i >= 0) keys.splice(i, 1);
  }

  global.Model = {
    uid,
    createProject, createBone, createPart, createImage, createAnimation, createIK,
    getBone, childrenOf, rootBones, walkBones, boneChain, isDescendant,
    reparentBone, reorderBone, removeBone,
    getPart, removePart,
    getKeys, findKeyIndex, putKey, removeKeyAt,
    getIKKeys, putIKKey, removeIKKeyAt,
  };
})(window);
