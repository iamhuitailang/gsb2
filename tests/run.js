/*
 * 战斗数值试算器 · 断言式测试（零依赖）
 * 运行：node tests/run.js
 */
'use strict';

const assert = require('assert');
const path = require('path');
const E = require(path.join(__dirname, '..', 'js', 'engine.js'));
const S = require(path.join(__dirname, '..', 'js', 'samples.js'));

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  ✓ ' + name);
  } catch (err) {
    failed += 1;
    console.error('  ✗ ' + name);
    console.error('    ' + (err && err.message ? err.message : err));
  }
}

function section(title) {
  console.log('\n' + title);
}

function baseSetup(overrides) {
  const setup = {
    name: '测试',
    seed: '1',
    rules: { maxTime: 20, speedTieBreak: 'id-asc' },
    allies: [{
      id: 'a1', name: '甲', maxHp: 500, atk: 40, def: 10, speed: 100,
      skills: [{
        id: 'a1s1', name: '斩', cooldown: 1, castTime: 0, target: 'lowestHpEnemy',
        damage: { min: 30, max: 30 }, heal: { min: 0, max: 0 }, effect: null
      }]
    }],
    enemies: [{
      id: 'b1', name: '乙', maxHp: 500, atk: 30, def: 10, speed: 100,
      skills: [{
        id: 'b1s1', name: '击', cooldown: 1, castTime: 0, target: 'lowestHpEnemy',
        damage: { min: 20, max: 20 }, heal: { min: 0, max: 0 }, effect: null
      }]
    }]
  };
  return deepMerge(setup, overrides || {});
}

function deepMerge(base, patch) {
  const out = JSON.parse(JSON.stringify(base));
  Object.keys(patch).forEach((k) => {
    const v = patch[k];
    if (Array.isArray(v)) out[k] = JSON.parse(JSON.stringify(v));
    else if (v && typeof v === 'object') out[k] = Object.assign({}, out[k], v);
    else out[k] = v;
  });
  return out;
}

// ---------------------------------------------------------------
section('1. 基础模拟与确定性');
test('相同配置 + 相同种子，结果与事件日志完全一致', () => {
  const a = E.simulate(S.getSample('stacking-dot').setupA);
  const b = E.simulate(S.getSample('stacking-dot').setupA);
  assert.deepStrictEqual(a.events, b.events);
  assert.strictEqual(a.winner, b.winner);
  assert.strictEqual(a.duration, b.duration);
  assert.strictEqual(a.allyHp, b.allyHp);
});

test('不同种子会产生不同的随机技能结果', () => {
  const setup = baseSetup({
    enemies: [{
      id: 'b1', name: '乙', maxHp: 5000, atk: 0, def: 0, speed: 1, skills: []
    }],
    allies: [{
      id: 'a1', name: '甲', maxHp: 5000, atk: 40, def: 10, speed: 100,
      skills: [{
        id: 'a1s1', name: '斩', cooldown: 0.1, castTime: 0, target: 'lowestHpEnemy',
        damage: { min: 1, max: 100 }, heal: { min: 0, max: 0 }, effect: null
      }]
    }]
  });
  const a = E.simulate(Object.assign({}, setup, { seed: '1' }));
  const b = E.simulate(Object.assign({}, setup, { seed: '2' }));
  // 只比较伤害数值序列，避免 battle_start 里的种子字符串本身造成"必然不同"
  const amountsA = a.events.filter((e) => e.type === 'damage').map((e) => e.amount);
  const amountsB = b.events.filter((e) => e.type === 'damage').map((e) => e.amount);
  assert.ok(amountsA.length > 0 && amountsB.length > 0);
  assert.notStrictEqual(JSON.stringify(amountsA), JSON.stringify(amountsB));
});

test('战斗必然在时间上限内结束，且结果字段齐全', () => {
  const r = E.simulate(S.getSample('basic').setupA);
  assert.ok(r.duration <= 30 + 1e-9);
  assert.ok(['ally', 'enemy', 'draw'].includes(r.winner));
  assert.ok(r.events.length > 0);
  assert.strictEqual(r.events[0].type, 'battle_start');
  assert.strictEqual(r.events[r.events.length - 1].type, 'battle_end');
});

// ---------------------------------------------------------------
section('2. 固定时间步与冷却');
test('冷却时间内的技能不会重复施放', () => {
  const setup = baseSetup({
    rules: { maxTime: 10, speedTieBreak: 'id-asc' },
    enemies: [{
      id: 'b1', name: '木桩', maxHp: 100000, atk: 0, def: 0, speed: 1,
      skills: []
    }],
    allies: [{
      id: 'a1', name: '甲', maxHp: 5000, atk: 0, def: 0, speed: 100,
      skills: [{
        id: 'a1s1', name: '慢斩', cooldown: 3, castTime: 0, target: 'lowestHpEnemy',
        damage: { min: 10, max: 10 }, heal: { min: 0, max: 0 }, effect: null
      }]
    }]
  });
  const r = E.simulate(setup);
  const completions = r.events.filter((e) => e.type === 'cast_complete');
  for (let i = 1; i < completions.length; i++) {
    const gap = completions[i].time - completions[i - 1].time;
    assert.ok(gap >= 3 - 1e-9, `两次施放间隔 ${gap}s < 冷却 3s`);
  }
});

test('时间步长为 0.1 秒：所有事件时间都是 0.1 的整数倍', () => {
  const r = E.simulate(S.getSample('cooldown-cast').setupA);
  r.events.forEach((e) => {
    const ticks = e.time * 10;
    assert.ok(Math.abs(ticks - Math.round(ticks)) < 1e-6, `事件时间 ${e.time} 不在时间步网格上`);
  });
});

test('引导技能：cast 与 cast_complete 间隔等于引导时长', () => {
  const r = E.simulate(S.getSample('cooldown-cast').setupA);
  let pending = null;
  let pairs = 0;
  r.events.forEach((e) => {
    if (e.type === 'cast' && e.skillName === '火球') pending = e;
    else if (pending && e.type === 'cast_complete' && e.skillName === '火球') {
      const gap = Math.round((e.time - pending.time) * 10) / 10;
      assert.ok(gap >= 1.2 - 1e-9, `引导间隔 ${gap}s 小于 1.2s`);
      pairs += 1;
      pending = null;
    } else if (pending && (e.type === 'cast_cancel' || e.type === 'cast_fizzle')) {
      pending = null;
    }
  });
  assert.ok(pairs > 0, '应至少完成一次火球引导');
});

// ---------------------------------------------------------------
section('3. 效果叠加 / 刷新 / 结束时机');
function dotSetup(stackMode, maxStacks) {
  return baseSetup({
    rules: { maxTime: 12, speedTieBreak: 'id-asc' },
    enemies: [{
      id: 'b1', name: '木桩', maxHp: 100000, atk: 0, def: 0, speed: 1, skills: []
    }],
    allies: [{
      id: 'a1', name: '甲', maxHp: 5000, atk: 0, def: 0, speed: 100,
      skills: [{
        id: 'a1s1', name: '割', cooldown: 1, castTime: 0, target: 'lowestHpEnemy',
        damage: { min: 0, max: 0 }, heal: { min: 0, max: 0 },
        effect: {
          kind: 'dot', value: { min: 5, max: 5 }, duration: 3, interval: 1,
          stackMode: stackMode, maxStacks: maxStacks
        }
      }]
    }]
  });
}

test('叠层模式：层数递增，达到上限后不再增加', () => {
  const r = E.simulate(dotSetup('stack', 3));
  const applies = r.events.filter((e) => e.type === 'effect_apply');
  const stacks = r.events.filter((e) => e.type === 'effect_stack');
  const caps = r.events.filter((e) => e.type === 'effect_cap');
  assert.ok(applies.length >= 1, '应有 effect_apply 建立效果');
  assert.ok(stacks.length >= 2, '至少叠 2 层，实际 ' + stacks.length);
  assert.ok(caps.length >= 1, '达到上限后应有 effect_cap');
  const maxSeen = Math.max.apply(null, stacks.map((e) => e.stacks));
  assert.ok(maxSeen <= 3, '叠层不应超过上限 3，实际 ' + maxSeen);
  // 首次应用后到第一次到期之前，层数应单调递增
  const firstApply = applies[0];
  const firstEnd = r.events.find((e) => e.type === 'effect_end' && e.effectId === firstApply.effectId);
  const stacksBeforeEnd = stacks.filter((e) => e.effectId === firstApply.effectId &&
    (!firstEnd || e.seq < firstEnd.seq)).map((e) => e.stacks);
  for (let i = 1; i < stacksBeforeEnd.length; i++) {
    assert.ok(stacksBeforeEnd[i] > stacksBeforeEnd[i - 1], '层数应严格递增');
  }
});

test('刷新模式：层数不变，effect_refresh 记录新的结束时间', () => {
  const r = E.simulate(dotSetup('refresh', 5));
  const stacks = r.events.filter((e) => e.type === 'effect_stack');
  const refreshes = r.events.filter((e) => e.type === 'effect_refresh');
  assert.strictEqual(stacks.length, 0, '刷新模式不应增加层数');
  assert.ok(refreshes.length >= 1);
  refreshes.forEach((e) => assert.strictEqual(e.stacks, 1));
});

test('忽略模式：重复施加产生 effect_ignore 且不改变层数', () => {
  const r = E.simulate(dotSetup('ignore', 5));
  const ignores = r.events.filter((e) => e.type === 'effect_ignore');
  const stacks = r.events.filter((e) => e.type === 'effect_stack');
  assert.ok(ignores.length >= 1);
  assert.strictEqual(stacks.length, 0);
});

test('效果到期会写 effect_end（duration 原因），结束后不再结算', () => {
  const setup = baseSetup({
    rules: { maxTime: 12, speedTieBreak: 'id-asc' },
    enemies: [{ id: 'b1', name: '木桩', maxHp: 999999, atk: 0, def: 0, speed: 1, skills: [] }],
    allies: [{
      id: 'a1', name: '甲', maxHp: 9999, atk: 0, def: 0, speed: 100,
      skills: [{
        id: 'a1-dot', name: '灼', cooldown: 5, castTime: 0, target: 'lowestHpEnemy',
        damage: { min: 0, max: 0 }, heal: { min: 0, max: 0 },
        effect: {
          kind: 'dot', value: { min: 5, max: 5 }, duration: 2, interval: 1,
          stackMode: 'refresh', maxStacks: 1
        }
      }]
    }]
  });
  const r = E.simulate(setup);
  const durationEnds = r.events.filter((e) => e.type === 'effect_end' && e.reason === 'duration');
  assert.ok(durationEnds.length >= 1, '应存在持续时间耗尽的 effect_end');
  const endTick = durationEnds[0].time;
  // 结束时刻之后不应再有该效果的跳伤（同一次施放周期内）
  const nextApply = r.events.find((e) => e.type === 'effect_apply' && e.time > endTick);
  const dotsAfterEnd = r.events.filter((e) =>
    e.type === 'damage' && e.effectKind === 'dot' &&
    e.time > endTick && (!nextApply || e.time < nextApply.time));
  assert.strictEqual(dotsAfterEnd.length, 0, '效果结束后不应再跳伤');
});

test('携带者阵亡时，其身上的效果立即以 death 原因结束', () => {
  const setup = baseSetup({
    rules: { maxTime: 15, speedTieBreak: 'id-asc' },
    allies: [{
      id: 'a1', name: '甲', maxHp: 60, atk: 0, def: 0, speed: 100,
      skills: [{
        id: 'a1s1', name: '战意', cooldown: 0.5, castTime: 0, target: 'self',
        damage: { min: 0, max: 0 }, heal: { min: 0, max: 0 },
        effect: { kind: 'buff', stat: 'atk', value: { min: 5, max: 5 }, duration: 10, interval: 1, stackMode: 'refresh', maxStacks: 1 }
      }]
    }],
    enemies: [{
      id: 'b1', name: '乙', maxHp: 5000, atk: 30, def: 0, speed: 100,
      skills: [{
        id: 'b1s1', name: '击', cooldown: 0.5, castTime: 0, target: 'lowestHpEnemy',
        damage: { min: 80, max: 80 }, heal: { min: 0, max: 0 }, effect: null
      }]
    }]
  });
  const r = E.simulate(setup);
  const death = r.events.find((e) => e.type === 'death' && e.unitId === 'a1');
  assert.ok(death, '甲应阵亡');
  const deathEnds = r.events.filter((e) => e.type === 'effect_end' && e.reason === 'death' && e.ownerId === 'a1');
  assert.ok(deathEnds.length >= 1, '阵亡时应清理身上的效果');
});

// ---------------------------------------------------------------
section('4. 多单位行动顺序与同速稳定规则');
test('同速时按固定规则排序，重复运行顺序一致', () => {
  const setup = S.getSample('simultaneous').setupA;
  const o1 = E.previewActionOrder(setup, 20);
  const o2 = E.previewActionOrder(setup, 20);
  assert.deepStrictEqual(o1, o2);
});

test('同速排序：我方先于敌方，再按配置内顺序', () => {
  const setup = S.getSample('simultaneous').setupA;
  const order = E.previewActionOrder(setup, 4);
  const firstTick = order[0].tick;
  const sameTick = order.filter((o) => o.tick === firstTick);
  // 第一个 tick 上：我方两名单位应在敌方两名之前
  const teams = sameTick.map((o) => o.team);
  const firstEnemy = teams.indexOf('enemy');
  const lastAlly = teams.lastIndexOf('ally');
  if (firstEnemy >= 0 && lastAlly >= 0) {
    assert.ok(lastAlly < firstEnemy, '同 tick 内我方应排在敌方之前');
  }
});

test('id-desc 规则会翻转同组单位的先后', () => {
  const asc = E.previewActionOrder(S.getSample('simultaneous').setupA, 2);
  const desc = E.previewActionOrder(S.getSample('simultaneous').setupB, 2);
  assert.notDeepStrictEqual(asc.map((o) => o.unitId), desc.map((o) => o.unitId));
});

test('多单位同时行动：同一 tick 内的行动者按排序逐个结算', () => {
  const r = E.simulate(S.getSample('simultaneous').setupA);
  const byTick = {};
  r.events.forEach((e) => {
    if (e.type === 'cast' || e.type === 'basic') {
      byTick[e.tick] = byTick[e.tick] || [];
      byTick[e.tick].push(e.unitId);
    }
  });
  const tickKeys = Object.keys(byTick);
  assert.ok(tickKeys.length > 0);
  // 至少有一个 tick 发生了 2 个以上单位的行动
  const multi = tickKeys.filter((k) => byTick[k].length > 1);
  assert.ok(multi.length > 0, '样例应能触发同一 tick 内多单位行动');
});

// ---------------------------------------------------------------
section('5. 批量模拟与分布');
test('批量模拟：固定种子基复现同一分布', () => {
  const a = E.simulateBatch(S.getSample('random-batch').setupA, { runs: 40, seed: '9' });
  const b = E.simulateBatch(S.getSample('random-batch').setupA, { runs: 40, seed: '9' });
  assert.deepStrictEqual(a.results, b.results);
  assert.strictEqual(a.runs, 40);
});

test('批量模拟：胜率之和为 100，分位数有序', () => {
  const b = E.simulateBatch(S.getSample('random-batch').setupA, { runs: 60, seed: '9' });
  const sum = b.winRate.ally + b.winRate.enemy + b.winRate.draw;
  assert.ok(Math.abs(sum - 100) < 0.01, '胜率之和应为 100，实际 ' + sum);
  assert.ok(b.duration.min <= b.duration.p10);
  assert.ok(b.duration.p10 <= b.duration.p50);
  assert.ok(b.duration.p50 <= b.duration.p90);
  assert.ok(b.duration.p90 <= b.duration.max);
});

test('批量模拟：随机伤害样例的时长存在波动（给出分布而非单一均值）', () => {
  const b = E.simulateBatch(S.getSample('random-batch').setupA, { runs: 120, seed: '9' });
  assert.ok(b.duration.max > b.duration.min, '应有可观察的分布范围');
  assert.ok(b.durationHistogram.length > 1);
  const total = b.durationHistogram.reduce((s, h) => s + h.count, 0);
  assert.strictEqual(total, 120);
});

// ---------------------------------------------------------------
section('6. 样例与校验');
test('所有样例都能完成模拟且不超时上限', () => {
  S.samples.forEach((s) => {
    ['setupA', 'setupB'].forEach((k) => {
      const r = E.simulate(s[k]);
      assert.ok(r.duration <= s[k].rules.maxTime + 1e-9, s.id + ' ' + k + ' 超出时间上限');
      assert.ok(r.events.length > 1);
      assert.ok(!r.eventsTruncated, s.id + ' ' + k + ' 事件日志被截断');
    });
  });
});

test('样例覆盖冷却、叠层、同时行动与随机效果', () => {
  const ids = S.samples.map((s) => s.id);
  assert.ok(ids.includes('cooldown-cast'));
  assert.ok(ids.includes('stacking-dot'));
  assert.ok(ids.includes('simultaneous'));
  assert.ok(ids.includes('random-batch'));
  assert.ok(ids.includes('heal-refresh'));
  assert.ok(ids.includes('buff-stack'));
});

test('叠层样例在战斗过程中真的叠到了多层', () => {
  const r = E.simulate(S.getSample('stacking-dot').setupA);
  const stackEvents = r.events.filter((e) => e.type === 'effect_stack');
  assert.ok(stackEvents.length >= 2, '叠层样例应出现多次叠层，实际 ' + stackEvents.length);
  const maxStacks = Math.max.apply(null, stackEvents.map((e) => e.stacks));
  assert.ok(maxStacks >= 2, '叠层样例应叠到至少 2 层，实际 ' + maxStacks);
});

test('刷新样例不叠层，但会刷新时长', () => {
  const r = E.simulate(S.getSample('stacking-dot').setupB);
  assert.strictEqual(r.events.filter((e) => e.type === 'effect_stack').length, 0);
  assert.ok(r.events.filter((e) => e.type === 'effect_refresh').length >= 1);
});

test('属性增益效果会提高有效攻击，进而提高伤害', () => {
  function run(withBuff) {
    const skills = [
      {
        id: 'a1-hit', name: '击', cooldown: 1, castTime: 0, target: 'lowestHpEnemy',
        damage: { min: 50, max: 50 }, heal: { min: 0, max: 0 }, effect: null
      }
    ];
    if (withBuff) {
      skills.unshift({
        id: 'a1-buff', name: '战意', cooldown: 100, castTime: 0, target: 'self',
        damage: { min: 0, max: 0 }, heal: { min: 0, max: 0 },
        effect: {
          kind: 'buff', stat: 'atk', value: { min: 40, max: 40 },
          duration: 10, interval: 1, stackMode: 'refresh', maxStacks: 1
        }
      });
    }
    const setup = baseSetup({
      rules: { maxTime: 20, speedTieBreak: 'id-asc' },
      enemies: [{ id: 'b1', name: '木桩', maxHp: 999999, atk: 0, def: 0, speed: 1, skills: [] }],
      allies: [{
        id: 'a1', name: '甲', maxHp: 9999, atk: 50, def: 0, speed: 100, skills: skills
      }]
    });
    const r = E.simulate(setup);
    return r.events.filter((e) => e.type === 'damage' && e.skillName === '击').map((e) => e.amount);
  }

  const plain = run(false);
  const buffed = run(true);
  assert.ok(plain.length > 0 && buffed.length > 0);
  const maxPlain = Math.max.apply(null, plain);
  const maxBuffed = Math.max.apply(null, buffed);
  // 50 × (1 + 50/100) = 75；50 × (1 + 90/100) = 95
  assert.ok(Math.abs(maxPlain - 75) < 1e-6, '无增益伤害应为 75，实际 ' + maxPlain);
  assert.ok(Math.abs(maxBuffed - 95) < 1e-6, '有增益伤害应为 95，实际 ' + maxBuffed);
  assert.ok(maxBuffed > maxPlain);
});

test('效果叠层与刷新只延长时间，不改变跳伤时间点', () => {
  function ticksFor(mode) {
    const setup = baseSetup({
      rules: { maxTime: 6, speedTieBreak: 'id-asc' },
      enemies: [{ id: 'b1', name: '木桩', maxHp: 999999, atk: 0, def: 0, speed: 1, skills: [] }],
      allies: [{
        id: 'a1', name: '甲', maxHp: 9999, atk: 0, def: 0, speed: 100,
        skills: [{
          id: 'a1-dot', name: '灼', cooldown: 1, castTime: 0, target: 'lowestHpEnemy',
          damage: { min: 0, max: 0 }, heal: { min: 0, max: 0 },
          effect: {
            kind: 'dot', value: { min: 5, max: 5 }, duration: 4, interval: 1,
            stackMode: mode, maxStacks: 5
          }
        }]
      }]
    });
    const r = E.simulate(setup);
    return Array.from(new Set(
      r.events.filter((e) => e.type === 'damage' && e.effectKind === 'dot').map((e) => e.time)
    ));
  }
  ['stack', 'refresh'].forEach((mode) => {
    const times = ticksFor(mode);
    assert.ok(times.length >= 3, mode + ' 模式应至少跳伤 3 次，实际 ' + times.length);
    for (let i = 1; i < times.length; i++) {
      assert.ok(Math.abs((times[i] - times[i - 1]) - 1) < 1e-9,
        mode + ' 跳伤间隔应为 1 秒：' + times[i - 1] + ' -> ' + times[i]);
    }
  });
});

test('校验：缺任一方的配置会被拒绝', () => {
  const v = E.validateSetup({ allies: [], enemies: [] });
  assert.ok(v.errors.length > 0);
});

test('校验：空技能的单位给出警告而非错误', () => {
  const v = E.validateSetup({
    allies: [{ id: 'a', name: '甲', maxHp: 100, atk: 1, def: 0, speed: 100, skills: [] }],
    enemies: [{ id: 'b', name: '乙', maxHp: 100, atk: 1, def: 0, speed: 100, skills: [] }]
  });
  assert.strictEqual(v.errors.length, 0);
  assert.ok(v.warnings.length >= 2);
});

test('伤害公式：防御越高，实际伤害越低', () => {
  function runWithDef(def) {
    const setup = baseSetup({
      allies: [{
        id: 'a1', name: '甲', maxHp: 10000, atk: 0, def: 0, speed: 100,
        skills: [{
          id: 'a1s1', name: '斩', cooldown: 0.1, castTime: 0, target: 'lowestHpEnemy',
          damage: { min: 100, max: 100 }, heal: { min: 0, max: 0 }, effect: null
        }]
      }],
      enemies: [{
        id: 'b1', name: '乙', maxHp: 100000, atk: 0, def: def, speed: 1, skills: []
      }]
    });
    const r = E.simulate(setup);
    const first = r.events.find((e) => e.type === 'damage');
    return first.amount;
  }
  assert.ok(runWithDef(100) < runWithDef(0));
  assert.ok(runWithDef(300) < runWithDef(100));
});

test('治疗不会超过生命上限', () => {
  const setup = baseSetup({
    rules: { maxTime: 20, speedTieBreak: 'id-asc' },
    allies: [
      {
        id: 'a1', name: '甲', maxHp: 1000, atk: 0, def: 0, speed: 100,
        skills: [{
          id: 'a1s1', name: '愈', cooldown: 0.5, castTime: 0, target: 'allAllies',
          damage: { min: 0, max: 0 }, heal: { min: 9999, max: 9999 }, effect: null
        }]
      }
    ],
    enemies: [{
      id: 'b1', name: '乙', maxHp: 5000, atk: 30, def: 0, speed: 100,
      skills: [{
        id: 'b1s1', name: '击', cooldown: 0.5, castTime: 0,
        target: 'lowestHpEnemy', damage: { min: 300, max: 300 },
        heal: { min: 0, max: 0 }, effect: null
      }]
    }]
  });
  const r = E.simulate(setup);
  const heals = r.events.filter((e) => e.type === 'heal');
  assert.ok(heals.length > 0, '应产生治疗事件');
  heals.forEach((e) => {
    assert.ok(e.hpAfter <= 1000 + 1e-9, '治疗溢出上限：' + e.hpAfter);
    assert.ok(e.amount <= 1000 + 1e-9, '单次治疗量溢出上限：' + e.amount);
  });
  assert.ok(heals.some((e) => Math.abs(e.hpAfter - 1000) < 1e-9), '应出现回满到上限的治疗');
  assert.ok(r.allyHp <= 1000);
});

// ---------------------------------------------------------------
console.log('\n结果：' + passed + ' 通过，' + failed + ' 失败');
if (failed > 0) process.exit(1);
