// 帧率无关性验证：所有样例在 24/30/60/144/237fps 下重放，
// 动作序列与消费事件必须完全一致；并打印各样例的判定结果供人工核对。
import { replayAtFps } from '../dist/engine.js';
import { DEFAULT_CONFIG, SAMPLE_GROUPS } from '../dist/samples.js';

let fail = 0;
for (const g of SAMPLE_GROUPS) {
  console.log(`\n=== ${g.name} ===`);
  for (const s of g.samples) {
    const fpsList = [24, 30, 60, 144, 237];
    const results = fpsList.map(f => replayAtFps(DEFAULT_CONFIG, s.events, f));
    const base = JSON.stringify({ a: results[0].actions, c: results[0].consumed });
    const allSame = results.every(r => JSON.stringify({ a: r.actions, c: r.consumed }) === base);
    if (!allSame) fail++;
    console.log(`${allSame ? '✓' : '✗ 帧率不一致!'} ${s.label}`);
    console.log(`    动作序列: ${results[0].actions.join(' → ') || '(无)'}`);
    console.log(`    消费事件: ${results[0].consumed.map(i => '#' + i).join(' ') || '(无)'}`);
  }
}

// 组内可比性抽查
const g3 = SAMPLE_GROUPS[2].samples;
const r3a = replayAtFps(DEFAULT_CONFIG, g3[0].events, 60);
const r3b = replayAtFps(DEFAULT_CONFIG, g3[1].events, 60);
const same3 = JSON.stringify(r3a.actions) === JSON.stringify(r3b.actions);
console.log(`\n③ 3a(重复上报) vs 3b(干净长按) 动作序列相同: ${same3 ? '✓' : '✗'}`);
if (!same3) fail++;

process.exit(fail ? 1 : 0);
