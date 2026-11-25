import type { FormSource, RenderResult, TemplatePart } from '../core/types.ts';
import { h } from './h.ts';
import { viaText } from '../core/diff.ts';

const LOCALE_SHORT: Record<string, string> = {
  'zh-CN': '中文',
  'en-US': 'EN',
  'ja-JP': '日',
};

export function localeShort(locale: string): string {
  return LOCALE_SHORT[locale] ?? locale;
}

/** 来源徽章：回退用琥珀色，绝不让回退看起来像本地已翻译 */
export function sourceBadge(source: FormSource) {
  const cls = `src-badge src-${source.via}`;
  let text: string;
  if (source.via === 'exact') text = `✓ ${localeShort(source.locale)} · 专用句`;
  else if (source.via === 'locale-fallback')
    text = `⚠ 跨语言回退 → ${localeShort(source.locale)}`;
  else if (source.via === 'missing') text = '✕ 文案缺失';
  else text = `↳ ${localeShort(source.locale)} · ${viaText(source.via)}`;

  return h(
    'span',
    {
      class: cls,
      title: [source.label, ...source.hops].join('\n'),
    },
    text,
  );
}

export function partsNodes(parts: TemplatePart[]) {
  return parts.map((p) => {
    if (p.type === 'text') return p.value;
    const cls =
      p.state === 'missing' ? 'tok tok-missing' : p.state === 'bad-type' ? 'tok tok-badtype' : 'tok';
    return h(
      'span',
      {
        class: cls,
        title:
          p.state === 'missing'
            ? `缺少变量值：${p.varName}`
            : p.state === 'bad-type'
              ? `变量类型不合契约：${p.varName}`
              : `变量 ${p.varName}`,
      },
      p.shown ?? p.value,
    );
  });
}

/** 行内错误/提示小胶囊 */
export function resultFlags(result: RenderResult) {
  const flags: ReturnType<typeof h>[] = [];
  const missing = result.parts.filter((p) => p.state === 'missing');
  const bad = result.parts.filter((p) => p.state === 'bad-type');
  if (missing.length)
    flags.push(h('span', { class: 'flag flag-error' }, `缺值 ×${missing.length}`));
  if (bad.length) flags.push(h('span', { class: 'flag flag-error' }, `类型不合 ×${bad.length}`));
  if (result.source.via === 'locale-fallback')
    flags.push(h('span', { class: 'flag flag-fallback' }, '未翻译·回退'));
  if (!flags.length) return null;
  return h('span', { class: 'flags' }, ...flags);
}
