import type { NamingRules } from './types.js';

/**
 * 演示用规则：三个族群。
 * - yan  岩氏族：词库中等，带两条声节禁忌（鼻音叠音、咝音叠音）
 * - xi   汐水族：后缀可选，禁忌为同元音相碰
 * - feng 风隼部：词库故意做得极小，用来演示“用尽”
 */
export const DEMO_RULES_V1: NamingRules = {
  version: 1,
  maxFullNameCollisions: 0,
  clans: [
    {
      id: 'yan',
      label: '岩氏族',
      surnames: ['Gan', 'Dor', 'Kum', 'Rash'],
      givens: ['Ald', 'Nara', 'Mek', 'Sora', 'Nul', 'Bren'],
      suffixes: ['-rok', '-din'],
      suffixOptional: false,
      incompatible: [
        { surnameEnding: 'n', givenInitial: 'n', note: '鼻音叠鼻音，岩语避讳' },
        { surnameEnding: 'sh', givenInitial: 's', note: '咝音相连，发音不吉' },
      ],
    },
    {
      id: 'xi',
      label: '汐水族',
      surnames: ['Mira', 'Sol', 'Unda'],
      givens: ['Eo', 'Lio', 'Ael', 'Ondine', 'Ilo'],
      suffixes: ['-wave', '-mere'],
      suffixOptional: true,
      incompatible: [
        { surnameEnding: 'a', givenInitial: 'a', note: '同元音相碰成 hiatus，汐语回避' },
        { surnameEnding: 'o', givenInitial: 'o', note: '同元音相碰成 hiatus，汐语回避' },
      ],
    },
    {
      id: 'feng',
      label: '风隼部',
      // 2 姓 × 2 名 × (1 后缀 + 无后缀) = 8 种全名，再扣掉禁忌组合，很快就会耗尽
      surnames: ['Kite', 'Veh'],
      givens: ['Tal', 'Eli'],
      suffixes: ['-swift'],
      suffixOptional: true,
      incompatible: [
        { surnameEnding: 'e', givenInitial: 'e', note: '风语不许 e 音相接' },
      ],
    },
  ],
};

/**
 * 第二版规则：岩氏族换掉一批名字、新增一条禁忌。
 * 用于演示“更新前预览哪些旧名字不再符合”。
 */
export const DEMO_RULES_V2: NamingRules = {
  ...DEMO_RULES_V1,
  version: 2,
  clans: DEMO_RULES_V1.clans.map((c) =>
    c.id === 'yan'
      ? {
          ...c,
          givens: ['Ald', 'Turo', 'Mek', 'Hesa', 'Nul', 'Bren'], // Nara、Sora 被弃用
          incompatible: [
            ...c.incompatible,
            { surnameEnding: 'm', givenInitial: 'm', note: '新版禁忌：唇音叠唇音' },
          ],
        }
      : c,
  ),
};
