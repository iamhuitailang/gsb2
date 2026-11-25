import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BASELINE_PACKS } from '../src/data/packs/index.ts';
import { buildRevisedPacks } from '../src/data/packs/revision.ts';
import { CHARACTERS_BY_ID, ITEMS_BY_ID } from '../src/data/game-data.ts';
import { ALL_SAMPLES } from '../src/data/events.ts';
import { runChecks, aggregateIssues } from '../src/core/checks.ts';
import { resolveWithin, resolveWithFallback } from '../src/core/resolve.ts';
import { pluralCategory } from '../src/core/plural.ts';
import { renderSample } from '../src/core/render.ts';
import { snapshotSamples, diffSnapshots } from '../src/core/diff.ts';
import type { TriggerSample } from '../src/core/types.ts';

const deps = {
  packs: BASELINE_PACKS,
  characters: CHARACTERS_BY_ID,
  items: ITEMS_BY_ID,
};

test('数量桶：0/1 全语言走 zero/one，其余按语言', () => {
  assert.equal(pluralCategory('zh-CN', 0), 'zero');
  assert.equal(pluralCategory('en-US', 0), 'zero');
  assert.equal(pluralCategory('ja-JP', 1), 'one');
  assert.equal(pluralCategory('en-US', 1), 'one');
  assert.equal(pluralCategory('zh-CN', 2), 'other');
  assert.equal(pluralCategory('en-US', 5), 'other');
});

test('句式选择：类别 + 数量精确命中，缺专用句时确定性回退', () => {
  const zh = BASELINE_PACKS['zh-CN'];
  const potionOne = resolveWithin(zh, 'shop.buy', {
    countBucket: 'one',
    category: 'potion',
  });
  assert.ok(potionOne);
  assert.equal(potionOne!.form.when.category, 'potion');
  assert.equal(potionOne!.via, 'exact');

  // 日语没有 one 通用句：food × 1 应数量回退到 other 通用句
  const jaFoodOne = resolveWithin(BASELINE_PACKS['ja-JP'], 'shop.buy', {
    countBucket: 'one',
    category: 'food',
  });
  assert.ok(jaFoodOne);
  assert.equal(jaFoodOne!.form.when.count, 'other');
  assert.equal(jaFoodOne!.via, 'count-fallback');

  // 日语没有 kid 欢迎句：落到通用句并标记 generic-form
  const jaKidWelcome = resolveWithin(BASELINE_PACKS['ja-JP'], 'shop.welcome', {
    address: 'kid',
  });
  assert.ok(jaKidWelcome);
  assert.deepEqual(jaKidWelcome!.form.when, {});
  assert.equal(jaKidWelcome!.via, 'generic-form');
});

test('跨语言回退带来源轨迹，且不伪装成本语言翻译', () => {
  const r = resolveWithFallback(BASELINE_PACKS, 'ja-JP', 'quest.remind', {
    address: 'captain',
  });
  assert.equal(r.source.locale, 'en-US');
  assert.equal(r.source.via, 'locale-fallback');
  assert.equal(r.source.isFallback, true);
  assert.match(r.source.signature, /^en-US::quest\.remind/);
  assert.ok(r.source.hops.length >= 1);
});

test('质检：四类必报问题 + 未走到句式 + 回退都能扫到', () => {
  const issues = runChecks({
    ...deps,
    referenceLocale: 'zh-CN',
    samples: ALL_SAMPLES,
  });
  const codes = new Set(issues.map((i) => i.code));
  for (const code of [
    'placeholder-dropped', // 变量缺失（译文漏放）
    'placeholder-undeclared', // 变量多出（拼写错误）
    'param-type-mismatch', // 类型不合
    'form-never-selected', // 没走到的句式
    'required-value-missing', // 事件漏传值
    'locale-fallback',
  ]) {
    assert.ok(codes.has(code), `应扫出 ${code}`);
  }

  // 每条问题都能指到语言、条目；除未走到句式外都带触发样例
  for (const issue of issues) {
    assert.ok(issue.locale.length > 0);
    assert.ok(issue.entryId.length > 0);
    if (issue.code !== 'form-never-selected') {
      assert.ok(issue.sampleId, `${issue.code} 应带 sampleId`);
    } else {
      assert.ok(issue.suggestedTrigger, '未走到句式应给建议样例');
    }
  }

  const grouped = aggregateIssues(issues);
  assert.ok(grouped.length < issues.length, '聚合应合并重复样例触发');
  const jaCountDrop = grouped.find(
    (i) => i.locale === 'ja-JP' && i.code === 'placeholder-dropped' && i.entryId === 'item.inspect',
  );
  assert.ok(jaCountDrop);
  assert.ok((jaCountDrop!.sampleCount ?? 0) >= 5, '矩阵应把同一缺陷聚合成多样例组');
});

test('渲染隔离：类型错误/缺值只坏对应片段，其他台词正常', () => {
  const bad: TriggerSample = {
    id: 't-bad',
    eventId: 'ev_test',
    lineId: 'l',
    label: 'bad',
    entryId: 'quest.reward',
    vars: { reward: '徽章', amount: '三' },
  };
  const r = renderSample(deps, bad, 'zh-CN');
  assert.equal(r.ok, false);
  assert.ok(r.parts.some((p) => p.state === 'bad-type' && p.varName === 'amount'));
  assert.ok(r.text.includes('三'));

  const good: TriggerSample = {
    id: 't-good',
    eventId: 'ev_test',
    lineId: 'l2',
    label: 'good',
    entryId: 'shop.welcome',
    characterId: 'vera',
  };
  const rg = renderSample(deps, good, 'zh-CN');
  assert.equal(rg.ok, true);
  assert.match(rg.text, /团长/);
});

test('diff：修订包能区分“文字变化”和“仅来源变化”', () => {
  const characters = CHARACTERS_BY_ID;
  const items = ITEMS_BY_ID;
  const before = snapshotSamples(deps, ALL_SAMPLES, 'ja-JP');
  const revisedPacks = buildRevisedPacks();
  const after = snapshotSamples(
    { packs: revisedPacks, characters, items },
    ALL_SAMPLES,
    'ja-JP',
  );
  const report = diffSnapshots(before, after, 'ja-JP', '2026-01-01T00:00:00.000Z');

  assert.ok(report.textChanged.length > 0, '应有文字变化');
  assert.ok(report.sourceOnly.length > 0, '应有仅来源变化');

  // food × 2：v2 新增同文 food/other 专用句 -> 仅来源变
  const foodTwo = report.rows.find((r) => r.sampleId === 'mx-buy-berry_bun-2');
  assert.ok(foodTwo);
  assert.equal(foodTwo!.status, 'source-only');
  assert.equal(foodTwo!.before.text, foodTwo!.after.text);
  assert.notEqual(foodTwo!.before.sourceSignature, foodTwo!.after.sourceSignature);

  // inspect × 2：补回 {count} -> 文字变
  const inspectTwo = report.rows.find((r) => r.sampleId === 'mx-inspect-moon_tonic-2');
  assert.ok(inspectTwo);
  assert.equal(inspectTwo!.status, 'text-changed');
  assert.match(inspectTwo!.after.text, /2/);
});
