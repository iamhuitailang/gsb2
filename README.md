# Tutorial Hint Lab · 引导提示调试台

游戏原型的引导提示系统 + 可视化调试页。核心引擎是纯 TypeScript、只认虚拟时钟的事件协调器，
同一份实现同时跑在 Node（CLI / 自动化测试）和浏览器（调试台）里，不依赖任何运行时框架。

## 想解决的问题

- 几条教学提示同时有资格时，**先教玩家眼前那一步**，已经会做的不再弹；
- 同一时刻只显示一条，触发再密也不能反复遮挡操作；排队中的提示过时就撤；
- 区分「看完 / 主动略过 / 靠自己完成」三种学习结局，进出场景、重开页面后沿用；
- 教学过程中允许打断（离开位置、更紧急的动作插入），恢复时有明确去留；
- 每条提示都能读出最近一次触发 / 过滤 / 取消的原因，并能在任意操作记录上暂停重走；
- 提供新账号与老存档样例，改规则后用同一串事件对比实际提示次序。

## 运行

```bash
npm install
npm test          # 编译 + 13 项 node:test, 逐条对应六项需求
npm run demo      # 新账号完整动线(CLI)
npm run experienced
npm run compare   # 两套规则在同一事件流上的次序对比
npm run replay    # 在某条操作记录上暂停、单步重走
npm run serve     # 浏览器调试台 → http://localhost:5173/
```

调试台前先 `npm run build`（`serve` 直接提供 `dist/` 里编译出的 ESM）。

## 目录结构

```
src/core/
  types.ts        领域类型: 解锁规则、过滤/取消原因、学习结局、操作日志
  rules.ts        可插拔规则集(zone-first 默认 / rescue-first 对比用)
  coordinator.ts  引擎: 解锁评估、优先级排队、冷却防刷、打断恢复、学习状态、全量日志
  replay.ts       重放会话: 从日志重建引擎, 支持 pauseAtSeq / runToSeq / 单步
src/catalog/
  hints.ts        6 条提示的目录(四类解锁齐全) + 两种存档样例 + 冷却/队列常量
src/sim/
  scenarios.ts    4 个场景脚本(含规则分歧基准用例)
  runner.ts       虚拟时钟跑脚本, 直接消费 trace 闭合每条上屏记录的结局
  compare.ts      同事件流 × 多规则集的次序对比
  cli.ts          命令行入口
src/facade.ts     浏览器与 CLI 共用的装配门面
public/           调试台(index.html / styles.css / app.js)
tests/            13 项测试, 覆盖六项需求
tools/serve.mjs   零依赖静态服务器
```

## 六项需求落在哪

### 1. 四种解锁方式 + 前置依赖
`src/catalog/hints.ts` 的每条 `HintSpec.unlock` 是规则数组，全部满足才有资格：

| 解锁 | 例子 | 不满足时的过滤原因 |
| --- | --- | --- |
| 位置 `zone` | 进 hub 教拾取 | `zoneMismatch` |
| 位置+首用复合 | 在 door 第一次 jump 才教跳跃 | `zoneActionPending` |
| 首用 `firstUse` | 第一次用背包 | `useCountNotMet` |
| 失败次数 `failure` | craft 连续失败 2 次 | `failureCountNotMet` |
| 前置 `prereq` | 先会拾取+背包，合成提示才出现 | `prereqNotMet` |

前置只认「看完 / 靠自己完成」，**主动略过不视为学会**，因此略过的技能不会解锁后续教学。

### 2. 一次一条 + 排队 + 过时撤掉 + 防刷屏
- `TutorialCoordinator` 任意时刻只有一个 `active`，其余按规则集优先级排队（`MAX_QUEUE = 4`，满了挤出最低优先并记 `queueEvicted`）。
- 每条提示有 `ttlMs`，排队/挂起期间超时记 `ttlExpired` 撤掉，不再占用屏幕。
- 三道防抖：全局上屏冷却 `GLOBAL_COOLDOWN_MS`、取消后重触发冷却 `RETRIGGER_COOLDOWN_MS`、
  主动略过冷静期 `SKIP_COOLDOWN_MS`，分别留 `retriggerCooldown` / `skipCooldown` 痕迹。

### 3. 三种学习结局 + 状态沿用
- 停留到展示时长 → `watched`；点略过 → `skipped`；没看会就做对目标动作 → `selfDone`（失败动作不算自学）。
- `exportLearned()` 只持久化学习结论；`new TutorialCoordinator({ initialLearned })` 即可在重开页面后还原。
- `sceneLeave` 清空运行期队列与计数但保留 learned，重新进场景不会重复教已会的提示（记 `alreadyLearned`）。

### 4. 打断与恢复的明确去留
- 离开绑定位置：展示中的提示在 `maxInterruptions` 额度内**挂起**（保留剩余展示时长），回位置恢复；超额则按 `interruptionBudget` 取消。排队中的同位置提示直接 `zoneLeft` 撤掉。
- 紧急提示（`urgent`）可抢占普通提示：被抢占者挂起、保留剩余时长；紧急上屏仍需在当前规则集下排第一，避免 `urgent` 短路掉规则对比。

### 5. 原因可审计 + 记录级重放
- 每次评估都给每条提示落一条 `TraceEntry`（`shown / queued / suspended / resumed / filtered:<原因> / cancelled:<原因> / learned:<结局>`），
  `getLastTrace(id)` 读出最近一次，`getLog()` 给出全量有序日志。
- `ReplaySession` 把日志里的事件按序喂给一个全新协调器（trace 只用于展示，引擎会重新产出同样的 trace）：
  `pauseAtSeq` / `runToSeq` / `step` / `reset`，调试台点任意日志行即在该处暂停。

### 6. 存档样例 + 规则对比
- `newAccountLearned()` 空存档；`experiencedAccountLearned()` 预置拾取、背包两条 `selfDone`。
- 规则集是实现 `RuleSet` 接口的普通对象（`priority` + `isStale`）。`rule-divergence` 场景是基准用例：
  失败救援提示排队时玩家走进危险区，`zone-first` 先教眼前的闪避，`rescue-first` 先救连续失败的合成——
  `npm run compare` 与调试台「规则对比」卡片都能看到两条不同次序。改 `src/core/rules.ts` 后重跑即可对比。

## 调试台操作

- 顶部切换**存档 / 规则集 / 场景**，「跑脚本」整段回放，「单步」一个事件一个事件走；
- 左列手动注入进位置、动作成功/失败、略过、推时间，随时构造边界情况；
- 中列看学习结局、每条提示最近原因、两套规则的次序对比，可导出/导入存档 JSON；
- 右列是完整操作日志，**点任意一行即在该处暂停重放**，用单步按钮重走。

## 设计约束

引擎不读 `Date` / `setTimeout`，所有时间来自事件携带的虚拟时间戳，因此同输入必然同输出，
重放结果可与原始运行逐字段比对（测试里有断言）。
