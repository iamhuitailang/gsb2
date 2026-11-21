/*
 * presets.js — 内置状态机配置、几何姿态与示例输入时间线
 */
(function (root) {
  const P = root.ASDebug = root.ASDebug || {};

  // 姿态字段（全部为数值，缺省 0）：
  // lean 躯干前倾角度 | legSpread 双腿开合角 | armSpread 双臂摆角
  // crouch 屈膝量 0..1 | tuck 空中收腿 0..1 | airborne 离地量 0..1
  const POSES = {
    idle:   { lean: 0, legSpread: 0, armSpread: 0, crouch: 0, tuck: 0, airborne: 0 },
    walkA:  { lean: 8, legSpread: 28, armSpread: 22, crouch: 0, tuck: 0, airborne: 0 },
    walkB:  { lean: 8, legSpread: -28, armSpread: -22, crouch: 0, tuck: 0, airborne: 0 },
    brakeA: { lean: 8, legSpread: 28, armSpread: 22, crouch: 0, tuck: 0, airborne: 0 },
    brakeB: { lean: -12, legSpread: 0, armSpread: 0, crouch: 0.75, tuck: 0, airborne: 0 },
    jCrouch:{ lean: 6, legSpread: 0, armSpread: 0, crouch: 0.85, tuck: 0, airborne: 0 },
    jAir:   { lean: 6, legSpread: 10, armSpread: 14, crouch: 0, tuck: 0.65, airborne: 1 },
    jFall:  { lean: 4, legSpread: 18, armSpread: 26, crouch: 0, tuck: 0, airborne: 1 },
    jLand:  { lean: 4, legSpread: 0, armSpread: 0, crouch: 0.6, tuck: 0, airborne: 0 },
    landUp: { lean: 0, legSpread: 0, armSpread: 0, crouch: 0, tuck: 0, airborne: 0 },
    hurt:   { lean: -20, legSpread: 14, armSpread: 30, crouch: 0.4, tuck: 0, airborne: 0 },
  };
  const kf = (t, pose) => ({ t, pose });

  function baseStates() {
    return [
      { id: 'idle', name: '站立', duration: 0, loop: true, keyframes: [kf(0, POSES.idle)] },
      {
        id: 'walk', name: '走路', duration: 0.6, loop: true,
        keyframes: [kf(0, POSES.walkA), kf(0.5, POSES.walkB), kf(1, POSES.walkA)],
      },
      {
        id: 'brake', name: '刹停', duration: 0.25, loop: false,
        keyframes: [kf(0, POSES.brakeA), kf(1, POSES.brakeB)],
      },
      {
        id: 'jump', name: '起跳', duration: 0.7, loop: false,
        keyframes: [kf(0, POSES.jCrouch), kf(0.25, POSES.jAir), kf(0.7, POSES.jFall), kf(1, POSES.jLand)],
      },
      {
        id: 'fall', name: '早松键坠落', duration: 0.4, loop: false,
        keyframes: [kf(0, POSES.jAir), kf(1, POSES.jFall)],
      },
      {
        id: 'land', name: '落地', duration: 0.15, loop: false,
        keyframes: [kf(0, POSES.jLand), kf(1, POSES.landUp)],
      },
      // 无任何入边：用于演示“永远进不去的状态”静态检查
      { id: 'hurt', name: '受击(不可达示例)', duration: 0.4, loop: false, keyframes: [kf(0, POSES.hurt)] },
    ];
  }

  const BUTTONS = [
    { id: 'move', name: '移动键', color: '#4ea1ff' },
    { id: 'jump', name: '跳跃键', color: '#ffb84e' },
  ];

  const G = {
    pressMove: { kind: 'btn-press', button: 'move' },
    upMove: { kind: 'btn-up', button: 'move' },
    pressJump: { kind: 'btn-press', button: 'jump' },
    releaseJump: { kind: 'btn-release', button: 'jump' },
    finished: { kind: 'state-finished' },
  };

  let seq = 0;
  function tr(partial) {
    return Object.assign({
      id: 't' + (++seq),
      name: partial.name || '',
      from: '', to: '',
      gates: [],
      priority: 5,
      enabled: true,
      blendDuration: 0.1,
      interruptible: false,
      blockMode: 'discard',   // discard | queue
      queueMaxWait: 0.5,
    }, partial);
  }

  // 配置 A：基线——长混合、不可打断、多余请求直接丢
  function configA() {
    seq = 0;
    return {
      id: 'A',
      name: 'A · 基线（不可打断，请求丢弃）',
      initialState: 'idle',
      buttons: BUTTONS.map((b) => ({ ...b })),
      states: baseStates(),
      transitions: [
        tr({ name: '站立→走路', from: 'idle', to: 'walk', gates: [G.pressMove], priority: 5, blendDuration: 0.08 }),
        tr({ name: '站立→起跳', from: 'idle', to: 'jump', gates: [G.pressJump], priority: 10, blendDuration: 0.12, interruptible: true, blockMode: 'discard' }),
        tr({ name: '走路→刹停', from: 'walk', to: 'brake', gates: [G.upMove], priority: 5, blendDuration: 0.1, interruptible: false, blockMode: 'discard' }),
        tr({ name: '刹停→走路', from: 'brake', to: 'walk', gates: [G.pressMove], priority: 5, blendDuration: 0.1, interruptible: false, blockMode: 'discard' }),
        tr({ name: '走路→起跳', from: 'walk', to: 'jump', gates: [G.pressJump], priority: 10, blendDuration: 0.12, interruptible: true, blockMode: 'discard' }),
        tr({ name: '刹停→起跳', from: 'brake', to: 'jump', gates: [G.pressJump], priority: 10, blendDuration: 0.12, interruptible: true, blockMode: 'discard' }),
        tr({ name: '起跳→早松坠落', from: 'jump', to: 'fall', gates: [G.releaseJump], priority: 8, blendDuration: 0.08, interruptible: true }),
        tr({ name: '起跳→落地', from: 'jump', to: 'land', gates: [G.finished], priority: 1, blendDuration: 0.05 }),
        tr({ name: '坠落→落地', from: 'fall', to: 'land', gates: [G.finished], priority: 1, blendDuration: 0.05 }),
        tr({ name: '落地→站立', from: 'land', to: 'idle', gates: [G.finished], priority: 1, blendDuration: 0.05 }),
        tr({ name: '刹停→站立', from: 'brake', to: 'idle', gates: [G.finished], priority: 1, blendDuration: 0.05 }),
      ],
    };
  }

  // 配置 B：快响应——短混合、可打断、不可立即受理的请求排队等待
  function configB() {
    const cfg = configA();
    cfg.id = 'B';
    cfg.name = 'B · 快响应（可打断，请求排队）';
    const byName = (n) => cfg.transitions.find((t) => t.name === n);
    Object.assign(byName('走路→刹停'), { blendDuration: 0.06, interruptible: true });
    // 即时触发看按下沿；排队后的受理看电平（按住中），避免沿在等待期被消费
    Object.assign(byName('站立→走路'), {
      acceptGates: [{ kind: 'btn-held', button: 'move' }],
      blockMode: 'queue', queueMaxWait: 0.4,
    });
    // 排队请求等混合结束后按电平（按住中）受理，避免按下沿已被消费
    Object.assign(byName('刹停→走路'), {
      gates: [{ kind: 'btn-held', button: 'move' }],
      acceptGates: [{ kind: 'btn-held', button: 'move' }],
      blendDuration: 0.06, interruptible: true, blockMode: 'queue', queueMaxWait: 0.4,
    });
    Object.assign(byName('走路→起跳'), { blendDuration: 0.05, blockMode: 'queue', queueMaxWait: 0.4 });
    Object.assign(byName('刹停→起跳'), { blendDuration: 0.05, blockMode: 'queue', queueMaxWait: 0.4 });
    Object.assign(byName('站立→起跳'), { blendDuration: 0.05, blockMode: 'queue', queueMaxWait: 0.4 });
    Object.assign(byName('起跳→落地'), { blendDuration: 0.03 });
    return cfg;
  }

  // 配置 C：故意制造条件遮蔽——演示“永远进不去”的切换
  function configC() {
    const cfg = configA();
    cfg.id = 'C';
    cfg.name = 'C · 问题配置（高优先级条件遮蔽刹停）';
    cfg.transitions.push(tr({
      name: '走路→站立(抢占)', from: 'walk', to: 'idle',
      gates: [{ kind: 'btn-up', button: 'move' }],
      priority: 20, blendDuration: 0.05,
    }));
    return cfg;
  }

  // 示例输入时间线（秒，循环播放）
  const TIMELINES = {
    movingJump: {
      id: 'movingJump',
      name: '移动中起跳',
      loopSec: 3,
      intervals: [
        { button: 'move', start: 0.2, end: 2.5 },
        { button: 'jump', start: 0.9, end: 1.0 },
        { button: 'jump', start: 1.9, end: 2.0 },
      ],
    },
    earlyRelease: {
      id: 'earlyRelease',
      name: '过早松键',
      loopSec: 3.2,
      intervals: [
        { button: 'move', start: 0.3, end: 0.75 },
        { button: 'jump', start: 0.55, end: 0.62 },   // 起跳后很快松开 jump → 坠落
        { button: 'move', start: 1.6, end: 2.4 },
        { button: 'jump', start: 1.75, end: 1.85 },
      ],
    },
    brakeQueue: {
      id: 'brakeQueue',
      name: '刹停混合期再按移动（丢弃 vs 打断）',
      loopSec: 3,
      intervals: [
        { button: 'move', start: 0.3, end: 1.0 },
        { button: 'move', start: 1.05, end: 2.3 },    // 0.05s 空隙，正落在刹停混合期内
      ],
    },
    walkQueue: {
      id: 'walkQueue',
      name: '落地混合期按移动（丢弃 vs 排队）',
      loopSec: 3,
      intervals: [
        { button: 'move', start: 0.2, end: 0.45 },
        { button: 'jump', start: 0.35, end: 0.45 },       // walk 中起跳
        // jump 0.7s + land 0.15s；1.033s 正落在 land→idle 不可打断混合期（1.017–1.067）
        { button: 'move', start: 1.033, end: 2.4 },
      ],
    },
  };

  P.Presets = { configA, configB, configC, TIMELINES, POSES, BUTTONS };
})(typeof self !== 'undefined' ? self : this);
