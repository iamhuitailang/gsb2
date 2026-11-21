// tune-demo.js —— 验证演示场景：基线部分走不通，仅调 p2 相位即全部救回
// 运行：node tools/tune-demo.js
import { sweep, simulateRoute, superPeriod, diffSweeps, REASONS } from '../core.js';
import { demoScene, rescuePatch, applyPatch } from '../scene.js';

function report(title, scene) {
  const T = superPeriod(scene);
  const r = sweep(scene, scene.route, { step: 0.1, horizon: scene.horizon });
  const pct = (100 * r.successCount / r.n).toFixed(1);
  console.log(`\n=== ${title}（联合周期 T=${T}s，采样 ${r.n} 个出发时点）===`);
  console.log(`成功率 ${pct}%，成功窗口 ${r.windows.length} 段：`);
  for (const w of r.windows) console.log(`  [${w.start.toFixed(2)}s, ${w.end.toFixed(2)}s) 宽 ${(w.end - w.start).toFixed(2)}s`);
  console.log('失败原因（含最早失败点）：');
  for (const f of r.failures) {
    console.log(`  ${f.reason} ×${f.count}；最早：t0=${f.earliest.t0.toFixed(1)}s 在步骤 ${f.earliest.step}、t=${f.earliest.at.toFixed(1)}s 中断`);
  }
  return r;
}

const base = report('基线（p2.phase=0）', demoScene);
const rescued = applyPatch(demoScene, rescuePatch);
const cur = report('救回方案（仅 p2.phase=1）', rescued);

const diff = diffSweeps(base, cur);
console.log('\n=== 两次试跑差异（路线锁定，只改一个平台相位）===');
console.log(`救回时段 ${diff.gained.length} 段，丢失时段 ${diff.lost.length} 段`);
for (const s of diff.segments) {
  console.log(`  ${s.tag === 'gained' ? '救回' : '丢失'} 出发时段 [${s.start.toFixed(1)}s, ${s.end.toFixed(1)}s)`);
}

// 救回窗口内单点逐步复核
const t0 = diff.gained[0].start + 0.1;
const sim = simulateRoute(rescued, rescued.route, t0, rescued.horizon);
console.log(`\n=== 救回时段 t0=${t0.toFixed(1)}s 逐步复核（结果：${sim.ok ? '成功' : sim.reason}）===`);
for (const st of sim.steps) {
  console.log(`  步骤${st.index} ${st.type} -> ${st.endAt?.toFixed(1) ?? ''}s ${(st.notes ?? []).join('；')}`);
}
const baseSim = simulateRoute(demoScene, demoScene.route, t0, demoScene.horizon);
console.log(`同一 t0 基线结果：${baseSim.ok ? '成功' : baseSim.reason}（步骤 ${baseSim.failStep}，t=${baseSim.failAt?.toFixed(1)}s）`);

// 硬闸门边界：刚好关门必须判失败
const closed = base.samples.filter((s) => !s.ok && s.reason === REASONS.DOOR_CLOSED).length;
console.log(`\n基线中硬闸门「刚好关门」判失败样本：${closed} 个（半开区间语义生效）`);
