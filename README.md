# 星港杂货铺 · 游戏文案上下文检查台

一个**纯本地、不联网**的 TypeScript 工具，用来在试玩前发现游戏文案的上下文问题：

- 同一条文案随 **数量（zero / one / 复数）**、**说话对象（称呼类别）**、**物品类别（量词/变格）** 走不同句式；
- 语言缺少专用句式 / 整个条目时按约定回退，并注明试玩句子的**真实资源来源**，回退不会被显示成“已翻译”；
- 把 **变量缺失（译文漏放 / 事件漏传值）、变量多出（拼错的契约外变量 / 未使用变量）、类型不合、没走到的句式** 分开报告，全部指到 **语言 · 条目 · 触发样例**；
- 页面顶部可批量切换角色、物品与数量，零 / 单数 / 复数矩阵一次跑完；单句翻译坏掉不影响其他台词；
- 编辑 / 一键填入语言包修订后，对同一组事件做渲染快照 diff，区分 **文字变了** 与 **仅来源变了**；
- 一键导出可读的 Markdown 质检清单；CLI 也能离线生成同一份清单。

页面内容全部是虚构游戏《星港杂货铺》的示例文本。

---

## 零安装快速体验

### 方式 A：直接打开页面（推荐给策划/翻译）

仓库里已经带了预构建的单文件 bundle：

```text
双击 index.html        # 任意现代浏览器即可，file:// 也能跑，无任何网络请求
```

如果改动了 `src/` 下的源码，重新构建一次即可（需要开发依赖）：

```bash
npm install
npm run build          # tsc 类型检查 + 打包 web/app.bundle.js 与 dist/cli.mjs
```

### 方式 B：命令行跑默认例子并导出质检清单

本机 Node ≥ 24（或 ≥ 22.18 原生支持运行 `.ts`）时，**无需 `npm install`**：

```bash
npm run qa             # 等价于 node src/cli.ts，生成 ./qa-checklist.md
```

也可以运行零依赖的打包产物：

```bash
npm run build && node dist/cli.mjs
```

### 测试

```bash
npm test               # 6 个核心单测：选句/回退/质检分类/渲染隔离/diff
npm run smoke:ui       # jsdom 加载真实 bundle，模拟切语言/筛选/应用修订
npm run shoot          # 可选：用本机 Chrome 截图（需自行 npm i -D puppeteer-core）
```

页面支持 `index.html#play` / `#qa` / `#diff` 深链。

---

## 页面三个 Tab

1. **试玩 / 批量预演**
   - 顶部控制栏切换预览语言、角色（决定 `address` 称呼句式）、物品（决定 `category` 类别句式）、数量（输入框 + `0 / 1 / 2+ / 5` 预设）。
   - 每个事件组逐句渲染，变量按值高亮；缺值显示 `⟨缺失:x⟩`，类型不合有虚线下划线。
   - 每句台词下方有**来源徽章**：
     - `✓ 中 · 专用句`：精确命中；
     - `↳ EN · 数量式回退 / 通用句式`：本语言内按约定回退；
     - `⚠ 跨语言回退 → EN`：该语言没翻译，文字实际来自 `en-US`（琥珀色，绝不冒充已翻译）；
     - `✕ 文案缺失`：整条回退链失败。
     - 鼠标悬停徽章可看完整资源坐标与回退轨迹。
   - 两张矩阵表（购买句、道具说明）一次跑完 4 个物品 × `0/1/2/5`，右下角小标是每格来源。

2. **质检清单**
   - 顶部是错误 / 警告触发次数与聚合问题组数；
   - 筛选 chips 按六类分开：变量缺失、变量多出、类型不合、未走到的句式、回退使用、条目缺失；
   - 每张问题卡包含语言、条目、命中句式条件、期望/实际、触发样例 ID 与标签、复现上下文 JSON；同一缺陷被矩阵多样例触发时会聚合成一组并列出全部样例 ID；
   - 可 **导出 Markdown 质检清单** 或 **复制全文**，也可在页内预览。

3. **更新语言包对比**
   - 左侧 JSON 编辑器可直接改当前语言包，或一键填入预置的 `ja-JP` 修订 v2；
   - “应用更新并对比”会对全部 45 个样例做更新前后渲染快照：
     - **文字变了**：渲染文本不同（示例中为补回 `{count}`、新增日文任务提醒，共 10 条）；
     - **仅来源变了**：文字逐字相同，但来源坐标变了（示例中新增了与通用句同文的 `food` 专用句式，共 3 条）；
   - 应用修订后，质检 Tab 会按新语言包重新统计（日文漏 `{count}` 的错误消失）。

---

## 默认样例故意埋了哪些问题

| 位置 | 问题 | 报告类别 |
| --- | --- | --- |
| `en-US / shop.welcome` 通用句 | 译文漏掉基准句里的 `{address}` | 变量缺失 · `placeholder-dropped` |
| `ja-JP / item.inspect` other 句 | 翻译漏放 `{count}`，被 9 个样例触发并聚合 | 变量缺失 · `placeholder-dropped` |
| 样例 `ev_broken.missing_value` | 暗号事件没传必需的 `code` | 变量缺失 · `required-value-missing` |
| `en-US / quest.remind` captain 句 | `{placee}` 拼写错误：契约外变量，同时漏掉 `{place}` | 变量多出 + 变量缺失 |
| 样例 `ev_quest.remind` 的 `qa_note` | 传入了但命中句式用不到的陈旧变量 | 变量多出 · `value-unused`（警告） |
| 样例 `ev_broken.bad_type` | `amount` 契约要求 integer，实际传字符串 `"三"` | 类型不合 |
| `shop.welcome` captain/stranger、`quest.remind` 通用句等 | 语言包里定义了但没有任何样例走到 | 未走到的句式（附建议补的触发上下文） |
| `ja-JP / quest.remind`、`system.save_hint` | 日文缺条目，跨语言回退到 `en-US` | 回退使用（试玩徽章同步注明） |
| `ja-JP / shop.welcome` kid | 无 kid 专用句，本语言内落到通用句 | 来源徽章标注 generic-form |

---

## 模型与检查原理

```text
src/core/
  types.ts       语言包 / 句式 when / 触发样例 / 问题 / diff 等类型
  plural.ts      zero/one/... 数量桶与约定回退顺序
  context.ts     样例 + 角色/物品 -> 匹配条件 + 本地化变量表
  resolve.ts     语言内选句（确定性排序）+ 跨语言回退链与来源轨迹
  template.ts    {var} 提取、类型判定、容错渲染
  checks.ts      全量扫描、问题聚合、统计
  diff.ts        渲染快照与 text-changed / source-only 对比
  checklist.ts   Markdown 质检清单生成
  render.ts      单样例渲染（错误收敛，不抛异常）
src/data/
  packs/         zh-CN（基准+变量契约）、en-US、ja-JP、ja-JP v2 修订
  game-data.ts   角色（address 类别）、物品（category 类别）、NPC 名
  events.ts      4 组可试对话事件（13 条台词）+ 32 个矩阵样例 = 45 个触发样例
src/ui/          无框架 DOM UI（h.ts 是极简 hyperscript），esbuild 打 IIFE
src/cli.ts       离线 QA CLI
test/            node:test 核心测试 + jsdom 真实 bundle 冒烟
```

### 句式选择规则（确定性）

一条句式的 `when` 可声明 `count / address / category`，缺省维度表示“不限”：

1. `when.address` / `when.category` 写明时必须与上下文相等，否则该句不适用；
2. `count` 按约定顺序匹配，例如 `zero -> other`、`one -> other`，最后允许不限数量的通用句；
3. 同档下限定条件越多越优先，仍相同则按语言包声明顺序；
4. 当前语言无可用条目/句式时，沿 `fallbackLocale` 继续找（默认约定指向 `en-US`），每一跳都记录在 `source.hops`。

注意：只有当条目本身定义了某维度的专用句式时，落到通用句才会被标为“句式回退”，避免没有该维度的条目（如存档提示）被误报。

### 变量契约

变量类型契约 `params` 维护在基准包 `zh-CN` 条目上：

```ts
params: {
  count:   { type: 'integer' },
  item:    { type: 'string' },
  address: { type: 'string' },
}
```

检查器对每个“语言 × 条目 × 触发样例”比较：

- 基准语言命中句式的占位符集合 vs 该语言命中句式的集合（漏放变量）；
- 占位符与契约/基准集合（契约外即“多出”，通常是拼写错误）；
- 样例 `vars` 与实际命中句式（传了没用 = 陈旧变量）；
- 样例值与 `params` 类型；
- 全部样例走完后，哪些 `locale:entry:formIndex` 从未被选中。

---

## 接入真实项目

1. 用真实语言包替换 `src/data/packs/*.ts`（或把 JSON 直接 `import` 进来，结构对齐 `LanguagePack`）；
2. 用真实对话/道具触发上下文替换 `src/data/events.ts` 的 `TriggerSample[]`——关键是让每个策划句式至少有一个样例能走到；
3. 在 `checks.ts` / `plural.ts` 中按项目实际的复数规则和回退约定调整；
4. 跑 `npm run qa`，或在页面里导出清单发给翻译/策划。

## 离线与隐私

- 页面不加载任何 CDN 字体/脚本/接口，所有示例数据内置，导出走浏览器 Blob；
- CLI 只读写本地文件；
- `npm install` 仅用于开发期的类型检查/打包/冒烟，运行预构建产物与 Node 原生 TS 时零第三方依赖。
