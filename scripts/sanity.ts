/* 纯逻辑冒烟测试：esbuild 打包到 node 后运行，不依赖 DOM。 */
import { DEFAULT_DECKS, PRESET_PLANS } from '../src/defaultDecks';
import { validateDeck } from '../src/validate';
import { analyzePair, applyBatch } from '../src/exchange';
import { trialForSeed } from '../src/opening';
import { POOL_V1, POOL_V2 } from '../src/pool';
import { deckFromPreview, previewImport, SAMPLE_OLD_EXPORT } from '../src/io';
import { zoneTotal } from '../src/deckUtils';

let failures = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✕ ${name} ${extra}`);
  }
}

console.log('— 默认牌组 —');
const byId = new Map(DEFAULT_DECKS.map((d) => [d.id, d]));
for (const d of DEFAULT_DECKS) {
  const r = validateDeck(d);
  console.log(`  · ${d.name}: main=${zoneTotal(d.main)} side=${zoneTotal(d.sideboard)} legal=${r.legal} errors=${r.errors.map((e) => e.code).join(',') || '—'}`);
}

const expectLegal = ['deck-aggro', 'deck-cycle', 'deck-combo', 'deck-grove'];
for (const id of expectLegal) {
  const r = validateDeck(byId.get(id)!);
  check(`${id} 应合法`, r.legal, r.errors.map((e) => e.message).join(' / '));
}
check('deck-faction 应有阵营错误', validateDeck(byId.get('deck-faction')!).errors.some((e) => e.code === 'R-CORE-FACTION'));
check('deck-printcap 应有超量错误', validateDeck(byId.get('deck-printcap')!).errors.some((e) => e.code === 'R-COPY-LIMIT'));
check('deck-twocore 应有阵营互斥错误', validateDeck(byId.get('deck-twocore')!).errors.filter((e) => e.code === 'R-CORE-FACTION').length >= 2);
check('deck-shortsize 应有数量错误', validateDeck(byId.get('deck-shortsize')!).errors.some((e) => e.code === 'R-DECK-SIZE'));

console.log('— 轮转交换：单换失败、整批合法 —');
const cycle = byId.get('deck-cycle')!;
const planCycle = PRESET_PLANS.find((p) => p.id === 'plan-cycle')!;
const a0 = analyzePair(cycle, planCycle.pairs[0]);
const a1 = analyzePair(cycle, planCycle.pairs[1]);
check('单换 1 不合法', !a0.singleLegal);
check('单换 1 换入牌触发 R-COPY-LIMIT', a0.incoming.hits.some((h) => h.code === 'R-COPY-LIMIT'));
check('单换 2 换入牌触发 R-COPY-LIMIT', a1.incoming.hits.some((h) => h.code === 'R-COPY-LIMIT'));
const batchCycle = applyBatch(cycle, planCycle.pairs);
check('两对整批合法', batchCycle.legal, batchCycle.report?.errors.map((e) => e.message).join(' / ') ?? 'qty');
if (batchCycle.final) {
  const blade = batchCycle.final.main.filter((e) => e.kind === 'entry' && e.cardId === 'c-blade');
  const oath = batchCycle.final.main.filter((e) => e.kind === 'entry' && e.cardId === 'c-oath');
  check('整批后炎刃仍为 4 且含异画印次', blade.reduce((s, e) => s + e.count, 0) === 4 && blade.some((e) => e.kind === 'entry' && e.printingId === 'c-blade-aa'));
  check('整批后誓约仍为 4 且含异画印次', oath.reduce((s, e) => s + e.count, 0) === 4 && oath.some((e) => e.kind === 'entry' && e.printingId === 'c-oath-aa'));
  check('整批后主牌仍 40', zoneTotal(batchCycle.final.main) === 40);
}

console.log('— 盟约配套交换 —');
const aggro = byId.get('deck-aggro')!;
const planPact = PRESET_PLANS.find((p) => p.id === 'plan-pact')!;
const pactSingle = analyzePair(aggro, planPact.pairs[1]);
check('只换潮卫单张：换入牌触发阵营盟约', pactSingle.incoming.hits.some((h) => h.code === 'R-CORE-FACTION'));
const pactBatch = applyBatch(aggro, planPact.pairs);
check('核心+潮卫同批交换合法', pactBatch.legal, pactBatch.report?.errors.map((e) => e.message).join(' / ') ?? '');

console.log('— 种子试抽 —');
const combo = byId.get('deck-combo')!;
const N = 2000;
let first = 0;
let afterSmart = 0;
const seeds = [1, 42, 777];
const signature = (t: ReturnType<typeof trialForSeed>) => t.initial.map((c) => `${c.cardId}#${c.printingId}`).join('|');
const determinismOk = seeds.every((s) => signature(trialForSeed(combo, s, 'smart')) === signature(trialForSeed(combo, s, 'smart')));
check('同种子结果确定', determinismOk);
for (let s = 1; s <= N; s++) {
  const t = trialForSeed(combo, s, 'smart');
  if (t.firstPass) first++;
  if (t.finalPass) afterSmart++;
}
console.log(`  · 双生 combo：初始 ${(first / N * 100).toFixed(2)}%  智能调度后 ${(afterSmart / N * 100).toFixed(2)}% (n=${N})`);
check('combo 初始概率在合理区间 (0.2%~4%)', first / N > 0.002 && first / N < 0.04);
check('智能调度改善 combo 达标率', afterSmart > first);

const grove = byId.get('deck-grove')!;
let grovePass = 0;
for (let s = 1; s <= N; s++) if (trialForSeed(grove, s, 'smart').finalPass) grovePass++;
console.log(`  · 森罗目标：调度后 ${(grovePass / N * 100).toFixed(1)}%`);
check('森罗目标达标率明显高于 combo', grovePass / N > afterSmart / N);

console.log('— 导入版本差异 —');
const prevV2 = previewImport(SAMPLE_OLD_EXPORT, POOL_V2);
const veteran = prevV2.rows.find((r) => r.cardId === 'c-veteran');
check('v2 中旧赤焰老兵标记为同名异 id', veteran?.status === 'same-name', veteran?.status ?? 'missing row');
check('同名候选是 c-veteran-neo', veteran?.candidates.some((c) => c.id === 'c-veteran-neo') ?? false);
const betaBlade = prevV2.rows.find((r) => r.printingId === 'c-blade-beta-test');
check('Beta 测试印次标记 printing-missing', betaBlade?.status === 'printing-missing');
const importedMissing = deckFromPreview(prevV2, POOL_V2);
const reportMissing = validateDeck(importedMissing, POOL_V2);
check('默认导入不做同名替换，且校验报 R-UNRESOLVED', reportMissing.errors.some((e) => e.code === 'R-UNRESOLVED'));

const prevV1 = previewImport(SAMPLE_OLD_EXPORT, POOL_V1);
const veteranV1 = prevV1.rows.find((r) => r.cardId === 'c-veteran');
check('切到 v1 后旧老兵与闪印都精确匹配', veteranV1?.status === 'exact', veteranV1?.status ?? '');

// 手动映射后应可消除 unresolved（主牌和备选各有一行老兵，都要映射）
for (const row of prevV2.rows.filter((r) => r.cardId === 'c-veteran')) {
  row.choice = { mode: 'map', cardId: 'c-veteran-neo', printingId: 'c-veteran-neo-o' };
}
{
  const mapped = deckFromPreview(prevV2, POOL_V2);
  const r = validateDeck(mapped, POOL_V2);
  check('手动映射后不再有 unresolved', !r.errors.some((e) => e.code === 'R-UNRESOLVED'));
}

console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`);
if (failures > 0) process.exit(1);
