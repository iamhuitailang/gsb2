/* 角色物理引擎：固定步长、确定性。可达性分析与键盘试玩调用同一个 step()，
   因此分析器预演的轨迹就是试玩里用同样输入能复现的轨迹。 */
(function () {
  const JR = (window.JR = window.JR || {});
  const { moveAxis, findGroundAt } = JR.geom;
  const C = JR.C;

  function spawnState(level, params) {
    const start = level.entities.find((e) => e.type === 'start');
    const x = start ? start.x + 4 : 40;
    let y;
    let groundId = null;
    if (start) {
      // 站到起跳区域水平范围内、顶面位于区域内的最高实心平台上；
      // 区域内没有平台时才使用区域底部（悬空出生，直接自由下落）
      const candidates = JR.geom
        .solids(level)
        .filter((s) => s.x < start.x + start.w && s.x + s.w > start.x && s.y >= start.y - 1 && s.y <= start.y + start.h + 1)
        .sort((a, b) => a.y - b.y);
      if (candidates.length) {
        y = candidates[0].y - params.height - 0.01;
        groundId = candidates[0].id;
      } else {
        y = start.y + start.h - params.height;
      }
    } else {
      y = 40;
    }
    return {
      x,
      y,
      w: params.width,
      h: params.height,
      vx: 0,
      vy: 0,
      grounded: groundId !== null,
      groundId,
      facing: 1,
      jumpHold: 0, // 当前跳跃键已按住时长
      jumpHeld: false,
      coyote: groundId !== null ? 0.08 : 0, // 土狼时间余量（秒）
      dropTimer: 0, // 按下方向下穿薄平台的计时
      time: 0,
    };
  }

  function approach(v, target, maxDelta) {
    if (v < target) return Math.min(v + maxDelta, target);
    if (v > target) return Math.max(v - maxDelta, target);
    return v;
  }

  /* input: { left, right, jumpHeld, jumpPressed, drop }
     jumpPressed 仅在按下那一帧为 true；jumpHeld 期间持续给上升加速（maxHold 窗口内）。 */
  function step(level, params, st, input) {
    const dt = C.DT;
    const events = [];
    st.time += dt;

    // --- 起跳（含土狼时间 0.08s） ---
    if (input.jumpPressed && (st.grounded || st.coyote > 0)) {
      st.vy = -params.jumpSpeed;
      st.grounded = false;
      st.groundId = null;
      st.coyote = 0;
      st.jumpHold = 0;
      st.jumpHeld = true;
      events.push({ kind: 'jump', t: st.time });
    }

    // --- 可变跳高：按住则在 maxHold 窗口内抵消部分重力，松开则 jumpCut 截断 ---
    if (st.jumpHeld && input.jumpHeld && st.vy < 0 && st.jumpHold < params.maxHold) {
      st.jumpHold += dt;
      st.vy -= params.gravity * 0.55 * dt; // 按住时重力减弱，形成更高的弧线
    } else if (st.jumpHeld && !input.jumpHeld && st.vy < 0) {
      st.vy *= params.jumpCut;
      st.jumpHeld = false;
    }
    if (st.jumpHold >= params.maxHold) st.jumpHeld = false;

    // --- 重力 ---
    st.vy += params.gravity * dt;
    st.vy = Math.min(st.vy, 1400);

    // --- 水平加速/摩擦（地面与空中不同参数） ---
    const dir = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    if (dir !== 0) {
      st.facing = dir;
      const accel = st.grounded ? params.groundAccel : params.airAccel;
      st.vx = approach(st.vx, dir * params.moveSpeed, accel * dt);
    } else {
      const fric = st.grounded ? params.groundFriction : params.airFriction;
      st.vx = approach(st.vx, 0, fric * dt);
    }

    // --- 下穿薄平台 ---
    if (input.drop && st.grounded) {
      const ent = level.entities.find((e) => e.id === st.groundId);
      if (ent && ent.oneWay) {
        st.dropTimer = 0.15;
        st.grounded = false;
        st.groundId = null;
      }
    }
    if (st.dropTimer > 0) st.dropTimer -= dt;

    // --- 分轴 swept AABB 移动（先水平后垂直，与主流平台游戏一致） ---
    const box = { x: st.x, y: st.y, w: st.w, h: st.h };
    const hx = moveAxis(level, box, st.vx * dt, 0);
    box.x = hx.x;
    if (hx.events.some((e) => e.kind === 'wall')) st.vx = 0;
    events.push(...hx.events);

    const vy = moveAxis(level, box, 0, st.vy * dt);
    box.y = vy.y;
    for (const ev of vy.events) {
      if (ev.kind === 'land') st.vy = 0;
      if (ev.kind === 'bonk') {
        st.vy = Math.max(0, st.vy); // 撞头：上升速度清零，立即转为下落
        st.jumpHeld = false;
      }
      events.push(ev);
    }

    st.x = box.x;
    st.y = box.y;

    /* 地面状态只由本帧垂直移动的碰撞结果决定，不做"吸附式"复检，
       避免起跳后被错误拉回平台。滑出边缘靠下一帧自然下落体现。
       例外：出生后第一帧（time≈dt 且本帧已起跳）保留跳跃产生的悬空状态。 */
    const landEv = vy.events.find((e) => e.kind === 'land');
    const justJumped = events.some((e) => e.kind === 'jump');
    st.grounded = false;
    st.groundId = null;
    if (landEv && !justJumped && st.dropTimer <= 0 && JR.geom.hasSupport(level, box, landEv.entityId)) {
      st.grounded = true;
      st.groundId = landEv.entityId;
    } else if (landEv && !justJumped && st.dropTimer <= 0) {
      events.push({ kind: 'edgeSlip', entityId: landEv.entityId, t: st.time });
    }

    if (st.grounded) st.coyote = 0.08;
    else st.coyote = Math.max(0, st.coyote - dt);

    return events;
  }

  /* 跑一条完整输入序列，记录逐帧轨迹与事件，返回结构化结果。 */
  function simulate(level, params, initial, inputGen, opts = {}) {
    const st = initial ? JSON.parse(JSON.stringify(initial)) : spawnState(level, params);
    st.w = params.width;
    st.h = params.height;
    const frames = [snapshot(st)];
    const events = [];
    const maxSteps = Math.floor((opts.maxSeconds || C.MAX_SIM_SECONDS) / C.DT);
    const floorY = Math.max(0, ...JR.geom.solids(level).map((s) => s.y + s.h)) + C.FALL_MARGIN;

    for (let i = 0; i < maxSteps; i++) {
      const input = inputGen(i, st);
      const evs = step(level, params, st, input);
      for (const e of evs) {
        e.t = st.time;
        events.push(e);
      }
      frames.push(snapshot(st));
      if (st.y > floorY) {
        events.push({ kind: 'fell', t: st.time });
        break;
      }
      if (opts.stopOnLand && st.grounded && i > 0) break;
    }
    return { state: st, frames, events };
  }

  function snapshot(st) {
    return {
      x: st.x, y: st.y, w: st.w, h: st.h,
      vx: st.vx, vy: st.vy, grounded: st.grounded,
      groundId: st.groundId, facing: st.facing, t: st.time,
    };
  }

  JR.physics = { spawnState, step, simulate, snapshot };
})();
