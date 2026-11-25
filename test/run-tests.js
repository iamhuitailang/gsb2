/*
 * 零依赖自动化测试：node test/run-tests.js
 * 覆盖：种子复现、连接几何、校验器、规则静态检查、锁定重生成、冲突报告、工程版本对比。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const rulesMod = require('../src/core/rules');
const genMod = require('../src/core/generator');
const validatorMod = require('../src/core/validator');
const projectMod = require('../src/core/project');

const rulesPath = path.join(__dirname, '../examples/rules/small-dungeon.json');
const rules = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  ✔ ' + name);
  } catch (err) {
    failed += 1;
    console.error('  ✘ ' + name + '\n    ' + (err.stack || err.message));
  }
}

function stripTime(map) {
  const c = JSON.parse(JSON.stringify(map));
  delete c.generatedAt;
  return c;
}

console.log('1. 规则静态检查');
test('示例规则无静态错误', () => {
  const issues = rulesMod.validateRules(rules).filter((i) => i.severity !== 'warning');
  assert.strictEqual(issues.length, 0, JSON.stringify(issues));
});

test('缺少起点类型被检出', () => {
  const bad = JSON.parse(JSON.stringify(rules));
  delete bad.roomTypes.find((t) => t.start).start;
  const issues = rulesMod.validateRules(bad);
  assert.ok(issues.some((i) => i.code === 'START_COUNT'));
});

test('min 之和超过 maxRooms 被判定必然无解', () => {
  const bad = JSON.parse(JSON.stringify(rules));
  bad.roomTypes.forEach((t) => { t.min = 5; t.max = 6; });
  const issues = rulesMod.validateRules(bad);
  assert.ok(issues.some((i) => i.code === 'MIN_EXCEEDS_MAXROOMS'));
});

test('相邻图上不可达的类型被检出', () => {
  const bad = JSON.parse(JSON.stringify(rules));
  bad.roomTypes.push({
    id: 'isolated', name: '孤岛房', color: '#fff', sizes: [[2, 2]], min: 1, max: 2,
    ports: { n: [0], s: [0], e: [0], w: [0] },
  });
  const issues = rulesMod.validateRules(bad);
  assert.ok(issues.some((i) => i.code === 'TYPE_UNREACHABLE_BY_ADJACENCY'));
});

test('端口偏移超出边长被检出', () => {
  const bad = JSON.parse(JSON.stringify(rules));
  bad.roomTypes[0].ports.n = [99];
  const issues = rulesMod.validateRules(bad);
  assert.ok(issues.some((i) => i.code === 'PORT_OUT_OF_RANGE'));
});

console.log('2. 生成与复现');
test('同一种子两次生成结果逐字节一致（忽略时间戳）', () => {
  const a = genMod.generate(rules, 'repro-001');
  const b = genMod.generate(rules, 'repro-001');
  assert.ok(a.ok && b.ok);
  assert.deepStrictEqual(stripTime(a.map), stripTime(b.map));
});

test('数字种子与字符串种子都能工作且稳定', () => {
  const a = genMod.generate(rules, 42);
  const b = genMod.generate(rules, '42');
  assert.ok(a.ok && b.ok);
  assert.deepStrictEqual(stripTime(a.map), stripTime(b.map));
});

test('不同种子产生不同地图', () => {
  const a = genMod.generate(rules, 'alpha');
  const b = genMod.generate(rules, 'beta');
  assert.notDeepStrictEqual(stripTime(a.map), stripTime(b.map));
});

console.log('3. 几何与连接完整性（已验证的成功种子）');
for (const seed of ['1', '2', '3', '7', '11', '42', '100']) {
  test(`seed ${seed} 生成成功且校验零错误`, () => {
    const res = genMod.generate(rules, seed);
    assert.ok(res.ok, res.conflicts?.map((c) => c.code).join(','));
    const report = validatorMod.validate(res.map, rules);
    assert.strictEqual(report.errors.length, 0, report.errors.map((e) => e.message).join(' | '));
  });
}

test('每条边的两个端口世界格重合、方向相反、双向引用', () => {
  const res = genMod.generate(rules, 'geometry-1');
  assert.ok(res.ok);
  const portById = new Map();
  res.map.rooms.forEach((r) => r.ports.forEach((p) => portById.set(p.id, { room: r, port: p })));
  for (const edge of res.map.edges) {
    const a = portById.get(edge.a);
    const b = portById.get(edge.b);
    assert.ok(a && b, '边引用了不存在的端口');
    const ca = genMod.portWorldCell(a.room, a.port);
    const cb = genMod.portWorldCell(b.room, b.port);
    assert.deepStrictEqual(ca, cb, '端口世界格不重合');
    assert.strictEqual(b.port.connects, a.port.id);
    assert.strictEqual(a.port.connects, b.port.id);
  }
});

test('房间不越界、不重叠', () => {
  const res = genMod.generate(rules, 'geometry-2');
  assert.ok(res.ok);
  const m = res.map;
  for (const r of m.rooms) {
    assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= m.grid.width && r.y + r.h <= m.grid.height);
  }
  for (let i = 0; i < m.rooms.length; i++) {
    for (let j = i + 1; j < m.rooms.length; j++) {
      const a = m.rooms[i], b = m.rooms[j];
      const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      assert.ok(!overlap, `${a.id} 与 ${b.id} 重叠`);
    }
  }
});

test('所有类型数量落在 min/max 区间', () => {
  const res = genMod.generate(rules, 'count-1');
  assert.ok(res.ok);
  const counts = rulesMod.countByType(res.map);
  for (const t of rules.roomTypes) {
    const n = counts[t.id] || 0;
    assert.ok(n >= t.min && n <= t.max, `${t.id}: ${n} 不在 [${t.min},${t.max}]`);
  }
});

console.log('4. 连通性');
test('起点到终点连通且必需房间全部可达', () => {
  const res = genMod.generate(rules, 'connect-1');
  const report = validatorMod.validate(res.map, rules);
  assert.ok(!report.issues.some((i) => ['END_UNREACHABLE', 'REQUIRED_UNREACHABLE', 'ROOM_ISOLATED', 'ROOM_NO_DOORS'].includes(i.code)));
});

console.log('5. 冲突报告（无法满足的规则）');
test('不可解规则返回结构化冲突而非抛异常', () => {
  // 静态检查能过（面积够、相邻图可达），但窄长网格在端口链约束下运行时摆不下全部必需房间
  const bad = JSON.parse(JSON.stringify(rules));
  bad.grid = { width: 60, height: 3 }; // 总面积够（静态过），但高 3 放不下 4x4 的 boss
  assert.strictEqual(rulesMod.validateRules(bad).filter((i) => i.severity !== 'warning').length, 0);
  const res = genMod.generate(bad, 'doomed');
  assert.strictEqual(res.ok, false);
  assert.ok(Array.isArray(res.conflicts) && res.conflicts.length > 0);
  assert.ok(res.partialMap, '失败时应返回局部地图');
});

test('静态必然无解的规则直接返回规则级冲突码', () => {
  const bad = JSON.parse(JSON.stringify(rules));
  bad.roomTypes.find((t) => t.id === 'boss').min = 99;
  bad.roomTypes.find((t) => t.id === 'boss').max = 99;
  const res = genMod.generate(bad, 'doomed2');
  assert.strictEqual(res.ok, false);
  assert.ok(res.conflicts.some((c) => c.code === 'MIN_EXCEEDS_MAXROOMS'));
});

test('网格过小冲突被静态拦截', () => {
  const bad = JSON.parse(JSON.stringify(rules));
  bad.grid = { width: 3, height: 3 };
  const res = genMod.generate(bad, 'x');
  assert.strictEqual(res.ok, false);
  assert.ok(res.conflicts.some((c) => c.code === 'GRID_TOO_SMALL' || c.code === 'NO_PLACEMENT_FOR_START'));
});

console.log('6. 锁定房间重生成');
test('重生成后锁定房间位置/尺寸/类型/端口完全不变', () => {
  const base = genMod.generate(rules, 'lock-base');
  assert.ok(base.ok);
  const lockedRooms = base.map.rooms.slice(0, 2).map((r) => ({ ...r, locked: true }));
  const lockedIds = new Set(lockedRooms.map((r) => r.id));
  // 断开跨边界连接
  for (const lr of lockedRooms) {
    lr.ports = lr.ports.map((p) => ({ ...p, connects: lockedIds.has(
      base.map.rooms.find((x) => x.ports.some((pp) => pp.id === p.connects))?.id
    ) ? p.connects : null }));
  }
  const regen = genMod.generate(rules, 'lock-regen-9', { lockedRooms });
  assert.ok(regen.ok, regen.conflicts?.map((c) => c.message).join(' | '));
  const report = validatorMod.validate(regen.map, rules, { rooms: lockedRooms });
  assert.ok(!report.issues.some((i) => i.code.startsWith('LOCKED')), report.issues.filter((i) => i.code.startsWith('LOCKED')).map((i) => i.message).join(' | '));
  for (const lr of lockedRooms) {
    const cur = regen.map.rooms.find((r) => r.id === lr.id);
    assert.ok(cur.locked);
    assert.strictEqual(cur.x, lr.x);
    assert.strictEqual(cur.y, lr.y);
    assert.strictEqual(cur.w, lr.w);
    assert.strictEqual(cur.h, lr.h);
    assert.strictEqual(cur.type, lr.type);
  }
});

test('重叠的锁定房间直接报错', () => {
  const base = genMod.generate(rules, 'lock-bad');
  const a = { ...base.map.rooms[0], locked: true };
  const b = { ...a, id: 'rx', ports: a.ports.map((p) => ({ ...p, id: p.id + 'b', connects: null })) };
  const res = genMod.generate(rules, 'lock-bad-2', { lockedRooms: [a, b] });
  assert.strictEqual(res.ok, false);
  assert.ok(res.conflicts.some((c) => c.code === 'LOCKED_OVERLAP'));
});

console.log('7. 工程保存与版本对比');
test('版本增删与 compareMaps 统计正确', () => {
  const project = projectMod.createProject(JSON.parse(JSON.stringify(rules)));
  const m1 = genMod.generate(rules, 'v1').map;
  const m2 = genMod.generate(rules, 'v2').map;
  const v1 = projectMod.addVersion(project, m1, 'A');
  const v2 = projectMod.addVersion(project, m2, 'B');
  assert.strictEqual(project.versions.length, 2);
  const cmp = projectMod.compareMaps(rules, v1.map, v2.map);
  assert.ok(cmp.rows.find((r) => r.key === 'rooms'));
  assert.ok(cmp.typeRows.length >= rules.roomTypes.length);
  projectMod.removeVersion(project, v1.id);
  assert.strictEqual(project.versions.length, 1);
  assert.strictEqual(project.activeVersionId, v2.id);
});

test('工程文件格式校验', () => {
  const project = projectMod.createProject(rules);
  assert.throws(() => projectMod.normalizeProject({ format: 'nope' }));
  const restored = projectMod.normalizeProject(JSON.parse(JSON.stringify(project)));
  assert.strictEqual(restored.format, projectMod.FORMAT);
});

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
