/* Node 自测：node tests/geometry.test.js，验证 JS 与 Python 共用的几何约定 */
const G = require('../js/geometry.js');
let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

// 1. 理想直立圆柱控制线：半宽 229px ≈ 输出 pxPerRad(229.3)，中心拉伸≈1
const W = 1000, H = 800;
const c = {
  LT: [271, 144], RT: [729, 144], LB: [271, 656], RB: [729, 656],
  TM: [500, 144], BM: [500, 656],
};
const warp = G.buildWarp(c, 720, 360, Math.PI / 2, W, H);

// 2. 等角映射：等距列的 θ 增量恒定（弧长等角）；数组行优先取首行
{
  const thetas = [0, 100, 200, 300, 400].map((x) => warp.theta[x]);
  const dTheta = thetas.slice(1).map((v, i) => v - thetas[i]);
  const eqTheta = dTheta.every((d) => Math.abs(d - dTheta[0]) < 1e-6);
  const sins = thetas.map(Math.sin);
  const mono = sins.slice(1).every((v, i) => v > sins[i]);
  check('输出列 θ 等角排布', eqTheta && mono, JSON.stringify(dTheta));
}

// 3. 中心列 θ≈0，两端列 θ≈±90°（W 为偶数时中心落在两列之间，容差半列）
check('中心列 θ≈0', Math.abs(warp.theta[360]) < Math.PI / 720 + 1e-6, `got ${warp.theta[360]}`);
check('左边界 θ=-90°', Math.abs(warp.theta[0] + Math.PI / 2) < 1e-6);
check('右边界 θ=+90°', Math.abs(warp.theta[719] - Math.PI / 2) < 1e-6);

// 4. 理想矩形控制线：源点随 s 水平线性变化，且中心在轴上（W 偶数，精确中心在两列之间）
{
  const mid = G.unwrappedToSource(c, 359.5, 180, 720, 360);
  check('中心列源点落在轴线上', Math.abs(mid.sx - W / 2) < 1e-6, `sx=${mid.sx}`);
  const top0 = G.edgePoint(c, 'top', 0);
  const top1 = G.edgePoint(c, 'top', 1);
  check('上缘端点即左右上角', top0[0] === c.LT[0] && top1[0] === c.RT[0]);
}

// 5. 边缘拉伸：|θ|→90° 时拉伸系数增大，中心 ≈1（有限差分近似，给 3% 容差）
{
  const sCenter = warp.stretch[360];
  const sEdge = warp.stretch[10];
  check('中心拉伸≈1', Math.abs(sCenter - 1) < 0.03, `got ${sCenter}`);
  check('边缘拉伸显著大于中心', sEdge > sCenter * 3, `edge=${sEdge}, center=${sCenter}`);
}

// 6. 取用角限制：θ 超限列 status=1，内部为 0
{
  const lim = 60 * Math.PI / 180;
  const w2 = G.buildWarp(c, 720, 360, lim, W, H);
  check('θ 限制列被标记为 status=1', w2.status[0] === 1 && w2.status[719] === 1);
  check('限制内列 status=0', w2.status[360] === 0);
  // 列与 θ 线性：x = (θ/π + 1/2)(W−1)
  const x60 = (lim / Math.PI + 0.5) * 719;
  const xIn = Math.floor(x60) - 8, xOut = Math.ceil(x60) + 8;
  const st = (x) => w2.status[x]; // 同列状态一致，首行索引即列号
  check('60° 边界附近状态翻转', st(xOut) === 1 && st(xIn) === 0,
    `x60=${x60.toFixed(1)} inside[${xIn}]=${st(xIn)} outside[${xOut}]=${st(xOut)}`);}

// 7. 相似变换：已知 (x,y)→(x+10,y-5)+2x，拟合后残差≈0
{
  const Mtrue = { a: 2, b: 0, tx: 10, ty: -5 };
  const pairs = [[0, 0], [10, 0], [0, 10], [7, 9]].map(([x, y]) => ({ b: [x, y], a: G.applySim(Mtrue, x, y) }));
  const fit = G.fitSimilarity(pairs);
  check('相似变换拟合参数',
    Math.abs(fit.M.a - 2) < 1e-8 && Math.abs(fit.M.tx - 10) < 1e-8 && Math.abs(fit.M.ty + 5) < 1e-8);
  check('拟合残差≈0', fit.rms < 1e-8, `rms=${fit.rms}`);
  // 逆变换往返
  const inv = G.invertSim(fit.M);
  const q = G.applySim(inv, ...G.applySim(fit.M, 12.5, -7.25));
  check('逆变换往返一致', Math.hypot(q[0] - 12.5, q[1] + 7.25) < 1e-8);
}

// 8. 单对点退化为平移
{
  const fit = G.fitSimilarity([{ a: [100, 200], b: [10, 20] }]);
  check('单对点=纯平移', fit.M.tx === 90 && fit.M.ty === 180 && fit.M.a === 1 && fit.M.b === 0);
  check('单对点给出平移提示', fit.warnings.some((w) => w.level === 'warn'));
}

// 8b. 两个共线点 → degenerate；三个非共线点 → 正常
{
  const collinear = [
    { b: [0, 0], a: [10, 5] }, { b: [10, 0], a: [20, 5] },
  ];
  const fitBad = G.fitSimilarity(collinear);
  check('共线点对标记 degenerate', fitBad.degenerate === true);
  const good = [
    { b: [0, 0], a: [10, 5] }, { b: [10, 0], a: [20, 5] }, { b: [0, 10], a: [10, 15] },
  ];
  const fitGood = G.fitSimilarity(good);
  check('非共线三点不退化', fitGood.degenerate === false && fitGood.rms < 1e-6);
}

// 9. 控制线体检：反向中点报错，相交侧缘报错
{
  const bad = JSON.parse(JSON.stringify(c));
  bad.TM = [W * 0.9, H * 0.1]; // 中点跑到右侧外面，破坏单调
  const warns = G.controlWarnings(bad, W, H);
  check('反向中点触发 error', warns.some((w) => w.level === 'error'));
  const swapped = JSON.parse(JSON.stringify(c));
  [swapped.LT, swapped.RT] = [swapped.RT, swapped.LT];
  const warns2 = G.controlWarnings(swapped, W, H);
  check('侧缘交叉/反向触发 error', warns2.some((w) => w.level === 'error'));
}

// 10. 贝塞尔中点采样在两端之间
{
  const p = G.bezier2([0, 0], [10, -5], [20, 0], 0.5);
  check('二次贝塞尔 t=.5 取到控制点加权', Math.abs(p[0] - 10) < 1e-9 && Math.abs(p[1] + 2.5) < 1e-9);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
