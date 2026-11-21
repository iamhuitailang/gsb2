import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = { window: {}, console, Math, JSON, Date };
sandbox.window.JR = sandbox.JR = {};
vm.createContext(sandbox);
for (const f of ['constants.js', 'geometry.js', 'physics.js', 'analyzer.js', 'level.js']) {
  vm.runInContext(readFileSync(join(root, 'js', f), 'utf8'), sandbox, { filename: f });
}
const { JR } = sandbox;

const lvl = JR.demo.demoLevel();
for (const e of lvl.entities) console.log(e.id, e.type, `(${e.x},${e.y})`, `${e.w}x${e.h}`, e.oneWay ? 'oneWay' : '');
for (const [label, key] of [['A', 'DEFAULT_PARAMS_A'], ['B', 'DEFAULT_PARAMS_B']]) {
  const res = JR.analyzer.analyze(lvl, { ...JR[key] });
  console.log(`\n[${label}] reachable=${[...res.reachableIds].join(',')} bonkBlocked=${[...res.bonkIds].join(',')}`);
  for (const agg of res.platforms) {
    console.log('  ', agg.entityId, 'reachable=', agg.reachable, 'bonkBlocked=', agg.bonkBlocked, 'edgeSlips=', agg.edgeSlips,
      agg.bestRun ? 'best=' + JR.analyzer.strategyLabel(agg.bestRun.run.strategy) : '');
  }
  const judge = JR.analyzer.judgeTarget(lvl, { ...JR[key] }, res);
  console.log('  target judge:', judge.ok ? 'OK ' + judge.text : judge.reason + ' - ' + judge.text);
}
