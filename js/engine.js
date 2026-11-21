/*
 * 战斗数值试算器 · 核心模拟引擎
 *
 * 纯函数式、无依赖、无网络。同一份配置 + 同一个种子，结果（含事件日志）完全一致。
 * 浏览器中挂到 window.CombatEngine；Node 中通过 module.exports 暴露，便于测试与批量模拟。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CombatEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DT_MS = 100;              // 固定时间步：0.1 秒
  var ACTION_SCALE_MS = 100000; // 速度 100 → 每 1000ms 行动一次
  var DEFENSE_K = 100;          // 防御减伤常数
  var MAX_EVENTS = 20000;       // 事件日志硬上限，避免极端配置撑爆内存
  var MAX_TIME_MS = 600000;     // 时间上限硬顶（10 分钟）
  var EPS = 1e-9;

  var TEAM_ORDER = { ally: 0, enemy: 1 };
  var TARGETS = [
    'lowestHpEnemy', 'randomEnemy', 'allEnemies',
    'self', 'lowestHpAlly', 'randomAlly', 'allAllies'
  ];
  var EFFECT_KINDS = ['dot', 'hot', 'buff'];
  var STACK_MODES = ['stack', 'refresh', 'replace', 'ignore'];

  var TARGET_LABELS = {
    lowestHpEnemy: '敌方·生命最低',
    randomEnemy: '敌方·随机',
    allEnemies: '敌方·全体',
    self: '自身',
    lowestHpAlly: '我方·生命最低',
    randomAlly: '我方·随机',
    allAllies: '我方·全体'
  };
  var EFFECT_LABELS = { dot: '持续伤害', hot: '持续治疗', buff: '属性增益' };
  var STACK_LABELS = {
    stack: '叠层',
    refresh: '刷新时长',
    replace: '覆盖',
    ignore: '忽略重复'
  };
  var TEAM_LABELS = { ally: '我方', enemy: '敌方', draw: '平局' };
  var STAT_LABELS = { atk: '攻击', def: '防御', speed: '速度' };
  var REASON_LABELS = {
    elimination: '一方全灭',
    timeout: '达到时间上限',
    mutual: '双方同时全灭',
    death: '携带者阵亡',
    battle_end: '战斗结束清理',
    duration: '持续时间耗尽'
  };
  var EVENT_LABELS = {
    battle_start: '战斗开始',
    battle_end: '战斗结束',
    cast: '施放开始',
    cast_complete: '施放完成',
    cast_fizzle: '技能落空',
    cast_cancel: '施放取消',
    basic: '普通攻击',
    damage: '伤害',
    heal: '治疗',
    death: '阵亡',
    effect_apply: '效果施加',
    effect_stack: '效果叠层',
    effect_refresh: '效果刷新',
    effect_replace: '效果覆盖',
    effect_ignore: '效果忽略',
    effect_cap: '达到层数上限',
    effect_end: '效果结束'
  };

  // ---------- 数值与随机工具 ----------

  function round3(n) { return Math.round(n * 1000) / 1000; }
  function round2(n) { return Math.round(n * 100) / 100; }
  function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }
  function finite(n, fallback) {
    var v = typeof n === 'number' ? n : Number(n);
    return Number.isFinite(v) ? v : fallback;
  }

  // FNV-1a：把任意种子（字符串/数字）压成 32 位无符号整数
  function hashSeed(seed) {
    if (typeof seed === 'number' && Number.isFinite(seed)) seed = String(seed);
    if (seed == null) seed = '0';
    var s = String(seed);
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  // mulberry32：小而稳定的 32 位 PRNG，返回 [0,1)
  function mulberry32(a) {
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // 按名字派生独立随机流，保证“谁的随机”不因执行顺序改变而漂移
  function deriveRng(seed, stream, index) {
    var h = hashSeed(String(seed) + '|' + stream + '|' + index);
    return mulberry32(h);
  }

  function makeRngObj(next) {
    return {
      next: next,
      range: function (min, max) {
        if (max <= min) return min;
        return min + next() * (max - min);
      },
      pick: function (arr) {
        if (!arr || !arr.length) return null;
        return arr[Math.floor(next() * arr.length)];
      }
    };
  }

  function rngFor(seed, stream) {
    return makeRngObj(deriveRng(seed, stream, 0));
  }

  function normalizeRngSpec(rng, fallback) {
    var base = finite(fallback, 0);
    if (!rng) return { min: base, max: base };
    var min = finite(rng.min, base);
    var max = finite(rng.max, min);
    if (min > max) { var t = min; min = max; max = t; }
    return { min: min, max: max };
  }

  function rollScalar(spec, rng) {
    return round3(rng.range(spec.min, spec.max));
  }

  function durationToTicks(seconds) {
    return Math.max(1, Math.round(finite(seconds, 1) * 10));
  }

  // ---------- 配置规整与校验 ----------

  function normalizeSkill(skill) {
    skill = skill || {};
    var dmg = normalizeRngSpec(skill.damage, 0);
    var heal = normalizeRngSpec(skill.heal, 0);
    var eff = skill.effect ? {
      kind: EFFECT_KINDS.indexOf(skill.effect.kind) >= 0 ? skill.effect.kind : 'dot',
      potion: normalizeRngSpec(skill.effect.value, 0),
      duration: Math.max(0, finite(skill.effect.duration, 0)),
      interval: Math.max(0.1, finite(skill.effect.interval, 1)),
      stackMode: STACK_MODES.indexOf(skill.effect.stackMode) >= 0 ? skill.effect.stackMode : 'stack',
      maxStacks: Math.max(1, Math.round(finite(skill.effect.maxStacks, 5))),
      stat: skill.effect.stat === 'def' || skill.effect.stat === 'speed' ? skill.effect.stat : 'atk'
    } : null;
    return {
      id: String(skill.id != null ? skill.id : (skill.name || 'skill')),
      name: String(skill.name || skill.id || '技能'),
      cooldown: Math.max(0, finite(skill.cooldown, 1)),
      castTime: Math.max(0, finite(skill.castTime, 0)),
      target: TARGETS.indexOf(skill.target) >= 0 ? skill.target : 'lowestHpEnemy',
      damage: { min: dmg.min, max: dmg.max },
      heal: { min: heal.min, max: heal.max },
      effect: eff
    };
  }

  function normalizeUnit(unit, team) {
    unit = unit || {};
    var skills = (unit.skills || []).map(normalizeSkill);
    // 同一单位内技能 id 必须唯一，否则两类不同效果会被当成“同类效果”
    var used = {};
    skills.forEach(function (s, i) {
      while (used[s.id]) s.id = s.id + '#' + i;
      used[s.id] = true;
    });
    return {
      id: String(unit.id != null ? unit.id : (unit.name || team + '-unit')),
      name: String(unit.name || unit.id || '单位'),
      team: team,
      maxHp: Math.max(1, finite(unit.maxHp, 100)),
      atk: Math.max(0, finite(unit.atk, 10)),
      def: Math.max(0, finite(unit.def, 0)),
      speed: Math.max(1, finite(unit.speed, 100)),
      skills: skills
    };
  }

  // 把“两套配置”统一规整成内部结构。防御性地接受缺省字段。
  function normalizeSetup(setup) {
    setup = setup || {};
    var units = [];
    (setup.allies || []).forEach(function (u) { units.push(normalizeUnit(u, 'ally')); });
    (setup.enemies || []).forEach(function (u) { units.push(normalizeUnit(u, 'enemy')); });

    // 单位 id 必须全局唯一：重复时追加序号直到不再冲突（排序与效果归属都依赖 id）
    var seen = {};
    units.forEach(function (u, i) {
      var base = u.id;
      var candidate = base;
      var n = i;
      while (seen[candidate]) candidate = base + '#' + (n++);
      u.id = candidate;
      seen[candidate] = true;
    });

    var rules = setup.rules || {};
    return {
      name: String(setup.name || '未命名配置'),
      units: units,
      maxTime: clamp(finite(rules.maxTime, 30), DT_MS / 1000, MAX_TIME_MS / 1000),
      seed: setup.seed == null ? '1' : String(setup.seed),
      speedTieBreak: rules.speedTieBreak === 'id-desc' ? 'id-desc' : 'id-asc'
    };
  }

  function validateSetup(setup) {
    var errors = [];
    var warnings = [];
    var norm = normalizeSetup(setup);
    if (!setup || (!(setup.allies || []).length && !(setup.enemies || []).length)) {
      errors.push('至少需要放置一名单位');
    } else {
      if (!(setup.allies || []).length) errors.push('我方场上没有单位');
      if (!(setup.enemies || []).length) errors.push('敌方场上没有单位');
    }
    norm.units.forEach(function (u) {
      if (!u.skills.length) warnings.push(u.name + ' 没有配置技能，将只做普通攻击');
      u.skills.forEach(function (s) {
        if (s.damage.max <= 0 && s.heal.max <= 0 && !s.effect) {
          warnings.push(u.name + ' 的技能「' + s.name + '」没有伤害/治疗/效果');
        }
        if (s.effect && s.effect.potion.max <= 0) {
          warnings.push(u.name + ' 的技能「' + s.name + '」持续效果数值为 0');
        }
        if (s.effect && s.effect.duration <= 0) {
          warnings.push(u.name + ' 的技能「' + s.name + '」持续效果时长为 0，不会生效');
        }
      });
    });
    return { errors: errors, warnings: warnings, setup: norm };
  }

  // ---------- 事件日志 ----------

  function makeLog(collect) {
    var events = [];
    var seq = 0;
    var truncated = false;
    var enabled = collect !== false;
    function push(ev) {
      if (!enabled) return null;
      if (events.length >= MAX_EVENTS) { truncated = true; return null; }
      ev.seq = ++seq;
      events.push(ev);
      return ev;
    }
    return { events: events, push: push, get seq() { return seq; }, isTruncated: function () { return truncated; } };
  }

  // ---------- 战斗上下文 ----------

  function buildContext(setup, baseSeed, collectEvents) {
    var log = makeLog(collectEvents);
    var units = setup.units.map(function (u, index) {
      return {
        id: u.id,
        name: u.name,
        team: u.team,
        index: index,
        maxHp: u.maxHp,
        hp: u.maxHp,
        atk: u.atk,
        def: u.def,
        baseSpeed: u.speed,
        speed: u.speed,
        skills: u.skills.map(function (s) {
          return { def: s, readyAtTick: 0, pending: null };
        }),
        effects: [],
        alive: true,
        lastActionTick: 0,
        nextActionTick: Math.round(ACTION_SCALE_MS / u.speed / DT_MS),
        actionCount: 0
      };
    });
    return {
      setup: setup,
      seed: baseSeed,
      units: units,
      byId: units.reduce(function (m, u) { m[u.id] = u; return m; }, {}),
      log: log,
      tick: 0,
      timeSec: 0,
      damageDealt: {},
      healingDone: {},
      ending: null,
      effectSeq: 0
    };
  }

  function livingUnits(ctx) {
    return ctx.units.filter(function (u) { return u.alive; });
  }

  function teamLiving(ctx, team) {
    return ctx.units.filter(function (u) { return u.alive && u.team === team; });
  }

  function enemyTeam(team) { return team === 'ally' ? 'enemy' : 'ally'; }

  function effectAtkBonus(unit) {
    var bonus = 0;
    unit.effects.forEach(function (e) {
      if (e.kind === 'buff' && e.stat === 'atk') bonus += e.potion * e.stacks;
    });
    return bonus;
  }

  function effectSpeedBonus(unit) {
    var bonus = 0;
    unit.effects.forEach(function (e) {
      if (e.kind === 'buff' && e.stat === 'speed') bonus += e.potion * e.stacks;
    });
    return bonus;
  }

  function effectDefBonus(unit) {
    var bonus = 0;
    unit.effects.forEach(function (e) {
      if (e.kind === 'buff' && e.stat === 'def') bonus += e.potion * e.stacks;
    });
    return bonus;
  }

  function effectiveAtk(unit) { return Math.max(0, unit.atk + effectAtkBonus(unit)); }
  function effectiveDef(unit) { return Math.max(0, unit.def + effectDefBonus(unit)); }
  function effectiveSpeed(unit) { return Math.max(1, unit.baseSpeed + effectSpeedBonus(unit)); }

  function actionIntervalTicks(unit) {
    return Math.max(1, Math.round(ACTION_SCALE_MS / effectiveSpeed(unit) / DT_MS));
  }

  function timeLabel(ctx) {
    return round2(ctx.tick * DT_MS / 1000);
  }

  // ---------- 事件构造 ----------

  function logEvent(ctx, event) {
    event.time = timeLabel(ctx);
    event.tick = ctx.tick;
    return ctx.log.push(event);
  }

  function logDamage(ctx, source, target, amount, meta) {
    meta = meta || {};
    if (amount <= 0 || !target.alive) return;
    var before = target.hp;
    target.hp = Math.max(0, round3(target.hp - amount));
    var actual = round3(before - target.hp); // 溢出伤害不计入统计，与剩余生命一致
    var key = source ? source.id : 'unknown';
    ctx.damageDealt[key] = round3((ctx.damageDealt[key] || 0) + actual);
    logEvent(ctx, {
      type: 'damage',
      sourceId: source ? source.id : null,
      sourceName: source ? source.name : meta.sourceName || '持续效果',
      targetId: target.id,
      targetName: target.name,
      amount: actual,
      hpAfter: target.hp,
      skillId: meta.skillId || null,
      skillName: meta.skillName || null,
      effectKind: meta.effectKind || null,
      detail: meta.detail || ''
    });
    if (target.hp <= 0) logDeath(ctx, target, meta.effectKind === 'dot' ? 'dot' : (meta.reason || 'skill'));
  }

  function logHeal(ctx, source, target, amount, meta) {
    meta = meta || {};
    if (amount <= 0 || !target.alive) return;
    var before = target.hp;
    target.hp = Math.min(target.maxHp, round3(target.hp + amount));
    var actual = round3(target.hp - before);
    if (actual <= 0) return; // 已满血：不写入空治疗日志
    var key = source ? source.id : 'unknown';
    ctx.healingDone[key] = round3((ctx.healingDone[key] || 0) + actual);
    logEvent(ctx, {
      type: 'heal',
      sourceId: source ? source.id : null,
      sourceName: source ? source.name : meta.sourceName || '持续效果',
      targetId: target.id,
      targetName: target.name,
      amount: actual,
      hpAfter: target.hp,
      skillId: meta.skillId || null,
      skillName: meta.skillName || null,
      effectKind: meta.effectKind || null,
      detail: meta.detail || ''
    });
  }

  function logDeath(ctx, unit, reason) {
    if (!unit.alive) return;
    unit.alive = false;
    unit.hp = 0;
    logEvent(ctx, {
      type: 'death',
      unitId: unit.id,
      unitName: unit.name,
      team: unit.team,
      reason: reason || 'damage',
      reasonLabel: reason === 'dot' ? '持续伤害致死' : '伤害致死'
    });
    // 阵亡单位身上（由他人施加）的持续效果立即结束；它此前施加到别人身上的效果继续生效
    unit.effects.forEach(function (e) {
      if (e.expired) return;
      e.expired = true;
      logEvent(ctx, {
        type: 'effect_end',
        effectId: e.id,
        effectName: e.name,
        kind: e.kind,
        stat: e.stat || null,
        ownerId: unit.id,
        ownerName: unit.name,
        sourceId: e.sourceId,
        sourceName: e.sourceName,
        stacks: e.stacks,
        reason: 'death',
        reasonLabel: REASON_LABELS.death
      });
    });
    unit.effects = [];
    // 正在引导的技能随阵亡取消
    unit.skills.forEach(function (sk) {
      if (sk.pending) {
        logEvent(ctx, {
          type: 'cast_cancel',
          unitId: unit.id,
          unitName: unit.name,
          skillId: sk.def.id,
          skillName: sk.def.name,
          reason: '携带者阵亡'
        });
        sk.pending = null;
      }
    });
  }

  // ---------- 目标选择 ----------

  function resolveTargets(ctx, actor, targetMode, rng) {
    var own = actor.team;
    var foe = enemyTeam(own);
    var foes = teamLiving(ctx, foe);
    var allies = teamLiving(ctx, own);
    function lowest(list) {
      var best = null;
      list.forEach(function (u) {
        if (!best) { best = u; return; }
        if (u.hp < best.hp - EPS) { best = u; return; }
        if (Math.abs(u.hp - best.hp) <= EPS && u.index < best.index) best = u;
      });
      return best;
    }
    switch (targetMode) {
      case 'allEnemies': return foes;
      case 'allAllies': return allies;
      case 'randomEnemy': {
        var pick = rng.pick(foes);
        return pick ? [pick] : [];
      }
      case 'randomAlly': {
        var pick2 = rng.pick(allies);
        return pick2 ? [pick2] : [];
      }
      case 'self': return [actor];
      case 'lowestHpAlly': {
        var t = lowest(allies);
        return t ? [t] : [];
      }
      case 'lowestHpEnemy':
      default: {
        var t2 = lowest(foes);
        return t2 ? [t2] : [];
      }
    }
  }

  // ---------- 效果施加：叠层 / 刷新 / 覆盖 / 忽略 ----------

  // 效果 id 按“本次模拟”递增，保证同一配置重复运行得到相同的 id 序列
  function nextEffectId(ctx) { return 'eff-' + (++ctx.effectSeq); }

  function applyEffect(ctx, source, target, skill, effectDef, rng) {
    if (!effectDef || effectDef.duration <= 0) return null;
    // 同类效果 = 同一来源单位 + 同一技能 + 同一效果类型 + 同一增益属性
    var stackKey = [source.id, skill.id, effectDef.kind, effectDef.stat || ''].join('|');
    var potion = rollScalar(effectDef.potion, rng);
    var durationTicks = durationToTicks(effectDef.duration);
    var intervalTicks = durationToTicks(effectDef.interval);
    var existing = target.effects.filter(function (e) {
      return !e.expired && e.stackKey === stackKey;
    })[0];

    if (existing) {
      if (effectDef.stackMode === 'ignore') {
        logEvent(ctx, {
          type: 'effect_ignore',
          effectId: existing.id,
          effectName: existing.name,
          kind: existing.kind,
          stat: existing.stat || null,
          ownerId: target.id,
          ownerName: target.name,
          sourceId: source.id,
          sourceName: source.name,
          stacks: existing.stacks,
          detail: '同类效果已存在且配置为忽略重复，未改变层数与时长'
        });
        return existing;
      }
      if (effectDef.stackMode === 'refresh') {
        existing.endTick = ctx.tick + durationTicks;
        existing.potion = potion;
        existing.intervalTicks = intervalTicks;
        recomputeSpeed(target);
        logEvent(ctx, {
          type: 'effect_refresh',
          effectId: existing.id,
          effectName: existing.name,
          kind: existing.kind,
          stat: existing.stat || null,
          ownerId: target.id,
          ownerName: target.name,
          sourceId: source.id,
          sourceName: source.name,
          stacks: existing.stacks,
          potion: potion,
          duration: effectDef.duration,
          endTime: round2(existing.endTick * DT_MS / 1000),
          detail: '刷新持续时间与强度，层数为 ' + existing.stacks + '，跳伤节奏不变'
        });
        return existing;
      }
      if (effectDef.stackMode === 'replace') {
        existing.potion = potion;
        existing.stacks = 1;
        existing.endTick = ctx.tick + durationTicks;
        existing.nextTickAt = ctx.tick + intervalTicks;
        existing.intervalTicks = intervalTicks;
        recomputeSpeed(target);
        logEvent(ctx, {
          type: 'effect_replace',
          effectId: existing.id,
          effectName: existing.name,
          kind: existing.kind,
          stat: existing.stat || null,
          ownerId: target.id,
          ownerName: target.name,
          sourceId: source.id,
          sourceName: source.name,
          stacks: existing.stacks,
          potion: potion,
          duration: effectDef.duration,
          endTime: round2(existing.endTick * DT_MS / 1000),
          detail: '覆盖：层数重置为 1，强度与持续时间刷新'
        });
        return existing;
      }
      // stack
      if (existing.stacks >= effectDef.maxStacks) {
        existing.endTick = ctx.tick + durationTicks;
        existing.intervalTicks = intervalTicks;
        logEvent(ctx, {
          type: 'effect_cap',
          effectId: existing.id,
          effectName: existing.name,
          kind: existing.kind,
          stat: existing.stat || null,
          ownerId: target.id,
          ownerName: target.name,
          sourceId: source.id,
          sourceName: source.name,
          stacks: existing.stacks,
          maxStacks: effectDef.maxStacks,
          endTime: round2(existing.endTick * DT_MS / 1000),
          detail: '已达最大层数，不再叠层，只刷新持续时间'
        });
        return existing;
      }
      existing.stacks += 1;
      existing.potion = potion;
      existing.endTick = ctx.tick + durationTicks;
      existing.intervalTicks = intervalTicks;
      logEvent(ctx, {
        type: 'effect_stack',
        effectId: existing.id,
        effectName: existing.name,
        kind: existing.kind,
        stat: existing.stat || null,
        ownerId: target.id,
        ownerName: target.name,
        sourceId: source.id,
        sourceName: source.name,
        stacks: existing.stacks,
        maxStacks: effectDef.maxStacks,
        potion: potion,
        duration: effectDef.duration,
        endTime: round2(existing.endTick * DT_MS / 1000),
        detail: '叠加 1 层，刷新持续时间；跳伤节奏不变'
      });
      recomputeSpeed(target);
      return existing;
    }

    var effect = {
      id: nextEffectId(ctx),
      stackKey: stackKey,
      name: skill.name + ' · ' + EFFECT_LABELS[effectDef.kind] +
        (effectDef.kind === 'buff' ? '（' + STAT_LABELS[effectDef.stat || 'atk'] + '）' : ''),
      kind: effectDef.kind,
      stat: effectDef.stat || null,
      sourceId: source.id,
      sourceName: source.name,
      skillId: skill.id,
      skillName: skill.name,
      ownerId: target.id,
      ownerName: target.name,
      potion: potion,
      stacks: 1,
      maxStacks: effectDef.maxStacks,
      stackMode: effectDef.stackMode,
      startTick: ctx.tick,
      endTick: ctx.tick + durationTicks,
      intervalTicks: intervalTicks,
      nextTickAt: ctx.tick + intervalTicks,
      expired: false
    };
    target.effects.push(effect);
    recomputeSpeed(target);
    logEvent(ctx, {
      type: 'effect_apply',
      effectId: effect.id,
      effectName: effect.name,
      kind: effect.kind,
      stat: effect.stat,
      ownerId: target.id,
      ownerName: target.name,
      sourceId: source.id,
      sourceName: source.name,
      stacks: 1,
      maxStacks: effect.maxStacks,
      stackMode: effect.stackMode,
      potion: potion,
      duration: effectDef.duration,
      interval: effectDef.interval,
      endTime: round2(effect.endTick * DT_MS / 1000),
      detail: '新效果，' + STACK_LABELS[effect.stackMode]
    });
    return effect;
  }

  function unitById(ctx, id) { return ctx.byId[id]; }

  function recomputeSpeed(unit) {
    unit.speed = effectiveSpeed(unit);
  }

  // ---------- 技能施放 ----------

  function computeDamage(ctx, actor, target, skill, rng) {
    var raw = skill.damage.min === skill.damage.max
      ? skill.damage.min
      : rollScalar(skill.damage, rng);
    var atk = effectiveAtk(actor);
    var def = effectiveDef(target);
    var mitigated = raw * (1 + atk / 100) * (DEFENSE_K / (DEFENSE_K + def));
    return round3(Math.max(0, mitigated));
  }

  function computeHeal(ctx, actor, target, skill, rng) {
    var raw = skill.heal.min === skill.heal.max
      ? skill.heal.min
      : rollScalar(skill.heal, rng);
    if (raw <= 0) return 0;
    return round3(raw * (1 + effectiveAtk(actor) / 200));
  }

  function executeCast(ctx, unit, skillState) {
    var skill = skillState.def;
    if (!unit.alive) return;
    var castRng = rngFor(ctx.seed, 'cast:' + unit.id + ':' + skill.id + ':' + ctx.tick);
    var targets = resolveTargets(ctx, unit, skill.target, castRng);
    if (!targets.length) return;

    logEvent(ctx, {
      type: 'cast',
      unitId: unit.id,
      unitName: unit.name,
      team: unit.team,
      skillId: skill.id,
      skillName: skill.name,
      targetIds: targets.map(function (t) { return t.id; }),
      targetNames: targets.map(function (t) { return t.name; }),
      targetMode: skill.target,
      detail: '开始施放' + (skill.castTime > 0 ? '（引导 ' + skill.castTime + ' 秒）' : '')
    });

    var applyNow = function () {
      if (!unit.alive) return;
      // 目标可能在引导期间死亡/失效，重新筛掉
      var livingTargets = targets.filter(function (t) { return t.alive; });
      if (!livingTargets.length) {
        logEvent(ctx, {
          type: 'cast_fizzle',
          unitId: unit.id,
          unitName: unit.name,
          skillId: skill.id,
          skillName: skill.name,
          detail: '目标已全部阵亡，技能落空'
        });
        // 落空也照常进入冷却
        skillState.readyAtTick = ctx.tick + (skill.cooldown > 0 ? Math.max(1, Math.round(skill.cooldown * 10)) : 0);
        return;
      }
      livingTargets.forEach(function (target, i) {
        var rng = deriveRng(ctx.seed, 'skill:' + unit.id + ':' + skill.id + ':' + ctx.tick, i);
        var rngObj = makeRngObj(rng);
        var dmg = computeDamage(ctx, unit, target, skill, rngObj);
        if (dmg > 0) {
          logDamage(ctx, unit, target, dmg, {
            skillId: skill.id,
            skillName: skill.name,
            detail: '技能伤害'
          });
        }
        var heal = computeHeal(ctx, unit, target, skill, rngObj);
        if (heal > 0 && target.alive) {
          logHeal(ctx, unit, target, heal, {
            skillId: skill.id,
            skillName: skill.name,
            detail: '技能治疗'
          });
        }
        if (skill.effect && target.alive) {
          applyEffect(ctx, unit, target, skill, skill.effect, rngObj);
        }
      });
      // 冷却从技能实际生效时开始计时（绝对 tick，便于日志核对）
      var cdTicks = skill.cooldown > 0 ? Math.max(1, Math.round(skill.cooldown * 10)) : 0;
      skillState.readyAtTick = ctx.tick + cdTicks;
      logEvent(ctx, {
        type: 'cast_complete',
        unitId: unit.id,
        unitName: unit.name,
        skillId: skill.id,
        skillName: skill.name,
        cooldown: skill.cooldown,
        cooldownUntil: round2(skillState.readyAtTick * DT_MS / 1000)
      });
    };

    if (skill.castTime > 0) {
      skillState.pending = {
        apply: applyNow,
        readyTick: ctx.tick + Math.max(1, Math.round(skill.castTime * 10))
      };
    } else {
      applyNow();
    }
  }

  // ---------- 单位每 tick 推进 ----------

  function tickUnitEffects(ctx, unit) {
    if (!unit.alive) return;
    var toRemove = [];
    unit.effects.forEach(function (e) {
      if (!unit.alive) return; // 本 tick 已被持续伤害打死，后续效果不再结算
      if (e.expired) return;
      if (e.kind === 'dot' || e.kind === 'hot') {
        // 用绝对 tick 判定，避免行动顺序影响结算时机
        while (e.nextTickAt <= ctx.tick && !e.expired) {
          e.nextTickAt += e.intervalTicks;
          var amount = round3(e.potion * e.stacks);
          if (e.kind === 'dot' && amount > 0) {
            var source = unitById(ctx, e.sourceId) || null;
            logDamage(ctx, source, unit, amount, {
              skillId: e.skillId,
              skillName: e.skillName,
              effectKind: 'dot',
              sourceName: e.sourceName,
              detail: '持续伤害结算（' + e.stacks + ' 层）'
            });
            if (!unit.alive) return;
          } else if (e.kind === 'hot' && amount > 0) {
            var healer = unitById(ctx, e.sourceId) || null;
            logHeal(ctx, healer, unit, amount, {
              skillId: e.skillId,
              skillName: e.skillName,
              effectKind: 'hot',
              sourceName: e.sourceName,
              detail: '持续治疗结算（' + e.stacks + ' 层）'
            });
          }
        }
      }
      if (ctx.tick >= e.endTick && !e.expired) {
        e.expired = true;
        logEvent(ctx, {
          type: 'effect_end',
          effectId: e.id,
          effectName: e.name,
          kind: e.kind,
          stat: e.stat || null,
          ownerId: unit.id,
          ownerName: unit.name,
          sourceId: e.sourceId,
          sourceName: e.sourceName,
          stacks: e.stacks,
          reason: 'duration',
          reasonLabel: REASON_LABELS.duration
        });
        toRemove.push(e);
      }
    });
    if (toRemove.length) {
      unit.effects = unit.effects.filter(function (e) { return toRemove.indexOf(e) < 0; });
      recomputeSpeed(unit);
    }
  }

  function tickUnitSkills(ctx, unit) {
    if (!unit.alive) return;
    unit.skills.forEach(function (sk) {
      if (sk.pending && ctx.tick >= sk.pending.readyTick) {
        var fn = sk.pending.apply;
        sk.pending = null;
        fn();
      }
    });
  }

  // ---------- 行动排序（稳定规则） ----------

  /*
   * 同 tick 排序的单一实现：行动时刻 → 速度降序 → team（我方在前）→
   * 配置内 index 升序，或 id 降序（由 rules.speedTieBreak 决定）。
   * simulate 与 previewActionOrder 共用它，保证预览与实际推演永不脱节。
   */
  function compareTie(a, aTick, b, bTick, tieMode) {
    if (aTick !== bTick) return aTick - bTick;
    var sa = effectiveSpeed(a), sb = effectiveSpeed(b);
    if (sa !== sb) return sb - sa;
    var ta = TEAM_ORDER[a.team] - TEAM_ORDER[b.team];
    if (ta !== 0) return ta;
    if (tieMode === 'id-desc') {
      if (a.id < b.id) return 1;
      if (a.id > b.id) return -1;
      return b.index - a.index;
    }
    if (a.index !== b.index) return a.index - b.index;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  }

  function compareActionOrder(a, b, tieMode) {
    return compareTie(a, a.nextActionTick, b, b.nextActionTick, tieMode);
  }

  function orderActors(ctx, actors) {
    var tieMode = ctx.setup.speedTieBreak;
    return actors.slice().sort(function (a, b) { return compareActionOrder(a, b, tieMode); });
  }

  /*
   * 行动顺序预览：按当前配置与排序规则，列出前 count 次行动。
   * 只反映基础行动节奏（不含引导占位与战况造成的减员），用于核对同速先后。
   */
  function previewActionOrder(rawSetup, count) {
    var setup = normalizeSetup(rawSetup);
    var ctx = buildContext(setup, setup.seed);
    count = clamp(Math.round(finite(count, 12)), 1, 60);
    var queue = ctx.units.map(function (u) {
      return { unit: u, tick: u.nextActionTick };
    });
    var out = [];
    while (out.length < count && queue.length) {
      queue.sort(function (a, b) {
        return compareTie(a.unit, a.tick, b.unit, b.tick, setup.speedTieBreak);
      });
      var head = queue[0];
      out.push({
        tick: head.tick,
        time: round2(head.tick * DT_MS / 1000),
        unitId: head.unit.id,
        unitName: head.unit.name,
        team: head.unit.team,
        speed: effectiveSpeed(head.unit)
      });
      head.tick += actionIntervalTicks(head.unit);
    }
    return out;
  }

  // 技能选择：按配置顺序，第一个已冷却完毕的技能；全部冷却中则普通攻击
  function chooseSkill(unit, tick) {
    for (var i = 0; i < unit.skills.length; i++) {
      var sk = unit.skills[i];
      if (sk.readyAtTick <= tick && !sk.pending) return sk;
    }
    return null;
  }

  function performAction(ctx, unit) {
    if (!unit.alive) return;
    // 引导中：本次行动时刻被引导占用，不施放新技能；照常推进下一次行动时刻
    var busy = unit.skills.some(function (sk) { return !!sk.pending; });
    if (busy) {
      unit.nextActionTick += actionIntervalTicks(unit);
      return;
    }

    var skillState = chooseSkill(unit, ctx.tick);
    if (skillState) executeCast(ctx, unit, skillState);
    else basicAttack(ctx, unit);

    unit.actionCount += 1;
    unit.lastActionTick = ctx.tick;
    unit.nextActionTick += actionIntervalTicks(unit);
  }

  function basicAttack(ctx, unit) {
    var foes = teamLiving(ctx, enemyTeam(unit.team));
    var target = null;
    foes.forEach(function (u) {
      if (!target || u.hp < target.hp - EPS ||
          (Math.abs(u.hp - target.hp) <= EPS && u.index < target.index)) target = u;
    });
    if (!target) return;
    var atk = effectiveAtk(unit);
    var raw = atk * 0.6;
    var dmg = round3(Math.max(0, raw * (DEFENSE_K / (DEFENSE_K + effectiveDef(target)))));
    logEvent(ctx, {
      type: 'basic',
      unitId: unit.id,
      unitName: unit.name,
      targetId: target.id,
      targetName: target.name,
      skillName: '普通攻击',
      detail: '无可用技能时的普通攻击'
    });
    logDamage(ctx, unit, target, dmg, { skillName: '普通攻击', detail: '普通攻击', reason: 'basic' });
  }

  // ---------- 结束判定 ----------

  function checkEnd(ctx) {
    var allies = teamLiving(ctx, 'ally');
    var enemies = teamLiving(ctx, 'enemy');
    if (!allies.length && !enemies.length) { ctx.ending = 'mutual'; return true; }
    if (!allies.length) { ctx.ending = 'enemy'; return true; }
    if (!enemies.length) { ctx.ending = 'ally'; return true; }
    return false;
  }

  // ---------- 主循环 ----------

  function simulate(rawSetup, options) {
    options = options || {};
    var collectEvents = options.collectEvents !== false;
    var setup = normalizeSetup(rawSetup);
    var ctx = buildContext(setup, setup.seed, collectEvents);
    var maxTicks = Math.round(setup.maxTime * 1000 / DT_MS);
    var guard = 0;

    logEvent(ctx, { type: 'battle_start', detail: '种子 ' + setup.seed + '，上限 ' + setup.maxTime + ' 秒' });

    while (!checkEnd(ctx) && ctx.tick < maxTicks) {
      ctx.tick += 1;
      // 1) 行动者集合：本 tick 到期且仍存活的单位
      var actors = livingUnits(ctx).filter(function (u) {
        return u.nextActionTick <= ctx.tick;
      });
      actors = orderActors(ctx, actors);
      // 2) 逐个结算行动
      actors.forEach(function (unit) { performAction(ctx, unit); });
      // 3) 结算所有单位的持续效果与引导
      livingUnits(ctx).forEach(function (unit) {
        if (!unit.alive) return;
        tickUnitEffects(ctx, unit);
        tickUnitSkills(ctx, unit);
      });
      guard += 1;
      if (guard > 1000000) break; // 防御性兜底
    }

    // 若在最后一个允许的 tick 内全灭，仍按全灭结算，而不是判超时
    if (!ctx.ending) checkEnd(ctx);
    var timedOut = false;
    if (!ctx.ending) {
      timedOut = true;
      ctx.ending = 'timeout';
    }

    var survivors = livingUnits(ctx).map(function (u) {
      return {
        id: u.id, name: u.name, team: u.team,
        hp: round3(u.hp), maxHp: u.maxHp,
        hpPct: round3(u.maxHp > 0 ? u.hp / u.maxHp * 100 : 0)
      };
    });
    var allyHp = round3(teamLiving(ctx, 'ally').reduce(function (s, u) { return s + u.hp; }, 0));
    var enemyHp = round3(teamLiving(ctx, 'enemy').reduce(function (s, u) { return s + u.hp; }, 0));
    var allyTotalMax = round3(ctx.units.filter(function (u) { return u.team === 'ally'; })
      .reduce(function (s, u) { return s + u.maxHp; }, 0));
    var enemyTotalMax = round3(ctx.units.filter(function (u) { return u.team === 'enemy'; })
      .reduce(function (s, u) { return s + u.maxHp; }, 0));

    var winner;
    if (ctx.ending === 'mutual') winner = 'draw';
    else if (ctx.ending === 'enemy') winner = 'enemy';
    else if (ctx.ending === 'ally') winner = 'ally';
    else winner = 'draw'; // 时间上限

    var winnerLabel = ctx.ending === 'mutual' ? '平局（同时全灭）'
      : ctx.ending === 'timeout' ? '平局（时间上限）'
      : TEAM_LABELS[winner];

    // 战斗结束：先清理所有剩余持续效果并写日志，再落最后一条 battle_end
    ctx.units.forEach(function (unit) {
      unit.effects.forEach(function (e) {
        if (e.expired) return;
        e.expired = true;
        logEvent(ctx, {
          type: 'effect_end',
          effectId: e.id,
          effectName: e.name,
          kind: e.kind,
          stat: e.stat || null,
          ownerId: unit.id,
          ownerName: unit.name,
          sourceId: e.sourceId,
          sourceName: e.sourceName,
          stacks: e.stacks,
          reason: 'battle_end',
          reasonLabel: REASON_LABELS.battle_end
        });
      });
      unit.effects = [];
    });

    logEvent(ctx, {
      type: 'battle_end',
      winner: winner,
      reason: ctx.ending,
      reasonLabel: winnerLabel,
      duration: round2(ctx.tick * DT_MS / 1000),
      allyHp: allyHp,
      enemyHp: enemyHp
    });

    var stats = {};
    ctx.units.forEach(function (u) {
      stats[u.id] = {
        name: u.name,
        team: u.team,
        damageDealt: round3(ctx.damageDealt[u.id] || 0),
        healingDone: round3(ctx.healingDone[u.id] || 0),
        actions: u.actionCount,
        hp: round3(u.hp),
        maxHp: u.maxHp,
        alive: u.alive
      };
    });

    return {
      setupName: setup.name,
      seed: setup.seed,
      winner: winner,
      winnerLabel: winnerLabel,
      reason: ctx.ending,
      timedOut: timedOut,
      duration: round2(ctx.tick * DT_MS / 1000),
      durationTicks: ctx.tick,
      allyHp: allyHp,
      enemyHp: enemyHp,
      allyMaxHp: allyTotalMax,
      enemyMaxHp: enemyTotalMax,
      allyHpPct: round3(allyTotalMax > 0 ? allyHp / allyTotalMax * 100 : 0),
      enemyHpPct: round3(enemyTotalMax > 0 ? enemyHp / enemyTotalMax * 100 : 0),
      survivors: survivors,
      events: ctx.log.events,
      eventsTruncated: ctx.log.isTruncated(),
      stats: stats,
      // 对比视图用：双方总血量快照
      timeline: collectEvents ? buildTimeline(ctx) : []
    };
  }

  function buildTimeline(ctx) {
    // 以事件里的 hpAfter 回放双方总血量；同一时间点只保留最后一个快照。
    var totals = {};
    ctx.units.forEach(function (u) { totals[u.id] = u.maxHp; });
    var allyMax = ctx.units.filter(function (u) { return u.team === 'ally'; })
      .reduce(function (s, u) { return s + u.maxHp; }, 0);
    var enemyMax = ctx.units.filter(function (u) { return u.team === 'enemy'; })
      .reduce(function (s, u) { return s + u.maxHp; }, 0);
    var points = [{ t: 0, ally: round3(allyMax), enemy: round3(enemyMax) }];
    var last = null;
    ctx.log.events.forEach(function (ev) {
      if (ev.type !== 'damage' && ev.type !== 'heal') return;
      var unit = ctx.byId[ev.targetId];
      if (!unit) return;
      totals[unit.id] = ev.hpAfter;
      var a = 0, e = 0;
      ctx.units.forEach(function (u) {
        if (u.team === 'ally') a += totals[u.id]; else e += totals[u.id];
      });
      var p = { t: ev.time, ally: round3(a), enemy: round3(e) };
      if (last && last.t === p.t) {
        last.ally = p.ally; last.enemy = p.enemy;
      } else {
        points.push(p);
        last = p;
      }
    });
    // 补一个战斗结束时刻的点，让曲线延伸到终点
    var endT = round2(ctx.tick * DT_MS / 1000);
    var finalAlly = 0, finalEnemy = 0;
    ctx.units.forEach(function (u) {
      var hp = u.alive ? u.hp : 0;
      if (u.team === 'ally') finalAlly += hp; else finalEnemy += hp;
    });
    finalAlly = round3(finalAlly);
    finalEnemy = round3(finalEnemy);
    if (last && last.t === endT) {
      last.ally = finalAlly;
      last.enemy = finalEnemy;
    } else if (!last || last.t !== endT) {
      points.push({ t: endT, ally: finalAlly, enemy: finalEnemy });
    }
    return points;
  }

  // ---------- 批量模拟 ----------

  function simulateBatch(rawSetup, options) {
    options = options || {};
    var runs = clamp(Math.round(finite(options.runs, 100)), 1, 2000);
    var baseSeed = options.seed == null ? '1' : String(options.seed);
    var results = [];
    for (var i = 0; i < runs; i++) {
      var setup = JSON.parse(JSON.stringify(rawSetup));
      setup.seed = baseSeed + '#' + i;
      // 批量只关心结果分布，不保留事件日志，避免大量运行时占用内存
      var r = simulate(setup, { collectEvents: false });
      results.push({
        index: i,
        seed: setup.seed,
        winner: r.winner,
        duration: r.duration,
        allyHpPct: r.allyHpPct,
        enemyHpPct: r.enemyHpPct,
        timedOut: r.timedOut
      });
    }
    return summarizeBatch(results, runs, baseSeed);
  }

  function percentile(sorted, p) {
    if (!sorted.length) return 0;
    if (sorted.length === 1) return sorted[0];
    var idx = (sorted.length - 1) * p;
    var lo = Math.floor(idx), hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  }

  function histogram(values, bucketCount) {
    if (!values.length) return [];
    var min = Math.min.apply(null, values);
    var max = Math.max.apply(null, values);
    if (min === max) {
      return [{ from: min, to: max, count: values.length, label: String(round2(min)) }];
    }
    var buckets = clamp(bucketCount || 10, 2, 30);
    var width = (max - min) / buckets;
    var out = [];
    for (var i = 0; i < buckets; i++) {
      out.push({
        from: round2(min + width * i),
        to: round2(min + width * (i + 1)),
        count: 0,
        label: round2(min + width * i).toFixed(2) + '–' + round2(min + width * (i + 1)).toFixed(2)
      });
    }
    values.forEach(function (v) {
      var idx = Math.min(buckets - 1, Math.floor((v - min) / width));
      out[idx].count += 1;
    });
    return out;
  }

  function summarizeBatch(results, runs, seed) {
    var wins = { ally: 0, enemy: 0, draw: 0 };
    var durations = [];
    var allyPcts = [];
    var enemyPcts = [];
    results.forEach(function (r) {
      wins[r.winner] += 1;
      durations.push(r.duration);
      allyPcts.push(r.allyHpPct);
      enemyPcts.push(r.enemyHpPct);
    });
    var sortedDur = durations.slice().sort(function (a, b) { return a - b; });
    var sortedAlly = allyPcts.slice().sort(function (a, b) { return a - b; });
    var sortedEnemy = enemyPcts.slice().sort(function (a, b) { return a - b; });
    return {
      runs: runs,
      seed: seed,
      wins: wins,
      winRate: {
        ally: round3(wins.ally / runs * 100),
        enemy: round3(wins.enemy / runs * 100),
        draw: round3(wins.draw / runs * 100)
      },
      duration: {
        min: sortedDur[0], max: sortedDur[sortedDur.length - 1],
        p10: round2(percentile(sortedDur, 0.1)),
        p50: round2(percentile(sortedDur, 0.5)),
        p90: round2(percentile(sortedDur, 0.9)),
        mean: round2(durations.reduce(function (s, v) { return s + v; }, 0) / runs)
      },
      allyHpPct: {
        min: sortedAlly[0], max: sortedAlly[sortedAlly.length - 1],
        p10: round3(percentile(sortedAlly, 0.1)),
        p50: round3(percentile(sortedAlly, 0.5)),
        p90: round3(percentile(sortedAlly, 0.9)),
        mean: round3(allyPcts.reduce(function (s, v) { return s + v; }, 0) / runs)
      },
      enemyHpPct: {
        min: sortedEnemy[0], max: sortedEnemy[sortedEnemy.length - 1],
        p10: round3(percentile(sortedEnemy, 0.1)),
        p50: round3(percentile(sortedEnemy, 0.5)),
        p90: round3(percentile(sortedEnemy, 0.9)),
        mean: round3(enemyPcts.reduce(function (s, v) { return s + v; }, 0) / runs)
      },
      durationHistogram: histogram(durations, 12),
      allyHpHistogram: histogram(allyPcts, 12),
      enemyHpHistogram: histogram(enemyPcts, 12),
      results: results
    };
  }

  return {
    DT_MS: DT_MS,
    ACTION_SCALE_MS: ACTION_SCALE_MS,
    TARGETS: TARGETS,
    EFFECT_KINDS: EFFECT_KINDS,
    STACK_MODES: STACK_MODES,
    TARGET_LABELS: TARGET_LABELS,
    EFFECT_LABELS: EFFECT_LABELS,
    STACK_LABELS: STACK_LABELS,
    TEAM_LABELS: TEAM_LABELS,
    STAT_LABELS: STAT_LABELS,
    REASON_LABELS: REASON_LABELS,
    EVENT_LABELS: EVENT_LABELS,
    simulate: simulate,
    simulateBatch: simulateBatch,
    previewActionOrder: previewActionOrder,
    normalizeSetup: normalizeSetup,
    validateSetup: validateSetup,
    hashSeed: hashSeed
  };
});
