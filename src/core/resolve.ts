import type { FormSource, MessageForm, LanguagePack } from './types.ts';
import { countBucketFallback } from './plural.ts';
import { whenSignature } from './template.ts';
import type { MatchContext } from './context.ts';

export interface WithinResult {
  form: MessageForm;
  index: number;
  /** 0 = 数量桶精确命中；>0 = 走了数量约定回退；Number.MAX = 落到不限数量句 */
  countRank: number;
  via: 'exact' | 'generic-form' | 'count-fallback';
  hops: string[];
}

/**
 * 在单一语言包内部选择最合适的句式。
 *
 * 选择规则（确定性）：
 * 1. when 中写明的 address/category 必须与上下文相等，否则该句不适用；
 *    未写明的维度视为“不限”，天然适用 —— 这就是“缺专用句式 -> 通用句式”的回退。
 * 2. count 按 [zero, other] / [one, other] ... 的约定顺序找，最后允许不限 count 的句子。
 * 3. 同档下限定条件越多越优先，仍相同则按语言包中的声明顺序。
 */
export function resolveWithin(
  pack: LanguagePack,
  entryId: string,
  ctx: MatchContext,
): WithinResult | null {
  const entry = pack.entries[entryId];
  if (!entry) return null;

  const bucketOrder = ctx.countBucket ? countBucketFallback(ctx.countBucket) : undefined;

  let best:
    | { index: number; form: MessageForm; countRank: number; specificity: number }
    | undefined;

  entry.forms.forEach((form, index) => {
    const w = form.when ?? {};
    if (w.address && w.address !== ctx.address) return;
    if (w.category && w.category !== ctx.category) return;

    let countRank: number;
    if (w.count) {
      if (!bucketOrder) return; // 样例没有数量上下文，不主动进入数量专用句
      const idx = bucketOrder.indexOf(w.count);
      if (idx === -1) return;
      countRank = idx;
    } else {
      // 不限数量的通用句，排在所有约定数量桶之后
      countRank = bucketOrder ? bucketOrder.length : 0;
    }

    const specificity = Object.keys(w).length;
    if (
      !best ||
      countRank < best.countRank ||
      (countRank === best.countRank && specificity > best.specificity) ||
      (countRank === best.countRank &&
        specificity === best.specificity &&
        index < best.index)
    ) {
      best = { index, form, countRank, specificity };
    }
  });

  if (!best) return null;
  const chosen = best;
  const w = chosen.form.when ?? {};
  const hops: string[] = [];

  // 只有当条目确实定义了某维度的专用句式时，“落到通用句”才算一次回退；
  // 例如 system.save_hint 根本没有称呼/数量维度，不应因为上下文带了这些值而被标注回退。
  const entryUses = {
    count: entry.forms.some((f) => f.when?.count !== undefined),
    address: entry.forms.some((f) => f.when?.address !== undefined),
    category: entry.forms.some((f) => f.when?.category !== undefined),
  };

  let via: WithinResult['via'] = 'exact';

  if (ctx.countBucket && entryUses.count && w.count !== ctx.countBucket) {
    via = 'count-fallback';
    if (!w.count) {
      hops.push(`缺少 ${ctx.countBucket} 数量式，按约定改用不限数量的通用句`);
    } else {
      hops.push(`缺少 ${ctx.countBucket} 数量式，按约定回退到 ${w.count} 句式`);
    }
  }

  const relaxed: string[] = [];
  if (entryUses.address && ctx.address && w.address !== ctx.address)
    relaxed.push(`称呼=${ctx.address} 无专用句，落到通用称呼句`);
  if (entryUses.category && ctx.category && w.category !== ctx.category)
    relaxed.push(`类别=${ctx.category} 无专用句，落到通用类别句`);
  if (relaxed.length) {
    if (via === 'exact') via = 'generic-form';
    hops.push(...relaxed);
  }

  return { form: chosen.form, index: chosen.index, countRank: chosen.countRank, via, hops };
}

export interface ResolvedMessage {
  text: string;
  source: FormSource;
  /** 实际取到的条目（可能来自回退语言），缺失时为 null */
  pack: LanguagePack | null;
}

function sourceLabel(locale: string, entryId: string, when: MessageForm['when'] | null): string {
  return `${locale} / ${entryId} # ${whenSignature(when)}`;
}

/**
 * 完整回退链：当前语言包内选句 -> 约定的 fallbackLocale -> … -> 缺失占位。
 * 每一跳都写进 source.hops，页面和清单据此注明真实来源，
 * 跨语言回退永远带 isFallback 标记，不会被展示成“已翻译”。
 */
export function resolveWithFallback(
  packs: Record<string, LanguagePack>,
  locale: string,
  entryId: string,
  ctx: MatchContext,
): ResolvedMessage {
  const hops: string[] = [];
  const visited = new Set<string>();
  let currentLocale: string | undefined = locale;
  let crossLanguage = false;

  while (currentLocale && !visited.has(currentLocale)) {
    visited.add(currentLocale);
    const pack = packs[currentLocale];
    if (!pack) {
      hops.push(`语言包 ${currentLocale} 不存在`);
      currentLocale = packs[locale]?.fallbackLocale;
      continue;
    }

    const hasEntry = Boolean(pack.entries[entryId]);
    const within = resolveWithin(pack, entryId, ctx);
    if (within) {
      const w = within.form.when ?? {};
      hops.push(...within.hops);
      const isFallback = crossLanguage || within.via !== 'exact';
      const via: FormSource['via'] = crossLanguage
        ? 'locale-fallback'
        : within.via === 'exact'
          ? 'exact'
          : within.via;
      return {
        text: within.form.text,
        pack,
        source: {
          locale: currentLocale,
          entryId,
          when: w,
          formIndex: within.index,
          via,
          isFallback,
          hops: hops.filter(Boolean),
          signature: `${currentLocale}::${entryId}#${whenSignature(w)}`,
          label: sourceLabel(currentLocale, entryId, w),
        },
      };
    }

    hops.push(
      hasEntry
        ? `${currentLocale} / ${entryId} 没有满足当前上下文的句式`
        : `${currentLocale} 缺少条目 ${entryId}`,
    );
    crossLanguage = true;
    if (pack.fallbackLocale) hops.push(`按约定跨语言回退到 ${pack.fallbackLocale}`);
    currentLocale = pack.fallbackLocale;
  }

  return {
    text: `⟨未找到文案 ${entryId}⟩`,
    pack: null,
    source: {
      locale,
      entryId,
      when: null,
      formIndex: -1,
      via: 'missing',
      isFallback: true,
      hops,
      signature: `missing::${entryId}`,
      label: `缺失 / ${entryId}`,
    },
  };
}
