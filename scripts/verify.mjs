// 无浏览器校验：直接跑求解器的关键场景，打印可核对的数据，并在明显异常时以非 0 退出。
// 用法：node scripts/verify.mjs

import { makeState, applyDemo, normalizeLoadedState, serializeScene } from '../js/model.js';
import { sampleLighting, samplePath, auditCoverage, pathEvents } from '../js/solver.js';
import { DIVIDER } from '../js/config.js';

const rows = [];
const failures = [];
const push = (name, value) => rows.push([name, value]);
const check = (name, ok, detail) => {
  push(name, `${ok ? 'PASS' : 'FAIL'} · ${detail}`);
  if (!ok) failures.push(`${name}: ${detail}`);
};

function lums(state, point) {
  const r = sampleLighting(state, point, { mode: 'restricted' });
  const u = sampleLighting(state, point, { mode: 'unrestricted' });
  return {
    r: r.lum,
    u: u.lum,
    support: r.support,
    probes: r.usedProbeCount,
    cross: r.contributions.filter((c) => c.crossSide).length,
    zone: r.zone,
  };
}

const open = makeState();
const closed = applyDemo('closed');
const gap = applyDemo('gap');

const inside = { x: 0.4, z: 0 };
const o = lums(open, inside);
const c = lums(closed, inside);

push('开门·室内', `${o.r.toFixed(4)} / 无限制 ${o.u.toFixed(4)} · 跨区探针 ${o.cross}`);
push('关门·室内', `${c.r.toFixed(4)} / 无限制 ${c.u.toFixed(4)} · 跨区探针 ${c.cross}`);

// 1. 开门时室内靠墙点确实有跨区探针经门洞参与
check('开门·门口透光', o.cross > 0, `${o.cross} 个跨区探针参与`);

// 2. 关门后受区域限制不跨区；无区域限制仍跨区且更亮
check('关门·限制了跨区探针', c.cross === 0, `${c.cross} 个跨区探针`);
check('关门·无区域限制漏光', c.u > c.r + 0.01, `差值 ${(c.u - c.r).toFixed(4)}`);

const openPath = samplePath(open, { step: 0.05 });
const closedPath = samplePath(closed, { step: 0.05 });

const maxJump = (samples) => {
  let max = 0;
  let at = 0;
  for (let i = 1; i < samples.length; i += 1) {
    const d = Math.abs(samples[i].restricted.lum - samples[i - 1].restricted.lum);
    if (d > max) { max = d; at = samples[i].dist; }
  }
  return { max, at };
};
const jo = maxJump(openPath);
const jc = maxJump(closedPath);
push('门开·最大单步亮度跳变', `${jo.max.toFixed(4)} @ ${jo.at.toFixed(2)} m`);
push('门关·最大单步亮度跳变', `${jc.max.toFixed(4)} @ ${jc.at.toFixed(2)} m`);

const leak = (samples) => {
  let max = 0;
  for (const s of samples) {
    if (s.x > DIVIDER.x - 1 && s.x < DIVIDER.x) {
      max = Math.max(max, s.unrestricted.lum - s.restricted.lum);
    }
  }
  return max;
};
const closedLeak = leak(closedPath);
const openLeak = leak(openPath);
push('门关·门内侧漏光峰值', closedLeak.toFixed(4));
push('门开·门内侧漏光峰值', openLeak.toFixed(4));
check('门关·漏光大于门开', closedLeak > openLeak, `关门 ${closedLeak.toFixed(3)} vs 开门 ${openLeak.toFixed(3)}`);

const auditGap = auditCoverage(gap);
push('区域罩不全·覆盖率', `${(auditGap.coverageRatio * 100).toFixed(1)}% · 补缺段 ${auditGap.fallbackSegments.length}`);
push('区域罩不全·审计说明', auditGap.summary);
check('区域罩不全·能识别缺口', auditGap.fallbackSegments.length > 0, `补缺段 ${auditGap.fallbackSegments.length}`);

const gapSamples = samplePath(gap, { step: 0.2 });
const tail = gapSamples.at(-1).restricted;
push('区域罩不全·末帧', `支撑 ${(tail.support * 100).toFixed(0)}% · 实测 ${format(tail.computed.up)} · 输出 ${format(tail.colors.up)}`);
check('区域罩不全·末帧为纯补缺', tail.support === 0, `支撑 ${tail.support}`);

function format(rgb) {
  return `rgb(${rgb.map((v) => Math.round(v * 255)).join(',')})`;
}

const ev = pathEvents(samplePath(open, { step: 0.1 }));
push('门开·事件数', String(ev.length));
check('门开·能标出格边与门槛', ev.some((e) => e.type === 'cell') && ev.some((e) => e.type === 'threshold'), `${ev.filter((e) => e.type === 'cell').length} 格边 / ${ev.filter((e) => e.type === 'threshold').length} 门槛`);
for (const e of ev.slice(0, 6)) push(`  事件 @${e.dist.toFixed(2)}m`, `${e.label} ${e.detail}`);

const serialized = serializeScene(open);
const round = normalizeLoadedState(JSON.parse(JSON.stringify(serialized)));
const before = samplePath(open, { step: 0.25 }).map((s) => s.restricted.lum);
const after = samplePath(round, { step: 0.25 }).map((s) => s.restricted.lum);
const maxDiff = Math.max(...before.map((v, i) => Math.abs(v - after[i])));
push('保存/读回·最大亮度差', maxDiff.toExponential(2));
check('保存/读回·可复现', maxDiff < 1e-9, maxDiff.toExponential(2));

const width = 16;
const line = '-'.repeat(width) + '  ' + '-'.repeat(64);
console.log(line);
for (const [k, v] of rows) console.log(k.padEnd(width) + '  ' + v);
console.log(line);
if (failures.length) {
  console.error(`\n${failures.length} 项失败：`);
  for (const f of failures) console.error(`  ✕ ${f}`);
  process.exitCode = 1;
} else {
  console.log('\n全部检查通过。');
}
