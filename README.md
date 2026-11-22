# 存档迁移检查器（save_migrator）

给策划用的本地存档迁移检查工具：把旧版存档依次升级到当前版本，**在迁移前**显示
每一处改动（原值 / 新值 / 规则 / 来源），**在迁移后**重新读入并校验收关键进度，
校验不通过就不产生任何存档文件。原存档全程只读。

- 只依赖 Python 3 标准库，无需安装第三方包。
- 自带四份虚构样例、一套可编辑的规则文件、一套端到端测试。

> 所有游戏、版本、物品和支线均为虚构，仅用于演示迁移流程。

---

## 1. 快速开始

在仓库根目录执行：

```bash
# 1) 看旧档里有什么（只读）
python3 -m save_migrator inspect samples/save_v1_cross.json

# 2) 预览跨两版迁移的每一处改动（不写文件）
python3 -m save_migrator preview samples/save_v1_cross.json

# 3) 确认无误后写出 v3 存档
python3 -m save_migrator migrate samples/save_v1_cross.json -o out/save_v3.json

# 4) 把写出的存档重新读入并检查关键进度
python3 -m save_migrator check out/save_v3.json

# 5) 跑全部测试
python3 -m unittest discover -s tests -v
#    或者：sh run_tests.sh
```

退出码：

| 码 | 含义 |
| --- | --- |
| 0 | 成功（预览/检查通过，或已写出存档） |
| 2 | 用法或规则文件错误 |
| 3 | 校验被阻断：**没有写出任何存档** |
| 4 | 目标文件已存在且内容不同，默认拒绝覆盖 |
| 5 | 无法识别的存档版本 |

---

## 2. 三个版本的格式差异

格式靠顶层 `format` 字段识别。字段结构如下：

| | v1「初版」 | v2「港口更新」 | v3「潮汐更新」 |
| --- | --- | --- | --- |
| 版本标识 | `"format": 1` | `"format": 2` | `"format": 3` |
| 背包 | `inventory.items[]`，条目用 `item` | `inventory.slots[]`，条目用 `id` | 同 v2 |
| 地图 | `location.map`，短名 | `location.region`，短名 | `location.region`，长名 + `checkpoint` |
| 坐标 | 原始坐标 | 缩放/平移后的坐标 | 再缩放/平移一次 |
| 支线 | 平铺数组，用 `done` 标记完成 | `quests.active[]` / `quests.completed[]`，每条有 `stage` | 同 v2，但 `stage` 拆成 `chapter` + `step`，并写显式 `status` |
| 迁移记录 | 无 | 无 | `migration`（工具写入，记录来源、规则 digest、历史和警告） |

升级路径固定为 `1 -> 2 -> 3`，不会跳版：

- **1 -> 2**：物品编号 `101/102/104/105/106/107/108` 映射为 `2101/2102/2104/2105/2106/2107/2108`
  （`103 破损护符` 已下线，按规则移除）；地图短名映射；坐标按
  `(x, y) * 1.05 + (6, 4)` 调整；`done` 拆成 active/completed 两个分组。
- **2 -> 3**：物品编号 `2101/2102/2104/2105/2107/2108` 映射为 `3101/3102/3104/3105/3107/3108`
  （`2106 船票` 按规则移除）；地图短名映射为长名；坐标按 `(x, y) * 0.98 + (2.5, -3.5)`
  调整；`stage` 按规则拆成章节/步骤；补 `checkpoint`。

无法识别的 `format`（缺失、字符串、布尔、超出 1..3）会直接报告
「无法识别存档版本」并退出，不做任何猜测迁移。

---

## 3. 三条必须满足的硬性规则

### 3.1 找不到映射时，指出具体内容并保留来源

缺映射会变成**阻断问题**，报告里给出：

- 具体物品/区域/进度：编号、名称、数量；
- 源档路径（如 `$.inventory.slots[2].id`）；
- 对应规则位置（如 `removed_items[2->3]`）。

被规则明确移除的物品记为**警告**而不是错误：显示编号、名称、数量和来源路径，
输出里仍保留该条移除记录（见 `migration.warnings`），方便日后核对丢失内容。

### 3.2 校验不通过就不产生输出

只有下面五项全部通过，才会写出文件：

1. **源档关键字段**：玩家等级/经验范围、坐标类型、格子数量与堆叠上限；
2. **规则适用**：物品/区域/进度都能映射，或明确移除；
3. **目标结构与范围**：版本号、区域检查点、坐标在世界范围内、物品编号存在于
   v3 物品表、无重复物品、支线章节/步骤为正整数；
4. **序列化后重新读入**：把准备写出的字节重新解析并再校验一次；
5. **关键进度不变量**：玩家名/等级/经验不变；背包格数 = 源档格数 − 规则移除格数；
   总数量 = 源档总量 − 规则移除量；支线 id 集合、状态分组不变；章节/步骤与拆分规则一致。

任何一项失败，命令以退出码 3 结束，`-o` 指定的路径**不会出现文件**。

### 3.3 重跑不破坏已有结果

- 目标文件不存在：临时文件 + `os.replace` 原子写出；
- 目标文件已存在且与本次结果**逐字节相同**：不重复写入，报告 `mode=reused`；
- 目标文件已存在但内容不同：默认拒绝（退出码 4），加 `--force` 才覆盖；
- 输出路径与源档相同：直接拒绝；
- 每次写出后都会重新读入并校验，并比对源档 SHA-256，确认源档没被改动。

---

## 4. 规则文件

默认规则：`rules/default_rules.json`，可用 `--rules` 指向其他文件。

| 字段 | 作用 |
| --- | --- |
| `items["1->2"]` / `items["2->3"]` | 物品编号映射（旧编号 → 新编号） |
| `removed_items` | 明确移除的物品及原因；与 `items` 不能重复定义 |
| `item_catalog` | 各版本编号到名称的对照，用于报告可读性和输出校验 |
| `regions` | 地图区域映射；中间目标必须能被下一步继续映射 |
| `map_transforms` | 坐标缩放/平移，`(x, y) * scale + (offset_x, offset_y)` |
| `quest_stage_split` | `stage` → `{chapter, step}`；不允许章节/步骤重复 |
| `checkpoints` | 最终区域 → 出生检查点 |
| `inventory_capacity` / `max_stack` | 背包容量与单格上限 |
| `world_bounds` / `player_limits` | 坐标与玩家属性范围 |
| `quest_labels` | 支线 id 到名称，仅用于报告 |

规则加载时会逐项校验；写错类型、漏字段、映射断链、移除原因为空等都会在迁移前
明确报错（退出码 2），不会带着坏规则跑一半。

### 调整规则后用同一份原档对照

```bash
python3 -m save_migrator preview samples/save_v1_cross.json \
    --json-report out/report_before.json

# 修改 rules/default_rules.json（例如把 map_transforms["1->2"].offset_x 改成 20）

python3 -m save_migrator preview samples/save_v1_cross.json \
    --rules rules/default_rules.json --json-report out/report_after.json
python3 -m save_migrator compare out/report_before.json out/report_after.json
```

`compare` 会：

- 确认两份报告是否来自同一份原档（比较 SHA-256）以及规则 digest；
- 按 `(步骤, 改动类型, 路径)` 对齐，逐项显示两侧的 原值 → 新值 与规则；
- 标记「结果变化 / 结果不变仅规则来源变化 / 一致」；
- 列出新增/消失的警告和阻断问题；
- 对比玩家、位置、背包、支线四组关键进度。

JSON 报告本身可以存档、diff，或交给其他脚本消费。

---

## 5. 样例与核对方法

主要样例三份（A / B / C）对应题目要求；另附一份当前版本样例用于验证 `check`。

### 样例 A：跨两版迁移（`samples/save_v1_cross.json`）

v1 存档，主角林雾，站在 `harbor_town (120, -45)`，背包 5 格，支线 4 条。

```bash
python3 -m save_migrator preview samples/save_v1_cross.json
python3 -m save_migrator migrate samples/save_v1_cross.json -o out/cross_v3.json
python3 -m save_migrator check out/cross_v3.json
```

预览里应能核对到：

- 物品：`101→2101→3101`、`102→2102→3102`、`104→2104→3104`、
  `105→2105→3105`、`107→2107→3107`；
- 坐标：x 先 `120*1.05+6 = 132`，再 `132*0.98+2.5 = 131.86`；
  y 先 `-45*1.05+4 = -43.25`，再 `-43.25*0.98-3.5 = -45.885`；
- 区域：`harbor_town → harbor → harbor_town`，最终检查点 `pier_gate`；
- 支线：`q_harbor_letters` 从 `done=true` 进入 completed，`stage 2` 拆成
  `chapter 1 / step 2`；`q_lighthouse_keeper` 保持 active，`stage 1` 拆成 `1/1`。

用 `check` 复核时，应看到背包 5 格、总量 27，支线进行中 2 条、已完成 2 条。

### 样例 B：编号已移除（`samples/save_v2_removed_item.json`）

v2 存档，背包第 3 格是 `2106 船票 ×1`，该编号在 2->3 规则中被移除。

```bash
python3 -m save_migrator preview samples/save_v2_removed_item.json
```

预期：

- 顶部「警告」出现 `item-removed`，写明 `2106（船票）`、数量 `1`、
  原因「船票系统并入新的交通界面……」；
- 来源路径 `$.inventory.slots[2].id`；
- 结果仍为「可迁移」，其余 3 格正常映射；
- 写出后 `check out/removed_v3.json` 显示背包 3 格、总量 54；
- 输出 JSON 的 `migration.warnings` 里有同样一条记录。

### 样例 C：字段坏掉（`samples/save_v2_broken_field.json`）

v2 存档，`player.level = 750`（超出 1..60），且第 2 格 `qty = "三"`（不是正整数）。

```bash
python3 -m save_migrator preview samples/save_v2_broken_field.json
python3 -m save_migrator migrate samples/save_v2_broken_field.json -o out/should_not_exist.json
echo $?    # 3
ls out/should_not_exist.json   # 不存在
```

预期：

- 「阻断问题」至少列出两条源档问题：`player-level-out-of-range`
  （路径 `$.player.level`，原值 750）和 `item-qty-invalid`
  （路径 `$.inventory.slots[1].qty`，原值 “三”）；
- 因为迁移结果里这两个值仍然不合法，「迁移后结构与范围」还会各报一条
  （`output-player-level` / `output-qty-invalid`），属于同一问题的下游表现；
- 所有校验项中「源档关键字段」标为未通过；
- 不写出任何文件，退出码 3；
- 修复这两个字段后，对**同一份原档**重跑即可正常迁移。

### 附：当前版本样例（`samples/save_v3_current.json`）

一份合法的 v3 存档，用来验证 `check` 本身和“已是最新版本”分支：

```bash
python3 -m save_migrator check  samples/save_v3_current.json   # 退出码 0
python3 -m save_migrator migrate samples/save_v3_current.json -o out/again.json
# 结果为「已是最新版本」，不会生成 out/again.json
```

---

## 6. 输出存档结构（v3）

```jsonc
{
  "format": 3,
  "meta":       { "save_id": "...", "created_at": "...", "playtime_seconds": 0 },
  "player":     { "name": "...", "level": 12, "xp": 3400 },
  "location":   { "region": "harbor_town", "x": 131.86, "y": -45.885, "checkpoint": "pier_gate" },
  "inventory":  { "slots": [ { "id": 3101, "qty": 1 } ] },
  "quests":     {
    "active":    [ { "id": "...", "chapter": 1, "step": 1, "status": "active" } ],
    "completed": [ { "id": "...", "chapter": 1, "step": 2, "status": "complete" } ]
  },
  "migration":  {
    "tool": "save-migrator/1",
    "source_format": 1,
    "source_sha256": "...",
    "rules_digest": "...",
    "steps": ["1->2", "2->3"],
    "history":  [ { "step": "...", "kind": "...", "path": "...", "old": 0, "new": 0, "rule": "...", "source_pointer": "..." } ],
    "warnings": [ { "code": "item-removed", "message": "...", "source_pointer": "..." } ]
  }
}
```

`migration` 只是记录，不参与游戏读档；`check` 会把它连同 `format` 一起验证。

---

## 7. 代码结构

```
save_migrator/
  __main__.py   python3 -m save_migrator 入口
  cli.py        子命令、退出码、compare
  formats.py    读取、版本识别、结构检查
  rules.py      规则加载与逐项校验
  migrate.py    迁移计划、五项校验、原子写出、不变量
  checks.py     源档/输出关键字段检查、进度快照
  report.py     报告数据结构与文本渲染
  errors.py     错误类型
rules/default_rules.json   映射与校验规则
samples/                   四份虚构样例（v1 跨版、v2 移除、v2 坏字段、v3 当前）
tests/test_migrator.py     端到端测试
```

常用 API：

```python
from save_migrator import preview_save, migrate_file, check_save

report = preview_save("samples/save_v1_cross.json")   # Report, 不写文件
print(report.render_text())
report = migrate_file("samples/save_v1_cross.json", "out/save_v3.json")
report = check_save("out/save_v3.json")
```

`Report.to_dict()` 输出与 `--json-report` 完全一致，便于二次处理。
