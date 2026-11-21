# 任务链编辑器与试玩工具

面向游戏任务策划的可视化工具：配置任务的前置、互斥与完成条件，自动发现
**循环依赖、无入口、无法到达结局、互斥死路**等玩家可能卡住的路径，并能像玩家
一样逐步模拟任务接取/完成/失败，实时看哪些任务变为可接取或失效。

- 纯 Python 标准库后端 + 原生 HTML/SVG/JS 前端，**零第三方依赖、零构建**
- 提供 CLI、本地 Web 编辑器、HTTP API 三种使用方式
- 工程文件与游戏运行时数据分离，导入时自动检查缺失引用
- 自带两个样例：完整多结局工程、故障诊断工程

---

## 目录

- [快速开始](#快速开始)
- [条件表达式 DSL（重点）](#条件表达式-dsl重点)
- [数据格式](#数据格式)
- [图诊断规则与路径说明](#图诊断规则与路径说明)
- [模拟器：玩家会怎样卡住](#模拟器玩家会怎样卡住)
- [影响分析与版本对比](#影响分析与版本对比)
- [导入导出与缺失引用检查](#导入导出与缺失引用检查)
- [CLI 命令一览](#cli-命令一览)
- [HTTP API](#http-api)
- [样例说明](#样例说明)
- [运行测试](#运行测试)

---

## 快速开始

```bash
# 启动 Web 编辑器 (默认 http://127.0.0.1:8765)
python3 -m quest_chain.cli serve

# 或指定端口
python3 -m quest_chain.cli serve --port 9000
```

浏览器打开后会自动载入演示样例。界面分三栏：

| 区域 | 功能 |
| --- | --- |
| 左栏 · 诊断 | 循环依赖 / 入口 / 结局可达性 / 互斥死路 / 条件引用问题，点击问题可定位节点 |
| 左栏 · 试玩 | 开始模拟后，点击画布节点选择接取/完成/失败，实时看状态差分、奖励、日志 |
| 左栏 · 影响 | 查某个任务的直接/传递后继、受影响结局；可与旧版工程文件做版本对比 |
| 中间画布 | 双击空白新建任务，拖动节点排版；实线箭头=前置依赖，红色虚线=互斥 |
| 右栏 | 编辑任务 ID、前置、条件、互斥、结局/支线标记、奖励、工程级初始变量 |

要求 Python 3.9+（开发与测试环境为 3.13）。

---

## 条件表达式 DSL（重点）

每个任务有两层接取门槛，二者取 **AND**：

1. `prerequisites`：前置任务 id 列表，必须**全部**处于 `completed`；
2. `condition`：一段 DSL 表达式，用来表达 flag、数值变量、其他任务状态等
   动态条件。留空（或空字符串）视为恒真。

### 语法（EBNF）

```
expr        := or_expr
or_expr     := and_expr { OR  and_expr }
and_expr    := not_expr { AND not_expr }
not_expr    := NOT not_expr | comparison
comparison  := primary [ CMP primary ]       # 不允许 1 < x < 2 连写
primary     := NUMBER | STRING | BOOL | IDENT
             | FUNC_NAME "(" [ expr { "," expr } ] ")"
             | "(" expr ")"

OR  := or  | ||       AND := and | &&       NOT := not | !
CMP := == | != | > | < | >= | <=
BOOL := true | false
```

- 关键字、函数名**大小写不敏感**；字符串用双引号，支持 `\"` `\\` `\n` `\t` 转义；
- 标识符支持字母、数字、下划线及中文等非 ASCII 字符（`拿到圣剑` 是合法标识符）；
- 运算优先级：`!`/`not` > 比较运算 > `and`/`&&` > `or`/`||`，可用括号改变；
- 数字为整数或浮点；真值规则：`0`、`false`、空字符串、`null` 为假，其余为真
  （字符串 `"false"`/`"0"`/`"no"` 也视为假）。

### 内置函数

| 函数 | 参数 | 含义 |
| --- | --- | --- |
| `q_meet("qid")` | 1 个任务 id | 该任务已完成（状态 = completed） |
| `q_failed("qid")` | 1 个任务 id | 该任务已失败（状态 = failed） |
| `q_state("qid")` | 1 个任务 id | 返回任务状态字符串：`available` / `active` / `completed` / `failed` / `locked`（不存在也返回 locked） |
| `any_of("a","b",...)` | ≥1 个任务 id | 任一完成即为真 |
| `all_of("a","b",...)` | ≥1 个任务 id | 全部完成即为真；无参数时恒真 |
| `none_of("a","b",...)` | ≥1 个任务 id | 所有任务都**没有**进入 completed/failed |
| `flag("name")` | 1 个 flag 名 | 取自定义开关的真值；未声明的 flag 为假 |
| `var("name")` | 变量名 | 取自定义数值变量；不存在返回 `0` |
| `var("name", 默认值)` | 变量名 + 默认值 | 变量不存在时返回默认值 |

裸标识符等价于 `flag(标识符)`：`got_sword` 与 `flag("got_sword")` 完全等价。

求值上下文中始终可用三个对象：

```jsonc
{
  "quest_states": { "q1": "completed", "q2": "active" },
  "flags":        { "village_known": true },
  "variables":    { "reputation": 35 }
}
```

### 表达式示例

```text
# 1. 声望达到 25 且见过村长
var("reputation") >= 25 and flag("village_known")

# 2. 懂得炼药 (等价写法: knows_alchemy)
flag("knows_alchemy")

# 3. 两个前置任务至少完成一个
any_of("q_escort_mission", "q_burglary")

# 4. 某任务处于失败状态
q_failed("q_trial")

# 5. 按任务状态字符串判断
q_state("q_trial") == "failed"

# 6. 带默认值的变量比较
var("chapter", 1) >= 2

# 7. 组合逻辑: 声望够, 且没有任何阵营任务失败
var("reputation") >= 50 && none_of("q_join_knights", "q_join_thieves") || flag("has_relic")

# 8. 中文 flag
拿到圣剑 and var("reputation") >= 40
```

### 静态检查

保存/诊断时会对每个条件做静态检查（`lint_condition`）：

- 语法错误（括号不匹配、连续比较、未知 token 等）；
- 未知函数、参数个数不对；
- `q_meet/any_of/...` 引用了不存在的任务 id（`CONDITION_BROKEN_REF`）；
- `flag(...)` / `var(...)` 引用了工程里未声明的 flag/变量；
- 任务引用参数必须是**字符串字面量**，动态表达式无法静态检查，会给出提示。

> 注意：条件里的任务引用只用于 lint 与运行时判断，**不会**在图上形成结构边。
> 任务能否走到某结局，只看 `prerequisites` 构成的真实依赖链。

也可以在 Python 里直接调用：

```python
from quest_chain.conditions import evaluate, lint_condition

evaluate('var("reputation") >= 25 and flag("village_known")', {
    "variables": {"reputation": 30},
    "flags": {"village_known": True},
})            # -> True

lint_condition('q_meet("ghost")', known_quests={"q1"})
# -> ["引用了不存在的任务 'ghost'"]
```

---

## 数据格式

### 工程文件（`.qchain.json`，含编辑器信息）

```jsonc
{
  "format_version": 1,
  "name": "王座之影",
  "description": "...",
  "initial_flags": { "village_known": false },
  "initial_variables": { "reputation": 0 },
  "quests": [
    {
      "id": "q_join_knights",              // 唯一 id, 必填
      "title": "加入骑士团",
      "description": "...",
      "prerequisites": ["q_goblin_camp"],  // 全部 completed 才可接取
      "condition": "var(\"reputation\") >= 25",
      "exclusive_with": ["q_join_thieves"],// 互斥, 加载时自动补全反向边
      "is_ending": false,                  // true=结局任务
      "optional": false,                   // true=可选支线, 不可达只报 warning
      "rewards": [
        { "type": "item",     "item_id": "potion", "amount": 2 },
        { "type": "currency", "currency_id": "gold", "amount": 50 },
        { "type": "flag",     "flag": "faction", "value": "knights" },
        { "type": "variable", "variable": "reputation", "op": "+=", "value": 15 },
        { "type": "quest",    "quest_id": "q_other", "state": "completed" }
      ],
      "position": { "x": 420, "y": 430 }   // 画布坐标 (导出运行时时剔除)
    }
  ]
}
```

奖励类型与字段：

| type | 必需字段 | 说明 |
| --- | --- | --- |
| `item` | `item_id`, `amount` | 物品进背包 |
| `currency` | `currency_id`, `amount` | 货币累加 |
| `flag` | `flag`, `value` | 直接设置 flag |
| `variable` | `variable`, `op`, `value` | `op` 支持 `+= -= *= /= =` |
| `quest` | `quest_id`, `state` | 把另一任务直接置为 `completed/failed/active/available` |

### 模拟进度文件（`sim_progress.json`）

进度与工程分开保存，结构为 `kind: "quest-sim-progress"`，记录各任务状态、
flags、变量、背包与事件日志。载入时若工程已改动，会对**已消失的任务 id**
给出警告并忽略，新增任务自动补 `locked` 后重算。

---

## 图诊断规则与路径说明

`analyze_project` 返回的每个 Issue 含 `code / severity / message / quest_ids / path`。

| code | 触发条件 | 级别 |
| --- | --- | --- |
| `CYCLE` | Tarjan 强连通分量发现环（含自环），`path` 给出环上完整路径，箭头指向前置 | error |
| `NO_ENTRY` | 所有任务都有前置，玩家没有起点 | error |
| `UNREACHABLE` | 从入口沿依赖边 BFS 不可达；`message` 指出卡在前置链的哪一环；`optional` 任务降为 warning | error/warning |
| `NO_ENDING` | 全图没有任何 `is_ending=true` 的任务 | error |
| `ENDING_UNREACHABLE` | 有结局但没有任何结局从入口可达 | error |
| `NO_PATH_TO_ENDING` | 某任务沿后继走不到任何结局，`path` 给出走到死路叶子的具体路径 | error（支线为 warning） |
| `MUTEX_DEAD_END` | 某任务的传递前置里同时出现一对互斥任务，无论玩家怎么选都接不到；同一互斥对只报一次 | error |
| `MUTEX_PREREQUISITE_CONFLICT` | A、B 互斥，但 B 又是 A 的（传递）前置，配置自相矛盾 | error |
| `CONDITION_INVALID` | 条件语法错误、函数/参数错误、未声明的 flag/变量 | error（未知注入函数为 warning） |
| `CONDITION_BROKEN_REF` | 条件引用了图中不存在的任务 id | error |

严重级别约定：**error** 表示玩家必然或可能卡死、配置不合法；**warning** 只提示
设计风险（典型如可选支线走不到结局）。

---

## 模拟器：玩家会怎样卡住

### 状态机

```
locked ──前置全完成且条件为真──▶ available ──accept──▶ active ──complete──▶ completed
  ▲                                 │                     │
  └──────────── 条件不再满足 ───────┴──────fail──────────┴──────────────▶ failed
```

- `completed` / `failed` 是**粘滞终态**，不会被重算覆盖；
- `active` 也是粘滞的：接取后只要没失效就保持进行中；
- 失效（永久等不到解锁）与普通等待分开给出原因：
  - 前置任务进入 `failed` → `前置任务 X 已失败`；
  - 互斥任务进入任一终态 → `互斥任务 X 已完成/失败`；
  - 前置未完成 → `等待前置: ...`；条件为假 → `条件尚未满足`；条件写错 → `条件求值失败: ...`。

### 每步差分

每次 `accept/complete/fail` 返回 `StepDiff`，前端按类别高亮：

- `new_available`：新变为可接取的任务；
- `invalidated`：从 available/active 掉回 locked 的任务及原因；
- `new_completed/new_failed`：含奖励联动（`quest` 类型奖励）造成的状态变化；
- `rewards_gained`：本步结算的全部奖励；
- `endings_reached`：本步新达成的结局。

### 卡住判定

当**没有任何 available/active 任务、但仍有任务未到终态**时判定卡住，
`stuck_info()` 逐个列出被卡任务与原因；若已有结局完成会同时标注。
试玩面板顶部会出现红色「玩家卡住了」横幅。

---

## 影响分析与版本对比

- **影响面**（`downstream_impact`）：给出某任务的 `direct`（直接后继）、
  `transitive`（全部传递后继）、`endings`（受影响结局）。改一个条件前先看它
  会波及哪些结局。
- **版本对比**（`compare_projects`）：选一份旧工程文件与当前工程对比，输出
  - `added` / `removed`：任务增删；
  - `changed`：每个被改任务变更了哪些字段（前置、条件、互斥、奖励、结局标记等），
    以及它的直接/传递受影响任务与结局；
  - `removal_impact`：删除任务在旧图上的波及面；
  - `flags_changed`：工程级初始 flag/变量是否变化。

---

## 导入导出与缺失引用检查

```bash
# 导出游戏读取的运行时数据 (自动剔除 position 等编辑器字段, 带 kind=quest-runtime)
python3 -m quest_chain.cli export samples/quest_demo.qchain.json -o runtime.json

# 导入任意 JSON (运行时格式或完整工程均可), 检查引用完整性
python3 -m quest_chain.cli import-check runtime.json
```

导入检查覆盖：

1. 结构合法性（重复 id、未知奖励类型、奖励缺字段、版本号等，直接报错拒绝）；
2. `prerequisites` / `exclusive_with` 指向不存在的任务；
3. `quest` 类型奖励指向不存在的任务；
4. 每个任务 `condition` 的语法与任务/flag/变量引用。

Web 编辑器的「导入并校验」会带着问题把图加载进来，问题汇总到诊断面板，
方便先修复再使用。

---

## CLI 命令一览

```bash
python -m quest_chain.cli validate <工程>                 # 静态诊断
python -m quest_chain.cli simulate <工程> \
    --step q_intro:complete --step q_training:fail \
    [--save-progress prog.json] [--load-progress prog.json]
python -m quest_chain.cli export <工程> [-o runtime.json] # 导出运行时数据
python -m quest_chain.cli import-check <数据文件>          # 导入 + 缺失引用检查
python -m quest_chain.cli impact <工程> <任务id>           # 影响面
python -m quest_chain.cli diff <旧工程> <新工程>           # 版本对比
python -m quest_chain.cli serve [--host 127.0.0.1] [--port 8765]
```

`--step` 可重复，格式为 `任务id:accept|complete|fail`。

---

## HTTP API

服务为无状态计算 + 内存模拟会话（单用户编辑器场景）：

| 方法/路径 | 说明 |
| --- | --- |
| `GET /api/health` | 健康检查 |
| `GET /api/samples` / `GET /api/samples/{name}` | 样例列表/内容 |
| `POST /api/validate` | body=工程对象，返回 issues |
| `POST /api/impact` | `{project, quest_id}` |
| `POST /api/diff` | `{before, after}` |
| `POST /api/export` | body=工程对象，返回运行时数据 |
| `POST /api/import` | body=任意任务 JSON，返回 `{project, problems}` |
| `POST /api/sim/create` | 创建模拟会话，返回 `session_id` |
| `GET /api/sim/{sid}` | 当前完整模拟状态 |
| `POST /api/sim/{sid}/step` | `{action, quest_id}`，返回差分+新状态 |
| `POST /api/sim/{sid}/undo` / `reset` | 撤销一步 / 重置 |
| `GET/POST /api/sim/{sid}/progress` | 保存/载入模拟进度 |

---

## 样例说明

| 文件 | 内容 |
| --- | --- |
| `samples/quest_demo.qchain.json` | **王座之影**：15 个任务。含骑士团/盗贼公会互斥阵营分支、声望与 flag 条件、采药与古代遗物两条可选支线、英雄/暗影/隐藏遗物三个结局，诊断零错误 |
| `samples/quest_broken.qchain.json` | **故障任务图**：故意制造循环依赖、缺失前置/互斥引用、互斥死路、条件语法错误、坏引用、走不到结局的死路、孤儿任务，用于对照诊断输出 |

试玩推荐路径（演示工程）：

1. 骑士好结局：`q_intro → q_training → q_goblin_camp → q_join_knights →
   q_escort_mission → q_castle_siege → q_ending_good`（注意声望条件）；
2. 盗贼暗影结局：先做 `q_herb_gathering` 拿到 `knows_alchemy` 才能加入公会；
3. 隐藏结局：支线 `q_herb_gathering → q_hidden_cave → q_relic_hunt →
   q_ending_relic`；
4. 失败实验：对 `q_training` 执行 fail，观察整条主线被标记失效并触发卡住提示。

---

## 运行测试

```bash
python3 -m unittest discover -s tests -v
```

测试共 70+ 个用例，覆盖 DSL 解析/求值/静态检查、Tarjan 找环与全部诊断码、
模拟器状态机/互斥/奖励/卡住/进度存取、导入导出往返、HTTP API 端到端。

## 项目结构

```
quest_chain/
  conditions.py   # 条件 DSL: tokenizer / 递归下降 parser / 求值 / lint
  model.py        # Quest/Reward/Project 数据模型、工程读写、运行时导出导入
  analysis.py     # Tarjan 找环、可达性、互斥死路、影响分析、版本对比
  simulator.py    # 状态机、逐步差分、奖励结算、卡住检测、进度存取
  cli.py          # 命令行入口
  server.py       # http.server 实现的静态托管 + JSON API
web/              # index.html / style.css / app.js (原生 SVG 编辑器)
samples/          # 两个样例工程
tests/            # unittest 测试
```
