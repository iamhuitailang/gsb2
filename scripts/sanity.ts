/**
 * 引擎自检：不依赖浏览器，运行 `npm run sanity`（tsx）。
 * 覆盖六条需求对应的关键解析结果，防止重构破坏演示线索。
 */
import assert from 'node:assert/strict';
import {
  DEMO_LIBRARY,
  ITEMS,
  DEFAULT_ENABLED_IDS,
} from '../src/demoData';
import { analyzePacks } from '../src/engine/graph';
import { resolveAll, resolveItem } from '../src/engine/resolve';
import { planBatchApply, attemptBatchApply } from '../src/engine/batch';
import {
  buildProvenance,
  buildExportDoc,
  parseImportText,
} from '../src/engine/transfer';
import { SCENES, LANGUAGES } from '../src/demoData';

const enabled: Record<string, boolean> = {};
for (const p of DEMO_LIBRARY) enabled[p.id] = false;
for (const id of DEFAULT_ENABLED_IDS) enabled[id] = true;
const priorities: Record<string, number> = {};

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const ctx = (scene: string, language: string, en = enabled, pr = priorities) => {
  const analysis = analyzePacks(DEMO_LIBRARY, en, pr);
  const results = new Map(
    ITEMS.map((i) => [
      i.id,
      resolveItem(i.id, { scene, language }, DEMO_LIBRARY, analysis),
    ]),
  );
  return { analysis, results };
};

console.log('1) 场景 / 语言 / 包顺序 / 逐级回退');

check('默认 world + zh-CN：铁剑为同级冲突，按 ID 次序蓝包临时胜出', () => {
  const { results } = ctx('world', 'zh-CN');
  const sword = results.get('sword_iron')!;
  assert.equal(sword.status, 'conflict');
  assert.equal(sword.winnerPackId, 'pack_hd_blue');
  assert.deepEqual(sword.conflict!.packIds, ['pack_hd_blue', 'pack_hd_red']);
});

check('切到 battle：赤包 battle 变体更精确，冲突改由赤包胜出', () => {
  const { results } = ctx('battle', 'zh-CN');
  const sword = results.get('sword_iron')!;
  assert.equal(sword.status, 'conflict');
  assert.equal(sword.winnerPackId, 'pack_hd_red');
  assert.equal(sword.winnerVariant!.scene, 'battle');
});

check('zh-CN 药水命中语言包的 zh-CN 精确键', () => {
  const { results } = ctx('world', 'zh-CN');
  assert.equal(results.get('potion_hp')!.winnerPackId, 'lang_zh');
  assert.equal(results.get('potion_hp')!.winnerVariant!.lang, 'zh-CN');
});

check('zh-CN 木箱经 zh 主标签回退本应命中中文包（但被移除包压制，关闭后可见）', () => {
  const en2 = { ...enabled, pack_lite: false };
  const { results } = ctx('world', 'zh-CN', en2);
  const chest = results.get('chest_wood')!;
  assert.equal(chest.status, 'found');
  assert.equal(chest.winnerPackId, 'lang_zh');
  assert.equal(chest.winnerVariant!.lang, 'zh');
});

check('en-US 药水 / 木箱切换到英文语言包', () => {
  const en2 = { ...enabled, pack_lite: false };
  const { results } = ctx('world', 'en-US', en2);
  assert.equal(results.get('potion_hp')!.winnerPackId, 'lang_en');
  assert.equal(results.get('chest_wood')!.winnerPackId, 'lang_en');
});

check('fr-FR 无语言包：跨包继续回退到高清赤包的 (*,*) 药水', () => {
  const { results } = ctx('world', 'fr-FR');
  assert.equal(results.get('potion_hp')!.winnerPackId, 'pack_hd_red');
});

check('金币在 world 命中 world/* 场景键，在 menu 命中 menu/* 场景键', () => {
  assert.equal(ctx('world', 'zh-CN').results.get('coin_gold')!.winnerVariant!.scene, 'world');
  assert.equal(ctx('menu', 'zh-CN').results.get('coin_gold')!.winnerVariant!.scene, 'menu');
  assert.equal(ctx('battle', 'zh-CN').results.get('coin_gold')!.winnerVariant!.scene, '*');
});

console.log('2) 依赖：缺依赖 / 成环 / 依赖未开启');

check('暗影包被识别为 missing-dependency（pack_ghost_assets）', () => {
  const { analysis } = ctx('world', 'zh-CN');
  const dark = analysis.byId.get('pack_darkmod')!;
  assert.ok(dark.manifestIssues.some((i) => i.code === 'missing-dependency' && i.depId === 'pack_ghost_assets'));
  assert.equal(dark.usable, false); // 默认未开启，usable 仍为 false
});

check('cycle_a / cycle_b 被 Tarjan 识别为一个环', () => {
  const { analysis } = ctx('world', 'zh-CN');
  assert.equal(analysis.cycles.length, 1);
  assert.deepEqual([...analysis.cycles[0].nodes].sort(), ['pack_cycle_a', 'pack_cycle_b']);
  for (const id of ['pack_cycle_a', 'pack_cycle_b']) {
    assert.ok(analysis.byId.get(id)!.manifestIssues.some((i) => i.code === 'cycle'));
  }
});

check('开启 neon 但关闭其依赖 hd_red：neon 因 dependency-disabled 不可用并被跳过', () => {
  const en2 = { ...enabled, pack_hd_red: false };
  const { analysis, results } = ctx('world', 'zh-CN', en2);
  const neon = analysis.byId.get('pack_neon')!;
  assert.equal(neon.usable, false);
  assert.ok(neon.runtimeIssues.some((i) => i.code === 'dependency-disabled' && i.depId === 'pack_hd_red'));
  // 弓失去霓虹包后落到基础包（水墨包默认关闭）
  assert.equal(results.get('bow_elf')!.winnerPackId, 'base_core');
});

check('坏包开启后仍不参与解析，其他道具照常', () => {
  const en2 = { ...enabled, pack_darkmod: true, pack_cycle_a: true, pack_cycle_b: true };
  const { results } = ctx('world', 'zh-CN', en2);
  // 暗影包原本会给 key 提供影钥，但因缺依赖被跳过 -> 仍是中文语言包
  assert.equal(results.get('key_brass')!.winnerPackId, 'lang_zh');
  assert.ok(results.get('sword_iron')!.winnerVariant);
});

console.log('3+4) 显式移除与缺图区分');

check('木箱默认状态为 removed，移除者是 pack_lite（不是 missing）', () => {
  const { results } = ctx('world', 'zh-CN');
  const chest = results.get('chest_wood')!;
  assert.equal(chest.status, 'removed');
  assert.equal(chest.removedByPackId, 'pack_lite');
});

check('关闭 lite 后木箱资源回来', () => {
  const en2 = { ...enabled, pack_lite: false };
  const { results } = ctx('world', 'zh-CN', en2);
  assert.equal(results.get('chest_wood')!.status, 'found');
  assert.ok(results.get('chest_wood')!.winnerVariant);
});

check('蓝宝石在 battle 被按场景移除，在 world 仍由霓虹包提供', () => {
  assert.equal(ctx('battle', 'zh-CN').results.get('gem_blue')!.status, 'removed');
  const worldGem = ctx('world', 'zh-CN').results.get('gem_blue')!;
  assert.equal(worldGem.status, 'found');
  assert.equal(worldGem.winnerPackId, 'pack_neon');
});

check('不存在任何资源的道具才是 missing（构造一个空库场景验证）', () => {
  const analysis = analyzePacks([], {});
  const r = resolveItem('ghost_item', { scene: 'world', language: 'zh-CN' }, [], analysis);
  assert.equal(r.status, 'missing');
});

console.log('5) 批量应用：先对比、坏包拦截、原子保留原状态');

check('勾选坏包时 plan.valid=false 且 attemptBatchApply 拒绝、原 enabled 不变', () => {
  const selected = ['pack_ink', 'pack_darkmod'];
  const plan = planBatchApply({
    library: DEMO_LIBRARY,
    items: ITEMS,
    query: { scene: 'world', language: 'zh-CN' },
    currentEnabled: enabled,
    priorities,
    selectedIds: selected,
  });
  assert.equal(plan.valid, false);
  assert.ok(plan.blockers.some((b) => b.packId === 'pack_darkmod'));

  const before = JSON.stringify(enabled);
  const result = attemptBatchApply({
    library: DEMO_LIBRARY,
    currentEnabled: enabled,
    priorities,
    selectedIds: selected,
  });
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(enabled), before);
});

check('勾选三个健康包：对比出 key/bow/coin/ring 变化，提交成功', () => {
  const selected = ['pack_ink', 'pack_autumn', 'pack_pixel'];
  const plan = planBatchApply({
    library: DEMO_LIBRARY,
    items: ITEMS,
    query: { scene: 'world', language: 'zh-CN' },
    currentEnabled: enabled,
    priorities,
    selectedIds: selected,
  });
  assert.equal(plan.valid, true);
  const changedIds = plan.changes.filter((c) => c.kind !== 'unchanged').map((c) => c.itemId).sort();
  assert.deepEqual(changedIds, ['bow_elf', 'coin_gold', 'key_brass', 'ring_ruby']);

  const result = attemptBatchApply({
    library: DEMO_LIBRARY,
    currentEnabled: enabled,
    priorities,
    selectedIds: selected,
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.enabled.pack_ink, true);
    assert.equal(result.enabled.pack_autumn, true);
    assert.equal(result.enabled.pack_pixel, true);
    assert.equal(result.enabled.base_core, true);
  }
});

console.log('6) 导出 / 导入往返重现覆盖结果');

check('全量来源清单为 9 道具 × 3 场景 × 4 语言 = 108 行', () => {
  const rows = buildProvenance({
    items: ITEMS,
    scenes: SCENES,
    languages: LANGUAGES,
    library: DEMO_LIBRARY,
    enabled,
    priorities,
  });
  assert.equal(rows.length, ITEMS.length * SCENES.length * LANGUAGES.length);
});

check('导出 JSON -> 解析 -> 逐行复算全部一致', () => {
  const rows = buildProvenance({
    items: ITEMS,
    scenes: SCENES,
    languages: LANGUAGES,
    library: DEMO_LIBRARY,
    enabled,
    priorities,
  });
  const doc = buildExportDoc({
    config: {
      query: { scene: 'battle', language: 'ja-JP' },
      selectedItemId: 'gem_blue',
      enabled,
      priorities,
    },
    items: ITEMS,
    scenes: SCENES,
    languages: LANGUAGES,
    library: DEMO_LIBRARY,
    provenance: rows,
  });
  const parsed = parseImportText(JSON.stringify(doc));
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.ok(parsed.data.verification);
    assert.equal(parsed.data.verification!.checked, 108);
    assert.equal(parsed.data.verification!.mismatches.length, 0);
    assert.equal(parsed.data.config.query.scene, 'battle');
    assert.equal(parsed.data.config.query.language, 'ja-JP');
    assert.equal(parsed.data.library.length, DEMO_LIBRARY.length);
  }
});

check('损坏 JSON 与错误 app 标识分别返回失败', () => {
  assert.equal(parseImportText('{not json').ok, false);
  const wrong = JSON.stringify({ app: 'nope', schema: 1 });
  assert.equal(parseImportText(wrong).ok, false);
});

check('resolveAll 一次性返回全部道具结果', () => {
  const { results } = resolveAll({
    items: ITEMS,
    scene: 'world',
    language: 'zh-CN',
    library: DEMO_LIBRARY,
    enabled,
  });
  assert.equal(results.size, ITEMS.length);
});

console.log(`\n全部 ${passed} 组自检通过 ✅`);
