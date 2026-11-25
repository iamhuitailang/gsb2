# 《星港杂货铺》文案上下文质检清单

- 生成时间：2026-11-25T19:57:52.253Z
- 运行方式：本地离线运行（`npm run qa`），不依赖任何网络服务
- 扫描语言：`zh-CN` / `en-US` / `ja-JP`
- 触发样例：45 个（对话事件 + 数量/物品矩阵）
- 聚合后问题：**18** 组；按样例计的原始触发：26 次
- 错误 6 组，警告 12 组

## 总览（按类别分开统计）

| 类别 | 问题组数 |
| --- | ---: |
| 变量缺失 | 4 |
| 变量多出 | 4 |
| 类型不合 | 1 |
| 未走到的句式 | 7 |
| 回退使用 | 2 |
| 条目缺失 | 0 |

> 来源标记约定：`exact` 精确专用句式；`generic-form` / `count-fallback` 为本语言约定回退；
> `locale-fallback` 为跨语言回退（**不算已翻译**）；`missing` 为资源缺失。

## 一、必须修复的错误

- [ ] **[变量缺失] 事件漏传必需变量**
  - 位置：全部语言（样例数据），条目 `shop.secret`
  - 问题：事件没有提供必需变量 {code}
  - 期望：string
  - 实际/原文：undefined
  - 触发样例：`ev_broken.missing_value`（暗号事件漏传 code 变量）
  - 复现上下文：

```json
{
  "characterId": "vera"
}
```

- [ ] **[变量缺失] 译文漏用了基准变量**
  - 位置：语言 `en-US`，条目 `quest.remind`
  - 句式：`address=captain`（称呼=captain）
  - 问题：译文句式漏掉了基准句式中的变量 {place}
  - 期望：应包含 {place}
  - 触发样例：`ev_quest.remind`（用团长称呼提醒汇合地点）
  - 复现上下文：

```json
{
  "characterId": "vera",
  "vars": {
    "reward": {
      "$localized": {
        "zh-CN": "潮汐罗盘",
        "en-US": "Tide Compass",
        "ja-JP": "潮の羅針盤"
      }
    },
    "place": {
      "$localized": {
        "zh-CN": "旧灯塔",
        "en-US": "the Old Lighthouse",
        "ja-JP": "旧灯台"
      }
    },
    "qa_note": "regression-sample-3"
  }
}
```

- [ ] **[变量缺失] 译文漏用了基准变量**
  - 位置：语言 `en-US`，条目 `shop.welcome`
  - 问题：译文句式漏掉了基准句式中的变量 {address}
  - 期望：应包含 {address}
  - 触发样例：`ev_harbor.welcome`（林恩（老朋友称呼）进店）
  - 复现上下文：

```json
{
  "characterId": "lynn"
}
```

- [ ] **[变量缺失] 译文漏用了基准变量**
  - 位置：语言 `ja-JP`，条目 `item.inspect`
  - 句式：`count=other`（数量=other）
  - 问题：译文句式漏掉了基准句式中的变量 {count}
  - 期望：应包含 {count}
  - 触发样例：共 **9** 个，首个 `ev_harbor.inspect`（查看月露药水，持有 2 瓶）
    - 样例 ID：`ev_harbor.inspect`、`mx-inspect-moon_tonic-2`、`mx-inspect-moon_tonic-5`、`mx-inspect-ember_blade-2`、`mx-inspect-ember_blade-5`、`mx-inspect-berry_bun-2`、`mx-inspect-berry_bun-5`、`mx-inspect-crystal_shard-2` 等 9 个
  - 复现上下文：

```json
{
  "characterId": "lynn",
  "itemId": "moon_tonic",
  "count": 2
}
```

- [ ] **[类型不合] 样例值类型与变量契约不符**
  - 位置：全部语言（样例数据），条目 `quest.reward`
  - 问题：变量 {amount} 应为 integer，样例实际传入 string
  - 期望：integer
  - 实际/原文：string
  - 触发样例：`ev_broken.bad_type`（金币数传成了中文字符串“三”）
  - 复现上下文：

```json
{
  "characterId": "milo",
  "vars": {
    "reward": {
      "$localized": {
        "zh-CN": "银港徽章",
        "en-US": "Silver Harbor Badge",
        "ja-JP": "銀港バッジ"
      }
    },
    "amount": "三"
  }
}
```

- [ ] **[变量多出] 模板出现契约外变量（疑似拼写错误）**
  - 位置：语言 `en-US`，条目 `quest.remind`
  - 句式：`address=captain`（称呼=captain）
  - 问题：译文使用了契约和基准句式中都不存在的变量 {placee}，疑似拼写错误
  - 期望：{address}, {reward}, {place}
  - 实际/原文：{placee}
  - 触发样例：`ev_quest.remind`（用团长称呼提醒汇合地点）
  - 复现上下文：

```json
{
  "characterId": "vera",
  "vars": {
    "reward": {
      "$localized": {
        "zh-CN": "潮汐罗盘",
        "en-US": "Tide Compass",
        "ja-JP": "潮の羅針盤"
      }
    },
    "place": {
      "$localized": {
        "zh-CN": "旧灯塔",
        "en-US": "the Old Lighthouse",
        "ja-JP": "旧灯台"
      }
    },
    "qa_note": "regression-sample-3"
  }
}
```

## 二、警告与回退

- [ ] **[变量多出] 样例传入的变量未被句式使用**
  - 位置：语言 `en-US`，条目 `quest.remind`
  - 句式：`address=captain`（称呼=captain）
  - 问题：样例传入的变量 {place} 在命中句式中没有被使用
  - 实际/原文：place
  - 触发样例：`ev_quest.remind`（用团长称呼提醒汇合地点）
  - 复现上下文：

```json
{
  "characterId": "vera",
  "vars": {
    "reward": {
      "$localized": {
        "zh-CN": "潮汐罗盘",
        "en-US": "Tide Compass",
        "ja-JP": "潮の羅針盤"
      }
    },
    "place": {
      "$localized": {
        "zh-CN": "旧灯塔",
        "en-US": "the Old Lighthouse",
        "ja-JP": "旧灯台"
      }
    },
    "qa_note": "regression-sample-3"
  }
}
```

- [ ] **[变量多出] 样例传入的变量未被句式使用**
  - 位置：语言 `en-US`，条目 `quest.remind`
  - 句式：`address=captain`（称呼=captain）
  - 问题：样例传入的变量 {qa_note} 在命中句式中没有被使用
  - 实际/原文：qa_note
  - 触发样例：`ev_quest.remind`（用团长称呼提醒汇合地点）
  - 复现上下文：

```json
{
  "characterId": "vera",
  "vars": {
    "reward": {
      "$localized": {
        "zh-CN": "潮汐罗盘",
        "en-US": "Tide Compass",
        "ja-JP": "潮の羅針盤"
      }
    },
    "place": {
      "$localized": {
        "zh-CN": "旧灯塔",
        "en-US": "the Old Lighthouse",
        "ja-JP": "旧灯台"
      }
    },
    "qa_note": "regression-sample-3"
  }
}
```

- [ ] **[变量多出] 样例传入的变量未被句式使用**
  - 位置：语言 `zh-CN`，条目 `quest.remind`
  - 句式：`address=captain`（称呼=captain）
  - 问题：样例传入的变量 {qa_note} 在命中句式中没有被使用
  - 实际/原文：qa_note
  - 触发样例：`ev_quest.remind`（用团长称呼提醒汇合地点）
  - 复现上下文：

```json
{
  "characterId": "vera",
  "vars": {
    "reward": {
      "$localized": {
        "zh-CN": "潮汐罗盘",
        "en-US": "Tide Compass",
        "ja-JP": "潮の羅針盤"
      }
    },
    "place": {
      "$localized": {
        "zh-CN": "旧灯塔",
        "en-US": "the Old Lighthouse",
        "ja-JP": "旧灯台"
      }
    },
    "qa_note": "regression-sample-3"
  }
}
```

- [ ] **[回退使用] 跨语言回退**
  - 位置：语言 `ja-JP`，条目 `quest.remind`
  - 句式：`address=captain`（称呼=captain）
  - 问题：本语言缺少可用条目/句式，试玩文本回退自 en-US
  - 期望：ja-JP
  - 实际/原文：en-US
  - 触发样例：`ev_quest.remind`（用团长称呼提醒汇合地点）
  - 复现上下文：

```json
{
  "characterId": "vera",
  "vars": {
    "reward": {
      "$localized": {
        "zh-CN": "潮汐罗盘",
        "en-US": "Tide Compass",
        "ja-JP": "潮の羅針盤"
      }
    },
    "place": {
      "$localized": {
        "zh-CN": "旧灯塔",
        "en-US": "the Old Lighthouse",
        "ja-JP": "旧灯台"
      }
    },
    "qa_note": "regression-sample-3"
  }
}
```

- [ ] **[回退使用] 跨语言回退**
  - 位置：语言 `ja-JP`，条目 `system.save_hint`
  - 问题：本语言缺少可用条目/句式，试玩文本回退自 en-US
  - 期望：ja-JP
  - 实际/原文：en-US
  - 触发样例：`ev_harbor.save_hint`（风起时的存档提示）

- [ ] **[未走到的句式] 句式从未被触发**
  - 位置：语言 `en-US`，条目 `quest.remind`
  - 问题：该句式没有被任何事件/矩阵样例触发，可能是死文案或条件写错
  - 实际/原文：Do not forget: bring the {reward} and meet the old helmsman at {place}.
  - 建议补的触发样例：`characterId=lynn（address=oldfriend，避开专用句式）`

- [ ] **[未走到的句式] 句式从未被触发**
  - 位置：语言 `en-US`，条目 `shop.welcome`
  - 句式：`address=captain`（称呼=captain）
  - 问题：该句式没有被任何事件/矩阵样例触发，可能是死文案或条件写错
  - 实际/原文：Welcome back, {address}! The docks wind has not been kind to you.
  - 建议补的触发样例：`characterId=vera`

- [ ] **[未走到的句式] 句式从未被触发**
  - 位置：语言 `en-US`，条目 `shop.welcome`
  - 句式：`address=stranger`（称呼=stranger）
  - 问题：该句式没有被任何事件/矩阵样例触发，可能是死文案或条件写错
  - 实际/原文：First time in our harbor, {address}? Nights are cold here — something warm?
  - 建议补的触发样例：`characterId=shade`

- [ ] **[未走到的句式] 句式从未被触发**
  - 位置：语言 `ja-JP`，条目 `shop.welcome`
  - 句式：`address=captain`（称呼=captain）
  - 问题：该句式没有被任何事件/矩阵样例触发，可能是死文案或条件写错
  - 实际/原文：お帰りなさい、{address}。波止場の風は強かったでしょう。
  - 建议补的触发样例：`characterId=vera`

- [ ] **[未走到的句式] 句式从未被触发**
  - 位置：语言 `zh-CN`，条目 `quest.remind`
  - 问题：该句式没有被任何事件/矩阵样例触发，可能是死文案或条件写错
  - 实际/原文：别忘了，带上{reward}去{place}找老舵手。
  - 建议补的触发样例：`characterId=lynn（address=oldfriend，避开专用句式）`

- [ ] **[未走到的句式] 句式从未被触发**
  - 位置：语言 `zh-CN`，条目 `shop.welcome`
  - 句式：`address=captain`（称呼=captain）
  - 问题：该句式没有被任何事件/矩阵样例触发，可能是死文案或条件写错
  - 实际/原文：欢迎回来，{address}！码头的风没少吹您吧。
  - 建议补的触发样例：`characterId=vera`

- [ ] **[未走到的句式] 句式从未被触发**
  - 位置：语言 `zh-CN`，条目 `shop.welcome`
  - 句式：`address=stranger`（称呼=stranger）
  - 问题：该句式没有被任何事件/矩阵样例触发，可能是死文案或条件写错
  - 实际/原文：初次见面，{address}。港里夜里凉，先看件厚实的？
  - 建议补的触发样例：`characterId=shade`

## 三、对话事件三语试玩结果（含真实来源）

### ev_harbor / `ev_harbor.welcome` 林恩（老朋友称呼）进店

- **zh-CN**：你来啦，老朋友。随便看，别碰倒架子就行。
  - 来源：↳ 本语言约定回退 · zh-CN / shop.welcome # *
  - 回退轨迹：称呼=oldfriend 无专用句，落到通用称呼句
- **en-US**：There you are. Browse around — just do not knock over the shelves.
  - 来源：↳ 本语言约定回退 · en-US / shop.welcome # *
  - 回退轨迹：称呼=oldfriend 无专用句，落到通用称呼句
- **ja-JP**：いらっしゃい、旧友。棚を倒さなければ、ゆっくり見ていって。
  - 来源：↳ 本语言约定回退 · ja-JP / shop.welcome # *
  - 回退轨迹：称呼=oldfriend 无专用句，落到通用称呼句

### ev_harbor / `ev_harbor.inspect` 查看月露药水，持有 2 瓶

- **zh-CN**：老朋友，「月露药水」还剩 2 件，补给充足。
  - 来源：✅ 精确 · zh-CN / item.inspect # count=other
- **en-US**：old friend, you still have 2 × Moondew Tonic in your pack.
  - 来源：✅ 精确 · en-US / item.inspect # count=other
- **ja-JP**：旧友、「月の雫薬」はまだたっぷり残っているよ。
  - 来源：✅ 精确 · ja-JP / item.inspect # count=other

### ev_harbor / `ev_harbor.save_hint` 风起时的存档提示

- **zh-CN**：风灯亮起时，星港会替你记住这次远航。
  - 来源：✅ 精确 · zh-CN / system.save_hint # *
- **en-US**：When the harbor lanterns light, Star Port remembers your voyage.
  - 来源：✅ 精确 · en-US / system.save_hint # *
- **ja-JP**：When the harbor lanterns light, Star Port remembers your voyage.
  - 来源：⚠️ 跨语言回退（不算已翻译）· en-US / system.save_hint # *
  - 回退轨迹：ja-JP 缺少条目 system.save_hint → 按约定跨语言回退到 en-US

### ev_deal / `ev_deal.blade_one` 薇拉团长买 1 把余烬短刃

- **zh-CN**：你买下 1 把「余烬短刃」，拔剑声引得满酒馆回头。
  - 来源：✅ 精确 · zh-CN / shop.buy # count=one&category=weapon
- **en-US**：You buy 1 blade called Ember Dagger; the tavern turns to look.
  - 来源：✅ 精确 · en-US / shop.buy # count=one&category=weapon
- **ja-JP**：「残火の短剣」を 1 振り買うと、酒場中の視線が集まった。
  - 来源：✅ 精确 · ja-JP / shop.buy # count=one&category=weapon

### ev_deal / `ev_deal.bun_zero` 米洛买麦香果包，数量 0

- **zh-CN**：你摆了摆手，这次什么也没买。
  - 来源：↳ 本语言约定回退 · zh-CN / shop.buy # count=zero
  - 回退轨迹：类别=food 无专用句，落到通用类别句
- **en-US**：You wave Moss off and buy nothing this time.
  - 来源：↳ 本语言约定回退 · en-US / shop.buy # count=zero
  - 回退轨迹：类别=food 无专用句，落到通用类别句
- **ja-JP**：何も買わずに手を振った。
  - 来源：↳ 本语言约定回退 · ja-JP / shop.buy # count=zero
  - 回退轨迹：类别=food 无专用句，落到通用类别句

### ev_deal / `ev_deal.tonic_three` 林恩买 3 瓶月露药水

- **zh-CN**：你买下 3 瓶「月露药水」，瓶瓶罐罐在包里叮当作响。
  - 来源：✅ 精确 · zh-CN / shop.buy # count=other&category=potion
- **en-US**：You buy 3 bottles of Moondew Tonic, clinking in your pack.
  - 来源：✅ 精确 · en-US / shop.buy # count=other&category=potion
- **ja-JP**：「月の雫薬」を 3 本買い込み、瓶が鞄の中でカタカタ鳴る。
  - 来源：✅ 精确 · ja-JP / shop.buy # count=other&category=potion

### ev_deal / `ev_deal.shard_five` 薇拉买 5 个共鸣晶簇

- **zh-CN**：你买下 5 个「共鸣晶簇」，苔姨笑得眼睛眯成一条缝。
  - 来源：↳ 本语言约定回退 · zh-CN / shop.buy # count=other
  - 回退轨迹：类别=material 无专用句，落到通用类别句
- **en-US**：You buy 5 × Resonant Shard. Moss beams.
  - 来源：↳ 本语言约定回退 · en-US / shop.buy # count=other
  - 回退轨迹：类别=material 无专用句，落到通用类别句
- **ja-JP**：「共鳴結晶」を 5 個買った。苔おばは目を細めて笑う。
  - 来源：↳ 本语言约定回退 · ja-JP / shop.buy # count=other
  - 回退轨迹：类别=material 无专用句，落到通用类别句

### ev_quest / `ev_quest.remind` 用团长称呼提醒汇合地点

- **zh-CN**：团长，别忘了：带着潮汐罗盘到旧灯塔汇合，港务长可不等人。
  - 来源：✅ 精确 · zh-CN / quest.remind # address=captain
- **en-US**：Captain, do not forget: bring the Tide Compass and meet at ⟨缺失:placee⟩. The harbormaster never waits.
  - 来源：✅ 精确 · en-US / quest.remind # address=captain
- **ja-JP**：団長, do not forget: bring the 潮の羅針盤 and meet at ⟨缺失:placee⟩. The harbormaster never waits.
  - 来源：⚠️ 跨语言回退（不算已翻译）· en-US / quest.remind # address=captain
  - 回退轨迹：ja-JP 缺少条目 quest.remind → 按约定跨语言回退到 en-US

### ev_quest / `ev_quest.reward_ok` 正常结算：30 枚金币（整数）

- **zh-CN**：委托完成！报酬是 30 枚金币，外加「银港徽章」。
  - 来源：✅ 精确 · zh-CN / quest.reward # *
- **en-US**：Contract complete! Reward: 30 coins and “Silver Harbor Badge”.
  - 来源：✅ 精确 · en-US / quest.reward # *
- **ja-JP**：依頼達成！ 報酬は金貨 30 枚と「銀港バッジ」だ。
  - 来源：✅ 精确 · ja-JP / quest.reward # *

### ev_broken / `ev_broken.before` 坏样例之前的问候（应正常）

- **zh-CN**：哟，小家伙！今天攒了多少铜币呀？
  - 来源：✅ 精确 · zh-CN / shop.welcome # address=kid
- **en-US**：Hey kiddo! How many coppers did you scrape together today?
  - 来源：✅ 精确 · en-US / shop.welcome # address=kid
- **ja-JP**：いらっしゃい、ぼうや。棚を倒さなければ、ゆっくり見ていって。
  - 来源：↳ 本语言约定回退 · ja-JP / shop.welcome # *
  - 回退轨迹：称呼=kid 无专用句，落到通用称呼句

### ev_broken / `ev_broken.bad_type` 金币数传成了中文字符串“三”

- **zh-CN**：委托完成！报酬是 三 枚金币，外加「银港徽章」。
  - 来源：✅ 精确 · zh-CN / quest.reward # *
- **en-US**：Contract complete! Reward: 三 coins and “Silver Harbor Badge”.
  - 来源：✅ 精确 · en-US / quest.reward # *
- **ja-JP**：依頼達成！ 報酬は金貨 三 枚と「銀港バッジ」だ。
  - 来源：✅ 精确 · ja-JP / quest.reward # *

### ev_broken / `ev_broken.missing_value` 暗号事件漏传 code 变量

- **zh-CN**：苔姨压低声音：「今晚的暗号是 ⟨缺失:code⟩，别告诉别人。」
  - 来源：✅ 精确 · zh-CN / shop.secret # *
- **en-US**：Moss whispers: “Tonight’s code is ⟨缺失:code⟩. Tell nobody.”
  - 来源：✅ 精确 · en-US / shop.secret # *
- **ja-JP**：苔おばは声をひそめた。「今夜の合言葉は ⟨缺失:code⟩ だよ。誰にも言うんじゃない」
  - 来源：✅ 精确 · ja-JP / shop.secret # *

### ev_broken / `ev_broken.after` 坏样例之后的成交句（应正常）

- **zh-CN**：你买下 2 瓶「月露药水」，瓶瓶罐罐在包里叮当作响。
  - 来源：✅ 精确 · zh-CN / shop.buy # count=other&category=potion
- **en-US**：You buy 2 bottles of Moondew Tonic, clinking in your pack.
  - 来源：✅ 精确 · en-US / shop.buy # count=other&category=potion
- **ja-JP**：「月の雫薬」を 2 本買い込み、瓶が鞄の中でカタカタ鳴る。
  - 来源：✅ 精确 · ja-JP / shop.buy # count=other&category=potion

---

## 四、使用说明

1. 页面顶部可切换角色、物品与数量（0 / 1 / 2 / 5），所有对话与矩阵批量重渲染。
2. 一句台词报错不会影响同事件其他台词。
3. 在「更新对比」页编辑或一键填入 ja-JP 修订包，可查看文字变化与“仅来源变了”。
4. 本清单由默认虚构样例生成，接入真实语言包时替换 `src/data/packs` 与 `src/data/events.ts` 即可。
