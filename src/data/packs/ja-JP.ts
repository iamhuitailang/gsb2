import type { LanguagePack } from '../../core/types.ts';

export const jaJP: LanguagePack = {
  locale: 'ja-JP',
  label: '日本語',
  fallbackLocale: 'en-US',
  terms: {
    address: {
      oldfriend: '旧友',
      captain: '団長',
      kid: 'ぼうや',
      stranger: '旅人さん',
    },
  },
  entries: {
    'shop.welcome': {
      id: 'shop.welcome',
      description: '店主の挨拶：呼びかけ相手で変化',
      forms: [
        {
          when: { address: 'captain' },
          text: 'お帰りなさい、{address}。波止場の風は強かったでしょう。',
        },
        // 故意缺少 kid 专用句式：milo 触发时按约定落到 {} 通用句，来源会注明
        {
          when: {},
          text: 'いらっしゃい、{address}。棚を倒さなければ、ゆっくり見ていって。',
        },
      ],
    },

    'shop.buy': {
      id: 'shop.buy',
      description: '購入成功：数量と品物カテゴリ（助数詞）',
      forms: [
        { when: { count: 'zero' }, text: '何も買わずに手を振った。' },
        {
          when: { count: 'one', category: 'potion' },
          text: '「{item}」を {count} 本買い、鞄の横ポケットにしまった。',
        },
        {
          when: { count: 'one', category: 'weapon' },
          text: '「{item}」を {count} 振り買うと、酒場中の視線が集まった。',
        },
        // 故意没有 one 通用句：food/material 在 1 个时回退到 other 通用句
        {
          when: { count: 'other', category: 'potion' },
          text: '「{item}」を {count} 本買い込み、瓶が鞄の中でカタカタ鳴る。',
        },
        {
          when: { count: 'other', category: 'weapon' },
          text: '「{item}」を {count} 振り揃え、まるで移動武器屋だ。',
        },
        {
          when: { count: 'other' },
          text: '「{item}」を {count} 個買った。苔おばは目を細めて笑う。',
        },
      ],
    },

    'item.inspect': {
      id: 'item.inspect',
      description: 'アイテム説明：呼称・名前・残り数',
      forms: [
        { when: { count: 'zero' }, text: '{address}、「{item}」はもう一つも残っていないよ。' },
        {
          when: { count: 'one' },
          text: '{address}、「{item}」はあと {count} 個だよ。大事に使って。',
        },
        {
          when: { count: 'other' },
          // 故意埋缺陷：基准 other 句にある {count} を翻訳が入れ忘れている
          text: '{address}、「{item}」はまだたっぷり残っているよ。',
        },
      ],
    },

    // 故意整个缺少 quest.remind 条目 -> 试玩时跨语言回退到 en-US，徽章必须标明

    'quest.reward': {
      id: 'quest.reward',
      description: 'クエスト報酬',
      forms: [
        { when: {}, text: '依頼達成！ 報酬は金貨 {amount} 枚と「{reward}」だ。' },
      ],
    },

    // 故意缺少 system.save_hint -> 干净的 en-US 回退例

    'shop.secret': {
      id: 'shop.secret',
      description: '合言葉',
      forms: [
        { when: {}, text: '苔おばは声をひそめた。「今夜の合言葉は {code} だよ。誰にも言うんじゃない」' },
      ],
    },
  },
};
