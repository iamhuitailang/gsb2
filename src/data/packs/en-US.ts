import type { LanguagePack } from '../../core/types.ts';

export const enUS: LanguagePack = {
  locale: 'en-US',
  label: 'English',
  fallbackLocale: 'zh-CN',
  terms: {
    address: {
      oldfriend: 'old friend',
      captain: 'Captain',
      kid: 'kiddo',
      stranger: 'traveler',
    },
  },
  entries: {
    'shop.welcome': {
      id: 'shop.welcome',
      description: 'Shop greeting by addressee',
      forms: [
        {
          when: { address: 'captain' },
          text: 'Welcome back, {address}! The docks wind has not been kind to you.',
        },
        {
          when: { address: 'kid' },
          text: 'Hey {address}! How many coppers did you scrape together today?',
        },
        {
          when: { address: 'stranger' },
          text: 'First time in our harbor, {address}? Nights are cold here — something warm?',
        },
        {
          // 故意埋缺陷：基准通用句使用 {address}，这句译文把变量漏了
          when: {},
          text: 'There you are. Browse around — just do not knock over the shelves.',
        },
      ],
    },

    'shop.buy': {
      id: 'shop.buy',
      description: 'Purchase success: count + item category',
      forms: [
        { when: { count: 'zero' }, text: 'You wave Moss off and buy nothing this time.' },
        {
          when: { count: 'one', category: 'potion' },
          text: 'You buy {count} bottle of {item} and tuck it into your pack.',
        },
        {
          when: { count: 'one', category: 'weapon' },
          text: 'You buy {count} blade called {item}; the tavern turns to look.',
        },
        {
          when: { count: 'one' },
          text: 'You buy {count} unit of {item}; Moss slips you a discount token.',
        },
        {
          when: { count: 'other', category: 'potion' },
          text: 'You buy {count} bottles of {item}, clinking in your pack.',
        },
        {
          when: { count: 'other', category: 'weapon' },
          text: 'You buy {count} blades of {item} — a walking armoury.',
        },
        {
          when: { count: 'other' },
          text: 'You buy {count} × {item}. Moss beams.',
        },
      ],
    },

    'item.inspect': {
      id: 'item.inspect',
      description: 'Item inspection with address, name and remaining count',
      forms: [
        { when: { count: 'zero' }, text: '{address}, you are all out of {item}.' },
        {
          when: { count: 'one' },
          text: '{address}, only {count} {item} left — use it wisely.',
        },
        {
          when: { count: 'other' },
          text: '{address}, you still have {count} × {item} in your pack.',
        },
      ],
    },

    'quest.remind': {
      id: 'quest.remind',
      description: 'Quest reminder',
      forms: [
        {
          when: { address: 'captain' },
          // 故意埋缺陷：{placee} 是拼写错误的“多出变量”，同时漏掉了基准里的 {place}
          text: '{address}, do not forget: bring the {reward} and meet at {placee}. The harbormaster never waits.',
        },
        {
          when: {},
          text: 'Do not forget: bring the {reward} and meet the old helmsman at {place}.',
        },
      ],
    },

    'quest.reward': {
      id: 'quest.reward',
      description: 'Quest settlement',
      forms: [
        { when: {}, text: 'Contract complete! Reward: {amount} coins and “{reward}”.' },
      ],
    },

    'system.save_hint': {
      id: 'system.save_hint',
      description: 'Save hint',
      forms: [
        { when: {}, text: 'When the harbor lanterns light, Star Port remembers your voyage.' },
      ],
    },

    'shop.secret': {
      id: 'shop.secret',
      description: 'Secret code line',
      forms: [
        { when: {}, text: 'Moss whispers: “Tonight’s code is {code}. Tell nobody.”' },
      ],
    },
  },
};
