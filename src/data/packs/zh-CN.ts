import type { LanguagePack } from '../../core/types.ts';

/** 基准语言包：变量契约 params 只在基准包维护，其他语言对照它检查 */
export const zhCN: LanguagePack = {
  locale: 'zh-CN',
  label: '简体中文',
  isReference: true,
  fallbackLocale: 'en-US',
  terms: {
    address: {
      oldfriend: '老朋友',
      captain: '团长',
      kid: '小家伙',
      stranger: '旅人',
    },
  },
  entries: {
    'shop.welcome': {
      id: 'shop.welcome',
      description: '店主迎客：随说话对象（称呼类别）变化',
      params: { address: { type: 'string' } },
      forms: [
        {
          when: { address: 'captain' },
          text: '欢迎回来，{address}！码头的风没少吹您吧。',
          note: '对骑士团长用敬语',
        },
        {
          when: { address: 'kid' },
          text: '哟，{address}！今天攒了多少铜币呀？',
        },
        {
          when: { address: 'stranger' },
          text: '初次见面，{address}。港里夜里凉，先看件厚实的？',
        },
        {
          when: {},
          text: '你来啦，{address}。随便看，别碰倒架子就行。',
        },
      ],
    },

    'shop.buy': {
      id: 'shop.buy',
      description: '购买成功：数量 + 物品类别（中文量词）共同决定句式',
      params: { count: { type: 'integer' }, item: { type: 'string' } },
      forms: [
        { when: { count: 'zero' }, text: '你摆了摆手，这次什么也没买。' },
        {
          when: { count: 'one', category: 'potion' },
          text: '你买下 {count} 瓶「{item}」，塞进背包侧袋。',
        },
        {
          when: { count: 'one', category: 'weapon' },
          text: '你买下 {count} 把「{item}」，拔剑声引得满酒馆回头。',
        },
        {
          when: { count: 'one' },
          text: '你买下 {count} 个「{item}」，苔姨顺手多塞来一张折扣券。',
        },
        {
          when: { count: 'other', category: 'potion' },
          text: '你买下 {count} 瓶「{item}」，瓶瓶罐罐在包里叮当作响。',
        },
        {
          when: { count: 'other', category: 'weapon' },
          text: '你买下 {count} 把「{item}」，活像个行走的兵器架。',
        },
        {
          when: { count: 'other' },
          text: '你买下 {count} 个「{item}」，苔姨笑得眼睛眯成一条缝。',
        },
      ],
    },

    'item.inspect': {
      id: 'item.inspect',
      description: '道具说明/查看持有数：同时包含称呼、物品名与数量变量',
      params: {
        address: { type: 'string' },
        item: { type: 'string' },
        count: { type: 'integer' },
      },
      forms: [
        {
          when: { count: 'zero' },
          text: '{address}，「{item}」已经一件不剩了。',
        },
        {
          when: { count: 'one' },
          text: '{address}，「{item}」只剩 {count} 件，省着点用。',
        },
        {
          when: { count: 'other' },
          text: '{address}，「{item}」还剩 {count} 件，补给充足。',
        },
      ],
    },

    'quest.remind': {
      id: 'quest.remind',
      description: '任务提醒：称呼、报酬与碰面地点变量',
      params: {
        address: { type: 'string' },
        reward: { type: 'string' },
        place: { type: 'string' },
      },
      forms: [
        {
          when: { address: 'captain' },
          text: '{address}，别忘了：带着{reward}到{place}汇合，港务长可不等人。',
        },
        {
          when: {},
          text: '别忘了，带上{reward}去{place}找老舵手。',
        },
      ],
    },

    'quest.reward': {
      id: 'quest.reward',
      description: '委托结算：金币数额必须是整数',
      params: { reward: { type: 'string' }, amount: { type: 'integer' } },
      forms: [
        {
          when: {},
          text: '委托完成！报酬是 {amount} 枚金币，外加「{reward}」。',
        },
      ],
    },

    'system.save_hint': {
      id: 'system.save_hint',
      description: '存档提示（无变量，用来演示整条目跨语言回退）',
      forms: [
        { when: {}, text: '风灯亮起时，星港会替你记住这次远航。' },
      ],
    },

    'shop.secret': {
      id: 'shop.secret',
      description: '暗号：必须提供 code 变量（用来演示事件漏传变量值）',
      params: { code: { type: 'string' } },
      forms: [
        { when: {}, text: '苔姨压低声音：「今晚的暗号是 {code}，别告诉别人。」' },
      ],
    },
  },
};
