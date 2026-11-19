/* 内置示例：几何拼贴角色 + 待机/行走两个循环动作，无需任何外部资源 */
(function (global) {
  'use strict';

  const { rad } = global.Math2D;

  /**
   * 用世界坐标的关节点定义骨骼，rest 局部平移 = 与父关节的差值
   * （示例静止姿势全部骨骼旋转为 0，层级仅由平移构成）
   */
  function buildSampleProject() {
    const project = global.Model.createProject();
    project.name = '示例角色（几何小人）';

    // [名称, 父名称, 世界坐标]
    const joints = [
      ['pelvis', null, [0, -140]],
      ['spine', 'pelvis', [0, -192]],
      ['chest', 'spine', [0, -238]],
      ['neck', 'chest', [0, -258]],
      ['head', 'neck', [0, -290]],
      ['shoulderL', 'chest', [-28, -228]],
      ['elbowL', 'shoulderL', [-72, -175]],
      ['wristL', 'elbowL', [-104, -132]],
      ['shoulderR', 'chest', [28, -228]],
      ['elbowR', 'shoulderR', [72, -175]],
      ['wristR', 'elbowR', [104, -132]],
      ['hipL', 'pelvis', [-22, -128]],
      ['kneeL', 'hipL', [-36, -68]],
      ['ankleL', 'kneeL', [-22, 0]],
      ['footL', 'ankleL', [-22, 16]],
      ['hipR', 'pelvis', [22, -128]],
      ['kneeR', 'hipR', [36, -68]],
      ['ankleR', 'kneeR', [22, 0]],
      ['footR', 'ankleR', [22, 16]],
    ];

    // 两级节点 rig 的静止姿势编码（IK 自洽约定）：
    // 子骨 rest 平移沿父 rotNode 局部 +x（长度=骨长，y=0），rest.rotation 编码段世界朝向。
    // FK：joint = 父rotNode · T(骨长,0)；rotNode = joint · R(局部旋转)。
    // 自顶向下把世界关节差换算进父级局部，取其长度与方向。
    const worldOf = {};
    const boneOf = {};
    for (const [name, parentName, pos] of joints) {
      const bone = global.Model.createBone(name, null);
      bone.name = name;
      worldOf[name] = { x: pos[0], y: pos[1] };
      boneOf[name] = bone;
      if (parentName) bone.parentId = boneOf[parentName].id;
      project.bones.push(bone);
    }
    const { M } = global.Math2D;
    const restRot = {};
    for (const [name, parentName, pos] of joints) {
      const bone = boneOf[name];
      if (!parentName) {
        bone.rest.x = pos[0];
        bone.rest.y = pos[1];
        bone.rest.rotation = 0;
        restRot[name] = M.translate(pos[0], pos[1]);
        continue;
      }
      const parentWorld = restRot[parentName];
      // 笛卡尔局部平移：两级 FK 用 T(x,y) 定位关节；段朝向由旋转节点 + 平移方向共同决定
      const local = M.apply(M.invert(parentWorld), worldOf[name]);
      bone.rest.x = local.x;
      bone.rest.y = local.y;
      bone.rest.rotation = 0;
      restRot[name] = M.multiply(parentWorld, M.translate(local.x, local.y));
    }

    /* ---------- 几何部件 ---------- */

    function addRect(name, boneName, w, h, offset, fill, stroke) {
      const part = global.Model.createPart(name, boneOf[boneName].id);
      part.shape.type = 'rect';
      part.shape.width = w;
      part.shape.height = h;
      part.offset = { x: offset[0], y: offset[1], rotation: offset[2] || 0, scaleX: 1, scaleY: 1 };
      part.fill = fill;
      part.stroke = stroke || '#10233d';
      project.parts.push(part);
      return part;
    }

    function addCircle(name, boneName, r, offset, fill) {
      const part = global.Model.createPart(name, boneOf[boneName].id);
      part.shape.type = 'circle';
      part.shape.radius = r;
      part.offset = { x: offset[0], y: offset[1], rotation: 0, scaleX: 1, scaleY: 1 };
      part.fill = fill;
      part.stroke = '#10233d';
      project.parts.push(part);
      return part;
    }

    /** 肢体部件：沿 from→to 关节方向生成矩形，自动计算相对骨骼的偏移与旋转 */
    function addLimb(name, boneName, fromName, toName, width, fill) {
      const from = worldOf[fromName], to = worldOf[toName];
      const origin = worldOf[boneName];
      const dx = to.x - from.x, dy = to.y - from.y;
      const len = Math.hypot(dx, dy);
      const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
      const part = global.Model.createPart(name, boneOf[boneName].id);
      part.shape.type = 'rect';
      part.shape.width = width;
      part.shape.height = len + 10;
      part.offset = {
        x: mid.x - origin.x,
        y: mid.y - origin.y,
        rotation: Math.atan2(dy, dx),
        scaleX: 1, scaleY: 1,
      };
      part.fill = fill;
      part.stroke = '#10233d';
      project.parts.push(part);
    }

    const SKIN = '#ffd9b3', SKIN_D = '#f0b98a';
    const SHIRT = '#4aa3ff', SHIRT_D = '#2f7fd6';
    const PANTS = '#6c7bd8', PANTS_D = '#4f5cb8';
    const SHOE = '#34405c';

    // 躯干（后层先添加，同级按数组顺序绘制）
    addRect('骨盆', 'pelvis', 72, 38, [0, 4], PANTS);
    addRect('躯干', 'chest', 78, 118, [0, 24], SHIRT);
    addRect('领口', 'neck', 20, 16, [0, 0], SHIRT_D);
    addCircle('头', 'head', 27, [0, -8], SKIN);
    addCircle('左眼', 'head', 3.6, [-10, -12], '#233049');
    addCircle('右眼', 'head', 3.6, [10, -12], '#233049');
    addLimb('左上臂', 'shoulderL', 'shoulderL', 'elbowL', 24, SHIRT);
    addLimb('左前臂', 'elbowL', 'elbowL', 'wristL', 21, SKIN);
    addLimb('右上臂', 'shoulderR', 'shoulderR', 'elbowR', 24, SHIRT);
    addLimb('右前臂', 'elbowR', 'elbowR', 'wristR', 21, SKIN);
    addCircle('左手', 'wristL', 11, [0, 0], SKIN_D);
    addCircle('右手', 'wristR', 11, [0, 0], SKIN_D);
    addLimb('左大腿', 'hipL', 'hipL', 'kneeL', 27, PANTS);
    addLimb('左小腿', 'kneeL', 'kneeL', 'ankleL', 24, PANTS_D);
    addLimb('右大腿', 'hipR', 'hipR', 'kneeR', 27, PANTS);
    addLimb('右小腿', 'kneeR', 'kneeR', 'ankleR', 24, PANTS_D);
    addRect('左脚', 'footL', 46, 17, [9, 2], SHOE);
    addRect('右脚', 'footR', 46, 17, [9, 2], SHOE);

    /* ---------- IK 约束 ---------- */

    function addIK(name, rootN, midN, effN, bend, enabled) {
      const c = global.Model.createIK(
        name, boneOf[rootN].id, boneOf[midN].id, boneOf[effN].id
      );
      c.bend = bend;
      c.enabled = enabled;
      // 静止目标取末端位置并沿 root→末端方向回收 8%，留出稳定可达余量，
      // 吸收 idle/walk 中骨盆起伏，避免正常动画误触发 limited
      const rootPos = worldOf[rootN];
      const effPos = worldOf[effN];
      const v = { x: effPos.x - rootPos.x, y: effPos.y - rootPos.y };
      const vl = Math.hypot(v.x, v.y) || 1;
      const pull = 0.08;
      c.target = {
        x: rootPos.x + v.x * (1 - pull),
        y: rootPos.y + v.y * (1 - pull),
      };
      project.ik.push(c);
      return c;
    }

    const ikLegL = addIK('左腿 IK', 'hipL', 'kneeL', 'ankleL', 1, true);
    const ikLegR = addIK('右腿 IK', 'hipR', 'kneeR', 'ankleR', 1, true);
    addIK('左臂 IK', 'shoulderL', 'elbowL', 'wristL', -1, false);
    addIK('右臂 IK', 'shoulderR', 'elbowR', 'wristR', -1, false);

    /* ---------- 动作一：待机（呼吸起伏 + 轻微摆动，12fps / 24 帧循环） ---------- */

    const idle = global.Model.createAnimation('待机 idle');
    idle.frameRate = 12;
    idle.frameCount = 24;
    idle.loop = true;
    project.animations.push(idle);

    const K = global.Model.putKey;
    // 骨盆上下呼吸（幅度控制在 IK 余量内，避免脚部目标越界）
    for (const [f, y] of [[0, 0], [6, -2], [12, 0], [18, -2], [24, 0]]) {
      K(idle, boneOf.pelvis.id, f, { y: boneOf.pelvis.rest.y + y });
    }
    // 胸腔与头部反向轻摆
    for (const [f, r] of [[0, 0], [6, 0.035], [12, 0], [18, -0.035], [24, 0]]) {
      K(idle, boneOf.chest.id, f, { rotation: r });
      K(idle, boneOf.head.id, f, { rotation: -r * 0.8 });
    }
    // 手臂自然轻晃
    K(idle, boneOf.shoulderL.id, 0, { rotation: 0.06 });
    K(idle, boneOf.shoulderL.id, 12, { rotation: -0.06 });
    K(idle, boneOf.shoulderL.id, 24, { rotation: 0.06 });
    K(idle, boneOf.shoulderR.id, 0, { rotation: -0.06 });
    K(idle, boneOf.shoulderR.id, 12, { rotation: 0.06 });
    K(idle, boneOf.shoulderR.id, 24, { rotation: -0.06 });
    // IK 目标只放静止关键帧：双脚稳稳钉在地面
    global.Model.putIKKey(idle, ikLegL.id, 0, ikLegL.target);
    global.Model.putIKKey(idle, ikLegR.id, 0, ikLegR.target);

    /* ---------- 动作二：行走（24fps / 24 帧循环，腿部走 IK，手臂 FK 摆动） ---------- */

    const walk = global.Model.createAnimation('行走 walk');
    walk.frameRate = 24;
    walk.frameCount = 24;
    walk.loop = true;
    project.animations.push(walk);

    // 骨盆起伏 + 轻微旋转
    for (const [f, y, r] of [
      [0, 0, 0], [6, 3, 0.04], [12, 0, 0], [18, 3, -0.04], [24, 0, 0],
    ]) {
      K(walk, boneOf.pelvis.id, f, {
        y: boneOf.pelvis.rest.y + y,
        rotation: r,
      });
    }
    // 上身略微前倾
    K(walk, boneOf.chest.id, 0, { rotation: 0.08 });
    // 头部保持稳定的小幅反向补偿
    K(walk, boneOf.head.id, 0, { rotation: -0.05 });
    K(walk, boneOf.head.id, 12, { rotation: 0.03 });
    K(walk, boneOf.head.id, 24, { rotation: -0.05 });

    // 手臂前后摆动（左右反相）
    const armSwing = [
      [0, 0.45], [12, -0.45], [24, 0.45],
    ];
    for (const [f, r] of armSwing) {
      K(walk, boneOf.shoulderL.id, f, { rotation: r });
      K(walk, boneOf.shoulderR.id, f, { rotation: -r });
    }
    K(walk, boneOf.elbowL.id, 0, { rotation: 0.35 });
    K(walk, boneOf.elbowL.id, 12, { rotation: 0.15 });
    K(walk, boneOf.elbowL.id, 24, { rotation: 0.35 });
    K(walk, boneOf.elbowR.id, 0, { rotation: 0.15 });
    K(walk, boneOf.elbowR.id, 12, { rotation: 0.35 });
    K(walk, boneOf.elbowR.id, 24, { rotation: 0.15 });

    // 脚部 IK 目标关键帧（世界坐标）：接触地面 -> 屈膝抬起 -> 落地
    // 接触帧用静止脚踝坐标（余量最大），抬起帧目标上移、距髋更近，始终可达
    global.Model.putIKKey(walk, ikLegL.id, 0, { ...ikLegL.target });
    global.Model.putIKKey(walk, ikLegL.id, 12, { x: -22, y: -40 });
    global.Model.putIKKey(walk, ikLegL.id, 24, { ...ikLegL.target });
    global.Model.putIKKey(walk, ikLegR.id, 0, { x: 22, y: -40 });
    global.Model.putIKKey(walk, ikLegR.id, 12, { ...ikLegR.target });
    global.Model.putIKKey(walk, ikLegR.id, 24, { x: 22, y: -40 });

    project.activeAnimId = idle.id;
    return project;
  }

  global.Sample = { buildSampleProject };
})(window);
