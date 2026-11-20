# sqli_scanner — 离线 Python SQL 注入静态检查工具

一个**完全离线、零第三方依赖**的 Python 代码安全检查工具，专注发现
“外部输入被拼进 SQL 查询”的风险。它只做 AST 静态分析，
**不会 import、执行或动态加载被扫描项目的任何代码**，也不需要访问网络。

## 能力概览

- 扫描本地 Python 项目，自动跳过虚拟环境、版本控制目录、缓存/构建目录等；
  也可以只指定一个或多个子目录，或扫描单个 `.py` 文件。
- 识别常见外部输入（Flask/Django 风格的 `request.args/form/json/cookies/headers`、
  下标取值、`input()`、环境变量等）和数据库执行调用
  （`cursor.execute / executemany / executescript`、`engine/session/connection.execute` 等）。
- 跟踪输入经过**赋值、字符串拼接（`+`）、f-string、`%` 格式化、`str.format/join`、
  下标/属性传递、同一文件内本地函数调用**之后是否进入动态 SQL。
- **参数绑定写法不误报**：查询字符串是静态的、输入只走 `?`/`:name` 占位参数或
  `params=` 等绑定关键字时不报告。
- 无法确认的复杂调用（第三方函数、跨模块导入、递归过深等）标为
  **待复核（review）**，而不是直接算成确定漏洞。
- 每条发现都给出**输入位置、查询执行位置和完整传播路径**（文件名、行号、代码片段、
  风险等级、简短原因），维护者可以顺着路径一步步查回源头。
- 每条问题有**稳定标识**，支持保存问题清单（基线），之后对比出
  **新增 / 仍存在 / 已消失**。
- 终端文本报告 + 结构化 JSON 导出；重复扫描的输出顺序保持一致。

## 目录结构

```
sqli_scanner/          扫描器包（纯标准库）
  model.py             数据模型：污点、传播路径、发现项、稳定标识
  sources.py           外部输入源 / SQL 执行点 / 内置函数识别规则
  analyzer.py          AST 污点分析引擎（过程内 + 同文件过程间）
  walker.py            文件发现与目录跳过规则
  baseline.py          问题清单的保存与对比
  report.py            文本报告与 JSON 导出
  scanner.py           扫描编排
  cli.py / __main__.py 命令行入口
examples/sample_app/   对照用示例项目（四类场景，不可运行也无需运行）
tests/                 自动化测试（unittest，零依赖）
run_tests.py           隔离模式测试入口
sqli_scan.py           免安装启动器
```

## 运行方式

需要 Python 3.9+，无需安装任何依赖。

### 方式一：免安装启动器（推荐，支持隔离模式）

```bash
python3 sqli_scan.py scan <项目目录>
python3 sqli_scan.py scan <项目目录> -s app/dao -s app/web   # 只扫子目录
python3 sqli_scan.py scan some_file.py                       # 扫描单文件
```

### 方式二：模块方式

```bash
python3 -m sqli_scanner scan <项目目录>
```

### 方式三：安装后使用控制台命令

```bash
pip install .
sqli-scanner scan <项目目录>
```

### 常用参数

| 参数 | 作用 |
| --- | --- |
| `-s, --subdir DIR` | 只扫描根目录下的该子目录，可重复指定；`.` 表示整个根目录 |
| `--extra-source a.b.c` | 追加识别的外部输入函数全名，可重复指定 |
| `--skip-dir NAME` | 在内置规则之外额外跳过的目录名，可重复指定 |
| `--assume-params-tainted` | 把函数参数整体视为不可信输入（覆盖框架参数注入，可能带来误报） |
| `--json FILE` | 同时导出结构化 JSON 结果 |
| `--fail-on-finding` | 存在确认风险时退出码为 1，便于接入 CI |

### 扫描示例项目

```bash
$ python3 sqli_scan.py scan examples/sample_app
发现总数: 7 (确认风险 4, 待复核 3)
```

- `direct_concat.py`：拼接 / f-string / `%` / `str.format` → **确认风险**
- `through_helper.py`：输入经本地函数（含跨模块导入）传递 → 确认风险 / 待复核
- `parameterized.py`：参数绑定 → **不报告**
- `unconfirmed.py`：第三方未知调用 → **待复核**

报告中的每条发现形如：

```
[确认风险] SQL-4422a47757 tainted-dynamic-sql
  输入位置: direct_concat.py:7  (request.args.get)
  执行位置: direct_concat.py:12  (cursor.execute)
  原因: 外部输入经动态拼接进入 cursor.execute() 的查询字符串，存在 SQL 注入风险
  传播路径:
    L7     source   读取外部输入 request.args.get
           > request.args.get("keyword", "")
    L9     concat   字符串拼接
           > "SELECT * FROM products WHERE name = '" + keyword + "'"
    L12    sink     污点进入 SQL 执行点 cursor.execute()
           > cursor.execute(query)
```

## 问题清单（基线）如何更新

清单按问题的**稳定标识**记录，用来区分新增问题、历史遗留和已修复问题。

```bash
# 1) 把当前发现保存为基线（默认 sqli-baseline.json，可用 -o 指定）
python3 sqli_scan.py baseline <项目目录> -o sqli-baseline.json

# 2) 之后每次扫描与基线对比，输出 新增 / 仍存在 / 已消失
python3 sqli_scan.py diff <项目目录> -b sqli-baseline.json

# 3) 确认处理完一批问题后，用当前结果刷新基线
python3 sqli_scan.py baseline <项目目录> -o sqli-baseline.json
```

对比结果在文本报告和 JSON（每条 finding 带 `status` 字段：`new` / `existing` /
`missing`）中都会体现。典型用法：把基线文件提交到版本库，CI 中跑 `diff`，
只对 `new` 的问题阻断合入。

### 稳定标识是怎么算的

标识（`SQL-xxxxxxxxxx`）是对以下内容做 SHA-1：文件相对路径、规则编号、来源类型与
名称、sink 名称，以及传播路径上每一步的**代码文本**。
**刻意不包含行号**：代码整体上下移动、行号变化时标识保持稳定；
一旦相关代码被修改，标识自然改变，于是表现为旧问题消失、新问题出现。

## 风险等级与规则

| 等级 | 规则 | 含义 |
| --- | --- | --- |
| `vulnerability` | `tainted-dynamic-sql` | 能确认外部输入经动态拼接进入了 SQL 执行点 |
| `review` | `unconfirmed-dynamic-sql` | 链路上存在无法确认的调用，需要人工复核，不直接判定为漏洞 |

注意：**即使写了参数绑定，只要查询字符串本身在执行前已被外部输入拼接，仍会报告**
（占位参数无法修复被篡改的查询结构）；报告原因会明确说明这一点。

## 分析能力边界

这是一个轻量的启发式静态工具，刻意保持零依赖和可解释性，以下情况需要知晓：

1. **过程间分析仅限同一文件内的本地函数**。跨模块/跨包导入的函数
   （如 `from .helpers import build_sql`）无法跟进去，会降级为待复核。
2. **无法确认的调用一律保守降级**。第三方库函数、动态属性、`getattr`、
   反射、元编程、装饰器注入等不会被当成确定漏洞。
3. **作用域模拟是轻量的**。支持模块/函数两层词法作用域、属性与常量下标赋值；
   动态下标、可变对象别名、容器内部字段的精细数据流不做完整建模。
4. **函数默认参数、`*args`/`**kwargs` 的精确映射有限**；递归调用超过
   8 层或检测到调用环时降级为待复核，不会无限分析。
5. **框架参数注入默认不跟踪**。类似 FastAPI 那种“视图函数参数即外部输入”的写法，
   普通扫描不会把参数当污点；可显式加 `--assume-params-tainted` 开启
   （该模式会把参数标为 unknown，命中时给待复核，可能带来误报）。
6. **源/sink 基于名字启发式识别**。内置规则覆盖常见写法；项目里自定义的输入
   封装函数可用 `--extra-source 包.模块.函数名` 注册。
7. 工具只读取 `.py` 文件做语法解析；包含语法错误的文件会跳过并给出警告，
   不会中断整体扫描。

## 运行测试

测试基于标准库 `unittest`，无第三方依赖。推荐用隔离模式运行，避免当前目录下
同名模块（如 planted `json.py`）干扰导入：

```bash
python3 -I run_tests.py            # 全部测试
python3 -I run_tests.py -v         # 详细输出
python3 -I run_tests.py tests.test_analyzer   # 单个测试模块
```

普通模式下也可以直接：

```bash
python3 -m unittest discover -s tests
```

## 设计约束

- 仅使用 Python 标准库（`ast`、`hashlib`、`json`、`argparse`、`pathlib/os` 等）。
- 不访问网络、不安装第三方服务、不执行被扫描代码。
- 所有输出在重复扫描间保持确定的排序与格式。
