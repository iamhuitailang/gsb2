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

function measure(params, label) {
  // 空旷世界，只给一个大地面
  const lvl = JR.geom.makeLevel();
  lvl.entities = [
    { id: 'g', type: 'platform', x: -400, y: 400, w: 2000, h: 40 },
    { id: 's', type: 'start', x: 0, y: 336, w: 64, h: 64 },
  ];
  console.log(`\n== ${label} (jump=${params.jumpSpeed}, g=${params.gravity}, move=${params.moveSpeed}) ==`);
  for (const runup of [0, 6, 14, 24]) {
    for (const hold of [0.06, 0.2, 0.45, 1.05]) {
      const s = { dir: 1, runup, hold, move: 1 };
      const gen = JR.analyzer.makeInputGen(s);
      const sim = JR.physics.simulate(lvl, params, JR.physics.spawnState(lvl, params), gen);
      const apex = Math.min(...sim.frames.map((f) => f.y + f.h));
      const maxUp = 400 - apex;
      // 第一次回到地面的帧
      let landFrame = null;
      for (let i = runup + 1; i < sim.frames.length; i++) if (sim.frames[i].grounded) { landFrame = i; break; }
      const lf = sim.frames[landFrame || sim.frames.length - 1];
      const dist = lf.x - sim.frames[0].x;
      const air = landFrame !== null ? (landFrame - runup) / 60 : null;
      console.log(`runup=${runup} hold=${hold}: 跳高=${maxUp.toFixed(0)}px 落点水平距离=${dist.toFixed(0)}px 滞空=${air !== null ? air.toFixed(2) + 's' : '>max'}`);
    }
  }
}
measure({ ...JR.DEFAULT_PARAMS_A }, '参数A 标准');
measure({ ...JR.DEFAULT_PARAMS_B }, '参数B 弱弹跳');
