# 程序化地牢规则编辑器

一个**零依赖、本地运行**的程序化地牢生成与校验工具。设计师配置房间类型、尺寸、门口（端口）和相邻规则，
用固定种子生成可复现的网格地图，自动检查连通性与孤立门口，支持锁定部分房间后重新生成，并能保存工程、对比生成版本。

- 纯原生 HTML/CSS/JavaScript + Node.js，**无需安装任何依赖、无需构建**
- 同一套核心逻辑同时在浏览器和命令行运行（UMD 模块）
- 同一种子 + 同一规则 + 同一锁定集合 ⇒ 逐字节稳定的生成结果

---

## 一、快速开始

### 网页界面（推荐设计师使用）

```bash
# 方式一：直接用浏览器打开（部分浏览器对本地 fetch 有限制时用方式二）
open index.html

# 方式二：起一个静态服务器（Node 自带，无需安装）
npx serve .          # 或： python3 -m http.server 8000
# 然后访问 http://localhost:3000（或 8000）
```

界面三栏：

- **左栏 规则配置**：网格尺寸、房间上限、房间类型（尺寸/数量/端口）、相邻规则
- **中栏 地图**：输入种子 → 生成；SVG 地图上点击房间可锁定；下方校验问题点击即在图上高亮定位
- **右栏 版本**：把当前地图存为命名版本，勾选两个版本做指标对比

### 命令行（推荐自动化 / 批处理）

```bash
# 规则静态检查
node bin/dungeon.js check-rules --rules examples/rules/small-dungeon.json

# 用固定种子生成地图
node bin/dungeon.js generate --rules examples/rules/small-dungeon.json --seed 42 --out map.json

# 校验一张地图
node bin/dungeon.js validate --rules examples/rules/small-dungeon.json --map map.json

# 批量跑一段种子，统计成功率与失败原因
node bin/dungeon.js batch --rules examples/rules/small-dungeon.json --seeds 1..50
node bin/dungeon.js batch --rules examples/rules/small-dungeon.json --seeds 1,7,42,41 --json

# 带锁定房间重新生成（locked.json 中 locked:true 的房间不会被改动）
node bin/dungeon.js generate --rules examples/rules/small-dungeon.json --seed 99 \
  --locked locked-map.json --out regen.json
```

退出码：`0` 成功/校验通过；`2` 生成失败或校验有错误；`1` 用法或文件错误。

### 运行测试

```bash
node test/run-tests.js
```

覆盖种子复现、连接几何、连通性、规则静态检查、锁定重生成、冲突报告、工程版本对比共 26 个用例。

---

## 二、种子（Seed）说明

种子是生成器随机性的唯一输入，决定了整张地图的所有随机选择。

### 复现规则

| 输入 | 行为 |
| --- | --- |
| 整数 `42` 与字符串 `"42"` | **等价**，数字字符串会归一化为数字 |
| 任意文字 `"boss-run-01"` | 经 FNV-1a 哈希成 32 位整数后驱动 PRNG |
| 留空 | 使用种子 `default` |

底层使用 **mulberry32** 伪随机数发生器（`src/core/rng.js`）。只要规则、种子、锁定房间三者不变，
生成的房间位置、类型、尺寸、端口连接完全一致（地图中的 `generatedAt` 时间戳除外）。

### 成功与失败种子

地图生成是带约束的回溯搜索。当网格、相邻规则、端口对齐的组合过紧时，部分种子可能在回溯预算内
找不到满足所有 `min` 数量的解——这不是程序错误，而是规则本身的可行空间问题。

随仓库附带的固化清单见 [`examples/seed-manifest.json`](examples/seed-manifest.json)：

- **成功种子**（小型地牢规则）：`1`、`7`、`42`、`100`、`2026`，全部生成成功且校验零错误
- **失败种子**：`41`、`48`、`87`，生成失败并输出结构化冲突（哪些规则拦截了多少次）
- **必然失败的规则**：`over-constrained.json`，静态检查通过但任何种子运行时都失败
- **静态即非法的规则**：`invalid-rules.json`，`check-rules` 直接报 5 类错误

> 调整规则后，种子的成败分布会变化。用 `batch` 命令重新扫描即可得到新规则下的清单。

### 失败时看到的不是"生成失败"四个字

生成器会返回按拦截次数排序的**冲突条件**，每条带错误码与结构化 detail，例如：

```
[MIN_NOT_MET]        以下类型未达到最小数量：combat（需 3，有 1）
[ADJACENCY_DENIED] ×176968  相邻规则禁止 "combat" 与 "boss" 相邻
[OUT_OF_BOUNDS]     ×30813  房间 "combat"(3x3) 从端口 p17 扩展会超出网格
[OVERLAP]           ×...    房间落在某坐标与已有房间重叠
[BUDGET_EXHAUSTED]          回溯节点预算（100000）耗尽
```

高频冲突就是主要拦路条件，设计师据此放松对应规则（加相邻 allow、缩小房间尺寸、放大网格、降低 min）。

---

## 三、规则文件格式

规则是一份 JSON，完整示例见 [`examples/rules/small-dungeon.json`](examples/rules/small-dungeon.json)。

```jsonc
{
  "version": 1,
  "name": "小型地牢",
  "grid": { "width": 14, "height": 11 },   // 网格大小（格）
  "maxRooms": 12,                          // 房间数量上限
  "defaultAdjacency": "deny",              // 未显式列出的类型对默认 allow / deny
  "adjacency": [                           // 相邻规则，按顺序匹配，第一条命中生效
    { "a": "start", "b": "combat", "allow": true },
    { "a": "boss", "b": "*", "allow": false }   // "*" 是通配类型
  ],
  "roomTypes": [
    {
      "id": "combat",                      // 唯一 id，字母开头
      "name": "战斗房",
      "color": "#d96a5b",
      "sizes": [[3, 3], [4, 3], [3, 4]],   // 可选尺寸 [宽, 高]，生成时随机取一个
      "min": 3, "max": 5,                  // 该类型在地图中的数量区间
      "required": false,                   // true = 必需房间，校验时单独检查可达性
      "start": false,                      // 全规则恰好一个类型为 true（起点）
      "end": false,                        // 全规则恰好一个类型为 true（终点）
      "ports": {                           // 端口 = 门口；key 为方向 n/s/e/w
        "n": [1], "s": [1], "e": [1], "w": [1]
        // 数组值是端口在该侧的偏移槽位：
        // 北/南按 x 偏移、东/西按 y 偏移，从 0 开始，必须小于该侧边长
      }
    }
  ]
}
```

### 端口（门口）几何约定

- 端口位于房间边界**外侧的那一个网格**
- 两个房间相连时，双方各出一个端口，且这两个端口的世界格必须是同一格、方向相反
- 没有连接的端口会被校验器标记为**孤立门口**（朝向空地或网格外）
- 例：3×3 房间 `n:[1]` 表示北墙正中有一个门；4×4 的 boss 房 `n:[1,2]` 表示北墙有两个门位

### 相邻规则匹配

- 规则按数组顺序逐条匹配，`a`/`b` 无序（自动互换判断），支持 `"*"` 通配
- 第一条命中的规则决定 allow/deny；都不命中则看 `defaultAdjacency`
- 静态检查会在"相邻关系图"上从起点做 BFS，把任何无法到达的 `min>0 / required / end` 类型判为必然无解

### 静态检查项（check-rules）

| 错误码 | 含义 |
| --- | --- |
| `GRID_INVALID` / `MAX_ROOMS_INVALID` | 网格或房间上限非法 |
| `TYPE_ID_INVALID` / `TYPE_DUPLICATE_ID` | 类型 id 非法或重复 |
| `TYPE_SIZE_MISSING` / `TYPE_SIZE_INVALID` | 尺寸缺失或格式错误 |
| `PORT_OUT_OF_RANGE` / `PORT_DUPLICATE` | 端口偏移越界或重复 |
| `START_COUNT` / `END_COUNT` | 起点/终点类型不唯一 |
| `MIN_EXCEEDS_MAXROOMS` | 各类型 min 之和超过 maxRooms，必然无解 |
| `TYPE_UNREACHABLE_BY_ADJACENCY` | 某必需类型在相邻图上从起点不可达 |
| `TYPE_NO_NEIGHBOR` | 某类型不允许与任何类型相邻，无法放置 |
| `ADJACENCY_UNKNOWN_TYPE` | 相邻规则引用了不存在的类型 |
| `GRID_TOO_SMALL` | 满足 min 数量的最小面积已超过网格 |

---

## 四、地图校验项

生成后（或导入地图时）自动运行 `src/core/validator.js`，每个问题都带 `anchors`，网页端点击即在 SVG 上高亮：

- **几何**：房间越界 `ROOM_OUT_OF_BOUNDS`、房间重叠 `ROOM_OVERLAP`
- **结构**：悬空端口 `PORT_DANGLING`、非双向连接 `PORT_NOT_MUTUAL`、连接未对齐 `CONNECTION_MISALIGNED`
- **数量**：低于 min `TYPE_BELOW_MIN`、超过 max `TYPE_ABOVE_MAX`、未知类型 `UNKNOWN_TYPE`
- **连通**：终点不可达 `END_UNREACHABLE`、必需房间不可达 `REQUIRED_UNREACHABLE`、
  孤立房间 `ROOM_ISOLATED`、零门房间 `ROOM_NO_DOORS`
- **门口**：孤立门口 `ORPHAN_PORT`（警告）、对齐却没连接的疑似漏门 `ALIGNED_UNCONNECTED`（警告）
- **锁定**：重生成后锁定房间被改动 `LOCKED_ROOM_MODIFIED` / 丢失 `LOCKED_ROOM_MISSING` 等

---

## 五、锁定房间与重新生成

1. 在地图上点击一个房间 → 详情面板点"锁定该房间"（可锁定多个，地图上以黄色虚线 + 🔒 标记）
2. 点"锁定后重新生成"：锁定房间的**类型、坐标、尺寸、端口布局完全冻结**，生成器只在剩余空间回溯扩展
3. 指向非锁定房间的门口连接会先断开，由生成器在新区重新接线
4. 若锁定内容本身非法（重叠、越界、违反相邻规则、超过 max），直接返回 `LOCKED_*` 冲突，不会静默改动

校验器会比对锁定参考，任何对锁定房间的改动都会报 `LOCKED_*` 错误。

---

## 六、工程文件与版本对比

- **保存工程**：导出 `.dungeon.json`，内含规则、全部命名版本、当前版本、锁定房间 id 列表
- **打开工程**：重新加载后可继续调规则、基于旧版本再生成
- **版本对比**：勾选任意两个版本，对比房间总数、连接数、连通分量、孤立门口、校验错误数、各类型数量及回溯节点数的差值

工程文件格式头：`{ "format": "dungeon-editor", "formatVersion": 1, ... }`，打开时做格式与版本校验。

---

## 七、目录结构

```
.
├── index.html                 # 网页编辑器入口
├── bin/dungeon.js             # 命令行工具
├── src/
│   ├── core/                  # 浏览器与 Node 共用的核心（UMD）
│   │   ├── rng.js             # mulberry32 随机数 + 种子哈希
│   │   ├── rules.js           # 规则模型 + 静态检查
│   │   ├── generator.js       # 回溯生成器 + 冲突统计 + 锁定支持
│   │   ├── validator.js       # 地图校验（连通/孤立门口/几何/锁定）
│   │   └── project.js         # 工程持久化 + 版本对比
│   └── web/                   # 浏览器专属：SVG 渲染、UI 控制器、样式
├── examples/
│   ├── rules/
│   │   ├── small-dungeon.json     # 主示例：可正常生成的小型关卡规则
│   │   ├── over-constrained.json  # 静态过、运行时必败的过约束规则
│   │   └── invalid-rules.json     # 静态检查即报错的非法规则
│   └── seed-manifest.json         # 固化的成功/失败种子清单
└── test/run-tests.js
```

---

## 八、生成算法简述

1. 规则静态预检，硬错误直接返回（不进入搜索）
2. 初始化占用网格；若有锁定房间先落位并校验合法性
3. 放置起点，随后沿"空闲端口"做深度优先回溯：每个候选都通过
   类型数量、相邻规则、网格边界、不重叠、端口偏移对齐五道检查
4. 第一阶段以满足所有类型的 `min` 为目标（回溯），第二阶段贪心填充到 `maxRooms`
5. 每个被拒绝的候选都会累计冲突计数；预算耗尽仍未满足 min 时，
   返回按频次排序的冲突列表 + 回溯终止时的局部地图（partialMap，网页端会渲染出来）
