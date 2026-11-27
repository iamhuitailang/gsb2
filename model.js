/*
 * Deterministic top-view two-axle grip rehearsal model.
 * Plain script (also CommonJS-exported for Node tests) so index.html works from file://.
 */
(function (root) {
  'use strict';

  const FRAME_DT = 1 / 60;
  const PHYS_DT = 1 / 240;
  const SUBSTEPS = 4;
  const G = 9.81;

  const SETUP_A = Object.freeze({
    id: 'A',
    label: 'A 运动胎 / 标准车',
    mass: 1350,
    cgToFront: 1.15,
    cgToRear: 1.45,
    cgHeight: 0.55,
    yawInertia: 1900,
    tireGrip: 1.0,
    maxSteerRad: 0.56,
    highSpeedSteerFactor: 1 / 22,
    engineForce: 5400,
    maxBrakeForce: 15200,
    frontBrakeBias: 0.78,
    frontDriveBias: 0.0,
    rearDriveBias: 1.0,
    wheelRadius: 0.32,
    axleWheelInertia: 2.2,
    aeroCdA: 0.62,
    rollingResistance: 0.014
  });

  const SETUP_B = Object.freeze({
    id: 'B',
    label: 'B 耐磨低抓胎 / 同车重',
    mass: 1350,
    cgToFront: 1.15,
    cgToRear: 1.45,
    cgHeight: 0.55,
    yawInertia: 1900,
    tireGrip: 0.76,
    maxSteerRad: 0.56,
    highSpeedSteerFactor: 1 / 22,
    engineForce: 5400,
    maxBrakeForce: 15200,
    frontBrakeBias: 0.78,
    frontDriveBias: 0.0,
    rearDriveBias: 1.0,
    wheelRadius: 0.32,
    axleWheelInertia: 2.2,
    aeroCdA: 0.62,
    rollingResistance: 0.014
  });

  const WORLD_CURVE = Object.freeze({
    bounds: { minX: -48, maxX: 52, minY: -34, maxY: 38 },
    defaultSurface: {
      id: 'dry',
      name: '高附着干地',
      kind: 'dry',
      mu: 0.95,
      color: '#cfc7b4'
    },
    zones: [
      {
        id: 'wet-curve',
        name: '低附着湿地',
        kind: 'wet',
        mu: 0.5,
        rect: { x: 0, y: -6.5, w: 15, h: 14 }
      }
    ],
    route: [
      { x: -42, y: -8 }, { x: -24, y: -8 }, { x: -8, y: -8 },
      { x: -2.2, y: -6.9 }, { x: 3.6, y: -3.8 }, { x: 8.9, y: 5.1 },
      { x: 10, y: 10 }, { x: 10, y: 28 }, { x: 10, y: 34 }
    ],
    arrows: [
      { x: -25, y: -8, angle: 0 },
      { x: 2.5, y: -4.2, angle: 0.62 },
      { x: 9.2, y: 5.5, angle: 1.18 },
      { x: 10, y: 22, angle: Math.PI / 2 }
    ]
  });

  const WORLD_BRAKE = Object.freeze({
    bounds: { minX: -50, maxX: 55, minY: -24, maxY: 24 },
    defaultSurface: {
      id: 'dry', name: '高附着干地', kind: 'dry', mu: 0.95, color: '#cfc7b4'
    },
    zones: [
      {
        id: 'wet-edge', name: '侧边湿地（样例不进入）', kind: 'wet', mu: 0.42,
        rect: { x: 18, y: -18, w: 16, h: 8 }
      }
    ],
    route: [
      { x: -44, y: 0 }, { x: -20, y: 0 }, { x: 8, y: 0 }, { x: 42, y: 0 }
    ],
    arrows: [
      { x: -24, y: 0, angle: 0 },
      { x: 8, y: 0, angle: 0 }
    ]
  });

  const WORLD_LAUNCH = Object.freeze({
    bounds: { minX: -50, maxX: 42, minY: -28, maxY: 24 },
    defaultSurface: {
      id: 'dry', name: '高附着干地', kind: 'dry', mu: 0.95, color: '#cfc7b4'
    },
    zones: [
      {
        id: 'wet-launch', name: '低附着起步板', kind: 'wet', mu: 0.34,
        rect: { x: -46, y: -7, w: 20, h: 14 }
      }
    ],
    route: [
      { x: -42, y: 0 }, { x: -24, y: 0 }, { x: 0, y: 0 }, { x: 34, y: 0 }
    ],
    arrows: [{ x: -31, y: 0, angle: 0 }, { x: -8, y: 0, angle: 0 }]
  });

  function deepFreezeWarn() { /* objects are plain data; structuredClone is used by callers */ }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function sign(v) { return v < 0 ? -1 : (v > 0 ? 1 : 0); }
  function clone(x) { return JSON.parse(JSON.stringify(x)); }

  function rectContains(rect, x, y) {
    return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
  }

  function surfaceAt(world, x, y) {
    for (let i = (world.zones || []).length - 1; i >= 0; i--) {
      const z = world.zones[i];
      if (rectContains(z.rect, x, y)) {
        return { id: z.id, name: z.name, kind: z.kind, mu: z.mu, zone: z };
      }
    }
    const d = world.defaultSurface;
    return { id: d.id, name: d.name, kind: d.kind || 'dry', mu: d.mu, zone: null };
  }

  function axlePositions(state, setup) {
    const c = Math.cos(state.h), s = Math.sin(state.h);
    return {
      front: { x: state.x + setup.cgToFront * c, y: state.y + setup.cgToFront * s },
      rear: { x: state.x - setup.cgToRear * c, y: state.y - setup.cgToRear * s }
    };
  }

  /*
   * Find the interpolation fraction [0,1] at which p0 -> p1 crosses a rectangle
   * boundary. Used only for reported boundary-crossing times.
   */
  function segmentRectCrossingFraction(p0, p1, rect, wantEnter) {
    const dx = p1.x - p0.x, dy = p1.y - p0.y;
    let best = null;
    const edges = [
      { axis: 'x', value: rect.x, lo: rect.y, hi: rect.y + rect.h },
      { axis: 'x', value: rect.x + rect.w, lo: rect.y, hi: rect.y + rect.h },
      { axis: 'y', value: rect.y, lo: rect.x, hi: rect.x + rect.w },
      { axis: 'y', value: rect.y + rect.h, lo: rect.x, hi: rect.x + rect.w }
    ];
    for (const e of edges) {
      let t;
      let along;
      if (e.axis === 'x') {
        if (Math.abs(dx) < 1e-12) continue;
        t = (e.value - p0.x) / dx;
        if (t < -1e-9 || t > 1 + 1e-9) continue;
        const y = p0.y + t * dy;
        along = y;
      } else {
        if (Math.abs(dy) < 1e-12) continue;
        t = (e.value - p0.y) / dy;
        if (t < -1e-9 || t > 1 + 1e-9) continue;
        const x = p0.x + t * dx;
        along = x;
      }
      if (along < e.lo - 1e-7 || along > e.hi + 1e-7) continue;
      t = clamp(t, 0, 1);
      const justBefore = { x: p0.x + (t - 1e-5) * dx, y: p0.y + (t - 1e-5) * dy };
      const justAfter = { x: p0.x + (t + 1e-5) * dx, y: p0.y + (t + 1e-5) * dy };
      const beforeIn = rectContains(rect, justBefore.x, justBefore.y);
      const afterIn = rectContains(rect, justAfter.x, justAfter.y);
      if (wantEnter && !beforeIn && afterIn) {
        if (best === null || t < best) best = t;
      } else if (!wantEnter && beforeIn && !afterIn) {
        if (best === null || t < best) best = t;
      }
    }
    return best;
  }

  function emptyInputFrame() {
    return { steer: 0, throttle: 0, brake: 0 };
  }

  function buildFrames(durationSeconds, fn) {
    const n = Math.round(durationSeconds / FRAME_DT);
    const frames = new Array(n);
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) * FRAME_DT;
      const v = fn(t, i) || {};
      frames[i] = {
        steer: clamp(Number(v.steer) || 0, -1, 1),
        throttle: clamp(Number(v.throttle) || 0, 0, 1),
        brake: clamp(Number(v.brake) || 0, 0, 1)
      };
    }
    return frames;
  }

  function ramp(t, start, end, lo, hi) {
    if (t <= start) return lo;
    if (t >= end) return hi;
    const k = (t - start) / (end - start);
    return lo + (hi - lo) * k;
  }

  function presetCases() {
    const crossFrames = buildFrames(9.5, (t) => {
      let steer = 0;
      steer = ramp(t, 2.1, 2.9, steer, 0.46);
      steer = ramp(t, 3.9, 5.0, steer, 0);
      // Lift shortly after turn-in so drive force does not hide the surface effect.
      const throttle = t < 2.6 ? 0.18 : 0;
      return { steer, throttle, brake: 0 };
    });

    const brakeFrames = buildFrames(8.0, (t) => {
      return {
        steer: 0,
        throttle: t < 0.55 ? 0.18 : 0,
        brake: t >= 0.75 ? 1 : 0
      };
    });

    const launchFrames = buildFrames(5.2, (t) => {
      return {
        steer: ramp(t, 0.7, 1.4, 0, 0.16),
        throttle: t < 3.2 ? 1 : 0,
        brake: t > 4.2 ? 0.55 : 0
      };
    });

    const turnBrakeFrames = buildFrames(7.0, (t) => {
      let steer = ramp(t, 0.7, 1.6, 0, 0.38);
      steer = ramp(t, 4.5, 5.5, steer, 0);
      return {
        steer,
        throttle: t < 1.6 ? 0.18 : 0,
        brake: t >= 2.3 ? 1 : 0
      };
    });

    return [
      {
        id: 'cross-curve',
        name: '跨路面弯道：前/后轴先后进湿地',
        badge: '跨路面弯道',
        description: '右转弯中穿过湿地矩形。注意前轴先跨越边界，约一个轴距之后后轴才进入；两轴处于不同 μ 时，仪表会分别变化。',
        config: {
          name: '跨路面弯道',
          scenarioId: 'cross-curve',
          world: clone(WORLD_CURVE),
          setupA: clone(SETUP_A),
          setupB: clone(SETUP_B),
          initial: { x: -34, y: -8, h: 0, speed: 9.0 },
          frameDt: FRAME_DT,
          physDt: PHYS_DT,
          substeps: SUBSTEPS
        },
        frames: crossFrames
      },
      {
        id: 'dry-brake',
        name: '干地刹车样例：高速直行全力制动',
        badge: '干地刹车',
        description: '干地 μ=0.95，初始约 76 km/h。前制动偏置和制动载荷转移使前轴利用率更高；B 配置可比较轮胎/车重影响。',
        config: {
          name: '干地刹车',
          scenarioId: 'dry-brake',
          world: clone(WORLD_BRAKE),
          setupA: clone(SETUP_A),
          setupB: clone(SETUP_B),
          initial: { x: -42, y: 0, h: 0, speed: 21.0 },
          frameDt: FRAME_DT,
          physDt: PHYS_DT,
          substeps: SUBSTEPS
        },
        frames: brakeFrames
      },
      {
        id: 'low-launch',
        name: '低速起步：湿地全油门',
        badge: '低速起步',
        description: '静止在低附着起步板上全油门。后驱设定下通常后轴先超过摩擦椭圆并持续滑转；离开湿地后抓地恢复。',
        config: {
          name: '低速起步',
          scenarioId: 'low-launch',
          world: clone(WORLD_LAUNCH),
          setupA: clone(SETUP_A),
          setupB: clone(SETUP_B),
          initial: { x: -40, y: 0, h: 0, speed: 0 },
          frameDt: FRAME_DT,
          physDt: PHYS_DT,
          substeps: SUBSTEPS
        },
        frames: launchFrames
      },
      {
        id: 'corner-brake',
        name: '弯中急刹：转弯需求上叠加全力制动',
        badge: '弯中急刹',
        description: '干地弯道中突然全力刹车。纵向和侧向力争夺同一摩擦圆；载荷前移通常让前轴先到极限并失去转向能力。',
        config: {
          name: '弯中急刹',
          scenarioId: 'corner-brake',
          // Reuse the geometric curve, but move the wet patch well behind the braking point.
          world: (() => {
            const w = clone(WORLD_CURVE);
            w.zones = [];
            return w;
          })(),
          setupA: clone(SETUP_A),
          setupB: clone(SETUP_B),
          initial: { x: -34, y: -8, h: 0, speed: 12.0 },
          frameDt: FRAME_DT,
          physDt: PHYS_DT,
          substeps: SUBSTEPS
        },
        frames: turnBrakeFrames
      }
    ];
  }

  function makeInitialState(config, setup) {
    const init = config.initial || {};
    const speed = Number(init.speed) || 0;
    return {
      x: Number(init.x) || 0,
      y: Number(init.y) || 0,
      h: Number(init.h) || 0,
      u: speed,
      v: 0,
      r: 0,
      kf: 0,
      kr: 0,
      ax: 0,
      ay: 0,
      stationaryTime: 0
    };
  }

  function gripCurve(slip, peak, slideValue, fullSlip) {
    const s = Math.abs(slip);
    if (s <= peak) return s / peak;
    const k = clamp((s - peak) / Math.max(1e-6, fullSlip - peak), 0, 1);
    return 1 + (slideValue - 1) * k;
  }

  function axlePhysics(state, input, setup, world, dt) {
    const L = setup.cgToFront + setup.cgToRear;
    const mass = setup.mass;

    // Longitudinal load transfer uses the previous step's body longitudinal acceleration.
    const transfer = mass * state.ax * setup.cgHeight / L;
    let nF = mass * G * setup.cgToRear / L - transfer;
    let nR = mass * G * setup.cgToFront / L + transfer;
    nF = clamp(nF, mass * G * 0.12, mass * G * 0.88);
    nR = clamp(nR, mass * G * 0.12, mass * G * 0.88);

    const pos = axlePositions(state, setup);
    const sf = surfaceAt(world, pos.front.x, pos.front.y);
    const sr = surfaceAt(world, pos.rear.x, pos.rear.y);
    const muF = sf.mu * setup.tireGrip;
    const muR = sr.mu * setup.tireGrip;
    const maxF = muF * nF;
    const maxR = muR * nR;

    const speedForSteer = Math.max(0, state.u);
    const steerMax = setup.maxSteerRad / (1 + speedForSteer * setup.highSpeedSteerFactor);
    const delta = input.steer * steerMax;
    const cd = Math.cos(delta), sd = Math.sin(delta);
    const ch = Math.cos(state.h), sh = Math.sin(state.h);

    // Body forward f=(ch,sh), driver-left l=(sh,-ch).
    const vLatPointF = state.v - setup.cgToFront * state.r;
    const vLatPointR = state.v + setup.cgToRear * state.r;

    // Front wheel-plane velocity.
    const uWheelF = state.u * cd - vLatPointF * sd;
    const vWheelF = state.u * sd + vLatPointF * cd;

    // Unregularized atan2 preserves force direction if a spin briefly points
    // an axle backwards through the body axis.
    const alphaF = Math.atan2(vWheelF, uWheelF);
    const alphaR = Math.atan2(vLatPointR, state.u);

    // Driver longitudinal force requests at each axle. Brake force opposes the
    // current contact-patch motion, including during a spin/reverse interval.
    const brakeDirF = Math.abs(uWheelF) > 0.25 ? sign(uWheelF) : 1;
    const brakeDirR = Math.abs(state.u) > 0.25 ? sign(state.u) : 1;
    const fxfCommand = input.throttle * setup.engineForce * setup.frontDriveBias -
      input.brake * setup.maxBrakeForce * setup.frontBrakeBias * brakeDirF;
    const fxrCommand = input.throttle * setup.engineForce * setup.rearDriveBias -
      input.brake * setup.maxBrakeForce * (1 - setup.frontBrakeBias) * brakeDirR;

    // Normalized brush-like lateral slip curve; peak then a modest sliding drop.
    const latGripF = gripCurve(alphaF, 0.115, 0.62, 0.48);
    const latGripR = gripCurve(alphaR, 0.115, 0.62, 0.48);

    const fyfRaw = -sign(alphaF) * latGripF * maxF;
    const fyrRaw = -sign(alphaR) * latGripR * maxR;

    const demandF = Math.hypot(fxfCommand / maxF, fyfRaw / maxF);
    const demandR = Math.hypot(fxrCommand / maxR, fyrRaw / maxR);
    const scaleF = demandF > 1 ? 1 / demandF : 1;
    const scaleR = demandR > 1 ? 1 / demandR : 1;
    const fxf = fxfCommand * scaleF;
    const fyfWheel = fyfRaw * scaleF;
    const fxr = fxrCommand * scaleR;
    const fyr = fyrRaw * scaleR;

    // Quasi-static longitudinal slip proxy. A request above the available
    // friction moves quickly from peak slip (~0.12) toward locked/spinning (1).
    function targetKappa(command, capacity, demand) {
      if (Math.abs(command) < 1) return 0;
      const longDemand = Math.abs(command) / capacity;
      const overload = Math.max(longDemand - 1, demand - 1, 0);
      if (overload <= 0.001) return sign(command) * 0.12 * clamp(longDemand, 0, 1);
      return sign(command) * clamp(0.12 + 0.88 * overload / 0.22, 0.12, 1);
    }
    const targetKF = targetKappa(fxfCommand, maxF, demandF);
    const targetKR = targetKappa(fxrCommand, maxR, demandR);
    // A small first-order rate keeps lock/spin onset readable frame-to-frame.
    const kRate = 1 - Math.exp(-18 * dt);
    const kappaF = state.kf + (targetKF - state.kf) * kRate;
    const kappaR = state.kr + (targetKR - state.kr) * kRate;

    // Convert front wheel-plane force into body forward/left components.
    const fxfBody = fxf * cd + fyfWheel * sd;
    const fyfBody = -fxf * sd + fyfWheel * cd;
    const fxrBody = fxr;
    const fyrBody = fyr;

    const aero = 0.5 * 1.225 * setup.aeroCdA * state.u * Math.abs(state.u);
    const roll = setup.rollingResistance * mass * G * sign(state.u);
    const resistance = -aero - roll;

    const fxTotal = fxfBody + fxrBody + resistance;
    const fyTotal = fyfBody + fyrBody;

    const rDot = (-setup.cgToFront * fyfBody + setup.cgToRear * fyrBody) / setup.yawInertia;
    const nextR = state.r + rDot * dt;

    // Apply force Euler, then rotate body components exactly. Plain explicit
    // Coriolis Euler adds energy when a spin makes |r*dt| non-negligible.
    const uForced = state.u + fxTotal / mass * dt;
    const vForced = state.v + fyTotal / mass * dt;
    const coriolisAngle = 0.5 * (state.r + nextR) * dt;
    const cc = Math.cos(coriolisAngle), ss = Math.sin(coriolisAngle);
    const nextU = uForced * cc - vForced * ss;
    const nextV = uForced * ss + vForced * cc;
    const nextH = state.h + nextR * dt;

    // Integrate position with the updated body velocities and midpoint-ish heading.
    const hForPos = state.h + nextR * dt * 0.5;
    const chp = Math.cos(hForPos), shp = Math.sin(hForPos);
    const nextX = state.x + (nextU * chp + nextV * shp) * dt;
    const nextY = state.y + (nextU * shp - nextV * chp) * dt;

    let outState = {
      ...state,
      x: nextX, y: nextY, h: nextH, u: nextU, v: nextV, r: nextR,
      kf: kappaF, kr: kappaR,
      ax: (nextU - state.u) / dt,
      ay: (nextV - state.v) / dt + state.r * state.u
    };

    // Stable full stop without residual rigid-body creep.
    const speed = Math.hypot(nextU, nextV);
    if (input.brake > 0.1 && speed < 0.45) {
      outState.u = 0; outState.v = 0; outState.r = 0;
      outState.kf = 0; outState.kr = 0;
      outState.ax = 0; outState.ay = 0;
      outState.stationaryTime = 0.2;
    } else if (speed < 0.18 && input.throttle < 0.02) {
      outState.stationaryTime = state.stationaryTime + dt;
      if (outState.stationaryTime > 0.18) {
        outState.u = 0; outState.v = 0; outState.r = 0;
        outState.kf = 0; outState.kr = 0;
        outState.ax = 0; outState.ay = 0;
      }
    } else {
      outState.stationaryTime = 0;
    }

    const slipScoreF = Math.max(Math.abs(kappaF) / 0.15, Math.abs(alphaF) / 0.12);
    const slipScoreR = Math.max(Math.abs(kappaR) / 0.15, Math.abs(alphaR) / 0.12);
    // Clear beyond-peak slip, or the friction ellipse is saturated at the peak edge.
    const lossF = Math.abs(kappaF) >= 0.3 || Math.abs(alphaF) >= 0.15 ||
      (slipScoreF >= 1.0 && demandF >= 0.985);
    const lossR = Math.abs(kappaR) >= 0.3 || Math.abs(alphaR) >= 0.15 ||
      (slipScoreR >= 1.0 && demandR >= 0.985);

    const telemetry = {
      delta,
      posBefore: pos,
      posAfter: axlePositions(outState, setup),
      nF, nR, muF, muR, maxF, maxR,
      surfaceF: sf.id, surfaceR: sr.id,
      surfaceNameF: sf.name, surfaceNameR: sr.name,
      kappaF, kappaR, alphaF, alphaR,
      demandF, demandR,
      utilizationF: clamp(demandF, 0, 1),
      utilizationR: clamp(demandR, 0, 1),
      slipScoreF: clamp(slipScoreF, 0, 2),
      slipScoreR: clamp(slipScoreR, 0, 2),
      fxf: fxfBody, fyf: fyfBody, fxr: fxrBody, fyr: fyrBody,
      lossF, lossR
    };

    return { state: outState, telemetry };
  }

  function detectCrossings(prevTel, tel, time, dt, world, events) {
    if (!prevTel) return;
    const axles = [
      { key: 'F', label: '前轴', before: prevTel.posAfter.front, now: tel.posAfter.front, prevSurface: prevTel.surfaceF },
      { key: 'R', label: '后轴', before: prevTel.posAfter.rear, now: tel.posAfter.rear, prevSurface: prevTel.surfaceR }
    ];
    for (const axle of axles) {
      const currentSurface = axle.key === 'F' ? tel.surfaceF : tel.surfaceR;
      if (currentSurface === axle.prevSurface) continue;
      // Find the relevant zone and a refined crossing fraction.
      for (const zone of world.zones || []) {
        const wasIn = axle.prevSurface === zone.id;
        const isIn = currentSurface === zone.id;
        if (wasIn === isIn) continue;
        const frac = segmentRectCrossingFraction(axle.before, axle.now, zone.rect, isIn);
        const f = frac === null ? 0.5 : frac;
        const p = {
          x: axle.before.x + (axle.now.x - axle.before.x) * f,
          y: axle.before.y + (axle.now.y - axle.before.y) * f
        };
        const prevMu = wasIn ? zone.mu : (world.defaultSurface.mu);
        const nextMu = isIn ? zone.mu : world.defaultSurface.mu;
        events.push({
          type: 'surface-crossing',
          time: +(time - dt + f * dt).toFixed(6),
          frameTime: +(time - dt + f * dt).toFixed(6),
          axle: axle.key,
          axleLabel: axle.label,
          zoneId: zone.id,
          zoneName: zone.name,
          direction: isIn ? 'enter' : 'leave',
          highToLow: isIn && prevMu - nextMu >= 0.2,
          prevMu, nextMu,
          x: +p.x.toFixed(4), y: +p.y.toFixed(4)
        });
      }
    }
  }

  function sampleFromState(state, tel, time, frameIndex) {
    const speed = Math.hypot(state.u, state.v);
    const movementAngle = Math.atan2(
      state.u * Math.sin(state.h) - state.v * Math.cos(state.h),
      state.u * Math.cos(state.h) + state.v * Math.sin(state.h)
    );
    return {
      frame: frameIndex,
      t: +time.toFixed(6),
      x: +state.x.toFixed(5),
      y: +state.y.toFixed(5),
      h: +state.h.toFixed(6),
      movementAngle: +movementAngle.toFixed(6),
      u: +state.u.toFixed(5),
      v: +state.v.toFixed(5),
      r: +state.r.toFixed(6),
      steerAngle: tel ? +tel.delta.toFixed(5) : 0,
      speed: +speed.toFixed(5),
      speedKmh: +(speed * 3.6).toFixed(3),
      kfState: +(state.kf || 0).toFixed(5),
      krState: +(state.kr || 0).toFixed(5),
      ax: +state.ax.toFixed(4),
      ay: +state.ay.toFixed(4),
      muF: tel ? +tel.muF.toFixed(3) : null,
      muR: tel ? +tel.muR.toFixed(3) : null,
      nF: tel ? +tel.nF.toFixed(1) : null,
      nR: tel ? +tel.nR.toFixed(1) : null,
      alphaF: tel ? +tel.alphaF.toFixed(5) : null,
      alphaR: tel ? +tel.alphaR.toFixed(5) : null,
      kappaF: tel ? +tel.kappaF.toFixed(5) : null,
      kappaR: tel ? +tel.kappaR.toFixed(5) : null,
      demandF: tel ? +tel.demandF.toFixed(4) : null,
      demandR: tel ? +tel.demandR.toFixed(4) : null,
      utilizationF: tel ? +tel.utilizationF.toFixed(4) : null,
      utilizationR: tel ? +tel.utilizationR.toFixed(4) : null,
      slipF: tel ? +tel.slipScoreF.toFixed(4) : null,
      slipR: tel ? +tel.slipScoreR.toFixed(4) : null,
      surfaceF: tel ? tel.surfaceF : null,
      surfaceR: tel ? tel.surfaceR : null,
      lossF: tel ? !!tel.lossF : false,
      lossR: tel ? !!tel.lossR : false
    };
  }

  function detectSituationMarkers(frames, events, samples) {
    let lowLaunchAdded = false;
    let turnBrakeAdded = false;
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      const t = i * FRAME_DT;
      const before = samples[Math.min(i, samples.length - 1)];
      if (!lowLaunchAdded && f.throttle >= 0.75 && before && before.speed < 3.0) {
        lowLaunchAdded = true;
        events.push({
          type: 'situation', subtype: 'low-speed-launch', time: +t.toFixed(6),
          label: '低速全油门起步', icon: '起'
        });
      }
      if (!turnBrakeAdded && f.brake >= 0.75 && Math.abs(f.steer) >= 0.30 && before && before.speed > 5.0) {
        turnBrakeAdded = true;
        events.push({
          type: 'situation', subtype: 'corner-hard-brake', time: +t.toFixed(6),
          label: '弯中急刹', icon: '刹'
        });
      }
    }
    // High-to-low crossings already carry the geometry marker; add a compact situation alias.
    for (const e of events.slice()) {
      if (e.type === 'surface-crossing' && e.highToLow && e.axle === 'F') {
        events.push({
          type: 'situation', subtype: 'high-to-low', time: e.time,
          label: '高抓地突然进入低抓地', icon: 'μ', x: e.x, y: e.y
        });
      }
    }
    events.sort((a, b) => a.time - b.time);
  }

  function firstLossEvent(samples) {
    // Require two consecutive frames to avoid single-step numerical chatter.
    for (let i = 2; i < samples.length; i++) {
      const s = samples[i];
      const prev = samples[i - 1];
      const f = s.lossF && prev.lossF;
      const r = s.lossR && prev.lossR;
      if (f || r) {
        let axle;
        if (f && r) axle = s.demandF - (prev.demandF || 0) >= s.demandR - (prev.demandR || 0) ? 'F' : 'R';
        else axle = f ? 'F' : 'R';
        return {
          type: 'first-loss',
          time: s.t,
          frame: s.frame,
          axle,
          axleLabel: axle === 'F' ? '前轴先失去抓地' : '后轴先失去抓地',
          x: s.x, y: s.y
        };
      }
    }
    return null;
  }

  function simulate(config, inputFrames, setupOverride) {
    const setup = setupOverride || config.setupA;
    const frameDt = config.frameDt || FRAME_DT;
    const physDt = config.physDt || PHYS_DT;
    const substeps = Math.max(1, Math.round(frameDt / physDt));
    const world = config.world;
    const frames = inputFrames && inputFrames.frames ? inputFrames.frames : inputFrames;

    let state = makeInitialState(config, setup);
    const samples = [sampleFromState(state, null, 0, 0)];
    const events = [];
    let prevTel = null;
    let lossStreakF = 0, lossStreakR = 0;
    let onsetF = null, onsetR = null, physicsFirstLoss = null;

    for (let i = 0; i < frames.length; i++) {
      const input = frames[i] || emptyInputFrame();
      let tel = null;
      for (let j = 0; j < substeps; j++) {
        const physTime = i * frameDt + (j + 1) * physDt;
        const result = axlePhysics(state, input, setup, world, physDt);
        state = result.state;
        if (j === substeps - 1) tel = result.telemetry;
        // Crossing detection at physics resolution uses consecutive telemetry-like positions.
        if (j > 0 || prevTel) detectCrossings(prevTel, result.telemetry, physTime, physDt, world, events);
        prevTel = result.telemetry;

        if (result.telemetry.lossF) {
          lossStreakF++;
          if (lossStreakF === 1) onsetF = { time: physTime, x: state.x, y: state.y };
        } else { lossStreakF = 0; onsetF = null; }
        if (result.telemetry.lossR) {
          lossStreakR++;
          if (lossStreakR === 1) onsetR = { time: physTime, x: state.x, y: state.y };
        } else { lossStreakR = 0; onsetR = null; }

        if (!physicsFirstLoss && (lossStreakF >= 2 || lossStreakR >= 2)) {
          let axle;
          if (lossStreakF >= 2 && lossStreakR >= 2) {
            axle = onsetF.time <= onsetR.time ? 'F' : 'R';
          } else {
            axle = lossStreakF >= 2 ? 'F' : 'R';
          }
          const onset = axle === 'F' ? onsetF : onsetR;
          physicsFirstLoss = {
            type: 'first-loss',
            time: +onset.time.toFixed(6),
            frame: Math.max(0, Math.round(onset.time / frameDt)),
            axle,
            axleLabel: axle === 'F' ? '前轴先失去抓地' : '后轴先失去抓地',
            x: +onset.x.toFixed(4),
            y: +onset.y.toFixed(4)
          };
          events.push(physicsFirstLoss);
        }
      }
      const time = (i + 1) * frameDt;
      samples.push(sampleFromState(state, tel, time, i + 1));
    }

    // Deduplicate repeated crossing events from adjacent substeps when refined fractions coincide.
    const crossings = [];
    for (const e of events) {
      if (e.type !== 'surface-crossing') { crossings.push(e); continue; }
      const dup = crossings.some(x => x.type === 'surface-crossing' && x.axle === e.axle &&
        x.zoneId === e.zoneId && x.direction === e.direction && Math.abs(x.time - e.time) < 0.012);
      if (!dup) crossings.push(e);
    }

    detectSituationMarkers(frames, crossings, samples);
    const firstLoss = crossings.find(e => e.type === 'first-loss') || firstLossEvent(samples);
    if (firstLoss && !crossings.some(e => e.type === 'first-loss')) crossings.push(firstLoss);
    crossings.sort((a, b) => a.time - b.time);

    const end = samples[samples.length - 1];
    const maxSlipF = samples.reduce((m, s) => Math.max(m, s.slipF || 0), 0);
    const maxSlipR = samples.reduce((m, s) => Math.max(m, s.slipR || 0), 0);
    return {
      setup: clone(setup),
      frameDt,
      physDt,
      samples,
      events: crossings,
      summary: {
        duration: end.t,
        distance: samples.reduce((d, s, i) => i ? d + Math.hypot(s.x - samples[i - 1].x, s.y - samples[i - 1].y) : 0, 0),
        endX: end.x, endY: end.y, endSpeedKmh: end.speedKmh,
        maxSpeedKmh: Math.max(...samples.map(s => s.speedKmh)),
        maxSlipF: +maxSlipF.toFixed(3),
        maxSlipR: +maxSlipR.toFixed(3),
        firstLoss
      }
    };
  }

  function framesToInputObject(frames) {
    return {
      frameDt: FRAME_DT,
      count: frames.length,
      steer: frames.map(f => +f.steer.toFixed(5)),
      throttle: frames.map(f => +f.throttle.toFixed(5)),
      brake: frames.map(f => +f.brake.toFixed(5))
    };
  }

  function inputObjectToFrames(input) {
    if (Array.isArray(input)) return input.map(f => ({ ...emptyInputFrame(), ...f }));
    if (!input) return [];
    if (Array.isArray(input.frames)) return input.frames.map(f => ({ ...emptyInputFrame(), ...f }));
    const n = Math.max(input.steer?.length || 0, input.throttle?.length || 0, input.brake?.length || 0);
    const frames = new Array(n);
    for (let i = 0; i < n; i++) {
      frames[i] = {
        steer: clamp(Number(input.steer?.[i]) || 0, -1, 1),
        throttle: clamp(Number(input.throttle?.[i]) || 0, 0, 1),
        brake: clamp(Number(input.brake?.[i]) || 0, 0, 1)
      };
    }
    return frames;
  }

  function makeTestCaseExport(presetOrConfig, frames, resultA, resultB) {
    const config = presetOrConfig.config || presetOrConfig;
    return {
      format: 'top-view-grip-rehearsal',
      version: 1,
      exportedAt: new Date().toISOString(),
      config: clone(config),
      input: framesToInputObject(frames),
      curves: {
        A: resultA ? { setup: resultA.setup, samples: resultA.samples, events: resultA.events, summary: resultA.summary } : null,
        B: resultB ? { setup: resultB.setup, samples: resultB.samples, events: resultB.events, summary: resultB.summary } : null
      },
      simplifications: SIMPLIFICATIONS
    };
  }

  const SIMPLIFICATIONS = [
    '只保留前后两个车轴的自行车模型，不分别计算四个车轮、左右载荷转移、侧倾和悬架运动。',
    '路面 μ 按前后轴中心的位置采样；矩形边界可给出车轴跨越时刻，但不模拟轮胎接地面尺寸。',
    '轮胎用力—滑移分段曲线加摩擦椭圆表示，未使用完整 Pacejka、温度、磨损、水膜和热衰减模型。',
    '制动未装 ABS、驱动未装 TCS/ESP，便于看清哪一轴先达到极限；真实车辆的电子系统会改变结果。',
    '载荷转移只考虑纵向，空气力仅用简化二次阻力；没有坡道、侧风、轮胎气压和转向系统柔性。',
    '结果用于设定之间的相对比较和几何预演，不应作为真实驾驶建议或精确动力学预测。'
  ];

  function deterministicHash(obj) {
    const str = JSON.stringify(obj);
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  function verifyImported(testCase) {
    const frames = inputObjectToFrames(testCase.input);
    const a = simulate(testCase.config, frames, testCase.config.setupA);
    const b = simulate(testCase.config, frames, testCase.config.setupB);
    const checks = [];
    if (testCase.curves?.A?.samples) {
      const exportedEnd = testCase.curves.A.samples[testCase.curves.A.samples.length - 1];
      const reproducedEnd = a.samples[a.samples.length - 1];
      checks.push({
        setup: 'A',
        sampleCountMatch: testCase.curves.A.samples.length === a.samples.length,
        endPositionError: Math.hypot(exportedEnd.x - reproducedEnd.x, exportedEnd.y - reproducedEnd.y),
        endSpeedError: Math.abs(exportedEnd.speed - reproducedEnd.speed),
        eventsMatch: JSON.stringify((testCase.curves.A.events || []).map(e => [e.type, e.time, e.axle])) ===
          JSON.stringify(a.events.map(e => [e.type, +e.time.toFixed(6), e.axle]))
      });
    }
    if (testCase.curves?.B?.samples) {
      const exportedEnd = testCase.curves.B.samples[testCase.curves.B.samples.length - 1];
      const reproducedEnd = b.samples[b.samples.length - 1];
      checks.push({
        setup: 'B',
        sampleCountMatch: testCase.curves.B.samples.length === b.samples.length,
        endPositionError: Math.hypot(exportedEnd.x - reproducedEnd.x, exportedEnd.y - reproducedEnd.y),
        endSpeedError: Math.abs(exportedEnd.speed - reproducedEnd.speed),
        eventsMatch: JSON.stringify((testCase.curves.B.events || []).map(e => [e.type, e.time, e.axle])) ===
          JSON.stringify(b.events.map(e => [e.type, +e.time.toFixed(6), e.axle]))
      });
    }
    return { frames, resultA: a, resultB: b, checks, hash: deterministicHash(testCase.config) };
  }

  const API = {
    FRAME_DT, PHYS_DT, SUBSTEPS, G,
    SETUP_A, SETUP_B,
    clamp, clone,
    surfaceAt, axlePositions, segmentRectCrossingFraction,
    buildFrames,
    presets: presetCases,
    makeInitialState,
    axlePhysics,
    sampleFromState,
    simulate,
    inputObjectToFrames,
    framesToInputObject,
    makeTestCaseExport,
    verifyImported,
    SIMPLIFICATIONS
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  root.VehicleSim = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
