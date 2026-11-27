import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTown, saveTown } from './persistence.js';
import { applyRuleUpdate, previewRuleUpdate } from './preview.js';
import { DEMO_RULES_V1, DEMO_RULES_V2 } from './rules.js';
import { replayRoster, Town, verifyRoster } from './town.js';
import { ExhaustedError } from './types.js';

function show(title: string): void {
  console.log(`\n=== ${title} ===`);
}

function showProvenance(r: { fullName: string; provenance: Array<{ rule: string; detail: string }> }): void {
  console.log(`  ${r.fullName}`);
  for (const p of r.provenance) console.log(`    [${p.rule}] ${p.detail}`);
}

const tmp = mkdtempSync(join(tmpdir(), 'town-namer-'));
try {
  // ---------- 1. 建城：三个族群、声节禁忌触发换词 ----------
  show('1. 建城 Emberford，三个族群各来几位居民');
  const ember = Town.create('emberford', 'seed-16313', DEMO_RULES_V1);
  ember.addResident('yan');
  ember.addResident('yan');
  ember.addResident('xi');
  ember.addResident('xi');
  for (const r of ember.residents) console.log(`  ${r.id}  ${r.fullName}  (${r.clanId})`);

  // 找一个触发了禁忌换词或撞车重抽的居民展示来历；没有就展示第一个
  const withSwap =
    ember.residents.find((r) => r.provenance.some((p) => p.rule === 'compat:swap')) ??
    ember.residents[0]!;
  show('某位居民的名字是按哪几条规则来的');
  showProvenance(withSwap);

  // ---------- 2. 继承：子女继承父家/母家姓 ----------
  show('2. 继承：子女继承父家或母家的姓');
  const father = ember.addResident('yan');
  const mother = ember.addResident('xi');
  const childF = ember.addChild({ fatherId: father.id, motherId: mother.id, inheritFrom: 'father' });
  const childM = ember.addChild({ fatherId: father.id, motherId: mother.id, inheritFrom: 'mother' });
  const childAuto = ember.addChild({ fatherId: father.id, motherId: mother.id, inheritFrom: 'auto' });
  assert.equal(childF.surname, father.surname);
  assert.equal(childM.surname, mother.surname);
  showProvenance(childF);
  showProvenance(childM);
  console.log(`  auto 继承结果：${childAuto.fullName}（${childAuto.provenance[0]!.detail}）`);

  // ---------- 3. 迁居：保留原名与来源 ----------
  show('3. 迁居：从 Emberford 迁到 Porthope，保留原名与来源');
  const port = Town.create('porthope', 'seed-16313', DEMO_RULES_V1);
  const mover = ember.migrateOut(father.id, port);
  assert.equal(mover.fullName, father.fullName);
  assert.equal(mover.originTownId, 'emberford');
  console.log(`  原城: ${father.fullName} (origin=${father.originTownId})`);
  console.log(`  新城: ${mover.fullName} (origin=${mover.originTownId})`);
  showProvenance(mover);

  // ---------- 4. 词库用尽：指出卡住的族群 ----------
  show('4. 风隼部词库极小，演示用尽并报出卡住的族群');
  console.log('  容量报告（生成前）:');
  for (const c of ember.capacityReport()) {
    console.log(`    ${c.label}(${c.clanId}): 容量 ${c.capacity}, 已用 ${c.used}, 剩余 ${c.remaining}`);
  }
  let exhaustedAt = '';
  try {
    for (let i = 0; i < 20; i++) ember.addResident('feng');
  } catch (e) {
    assert.ok(e instanceof ExhaustedError);
    assert.equal(e.clanId, 'feng');
    exhaustedAt = (e as Error).message;
  }
  assert.ok(exhaustedAt, '风隼部应当耗尽');
  console.log(`  ${exhaustedAt}`);
  console.log(`  风隼部实际入住 ${ember.residents.filter((r) => r.clanId === 'feng').length} 人后卡住`);

  // ---------- 5. 持久化 + 重建一致性 + 追加稳定 ----------
  show('5. 存档 → 重开 → 重建名册逐字一致；新增居民不影响老名字');
  const file = join(tmp, 'emberford.json');
  saveTown(ember, file);
  const before = ember.residents.map((r) => `${r.id}:${r.fullName}`);
  const reopened = loadTown(file);
  const check = verifyRoster(reopened.state);
  assert.ok(check.ok, check.mismatches.join('\n'));
  console.log('  重开后重放名册：逐字一致 ✔');

  const replayed = replayRoster(reopened.state);
  assert.deepEqual(
    replayed.map((r) => r.fullName),
    ember.residents.map((r) => r.fullName),
  );

  reopened.addResident('yan'); // 新居民只追加
  const after = reopened.residents.map((r) => `${r.id}:${r.fullName}`);
  assert.deepEqual(after.slice(0, before.length), before);
  console.log(`  新增 ${after[after.length - 1]}，前 ${before.length} 位老居民名字一个没变 ✔`);

  // ---------- 6. 规则更新：预览 + 沿用标记 ----------
  show('6. 岩氏族规则升级到 v2，先预览哪些旧名字不再符合');
  const preview = previewRuleUpdate(reopened.residents, DEMO_RULES_V2);
  console.log(`  仍符合新规则: ${preview.cleanCount} 人`);
  for (const v of preview.violations) {
    console.log(`  ✗ ${v.residentId} ${v.fullName}: ${v.reasons.join('；')}`);
  }
  assert.ok(preview.violations.length > 0, 'v2 弃用了 Nara/Sora，应当有违规者');

  // 标记沿用，绝不批量改名
  applyRuleUpdate(reopened.state.residents, DEMO_RULES_V2, preview.violations.map((v) => v.residentId));
  reopened.state.rules = DEMO_RULES_V2; // 之后新生成的走新规则
  const previewAfter = previewRuleUpdate(reopened.residents, DEMO_RULES_V2);
  assert.equal(previewAfter.violations.length, 0);
  assert.ok(previewAfter.grandfatheredViolations.length > 0);
  console.log(`  已标记沿用旧名 ${previewAfter.grandfatheredViolations.length} 人，不批量改名`);

  const newGen = reopened.addResident('yan');
  assert.ok(DEMO_RULES_V2.clans[0]!.givens.includes(newGen.given));
  console.log(`  新规则下出生的居民: ${newGen.fullName}（名字出自 v2 词库 ✔）`);

  // ---------- 7. 导出 ----------
  show('7. 导出已生成居民');
  const exportFile = join(tmp, 'residents.json');
  saveTown(reopened, join(tmp, 'final.json'));
  const exported = reopened.exportResidents();
  console.log(exported.split('\n').slice(0, 8).join('\n') + '\n  ...');
  assert.ok(JSON.parse(exported).length === reopened.residents.length);
  void readFileSync; // （导出内容即上方 JSON 字符串，调用方可自行写盘）
  void exportFile;

  console.log('\n全部演示与断言通过 ✔');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
