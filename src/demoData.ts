import type { ItemDef, LanguageDef, PackManifest, SceneDef } from './types';

export const SCENES: SceneDef[] = [
  { id: 'world', name: '大地图' },
  { id: 'battle', name: '战斗' },
  { id: 'menu', name: '背包' },
];

export const LANGUAGES: LanguageDef[] = [
  { id: 'zh-CN', name: '简体中文' },
  { id: 'en-US', name: 'English' },
  { id: 'ja-JP', name: '日本語' },
  { id: 'fr-FR', name: 'Français（无语言包）' },
];

export const ITEMS: ItemDef[] = [
  { id: 'sword_iron', name: '铁剑', category: '武器' },
  { id: 'potion_hp', name: '生命药水', category: '消耗品' },
  { id: 'shield_wood', name: '木盾', category: '防具' },
  { id: 'coin_gold', name: '金币', category: '货币' },
  { id: 'bow_elf', name: '精灵弓', category: '武器' },
  { id: 'gem_blue', name: '蓝宝石', category: '材料' },
  { id: 'key_brass', name: '黄铜钥匙', category: '道具' },
  { id: 'chest_wood', name: '木箱', category: '容器' },
  { id: 'ring_ruby', name: '红宝石戒指', category: '饰品' },
];

/** 首次进入页面时开启的包（精简移除包默认开启，便于直接看到「已移除」态） */
export const DEFAULT_ENABLED_IDS = [
  'base_core',
  'lang_zh',
  'lang_en',
  'lang_ja',
  'pack_hd_red',
  'pack_hd_blue',
  'pack_neon',
  'pack_lite',
];

export const DEFAULT_SCENE = 'world';
export const DEFAULT_LANGUAGE = 'zh-CN';
export const DEFAULT_SELECTED_ITEM = 'sword_iron';

/**
 * 演示用包库。
 *
 * 刻意埋好的演示线索：
 * - pack_hd_red 与 pack_hd_blue 优先级同为 100，且都替换铁剑 / 木盾 → 同级替换冲突
 * - pack_neon 正常依赖 pack_hd_red；关掉赤包后霓虹包会因依赖未开启被跳过
 * - pack_darkmod 依赖一个库里不存在的包 → 缺依赖
 * - pack_cycle_a / pack_cycle_b 互相依赖 → 依赖成环
 * - pack_lite 全局移除木箱、按战斗场景移除蓝宝石 → 显式移除（区别于缺图）
 * - lang_zh 同时演示精确键 zh-CN（药水）与主标签回退 zh（木箱）
 * - fr-FR 没有任何语言包，会继续回退到高清替换包 / 基础包
 */
export const DEMO_LIBRARY: PackManifest[] = [
  {
    id: 'base_core',
    name: '基础核心包',
    kind: 'base',
    version: '1.0.0',
    priority: 0,
    accent: '#64748b',
    description: '随游戏发布的基础美术，所有道具都有兜底色块。',
    resources: {
      sword_iron: [
        {
          scene: '*',
          lang: '*',
          block: { colors: ['#94a3b8', '#334155'], pattern: 'diagonal', glyph: '剑' },
        },
        {
          scene: 'battle',
          lang: '*',
          note: '基础包战斗特写版',
          block: { colors: ['#f87171', '#7f1d1d'], pattern: 'stripe', glyph: '剑' },
        },
      ],
      potion_hp: [
        {
          scene: '*',
          lang: '*',
          block: { colors: ['#fb7185', '#9f1239'], pattern: 'ring', glyph: '药' },
        },
      ],
      shield_wood: [
        {
          scene: '*',
          lang: '*',
          block: { colors: ['#d97706', '#78350f'], pattern: 'grid', glyph: '盾' },
        },
      ],
      coin_gold: [
        {
          scene: 'world',
          lang: '*',
          block: { colors: ['#fbbf24', '#b45309'], pattern: 'ring', glyph: '金' },
        },
        {
          scene: 'menu',
          lang: '*',
          note: '背包里展示堆叠金币',
          block: { colors: ['#fde047', '#ca8a04'], pattern: 'dots', glyph: '金×2' },
        },
        {
          scene: '*',
          lang: '*',
          block: { colors: ['#eab308', '#a16207'], pattern: 'solid', glyph: '金' },
        },
      ],
      bow_elf: [
        {
          scene: '*',
          lang: '*',
          block: { colors: ['#34d399', '#065f46'], pattern: 'diagonal', glyph: '弓' },
        },
      ],
      gem_blue: [
        {
          scene: '*',
          lang: '*',
          block: { colors: ['#38bdf8', '#1e3a8a'], pattern: 'ring', glyph: '宝' },
        },
      ],
      key_brass: [
        {
          scene: '*',
          lang: '*',
          block: { colors: ['#facc15', '#854d0e'], pattern: 'dots', glyph: '钥' },
        },
      ],
      chest_wood: [
        {
          scene: '*',
          lang: '*',
          block: { colors: ['#b45309', '#713f12'], pattern: 'grid', glyph: '箱' },
        },
      ],
      ring_ruby: [
        {
          scene: '*',
          lang: '*',
          block: { colors: ['#fb7185', '#881337'], pattern: 'ring', glyph: '戒' },
        },
      ],
    },
  },

  /* ------------------------------ 语言包 ------------------------------ */
  {
    id: 'lang_zh',
    name: '简体中文语言包',
    kind: 'language',
    version: '2.1.0',
    priority: 150,
    accent: '#e11d48',
    description: '药水用 zh-CN 精确键；木箱只给了 zh 主标签，靠语言回退命中。',
    resources: {
      potion_hp: [
        {
          scene: '*',
          lang: 'zh-CN',
          note: '语言精确键',
          block: { colors: ['#f43f5e', '#9f1239'], pattern: 'solid', glyph: '药水' },
        },
      ],
      chest_wood: [
        {
          scene: '*',
          lang: 'zh',
          block: { colors: ['#c2410c', '#7c2d12'], pattern: 'grid', glyph: '木箱' },
        },
      ],
      key_brass: [
        {
          scene: '*',
          lang: 'zh',
          block: { colors: ['#eab308', '#854d0e'], pattern: 'dots', glyph: '钥匙' },
        },
      ],
    },
  },
  {
    id: 'lang_en',
    name: 'English Language Pack',
    kind: 'language',
    version: '2.1.0',
    priority: 150,
    accent: '#2563eb',
    resources: {
      potion_hp: [
        {
          scene: '*',
          lang: 'en',
          block: { colors: ['#ef4444', '#991b1b'], pattern: 'solid', glyph: 'HP' },
        },
      ],
      chest_wood: [
        {
          scene: '*',
          lang: 'en',
          block: { colors: ['#d97706', '#78350f'], pattern: 'grid', glyph: 'Chest' },
        },
      ],
      key_brass: [
        {
          scene: '*',
          lang: 'en',
          block: { colors: ['#ca8a04', '#713f12'], pattern: 'dots', glyph: 'Key' },
        },
      ],
    },
  },
  {
    id: 'lang_ja',
    name: '日本語言語パック',
    kind: 'language',
    version: '2.1.0',
    priority: 150,
    accent: '#db2777',
    resources: {
      potion_hp: [
        {
          scene: '*',
          lang: 'ja',
          block: { colors: ['#ec4899', '#9d174d'], pattern: 'solid', glyph: '薬' },
        },
      ],
      chest_wood: [
        {
          scene: '*',
          lang: 'ja',
          block: { colors: ['#ea580c', '#7c2d12'], pattern: 'grid', glyph: '箱' },
        },
      ],
      key_brass: [
        {
          scene: '*',
          lang: 'ja',
          block: { colors: ['#eab308', '#854d0e'], pattern: 'dots', glyph: '鍵' },
        },
      ],
    },
  },

  /* ------------------------------ 高清替换包（同级冲突） ------------------------------ */
  {
    id: 'pack_hd_red',
    name: '高清材质包 · 赤',
    kind: 'replace',
    version: '3.0.0',
    priority: 100,
    accent: '#dc2626',
    batchCandidate: true,
    description: '与「高清 · 蓝」同为优先级 100，同时替换铁剑 / 木盾，产生同级冲突。',
    resources: {
      sword_iron: [
        {
          scene: '*',
          lang: '*',
          block: { colors: ['#f87171', '#7f1d1d'], pattern: 'stripe', glyph: '剑HD赤' },
        },
        {
          scene: 'battle',
          lang: '*',
          note: '战斗特写变体，匹配精度高于蓝包',
          block: { colors: ['#fb923c', '#9a3412'], pattern: 'stripe', glyph: '战剑·赤' },
        },
      ],
      potion_hp: [
        {
          scene: '*',
          lang: '*',
          block: { colors: ['#fca5a5', '#991b1b'], pattern: 'dots', glyph: 'HP赤' },
        },
      ],
      shield_wood: [
        {
          scene: '*',
          lang: '*',
          block: { colors: ['#ef4444', '#7f1d1d'], pattern: 'stripe', glyph: '盾HD赤' },
        },
      ],
    },
  },
  {
    id: 'pack_hd_blue',
    name: '高清材质包 · 蓝',
    kind: 'replace',
    version: '3.0.0',
    priority: 100,
    accent: '#0284c7',
    batchCandidate: true,
    description: '与「高清 · 赤」同级。世界场景双方都是 (*,*) 同精度，按 ID 固定次序蓝包暂胜。',
    resources: {
      sword_iron: [
        {
          scene: '*',
          lang: '*',
          block: { colors: ['#7dd3fc', '#075985'], pattern: 'dots', glyph: '剑HD蓝' },
        },
      ],
      shield_wood: [
        {
          scene: '*',
          lang: '*',
          block: { colors: ['#3b82f6', '#1e3a8a'], pattern: 'dots', glyph: '盾HD蓝' },
        },
      ],
    },
  },

  /* ------------------------------ 正常依赖示例 ------------------------------ */
  {
    id: 'pack_neon',
    name: '霓虹特效包',
    kind: 'replace',
    version: '0.9.2',
    priority: 110,
    accent: '#a21caf',
    dependencies: ['pack_hd_red'],
    description: '依赖「高清材质包 · 赤」。赤包被关闭时，本包会因依赖未开启而被跳过。',
    resources: {
      gem_blue: [
        {
          scene: '*',
          lang: '*',
          block: { colors: ['#e879f9', '#6b21a8'], pattern: 'ring', glyph: '霓宝' },
        },
      ],
      bow_elf: [
        {
          scene: '*',
          lang: '*',
          block: { colors: ['#bef264', '#365314'], pattern: 'diagonal', glyph: '霓弓' },
        },
      ],
    },
  },

  /* ------------------------------ 显式移除包 ------------------------------ */
  {
    id: 'pack_lite',
    name: '精简 / 移除包',
    kind: 'replace',
    version: '1.2.0',
    priority: 200,
    accent: '#e11d48',
    description: '全局移除木箱；仅在战斗场景移除蓝宝石。关闭后原资源立即回来。',
    removals: [
      {
        item: 'chest_wood',
        scene: '*',
        lang: '*',
        reason: '精简包：移除木箱贴图以减小包体',
      },
      {
        item: 'gem_blue',
        scene: 'battle',
        lang: '*',
        reason: '战斗场景不展示蓝宝石，按场景移除',
      },
    ],
  },

  /* ------------------------ 可批量勾选的健康替换包 ------------------------ */
  {
    id: 'pack_ink',
    name: '水墨风替换包',
    kind: 'replace',
    version: '1.0.0',
    priority: 160,
    accent: '#475569',
    batchCandidate: true,
    description: '批量应用演示：高优先级整体替换黄铜钥匙与精灵弓（会盖过语言包的钥匙文字）。',
    resources: {
      key_brass: [
        {
          scene: '*',
          lang: '*',
          block: { colors: ['#94a3b8', '#0f172a'], pattern: 'diagonal', glyph: '墨钥' },
        },
      ],
      bow_elf: [
        {
          scene: '*',
          lang: '*',
          block: { colors: ['#64748b', '#1e293b'], pattern: 'grid', glyph: '墨弓' },
        },
      ],
    },
  },
  {
    id: 'pack_autumn',
    name: '秋日暖色包',
    kind: 'replace',
    version: '1.4.0',
    priority: 70,
    accent: '#ea580c',
    batchCandidate: true,
    description: '批量应用演示：替换金币。',
    resources: {
      coin_gold: [
        {
          scene: '*',
          lang: '*',
          block: { colors: ['#fb923c', '#7c2d12'], pattern: 'dots', glyph: '秋金' },
        },
      ],
    },
  },
  {
    id: 'pack_pixel',
    name: '像素趣味包',
    kind: 'replace',
    version: '0.3.1',
    priority: 60,
    accent: '#db2777',
    batchCandidate: true,
    description: '批量应用演示：替换红宝石戒指。',
    resources: {
      ring_ruby: [
        {
          scene: '*',
          lang: '*',
          block: { colors: ['#f9a8d4', '#9d174d'], pattern: 'grid', glyph: '像戒' },
        },
      ],
    },
  },

  /* ------------------------------ 坏包：缺依赖 ------------------------------ */
  {
    id: 'pack_darkmod',
    name: '暗影扩展（缺依赖）',
    kind: 'replace',
    version: '0.1.0-beta',
    priority: 50,
    accent: '#312e81',
    batchCandidate: true,
    description: '依赖 pack_ghost_assets，但库中不存在该包。可在批量应用弹窗中看到拦截。',
    dependencies: ['pack_ghost_assets'],
    resources: {
      key_brass: [
        {
          scene: '*',
          lang: '*',
          block: { colors: ['#818cf8', '#1e1b4b'], pattern: 'solid', glyph: '影钥' },
        },
      ],
    },
  },

  /* ------------------------------ 坏包：依赖成环 ------------------------------ */
  {
    id: 'pack_cycle_a',
    name: '循环包 A',
    kind: 'replace',
    version: '0.0.1',
    priority: 40,
    accent: '#15803d',
    batchCandidate: true,
    description: 'cycle_a → cycle_b → cycle_a，依赖成环。',
    dependencies: ['pack_cycle_b'],
    resources: {
      coin_gold: [
        {
          scene: '*',
          lang: '*',
          block: { colors: ['#4ade80', '#14532d'], pattern: 'solid', glyph: 'A币' },
        },
      ],
    },
  },
  {
    id: 'pack_cycle_b',
    name: '循环包 B',
    kind: 'replace',
    version: '0.0.1',
    priority: 40,
    accent: '#7e22ce',
    batchCandidate: true,
    description: 'cycle_b → cycle_a → cycle_b，依赖成环。',
    dependencies: ['pack_cycle_a'],
    resources: {
      potion_hp: [
        {
          scene: '*',
          lang: '*',
          block: { colors: ['#c084fc', '#581c87'], pattern: 'solid', glyph: 'B药' },
        },
      ],
    },
  },
];
