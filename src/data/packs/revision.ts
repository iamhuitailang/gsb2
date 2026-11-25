import type { LanguagePack } from '../../core/types.ts';
import { clonePacks } from './index.ts';
import { BASELINE_PACKS } from './index.ts';

/**
 * 一份“语言包更新”的示例：修订 ja-JP。
 * - 补回 item.inspect / other 漏掉的 {count}（文字变化）
 * - 新增 quest.remind 日文条目（来源从 en-US 回退变为 ja-JP，文字也变化）
 * - 新增 shop.buy 的 food 专用 other 句，但文案与原通用句逐字相同
 *   => 渲染文字不变、仅来源坐标改变，用来验证 diff 的“仅来源变了”
 */
export function buildRevisedPacks(): Record<string, LanguagePack> {
  const packs = clonePacks(BASELINE_PACKS);
  const ja: LanguagePack = packs['ja-JP'];

  const inspect = ja.entries['item.inspect'];
  inspect.forms = inspect.forms.map((f) =>
    f.when.count === 'other'
      ? { ...f, text: '{address}、「{item}」はまだ {count} 個も残っているよ。' }
      : f,
  );

  ja.entries['quest.remind'] = {
    id: 'quest.remind',
    description: 'クエストリマインド（v2 新規翻訳）',
    forms: [
      {
        when: { address: 'captain' },
        text: '{address}、忘れるな：{reward}を持って{place}で落ち合おう。港務長は待ってくれない。',
      },
      { when: {}, text: '{reward}を持って{place}で老舵手を探してね。' },
    ],
  };

  const buy = ja.entries['shop.buy'];
  buy.forms.push({
    when: { count: 'other', category: 'food' },
    // 故意与 when:{count:'other'} 通用句完全同文
    text: '「{item}」を {count} 個買った。苔おばは目を細めて笑う。',
    note: '食べ物カテゴリ専用枠。現状は通用句と同じ訳文。',
  });

  return packs;
}

/** 供页面 textarea 使用的修订版 ja-JP JSON 文本 */
export function revisedJaJson(): string {
  return JSON.stringify(buildRevisedPacks()['ja-JP'], null, 2);
}
