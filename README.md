# town-namer

本地游戏命名规则生成器（TypeScript，零运行时依赖）：为虚构城镇的居民按族群规则起名，名册可确定性重建。

## 运行

```bash
npm install
npm run demo   # 演示：用尽 / 继承 / 迁居 / 规则升级预览 / 存档重开
npm test       # 10 项断言测试
```

## 功能对照

| 需求 | 实现 |
|---|---|
| 三族群姓氏/名字/后缀组合，声节不合按规则换词 | `src/rules.ts` 词库与禁忌表；`src/generator.ts` 的 `compatViolation` + 换词重抽 |
| 同城同规则同种子可重建名册；加新居民不改老名字 | 每个居民的随机流只由 `(seed, townId, residentId)` 派生（`src/rng.ts`）；`replayRoster` / `verifyRoster`（`src/town.ts`） |
| 继承父家/母家姓、迁居保留来源、名字来历可查 | `Town.addChild` / `Town.migrateOut`；每个居民带 `provenance` 规则链 |
| 允许撞姓、限制全名撞车；词库不足报出卡住的族群；可导出 | `maxFullNameCollisions`；`ExhaustedError` 携带 `clanId`；`capacityReport()`；`exportResidents()` |
| 规则更新前预览、标记沿用不批量改名、新居民走新规则 | `previewRuleUpdate` / `applyRuleUpdate`（`src/preview.ts`） |
| 有限词库演示用尽/继承/迁居，重开后结果一致 | `src/demo.ts`；存档/读档在 `src/persistence.ts` |

## 规则定义示例

```ts
{
  id: 'yan', label: '岩氏族',
  surnames: ['Gan', 'Dor', 'Kum', 'Rash'],
  givens: ['Ald', 'Nara', 'Mek', 'Sora', 'Nul', 'Bren'],
  suffixes: ['-rok', '-din'],
  suffixOptional: false,
  incompatible: [
    { surnameEnding: 'n', givenInitial: 'n', note: '鼻音叠鼻音，岩语避讳' },
  ],
}
```

姓氏尾音与名字首音命中 `incompatible` 即换词重抽；全名在城内撞车超过上限同样重抽。所有重抽只推进该居民自己的随机流，因此：

- 同一 `(规则, 种子, 操作序列)` 重放结果逐字一致；
- 新增居民只追加，老名字永不重算；
- 词库耗尽时抛出 `ExhaustedError`，指明是哪个族群卡住。
