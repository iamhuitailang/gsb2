/* 可达性分析器：从起跳区域枚举一组确定性的输入策略，每条策略都通过
   physics.simulate（与试玩同一引擎）跑出轨迹与落脚结果。
   再用一份"移除上方障碍"的幽灵关卡对照，识别"距离够但头会撞到"的位置。 */
(function () {
  const JR = (window.JR = window.JR || {});
  const C = JR.C;

  // 一条输入策略：起跳方向、起跳时水平速度比例（0~1，模拟助跑程度）、
  // 按住跳跃时长、空中横移强度。出生点取起跳区域朝目标方向的边缘，
  // 这样枚举的是"站在边缘、以某初速度起跳"的真实玩家动作空间。
  const V0_SAMPLES = [0, 0.35, 0.6, 0.8, 1];
  function strategies() {
    const out = [];
    for (const dir of C.DIR_SAMPLES) {
      for (const v0 of V0_SAMPLES) {
        for (const hold of C.HOLD_SAMPLES) {
          for (const move of C.MOVE_SAMPLES) {
            out.push({ dir, v0, hold, move });
          }
        }
      }
    }
    return out;
  }

  function strategyLabel(s) {
    const dirTxt = s.dir < 0 ? '向左' : '向右';
    const moveTxt = s.move === 0 ? '空中不推方向' : `空中横移${Math.round(s.move * 100)}%`;
    const v0Txt = s.v0 === 0 ? '原地起跳' : `起跳初速${Math.round(s.v0 * 100)}%`;
    return `${dirTxt} · ${v0Txt} · 按住跳跃${s.hold.toFixed(2)}s · ${moveTxt}`;
  }

  // 在起跳区域朝 dir 的边缘出生，并赋予对应助跑初速度
  function spawnAtEdge(level, params, dir, v0) {
    const st = JR.physics.spawnState(level, params);
    const start = level.entities.find((e) => e.type === 'start');
    if (start) {
      st.x = dir > 0 ? start.x + start.w - params.width - 0.5 : start.x + 0.5;
    }
    st.vx = dir * params.moveSpeed * v0;
    st.facing = dir;
    return st;
  }

  function makeInputGen(s) {
    return (i) => ({
      left: s.move > 0 && s.dir < 0,
      right: s.move > 0 && s.dir > 0,
      jumpPressed: i === 0,
      jumpHeld: i < Math.round(s.hold / C.DT),
      drop: false,
    });
  }

  function withoutOverhead(level) {
    return {
      ...level,
      entities: level.entities.filter((e) => e.type !== 'overhead'),
    };
  }

  /* 对每个平台聚合可达性结果 */
  function analyze(level, params) {
    const strats = strategies();
    const runs = [];
    const ghostLevel = withoutOverhead(level);

    for (const s of strats) {
      const gen = makeInputGen(s);
      const real = JR.physics.simulate(level, params, spawnAtEdge(level, params, s.dir, s.v0), gen);
      const ghost = JR.physics.simulate(
        ghostLevel, params, spawnAtEdge(ghostLevel, params, s.dir, s.v0), gen
      );
      runs.push({ strategy: s, real, ghost });
    }

    // 每个平台的聚合
    const byPlatform = new Map();
    for (const e of level.entities) {
      if (e.type !== 'platform') continue;
      byPlatform.set(e.id, {
        entityId: e.id,
        reachable: false,
        bonkBlocked: false, // 幽灵关卡能到、真实关卡到不了（被上方障碍撞头）
        edgeSlips: 0,
        bestRun: null,
        ghostOnly: false,
      });
    }

    for (const run of runs) {
      const realLand = firstLanding(run.real);
      const ghostLand = firstLanding(run.ghost);
      const hadBonk = run.real.events.some((e) => e.kind === 'bonk');
      if (realLand && byPlatform.has(realLand.entityId)) {
        const agg = byPlatform.get(realLand.entityId);
        agg.reachable = true;
        // 保留完整轨迹帧（不只截到着陆帧），供逐步回放与多跳观察
        if (!agg.bestRun || realLand.frameIndex < agg.bestRun.frameIndex) {
          agg.bestRun = { run, frameIndex: realLand.frameIndex };
        }
      }
      if (ghostLand && byPlatform.has(ghostLand.entityId)) {
        const agg = byPlatform.get(ghostLand.entityId);
        // 仅当真实跑确实撞头、而移除上方障碍的幽灵跑能到时，才记为撞头阻挡
        if (hadBonk && (!realLand || realLand.entityId !== ghostLand.entityId)) {
          agg.ghostOnly = true;
        }
      }
      for (const ev of run.real.events) {
        if (ev.kind === 'edgeSlip' && byPlatform.has(ev.entityId)) {
          byPlatform.get(ev.entityId).edgeSlips++;
        }
      }
    }

    for (const agg of byPlatform.values()) {
      agg.bonkBlocked = agg.ghostOnly && !agg.reachable;
    }

    return {
      runs,
      platforms: [...byPlatform.values()],
      reachableIds: new Set([...byPlatform.values()].filter((p) => p.reachable).map((p) => p.entityId)),
      bonkIds: new Set([...byPlatform.values()].filter((p) => p.bonkBlocked).map((p) => p.entityId)),
    };
  }

  function firstLanding(sim) {
    // 起跳后第一次"站稳"的着陆（第 0 帧的出生平台与 edgeSlip 都不算）
    for (let i = 1; i < sim.frames.length; i++) {
      const f = sim.frames[i];
      if (f.grounded) return { entityId: f.groundId, frameIndex: i };
    }
    return null;
  }

  /* 针对目标平台给出一条可行跳法，或跳不过的主要原因分类 */
  function judgeTarget(level, params, result) {
    const target = level.entities.find((e) => e.id === level.targetId && e.type === 'platform');
    if (!target) return { ok: false, reason: 'no-target', text: '未标记目标平台' };

    const agg = result.platforms.find((p) => p.entityId === target.id);
    if (agg && agg.reachable) {
      return {
        ok: true,
        text: strategyLabel(agg.bestRun.run.strategy),
        run: agg.bestRun.run,
        frameIndex: agg.bestRun.frameIndex,
      };
    }

    const start = level.entities.find((e) => e.type === 'start');
    const reasons = diagnose(level, params, result, target, start);
    return { ok: false, ...reasons };
  }

  function diagnose(level, params, result, target, start) {
    // 1) 撞头：幽灵关卡能到
    if (result.bonkIds.has(target.id)) {
      return { reason: 'bonk', text: '水平距离与高度都够，但起跳弧线会撞到上方障碍（撞头后上升被截断）' };
    }
    // 2) 贴边滑落
    const agg = result.platforms.find((p) => p.entityId === target.id);
    if (agg && agg.edgeSlips > 0) {
      return { reason: 'edge', text: `能碰到平台边缘，但落脚重叠不足 ${JR.C.EDGE_TOLERANCE}px 贴边容差，发生 ${agg.edgeSlips} 次滑落` };
    }
    // 3) 高度/距离：用真实引擎数值积分测最大跳高，避免手写近似与引擎不一致
    if (start) {
      const maxUp = measureMaxJumpUp(level, params, start);
      const startTop = start.y + start.h - params.height;
      const dy = startTop - target.y; // 正值表示目标更高
      if (dy > maxUp + 2) {
        return { reason: 'too-high', text: `目标高出起跳点 ${Math.round(dy)}px，当前参数最大跳高约 ${Math.round(maxUp)}px（按住跳跃 ${params.maxHold.toFixed(2)}s 的满弧线）` };
      }
      const sx = start.x + start.w / 2;
      const tx = target.x + target.w / 2;
      const dx = Math.abs(tx - sx);
      return { reason: 'too-far', text: `高度够（需上升 ${Math.max(0, Math.round(dy))}px / 能力 ${Math.round(maxUp)}px），但水平距离 ${Math.round(dx)}px 超出当前起跳速度+空中横移的覆盖范围` };
    }
    return { reason: 'unknown', text: '枚举的全部输入策略均无法在目标上站稳' };
  }

  // 在空旷世界里让引擎跑一次满按住的原地跳，返回真实最大上升像素
  function measureMaxJumpUp(level, params, start) {
    const probe = JR.geom.makeLevel();
    const groundY = start.y + start.h;
    probe.entities = [
      { id: 'g', type: 'platform', x: start.x - 200, y: groundY, w: 600, h: 40 },
      { id: 'sp', type: 'start', x: start.x, y: start.y, w: start.w, h: start.h },
    ];
    const sim = JR.physics.simulate(
      probe, params, JR.physics.spawnState(probe, params),
      (i) => ({ left: false, right: false, jumpPressed: i === 0, jumpHeld: true, drop: false }),
      { maxSeconds: 2 }
    );
    const startY = sim.frames[0].y;
    const apex = Math.min(...sim.frames.map((f) => f.y));
    return startY - apex;
  }

  /* 连通性图：以平台为节点，可达关系为边；两套参数对比时返回变化边 */
  function connectivity(level, result) {
    const nodes = level.entities.filter((e) => e.type === 'platform').map((e) => e.id);
    const edges = [];
    for (const run of result.runs) {
      const land = firstLanding(run.real);
      if (land) edges.push({ from: 'start', to: land.entityId, strategy: run.strategy });
    }
    return { nodes, edges };
  }

  function diffConnectivity(level, resA, resB) {
    const a = resA.reachableIds;
    const b = resB.reachableIds;
    const name = (id) => {
      const e = level.entities.find((x) => x.id === id);
      return e ? `平台#${id}` : `#${id}`;
    };
    const lost = [...a].filter((id) => !b.has(id)).map((id) => ({ id, text: `${name(id)}：参数B 不再可达` }));
    const gained = [...b].filter((id) => !a.has(id)).map((id) => ({ id, text: `${name(id)}：参数B 新增可达` }));
    const bonkChange = [...resB.bonkIds].filter((id) => !resA.bonkIds.has(id))
      .map((id) => ({ id, text: `${name(id)}：参数B 下因弧线变化新出现撞头阻挡` }));
    return { lost, gained, bonkChange };
  }

  JR.analyzer = { analyze, judgeTarget, strategies, strategyLabel, makeInputGen, spawnAtEdge, connectivity, diffConnectivity };
})();
