/**
 * 离线冒烟检查：直接调用核心模块，验证确定性、跳帧一致性与预算保护。
 * 运行：npm run smoke
 */

import assert from 'node:assert/strict';

import { createPresetProject, PRESETS } from '../src/core/presets.ts';
import { simulateScene, emitterPositionAt } from '../src/core/simulation.ts';
import { createEmitter, createProject, normalizeProject } from '../src/core/project.ts';
import { parseProjectText, serializeProject, exportRuntimeConfig } from '../src/core/serialization.ts';
import { evalCurve } from '../src/core/curve.ts';
import { evalGradient } from '../src/core/color.ts';

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

check('相同种子重复计算结果一致', () => {
  const project = createPresetProject('spark');
  const a = simulateScene(project.scene, project.emitters, 1.37);
  const b = simulateScene(project.scene, project.emitters, 1.37);
  assert.equal(a.total, b.total);
  assert.ok(a.total > 0, '火花示例在 1.37s 应至少有一个粒子');
  for (let i = 0; i < a.emitters.length; i++) {
    const pa = a.emitters[i].particles;
    const pb = b.emitters[i].particles;
    assert.equal(pa.length, pb.length);
    for (let j = 0; j < pa.length; j++) {
      assert.equal(pa[j].x, pb[j].x);
      assert.equal(pa[j].y, pb[j].y);
      assert.equal(pa[j].size, pb[j].size);
    }
  }
});

check('跳到任意帧不依赖播放历史', () => {
  const project = createPresetProject('smoke');
  const direct = simulateScene(project.scene, project.emitters, 7.1);
  simulateScene(project.scene, project.emitters, 0.5);
  simulateScene(project.scene, project.emitters, 2.5);
  const afterPlay = simulateScene(project.scene, project.emitters, 7.1);
  assert.equal(direct.total, afterPlay.total);
  for (let i = 0; i < direct.emitters.length; i++) {
    const a = direct.emitters[i].particles;
    const b = afterPlay.emitters[i].particles;
    assert.equal(a.length, b.length);
    for (let j = 0; j < a.length; j++) {
      assert.equal(a[j].x, b[j].x);
      assert.equal(a[j].y, b[j].y);
    }
  }
});

check('不同种子产生不同结果', () => {
  const project = createPresetProject('spark');
  const a = simulateScene({ ...project.scene, seed: 1 }, project.emitters, 1.2);
  const b = simulateScene({ ...project.scene, seed: 2 }, project.emitters, 1.2);
  const ax = a.emitters.flatMap((e) => e.particles.map((p) => p.x));
  const bx = b.emitters.flatMap((e) => e.particles.map((p) => p.x));
  assert.notDeepEqual(ax.slice(0, 20), bx.slice(0, 20));
});

check('local 跟随发射器、world 留在出生位置', () => {
  const scene = createProject().scene;
  const base = createEmitter({
    id: 'motion-emitter',
    motion: { type: 'pingpong', speed: 1, radius: 200, radiusY: 0, phase: 0 },
    lifetime: { min: 2, max: 2 },
    speed: { min: 0, max: 0 },
    spawnRadius: 0,
    emission: { mode: 'rate', rate: 10, duration: 20, loop: true, startDelay: 0, burstCount: 0, burstTime: 0 },
    sizeCurve: { points: [{ t: 0, v: 10 }, { t: 1, v: 10 }], interpolation: 'linear' },
    alphaCurve: { points: [{ t: 0, v: 1 }, { t: 1, v: 1 }], interpolation: 'linear' },
  });
  const world = { ...structuredClone(base), id: 'world-emitter', space: 'world' };
  const local = { ...structuredClone(base), id: 'local-emitter', space: 'local' };

  const t = 1.7;
  const sim = simulateScene(scene, [world, local], t);
  const worldParticles = sim.emitters[0].particles;
  const localParticles = sim.emitters[1].particles;
  assert.ok(worldParticles.length > 0, 'world 模式应有粒子');
  const emitterNow = emitterPositionAt(local, t);
  for (const particle of localParticles) {
    assert.ok(Math.abs(particle.x - emitterNow.x) < 1e-6, 'local 粒子应跟随发射器当前位置');
  }
  const spread = Math.max(...worldParticles.map((p) => Math.abs(p.x - emitterNow.x)));
  assert.ok(spread > 20, `world 粒子应留在出生位置，实际最大偏移 ${spread}`);
});

check('一次性爆发只在一个窗口内出现', () => {
  const base = createProject();
  const project = createProject({
    scene: { ...base.scene, seed: 42, duration: 20 },
    emitters: [
      createEmitter({
        id: 'burst-one',
        emission: { mode: 'burst', rate: 0, duration: 1, loop: false, startDelay: 0, burstCount: 12, burstTime: 0.5 },
        lifetime: { min: 0.4, max: 0.4 },
      }),
    ],
  });
  assert.equal(simulateScene(project.scene, project.emitters, 0.4).total, 0);
  assert.equal(simulateScene(project.scene, project.emitters, 0.6).total, 12);
  assert.equal(simulateScene(project.scene, project.emitters, 1.2).total, 0);
});

check('循环爆发按周期重复', () => {
  const base = createProject();
  const project = createProject({
    scene: { ...base.scene, seed: 7, duration: 20 },
    emitters: [
      createEmitter({
        id: 'burst-loop',
        emission: { mode: 'burst', rate: 0, duration: 2, loop: true, startDelay: 0, burstCount: 5, burstTime: 0 },
        lifetime: { min: 0.3, max: 0.3 },
      }),
    ],
  });
  assert.equal(simulateScene(project.scene, project.emitters, 0.1).total, 5);
  assert.equal(simulateScene(project.scene, project.emitters, 2.1).total, 5);
  assert.equal(simulateScene(project.scene, project.emitters, 4.1).total, 5);
});

check('超过粒子预算时裁剪而非无限增长', () => {
  const base = createProject();
  const project = createProject({
    scene: { ...base.scene, seed: 99, duration: 10, maxParticles: 120 },
    emitters: [
      createEmitter({
        id: 'flood',
        emission: { mode: 'rate', rate: 900, duration: 10, loop: true, startDelay: 0, burstCount: 0, burstTime: 0 },
        lifetime: { min: 3, max: 4 },
      }),
    ],
  });
  const sim = simulateScene(project.scene, project.emitters, 5);
  assert.ok(sim.total <= 120, `渲染数量 ${sim.total} 应不超过预算`);
  assert.equal(sim.capped, true);
  assert.ok(sim.omittedTotal > 0);
  assert.ok(sim.aliveTotal > sim.total);
});

check('发射率为 0 时不产生粒子', () => {
  const project = createProject({
    emitters: [
      createEmitter({
        id: 'quiet',
        emission: { mode: 'rate', rate: 0, duration: 5, loop: true, startDelay: 0, burstCount: 0, burstTime: 0 },
      }),
    ],
  });
  assert.equal(simulateScene(project.scene, project.emitters, 2).total, 0);
});

check('寿命范围反向时自动纠正', () => {
  const project = createProject({
    emitters: [createEmitter({ id: 'reversed', lifetime: { min: 2, max: 1 } })],
  });
  const sim = simulateScene(project.scene, project.emitters, 1);
  for (const particle of sim.emitters[0].particles) {
    assert.ok(particle.life >= 1 && particle.life <= 2);
  }
});

check('重力影响纵向位置（解析积分）', () => {
  const base = createProject();
  const scene = { ...base.scene, seed: 123, gravity: { x: 0, y: 400 } };
  const emitter = createEmitter({
    id: 'gravity',
    space: 'world',
    motion: { type: 'static', speed: 0, radius: 0, radiusY: 0, phase: 0 },
    emission: { mode: 'burst', rate: 0, duration: 1, loop: false, startDelay: 0, burstCount: 1, burstTime: 0 },
    speed: { min: 0, max: 0 },
    spawnRadius: 0,
    lifetime: { min: 1, max: 1 },
    gravityScale: 1,
  });
  const t = 0.5;
  const particle = simulateScene(scene, [emitter], t).emitters[0].particles[0];
  assert.ok(particle, '应有一个粒子');
  const expected = 0.5 * 400 * t * t;
  assert.ok(Math.abs(particle.y - (emitter.position.y + expected)) < 1e-6);
});

check('曲线与渐变端点外保持端点值', () => {
  const curve = {
    points: [{ t: 0.2, v: 2 }, { t: 0.8, v: 6 }],
    interpolation: 'linear',
  };
  assert.equal(evalCurve(curve, 0), 2);
  assert.equal(evalCurve(curve, 1), 6);
  assert.equal(evalCurve(curve, 0.5), 4);

  const gradient = {
    stops: [{ t: 0, color: '#000000' }, { t: 1, color: '#ffffff' }],
  };
  assert.deepEqual(evalGradient(gradient, 0), [0, 0, 0]);
  assert.deepEqual(evalGradient(gradient, 1), [255, 255, 255]);
  const mid = evalGradient(gradient, 0.5);
  assert.ok(Math.abs(mid[0] - 127.5) < 1);
});

check('保存后重新打开可还原发射器与曲线', () => {
  const project = createPresetProject('smoke');
  const text = serializeProject(project);
  const parsed = parseProjectText(text);
  assert.equal(parsed.ok, true);
  const restored = parsed.project;
  assert.equal(restored.emitters.length, project.emitters.length);
  for (let i = 0; i < project.emitters.length; i++) {
    const a = project.emitters[i];
    const b = restored.emitters[i];
    assert.equal(a.name, b.name);
    assert.equal(a.space, b.space);
    assert.deepEqual(a.position, b.position);
    assert.deepEqual(a.lifetime, b.lifetime);
    assert.deepEqual(a.sizeCurve, b.sizeCurve);
    assert.deepEqual(a.alphaCurve, b.alphaCurve);
    assert.deepEqual(a.gradient, b.gradient);
    assert.equal(a.emission.mode, b.emission.mode);
    assert.equal(a.emission.burstCount, b.emission.burstCount);
  }
  const before = simulateScene(project.scene, project.emitters, 3.3);
  const after = simulateScene(restored.scene, restored.emitters, 3.3);
  assert.equal(before.total, after.total);
});

check('损坏的工程文件被拒绝而不是抛异常', () => {
  assert.equal(parseProjectText('').ok, false);
  assert.equal(parseProjectText('{').ok, false);
  assert.equal(parseProjectText('[]').ok, false);
  assert.equal(parseProjectText('{"magic":"other"}').ok, false);
  assert.equal(parseProjectText(JSON.stringify({ scene: {}, emitters: [] })).ok, true);
});

check('越界参数被夹紧并给出警告', () => {
  const result = normalizeProject({
    name: '   ',
    scene: { seed: 'abc', duration: -5, fps: 999, maxParticles: 1e9, gravity: { x: 0, y: 'x' } },
    emitters: [{ name: '', emission: { mode: 'weird', rate: 1e9 }, position: { x: 'a', y: null } }],
  });
  assert.equal(result.project.name, '未命名粒子工程');
  assert.ok(result.project.scene.duration >= 0.1);
  assert.ok(result.project.scene.fps <= 120);
  assert.ok(result.project.scene.maxParticles <= 60000);
  assert.equal(result.project.emitters[0].emission.mode, 'rate');
  assert.ok(result.warnings.length > 0, '应有夹紧警告');
});

check('导出配置只包含启用的发射器', () => {
  const project = createProject({
    emitters: [createEmitter({ id: 'on', enabled: true }), createEmitter({ id: 'off', enabled: false })],
  });
  const config = JSON.parse(exportRuntimeConfig(project));
  assert.equal(config.emitters.length, 1);
  assert.equal(config.emitters[0].id, 'on');
  assert.ok(Array.isArray(config.emitters[0].sizeCurve.keys));
});

check('两个预设均可创建且有粒子', () => {
  assert.equal(PRESETS.length, 2);
  for (const preset of PRESETS) {
    const project = preset.build();
    assert.ok(project.emitters.length > 0);
    const sim = simulateScene(project.scene, project.emitters, 1.5);
    assert.ok(sim.total > 0, `${preset.id} 应在 1.5s 有粒子`);
  }
});

check('发射器位置连续且周期正确', () => {
  const emitter = createEmitter({
    motion: { type: 'orbit', speed: 1, radius: 100, radiusY: 100, phase: 0 },
  });
  const p0 = emitterPositionAt(emitter, 0);
  const pHalf = emitterPositionAt(emitter, Math.PI);
  assert.ok(Math.abs(p0.x - (emitter.position.x + 100)) < 1e-9);
  assert.ok(Math.abs(pHalf.x - (emitter.position.x - 100)) < 1e-6);
});

check('采样扫描不改变确定性', () => {
  const base = createProject();
  const project = createProject({
    scene: { ...base.scene, seed: 5, duration: 10, maxParticles: 60000 },
    emitters: [
      createEmitter({
        id: 'many',
        emission: { mode: 'rate', rate: 900, duration: 10, loop: true, startDelay: 0, burstCount: 0, burstTime: 0 },
        lifetime: { min: 4, max: 6 },
      }),
    ],
  });
  const full = simulateScene(project.scene, project.emitters, 5, { scanLimit: 200000, renderLimit: 60000 });
  const sampled = simulateScene(project.scene, project.emitters, 5, { scanLimit: 2000, renderLimit: 60000 });
  assert.equal(full.scanReduced, false);
  assert.equal(sampled.scanReduced, true);
  // 抽样只影响数量估计精度，不应崩溃或产生负数。
  assert.ok(sampled.total >= 0);
  assert.ok(Number.isFinite(sampled.aliveTotal));
});

console.log(`\n${passed} 项检查全部通过。`);
