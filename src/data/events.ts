import type { TriggerSample } from '../core/types.ts';
import { ITEMS } from './game-data.ts';
import { lv } from '../core/context.ts';

export interface DialogueLine {
  id: string;
  speakerId: string;
  sample: TriggerSample;
}

export interface DialogueEvent {
  id: string;
  title: string;
  blurb: string;
  lines: DialogueLine[];
}

type SampleSeed = Omit<TriggerSample, 'id' | 'eventId' | 'lineId'> & { id?: string };

function makeEvent(
  id: string,
  title: string,
  blurb: string,
  lines: Array<{ id: string; speaker: string; sample: SampleSeed }>,
): DialogueEvent {
  return {
    id,
    title,
    blurb,
    lines: lines.map((l) => ({
      id: l.id,
      speakerId: l.speaker,
      sample: {
        ...l.sample,
        id: l.sample.id ?? `${id}.${l.id}`,
        eventId: id,
        lineId: l.id,
      },
    })),
  };
}

const COMPASS = lv({
  'zh-CN': '潮汐罗盘',
  'en-US': 'Tide Compass',
  'ja-JP': '潮の羅針盤',
});

const LIGHTHOUSE = lv({
  'zh-CN': '旧灯塔',
  'en-US': 'the Old Lighthouse',
  'ja-JP': '旧灯台',
});

const BADGE = lv({
  'zh-CN': '银港徽章',
  'en-US': 'Silver Harbor Badge',
  'ja-JP': '銀港バッジ',
});

export const EVENTS: DialogueEvent[] = [
  makeEvent('ev_harbor', '初到星港', '林恩第一次走进苔姨的杂货铺。', [
    {
      id: 'welcome',
      speaker: 'moss',
      sample: {
        label: '林恩（老朋友称呼）进店',
        entryId: 'shop.welcome',
        characterId: 'lynn',
      },
    },
    {
      id: 'inspect',
      speaker: 'narrator',
      sample: {
        label: '查看月露药水，持有 2 瓶',
        entryId: 'item.inspect',
        characterId: 'lynn',
        itemId: 'moon_tonic',
        count: 2,
      },
    },
    {
      id: 'save_hint',
      speaker: 'narrator',
      sample: {
        label: '风起时的存档提示',
        entryId: 'system.save_hint',
      },
    },
  ]),

  makeEvent('ev_deal', '第一笔买卖', '不同客人、物品类别和数量下的成交句。', [
    {
      id: 'blade_one',
      speaker: 'moss',
      sample: {
        label: '薇拉团长买 1 把余烬短刃',
        entryId: 'shop.buy',
        characterId: 'vera',
        itemId: 'ember_blade',
        count: 1,
      },
    },
    {
      id: 'bun_zero',
      speaker: 'moss',
      sample: {
        label: '米洛买麦香果包，数量 0',
        entryId: 'shop.buy',
        characterId: 'milo',
        itemId: 'berry_bun',
        count: 0,
      },
    },
    {
      id: 'tonic_three',
      speaker: 'moss',
      sample: {
        label: '林恩买 3 瓶月露药水',
        entryId: 'shop.buy',
        characterId: 'lynn',
        itemId: 'moon_tonic',
        count: 3,
      },
    },
    {
      id: 'shard_five',
      speaker: 'moss',
      sample: {
        label: '薇拉买 5 个共鸣晶簇',
        entryId: 'shop.buy',
        characterId: 'vera',
        itemId: 'crystal_shard',
        count: 5,
      },
    },
  ]),

  makeEvent('ev_quest', '团长的委托', '任务提醒与结算，含多变量与一个陈旧调试变量。', [
    {
      id: 'remind',
      speaker: 'moss',
      sample: {
        label: '用团长称呼提醒汇合地点',
        entryId: 'quest.remind',
        characterId: 'vera',
        vars: {
          reward: COMPASS,
          place: LIGHTHOUSE,
          qa_note: 'regression-sample-3',
        },
      },
    },
    {
      id: 'reward_ok',
      speaker: 'moss',
      sample: {
        label: '正常结算：30 枚金币（整数）',
        entryId: 'quest.reward',
        characterId: 'lynn',
        vars: { reward: BADGE, amount: 30 },
      },
    },
  ]),

  makeEvent(
    'ev_broken',
    '质检事故现场',
    '中间两句分别有类型错误和漏传变量，前后台词必须照常渲染。',
    [
      {
        id: 'before',
        speaker: 'moss',
        sample: {
          label: '坏样例之前的问候（应正常）',
          entryId: 'shop.welcome',
          characterId: 'milo',
        },
      },
      {
        id: 'bad_type',
        speaker: 'moss',
        sample: {
          label: '金币数传成了中文字符串“三”',
          entryId: 'quest.reward',
          characterId: 'milo',
          vars: { reward: BADGE, amount: '三' },
        },
      },
      {
        id: 'missing_value',
        speaker: 'moss',
        sample: {
          label: '暗号事件漏传 code 变量',
          entryId: 'shop.secret',
          characterId: 'vera',
          vars: {},
        },
      },
      {
        id: 'after',
        speaker: 'moss',
        sample: {
          label: '坏样例之后的成交句（应正常）',
          entryId: 'shop.buy',
          characterId: 'lynn',
          itemId: 'moon_tonic',
          count: 2,
        },
      },
    ],
  ),
];

export const EVENT_SAMPLES: TriggerSample[] = EVENTS.flatMap((e) => e.lines.map((l) => l.sample));

/** 批量预演矩阵使用的数量档：0 / 1 / 复数 */
export const MATRIX_COUNTS = [0, 1, 2, 5] as const;

function matrixSamplesFor(entryId: 'shop.buy' | 'item.inspect'): TriggerSample[] {
  return ITEMS.flatMap((item) =>
    MATRIX_COUNTS.map((count) => ({
      id: `mx-${entryId === 'shop.buy' ? 'buy' : 'inspect'}-${item.id}-${count}`,
      eventId: 'ev_matrix',
      lineId: `mx-${item.id}-${count}`,
      label: `${item.id} × ${count}`,
      entryId,
      characterId: 'lynn',
      itemId: item.id,
      count,
    })),
  );
}

export const BUY_MATRIX_SAMPLES = matrixSamplesFor('shop.buy');
export const INSPECT_MATRIX_SAMPLES = matrixSamplesFor('item.inspect');
export const MATRIX_SAMPLES = [...BUY_MATRIX_SAMPLES, ...INSPECT_MATRIX_SAMPLES];

/** 质检扫描的完整触发样例集：可试事件 + 批量矩阵 */
export const ALL_SAMPLES: TriggerSample[] = [...EVENT_SAMPLES, ...MATRIX_SAMPLES];
