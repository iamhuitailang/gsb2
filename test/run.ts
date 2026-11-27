import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clanCapacity, getClan } from '../src/generator.js';
import { loadTown, saveTown } from '../src/persistence.js';
import { applyRuleUpdate, previewRuleUpdate, validateAgainst } from '../src/preview.js';
import { DEMO_RULES_V1, DEMO_RULES_V2 } from '../src/rules.js';
import { replayRoster, Town, verifyRoster } from '../src/town.js';
import { ExhaustedError } from '../src/types.js';

let passed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✔ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}`);
    throw e;
  }
}

/** 用同一串操作建一座城，便于对比两次运行的结果。 */
function buildTown(): Town {
  const t = Town.create('emberford', 'seed-16313', DEMO_RULES_V1);
  t.addResident('yan');
  t.addResident('xi');
  const f = t.addResident('yan');
  const m = t.addResident('xi');
  t.addChild({ fatherId: f.id, motherId: m.id, inheritFrom: 'father' });
  t.addChild({ fatherId: f.id, motherId: m.id, inheritFrom: 'auto' });
  t.addResident('feng');
  return t;
}

console.log('运行测试…');

test('确定性：同规则同种子同操作，两次建城名册逐字一致', () => {
  const a = buildTown();
  const b = buildTown();
  assert.deepEqual(
    a.residents.map((r) => r.fullName),
    b.residents.map((r) => r.fullName),
  );
  assert.deepEqual(
    a.residents.map((r) => r.provenance),
    b.residents.map((r) => r.provenance),
  );
});

test('追加稳定：新增居民不改变任何老居民的名字', () => {
  const t = buildTown();
  const before = t.residents.map((r) => `${r.id}:${r.fullName}`);
  t.addResident('yan');
  t.addResident('xi');
  const after = t.residents.map((r) => `${r.id}:${r.fullName}`);
  assert.deepEqual(after.slice(0, before.length), before);
});

test('重建：从存档状态重放，名册与来历完全一致', () => {
  const t = buildTown();
  const replayed = replayRoster(t.state);
  assert.deepEqual(replayed, t.residents.map((r) => ({ ...r })));
  assert.ok(verifyRoster(t.state).ok);
});

test('持久化：存档重开后继续生成，与不间断运行结果一致', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'town-namer-test-'));
  try {
    const a = buildTown();
    const file = join(tmp, 'town.json');
    saveTown(a, file);
    const reopened = loadTown(file);
    reopened.addResident('yan');

    const b = buildTown();
    b.addResident('yan');

    assert.deepEqual(
      reopened.residents.map((r) => r.fullName),
      b.residents.map((r) => r.fullName),
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('继承：子女姓与被继承家长一致，来历含 inherit 记录', () => {
  const t = Town.create('t', 's', DEMO_RULES_V1);
  const f = t.addResident('yan');
  const m = t.addResident('xi');
  const cf = t.addChild({ fatherId: f.id, motherId: m.id, inheritFrom: 'father' });
  const cm = t.addChild({ fatherId: f.id, motherId: m.id, inheritFrom: 'mother' });
  assert.equal(cf.surname, f.surname);
  assert.equal(cm.surname, m.surname);
  assert.equal(cf.clanId, f.clanId);
  assert.equal(cm.clanId, m.clanId);
  assert.ok(cf.provenance.some((p) => p.rule === 'inherit:father'));
  assert.ok(cm.provenance.some((p) => p.rule === 'inherit:mother'));
});

test('迁居：名字不变、来源保留、来历含 migrate 记录', () => {
  const a = Town.create('a-town', 's1', DEMO_RULES_V1);
  const b = Town.create('b-town', 's2', DEMO_RULES_V1);
  const r = a.addResident('xi');
  const moved = a.migrateOut(r.id, b);
  assert.equal(moved.fullName, r.fullName);
  assert.equal(moved.originTownId, 'a-town');
  assert.ok(moved.provenance.some((p) => p.rule === 'migrate:keep'));
  // 迁居记录也参与确定性重放
  assert.ok(verifyRoster(b.state).ok);
});

test('撞车：同城允许撞姓，但全名唯一（上限 0）', () => {
  const t = Town.create('t', 's', DEMO_RULES_V1);
  for (let i = 0; i < 6; i++) t.addResident('yan');
  const full = t.residents.map((r) => r.fullName);
  assert.equal(new Set(full).size, full.length, '全名必须唯一');
  const surnames = t.residents.map((r) => r.surname);
  assert.ok(new Set(surnames).size < surnames.length, '4 个姓 6 个人，必然撞姓');
});

test('用尽：词库耗尽时抛出 ExhaustedError 并指明族群', () => {
  const t = Town.create('t', 's', DEMO_RULES_V1);
  const feng = getClan(DEMO_RULES_V1, 'feng');
  const cap = clanCapacity(feng);
  assert.ok(cap <= 8, `风隼部容量应很小，实际 ${cap}`);
  let err: ExhaustedError | null = null;
  try {
    for (let i = 0; i < cap + 5; i++) t.addResident('feng');
  } catch (e) {
    err = e as ExhaustedError;
  }
  assert.ok(err instanceof ExhaustedError);
  assert.equal(err!.clanId, 'feng');
  // 换词机制会把所有姓氏组合都填满才卡住：耗尽时人数应正好等于容量
  assert.equal(t.residents.length, cap);
  // 耗尽前生成的名字仍然全部唯一
  const full = t.residents.map((r) => r.fullName);
  assert.equal(new Set(full).size, full.length);
});

test('规则更新：预览违规 → 标记沿用 → 新居民走新规则', () => {
  const t = Town.create('t', 's', DEMO_RULES_V1);
  for (let i = 0; i < 8; i++) t.addResident('yan');
  const preview = previewRuleUpdate(t.residents, DEMO_RULES_V2);
  assert.ok(preview.violations.length > 0, 'v2 弃用词应当揪出旧名字');

  const ids = preview.violations.map((v) => v.residentId);
  applyRuleUpdate(t.state.residents, DEMO_RULES_V2, ids);
  const again = previewRuleUpdate(t.residents, DEMO_RULES_V2);
  assert.equal(again.violations.length, 0, '沿用标记后不再要求改名');
  assert.equal(again.grandfatheredViolations.length, ids.length);

  t.state.rules = DEMO_RULES_V2;
  const n = t.addResident('yan');
  assert.deepEqual(validateAgainst(n, DEMO_RULES_V2), []);
  assert.ok(getClan(DEMO_RULES_V2, 'yan').givens.includes(n.given));
});

test('导出：JSON 可解析且人数一致', () => {
  const t = buildTown();
  const data = JSON.parse(t.exportResidents()) as Array<{ id: string; fullName: string }>;
  assert.equal(data.length, t.residents.length);
  assert.ok(data.every((d) => d.id && d.fullName));
});

console.log(`\n${passed} 项测试全部通过 ✔`);
