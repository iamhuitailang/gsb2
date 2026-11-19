# 本机数字取证采集工具（forensics）

一个**只在本机运行、仅依赖 Python 标准库**的数字取证采集工具。它从用户指定的
案件根目录生成证据副本与清单，之后可以：

- 复核采集是否完整、副本是否与清单一致、文件有没有被篡改；
- 识别符号链接逃逸、路径变体越界、特殊文件等边界情况；
- 记录读取失败、采集中源文件变化、命中数量/字节上限等问题，
  且单个文件的问题不会抹掉其他文件的采集结果。

工具全程不联网、不连接任何真实证据库或账号。仓库内的样例与测试使用的都是
程序生成的**虚构数据**，测试只读写系统临时目录，不读取机器上的真实敏感文件。

---

## 1. 环境与运行方式

- 需要 Python 3.10+（开发与测试环境为 3.13），无第三方依赖。
- 推荐始终用隔离模式运行，避免当前目录或环境变量中的同名模块被意外加载：

```bash
python3 -I forensics_cli.py <子命令> [参数]
```

> 说明：`python3 -I` 不会把当前目录加入模块搜索路径，因此仓库提供了
> `forensics_cli.py` 启动器（它会显式把仓库根目录加入 `sys.path`）。
> 在已正确配置 `PYTHONPATH` 的环境里也可以用 `python3 -m forensics ...`。

### 命令一览

| 子命令 | 作用 |
| --- | --- |
| `create CASE_DIR SOURCE` | 创建空案件（可同时指定上限） |
| `collect CASE_DIR [SOURCE]` | 采集目录；中断后重跑同一命令即续采 |
| `info CASE_DIR` | 查看案件状态与条目明细（只含元数据/摘要，不含正文） |
| `verify CASE_DIR [--check-source] [--json]` | 复核副本与清单一致性 |

所有子命令都支持 `--json` 输出机器可读结果；人类可读输出为默认。
每次操作都会打印成功/失败结论，失败时说明是哪一步未完成。

### 退出码（便于脚本编排）

| 码 | 含义 |
| --- | --- |
| 0 | 成功；或复核无差异 |
| 1 | 复核发现差异（缺失/变化/意外新增/源端漂移） |
| 2 | 用法或流程错误（案件损坏、目录冲突、拒绝覆盖等） |
| 3 | 采集结束但案件为 `partial`（部分完成） |
| 4 | 采集 `failed`（没有任何文件成功采集） |
| 5 | 采集被中断（`in_progress`） |

### 典型用法

```bash
# 1) 创建案件，并设置文件数量与总字节上限（均可省略）
python3 -I forensics_cli.py create ./cases/case001 ./evidence_root \
    --max-files 10000 --max-bytes 1073741824

# 2) 采集（也可跳过 create，直接对不存在的案件目录执行 collect）
python3 -I forensics_cli.py collect ./cases/case001 ./evidence_root

# 3) 查看案件（-v 显示每条记录的详细说明）
python3 -I forensics_cli.py info ./cases/case001 -v

# 4) 复核：默认完全离线，只依赖案件目录自身
python3 -I forensics_cli.py verify ./cases/case001

# 5) 可选：额外只读对比源根目录当前状态（报告源端新增/变化/删除）
python3 -I forensics_cli.py verify ./cases/case001 --check-source
```

---

## 2. 案件目录结构

```
CASE_DIR/
├── case.json          # 案件元数据：ID、状态、源根目录（规范化后）、采集上限
├── MANIFEST.json      # 全量条目清单：相对路径、属性、SHA-256、状态、原因
├── MANIFEST.sha256    # MANIFEST.json 自身的 SHA-256（检测清单篡改/损坏）
├── copies/            # 证据副本，保持源目录的相对结构
│   └── <相对路径>      # 例如 copies/docs/incident_notes.txt
├── events.log         # 采集过程事件日志（追加写，带 UTC 时间戳）
└── .in_progress       # 采集中/中断标记；完整案件不会保留此文件
```

### 清单每个条目记录的内容

- `rel_path`：相对源根目录的 POSIX 风格相对路径（跨平台稳定）；
- `entry_type`：`regular` / `directory` / `symlink` / `special`；
- `size`、`mode`（八进制权限位）、`uid`、`gid`、`inode`、`nlink`、`mtime_ns`；
- `sha256`、`copy_path`：仅成功采集的普通文件有；
- `status`、`reason`、`detail`：处理状态与原因码/可读说明。

`MANIFEST.json` 采用确定性序列化（固定键序、缩进与分隔符），同一份数据
重复写入字节完全一致；配套的 `MANIFEST.sha256` 让清单自身的任何篡改或损坏
都能在复核时被发现。

---

## 3. 采集边界与路径安全

这是本工具最核心的安全约束：**采集范围永远固定在用户选定的根目录内。**

1. **根目录规范化**：采集开始时对根目录做一次 `realpath` 规范化并记录在案，
   之后所有边界判定都基于它。`./x`、`a/../b` 等路径变体不会改变实际边界。
2. **不跟随符号链接**：扫描使用 `lstat`/`scandir` 语义，符号链接目录不会被
   递归进入。打开文件时额外使用 `O_NOFOLLOW` 作为兜底。
3. **链接逃逸判定**：对每个符号链接，解析其目标（展开多层链接）后判定是否
   落在根目录之外。相对逃逸（`../../outside/x`）、绝对逃逸、链接目录逃逸、
   多级跳转逃逸都会被标记为 `out_of_bounds`，且**绝不读取目标内容**。
4. **边界内链接**：只登记链接本身及其目标字符串（状态 `recorded`），
   不复制目标内容；目标若是普通文件，会作为独立普通文件正常采集。
5. **特殊文件**：FIFO、套接字、字符/块设备识别为 `special` 并 `skipped`，
   永远不会被当作普通文件打开（避免在 FIFO 上阻塞）。
6. **路径冲突显式报告**：
   - 规范化后相对路径完全相同 → `conflict` / `duplicate_relpath`；
   - 副本落盘路径在大小写不敏感文件系统（macOS/Windows 默认）上冲突
     → `conflict` / `case_insensitive_collision`。
7. **副本写入再校验**：清单相对路径拼接副本目录时会再次做边界校验，
   即使清单被损坏，也无法借副本路径写到案件目录之外。

---

## 4. 状态与失败语义

### 4.1 条目状态（MANIFEST.json 中每个条目的 `status`）

| 状态 | 含义 |
| --- | --- |
| `collected` | 普通文件已完整采集，副本与 SHA-256 均已落盘 |
| `recorded` | 目录或边界内符号链接，仅登记属性，不复制内容 |
| `skipped` | 特殊文件，按规则不读取不复制 |
| `failed` | 读取失败、权限错误、采集中变化/删除、短读、中断未处理 |
| `conflict` | 相对路径重复或副本路径大小写冲突 |
| `out_of_bounds` | 链接/路径指向根目录之外 |
| `limit_exceeded` | 命中文件数或总字节上限，未被采集 |
| `pending` | 已规划但尚未处理（仅存在于中断的半成品案件中） |

### 4.2 失败原因码（`reason`）

`permission_denied`、`read_error`、`short_read`、`changed_during_read`、
`source_missing`、`special_file`、`symlink_escape`、`path_escape`、
`duplicate_relpath`、`case_insensitive_collision`、`unreadable_directory`、
`max_files_limit`、`max_bytes_limit`、`interrupted`。

### 4.3 案件整体状态（case.json 的 `case_status`）

| 状态 | 含义 |
| --- | --- |
| `new` | 案件已创建，尚未采集 |
| `in_progress` | 采集中或被中断（存在 `.in_progress` 标记） |
| `complete` | 全部条目处理完毕，无失败/越界/冲突/超限 |
| `partial` | 有成功采集的文件，但存在失败、越界、冲突或超限 |
| `failed` | 没有任何文件成功采集，且存在读取失败/中断条目 |

### 4.4 采集完整性规则

- **变化检测**：每个文件采集前后各做一次 `lstat` 快照，大小/mtime/inode
  任一变化即判 `changed_during_read`；读取字节数与采集前大小不符判
  `short_read`；读取过程中文件被删除同样判失败。失败文件不会留下半成品副本，
  也绝不会被记成 `collected`。
- **隔离失败**：单个文件失败只影响它自己，其他文件照常采集，问题在案件
  汇总与清单中逐项列出。
- **上限不静默**：文件数/总字节上限在读取前按确定性顺序（相对路径字典序）
  预占，超出的每个文件都显式标记 `limit_exceeded`，案件判为 `partial`，
  不会先生成一个“看起来完整”的案件。
- **原子写入**：副本与清单都通过“同目录临时文件 + fsync + 原子替换”落盘，
  每处理完一个条目就重写一次清单，因此中断时清单始终自洽。

### 4.5 中断恢复与防覆盖

- 采集被中断（含 `KeyboardInterrupt`）时，已完成条目保留，未处理条目标记
  `interrupted`，案件留在 `in_progress` 并保留 `.in_progress` 标记。
- 对同一案件重跑 `collect` 即**续采**：重新扫描源目录，逐个复核已有副本的
  大小与 SHA-256，完好则复用、损坏则重采；源文件已消失的条目保留原副本并
  加注说明。报告中的 `复用已有副本` / `重新处理` 计数说明哪些已存在、
  哪些需要重新处理。
- 已 `complete` 的案件拒绝再次采集；非空目录拒绝创建新案件；清单校验和
  损坏的案件拒绝在其上继续——避免覆盖原有证据或把半成品当完整案件。

---

## 5. 复核方法与结果含义

```bash
python3 -I forensics_cli.py verify CASE_DIR
```

复核分两层，结果按类别归类并按相对路径排序，**重复运行输出稳定**：

1. **清单完整性**：`MANIFEST.json` 能否解析、`MANIFEST.sha256` 是否匹配。
   清单缺失、JSON 损坏、校验和不匹配都会明确报告为清单损坏。
2. **逐条目核对**：
   - `missing`：清单记录已采集，但副本缺失/不是普通文件/不可读；
   - `changed`：副本仍在，但大小或 SHA-256 与清单不一致（内容被篡改或损坏）；
   - `unexpected`：`copies/` 中出现清单未登记的文件（意外新增）；
   - `entry_problems`：清单中保留的失败/越界/冲突/超限终态条目，
     提醒这些内容从未被成功采集。

加 `--check-source` 会额外**只读**对比源根目录当前状态，报告源文件的
新增、变化与删除（`source_drift`）；不加该参数时复核完全离线。

### 复核能证明什么、不能证明什么

- 本地清单与 SHA-256 校验和**能够证明副本与采集时记录的清单一致**、
  副本在采集后是否被改动、清单本身是否被篡改。
- 但它**不能单独证明证据来源的真实性与原始性**：工具无法证明采集那一刻
  源文件本身未被伪造、时间戳未被篡改，也不提供可信时间戳、数字签名或
  链式保管（chain of custody）。来源可信度需要结合采集规程、见证人、
  外部签名/时间戳服务等手段共同保证。

---

## 6. 虚构样例与自动化测试

### 生成并演示虚构样例

```bash
python3 -I samples/generate_samples.py   # 生成 samples/generated/ 虚构素材
python3 -I samples/demo.py               # 跑完整端到端演示
```

样例源树包含：虚构文档/日志/二进制文件、边界内符号链接、相对/绝对/目录
逃逸链接、FIFO 特殊文件、无读权限文件，以及根目录之外的“越界对照文件”，
用于直观验证逃逸内容不会被采集。所有内容均为程序生成的虚构文本。

### 运行自动化测试

```bash
python3 -I run_tests.py
```

51 个用例覆盖（全部使用临时目录中的虚构数据）：

- 正常采集、清单字段、确定性输出、CLI 行为与“报告不含文件正文”；
- 路径规范化、相对/绝对/多级符号链接逃逸、链接目录不进入、边界内链接；
- 重复相对路径冲突、大小写不敏感冲突、FIFO 跳过、不可读目录；
- 权限错误、读取失败、采集中源文件变化/增长/删除；
- 文件数上限、字节上限、上限为 0 的显式行为；
- 中断标记、续采复用、副本损坏重采、源消失保留、清单损坏拒绝续采；
- 复核发现副本篡改、缺失、意外新增、清单校验和篡改/缺失、源端漂移、
  结果稳定性。

---

## 7. 项目结构

```
forensics/
  __init__.py
  __main__.py      # python -m forensics 入口
  paths.py         # 根目录规范化、相对路径、边界判定
  models.py        # 状态/原因常量与数据结构
  manifest.py      # 清单原子读写、校验和、案件目录组成
  scanner.py       # 不跟随链接的目录扫描
  planner.py       # 边界/冲突/上限规划
  collector.py     # 逐文件采集、变化检测、中断恢复
  verifier.py      # 副本与清单一致性复核
  cli.py           # 命令行解析与可读/JSON 输出
forensics_cli.py   # 兼容 python -I 的启动器
samples/           # 虚构样例生成器与端到端演示
tests/             # 自动化测试（unittest，标准库）
run_tests.py       # 测试入口
```
