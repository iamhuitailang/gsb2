# sqlguard — 离线 Python SQL 注入静态审查工具

sqlguard 帮助维护者发现 Python 代码中可能由外部输入造成的 SQL 注入，
并给出从输入来源到数据库执行位置的传播路径，便于定位风险是如何
一路传到查询语句的。

特点：

- **完全离线**：纯 AST 静态分析，只读扫描目标文件，不执行被扫描项目的
  代码，不连接数据库、网站或任何外部服务，无第三方依赖（仅标准库）。
- **污点跟踪**：跟踪外部输入经过变量赋值、字符串拼接、格式化、函数参数
  和返回值后到达查询语句的完整链路。
- **区分安全写法**：把数据作为查询参数传入（参数化查询）不会报告；
  把数据拼进查询文本才会报告。
- **证据不足标为不确定**：污点经过无法分析的调用或不确定分支时，
  报为"不确定"而不是确认漏洞。

## 安装

需要 Python 3.9+，无第三方依赖。

```bash
# 方式一：直接运行（仓库根目录下）
python -m sqlguard --help

# 方式二：安装为命令行工具
pip install .
sqlguard --help
```

## 使用

```bash
# 检查单个文件
python -m sqlguard path/to/file.py

# 递归检查整个项目目录
python -m sqlguard path/to/project

# JSON 格式报告
python -m sqlguard --format json path/to/project

# 额外忽略某些目录/文件（.git、.venv 等默认已忽略）
python -m sqlguard --exclude 'migrations*' --exclude 'scripts' path/to/project

# 按发现编号忽略已知问题（可附带原因）
python -m sqlguard --ignore SQLI001-5c848e1f44=历史代码 path/to/project

# 使用忽略清单文件（每行：发现编号 忽略原因，# 开头为注释）
python -m sqlguard --ignore-file ignores.txt path/to/project

# 报告写入文件
python -m sqlguard -o report.txt path/to/project
```

退出码：有未忽略的发现时为 `1`，否则为 `0`，便于接入 CI。

默认忽略的目录：`.git`、`.hg`、`.svn`、`__pycache__`、`.venv`、`venv`、
`env`、`node_modules`、`.tox`、各类缓存与构建目录等；`--exclude` 可追加
自定义的 glob 模式。

## 报告说明

每条发现包含：

- **发现编号**：如 `SQLI001-5c848e1f44`，由规则、文件、行号和代码片段
  生成，同一处问题多次扫描编号不变，可用于 `--ignore`。
- **规则编号与风险级别**：见下表。
- **文件和行号、代码片段**：发现所在位置。
- **传播路径**：从外部输入来源到数据库执行位置的逐步依据
  （来源 → 赋值/拼接/格式化 → 函数间传递 → 执行点）。

| 规则 | 级别 | 置信度 | 含义 |
| --- | --- | --- | --- |
| SQLI001 | 高危 | 确认 | 外部输入被拼接进 SQL 查询文本 |
| SQLI002 | 高危 | 确认 | 查询结构（表名/列名等）混入外部输入，参数占位符无法保护标识符 |
| SQLI003 | 中危 | 不确定 | 污点经过无法分析的代码，证据不足，需人工核查 |

JSON 报告结构：

```json
{
  "summary": {"files_scanned": 6, "findings": 4, "ignored": 0, "errors": 1},
  "findings": [{"id": "...", "rule": "SQLI001", "severity": "high",
                "confidence": "confirmed", "file": "...", "line": 11,
                "snippet": "...", "message": "...",
                "path": [{"text": "...", "file": "...", "line": 7}]}],
  "ignored":  [{"...": "...", "ignore_reason": "历史代码"}],
  "errors":   [{"file": "...", "error": "无法解析: ..."}]
}
```

- `findings`：未忽略的发现，按（文件、行号、规则）排序，顺序稳定。
- `ignored`：被忽略的发现及其忽略原因。
- `errors`：无法解析或读取的文件。**解析失败的文件不会被当作安全跳过**，
  会在这里明确列出，需要人工关注。

## 忽略已有问题

在报告中复制发现编号，通过 `--ignore 编号=原因` 或忽略清单文件忽略。
被忽略的发现会移入报告的 `ignored` 部分并保留原因；**新出现的问题
编号不同，不受影响，仍会正常显示**。也可以按规则号（如 `SQLI003`）
整体忽略某类发现。

## 分析能力

**识别的污染源**：命令行参数 `sys.argv`、环境变量 `os.environ` /
`os.getenv()`、标准输入 `input()` / `sys.stdin`、常见 Web 请求参数
（`request.args` / `request.form` / `request.GET` / `request.POST` /
`request.json` 等，覆盖 Flask / Django 风格写法）。

**识别的汇聚点**：`execute` / `executemany` / `executescript` / `raw`
方法调用，覆盖 sqlite3、DB-API（psycopg2、pymysql、MySQLdb）、
SQLAlchemy `session.execute` 等常见数据库接口。

**污点传播**：变量赋值、字符串拼接（`+`）、f-string、`str.format`、
`%` 格式化、常见字符串方法、容器（列表/字典等）、函数参数与返回值
（跨函数、跨文件）、`global` 声明的全局变量。`int()` / `float()` 等
类型转换视为净化。局部变量遮蔽、重新赋值为常量会正确清除污点。

## 已知分析边界

静态分析无法做到完全精确，以下情况存在近似或遗漏：

- 不执行目标代码：`eval`、`exec`、`getattr` 动态取值、动态导入等
  无法分析。
- 未知外部函数（非项目内定义）保守地传播污点并标为"不确定"（SQLI003）。
- 跨文件函数按短名匹配，同名函数可能误配。
- 类实例属性（`self.x`）的跨方法传递不跟踪；闭包 / `nonlocal` 近似处理。
- 循环按最多两轮迭代近似；分支、异常路径做保守合并（部分路径污染时
  标为不确定）。
- 只检查执行方法的第一个位置参数（查询文本）；ORM 的高层 API
  （如 Django ORM 的 `filter`）不在覆盖范围。
- 查询中占位符的识别基于 `?`、`%s`、`:name`、`$1` 等常见形式的启发式
  匹配。

## 本地样例与测试

`examples/` 目录包含各类样例：可疑拼接、参数化查询（安全）、跨函数
传递、变量遮蔽、动态查询结构、Web 请求参数、无法解析的文件。

```bash
# 对样例运行（预期报告 4 条发现 + 1 个解析失败文件）
python -m sqlguard examples

# 运行自动化测试
python -m unittest discover -s tests -v
```

## 项目结构

```
sqlguard/
  cli.py       命令行入口
  scanner.py   文件收集与扫描调度（只读）
  analyzer.py  AST 污点分析核心
  patterns.py  污染源/汇聚点/净化模式定义
  rules.py     规则定义
  report.py    文本 / JSON 报告
  model.py     数据模型
examples/      本地样例
tests/         自动化测试
```
