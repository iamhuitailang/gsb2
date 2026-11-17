# sqlaudit —— 本地 Python 项目 SQL 注入静态审查工具

`sqlaudit` 对一个 Python 项目目录做**只读**的静态分析，识别用户可控输入
最终流入数据库查询执行位置的 SQL 注入风险。它：

- **只解析源码（AST），从不执行被扫描项目的任何代码**，不需要数据库、
  外部账号或网络服务；
- 除 Python 标准库外**无第三方运行时依赖**；
- 同时提供适合人阅读的文本报告和可供其他工具读取的 JSON 报告。

## 安装

需要 Python 3.9+。两种方式任选：

```bash
# 方式一：可编辑安装（推荐，安装后得到 sqlaudit 命令）
python3 -m venv .venv
.venv/bin/pip install -e .

# 方式二：不安装，直接在仓库根目录用模块方式运行
python3 -m sqlaudit <项目目录>
```

## 使用

```bash
# 文本报告（默认）
python3 -m sqlaudit ./my_project

# 只看 MEDIUM 及以上（HIGH/MEDIUM/LOW，默认 low 即全部显示）
python3 -m sqlaudit ./my_project --min-level medium

# 结构化 JSON，写到文件供其他工具消费
python3 -m sqlaudit ./my_project --format json --output report.json

# 扫描单个文件、关闭颜色、额外跳过某些目录
python3 -m sqlaudit ./my_project/app.py --no-color --exclude migrations
```

命令行参数：

| 参数 | 说明 |
| --- | --- |
| `target` | 要检查的项目目录或单个 `.py` 文件 |
| `--min-level {low,medium,high}` | 只显示指定等级及以上的发现 |
| `--format {text,json}` | 输出格式，默认 `text` |
| `--output, -o` | 输出到文件，默认标准输出 |
| `--no-color` | 文本报告不着色 |
| `--exclude NAME` | 额外跳过的目录名/文件名，可重复 |

退出码：`0` 没有达到阈值的发现；`1` 存在达到阈值的发现；`2` 用法错误
（如路径不存在）。分析失败的文件不改变退出码，但会在报告中明确列出。

## 它是怎么判断的（与"搜索字符串拼接"的区别）

工具对每个文件 `ast.parse` 后做**过程间污点分析（taint analysis）**：

1. **源头（source）**：识别用户可控输入，例如 `request.args` /
   `request.form` / `request.json` / `request.headers` / `request.GET` 等
   Flask/Django 风格输入、内置 `input()`、`sys.argv`、`os.environ` /
   `os.getenv`，包括它们的 `.get(...)` 与下标取值。
2. **传播（propagation）**：污点会随赋值、字符串拼接、f-string、
   `%`/`.format()` 格式化、容器、返回值、函数实参/形参、实例字段
   （`self.x`）等在函数内、函数间、文件间逐跳传播。引擎用函数摘要 +
   不动点迭代把跨函数、跨文件、跨方法的完整传递链拼接出来，而不是只看
   单行写法。
3. **执行点（sink）**：识别 DB-API 的 `execute/executemany/executescript`、
   SQLAlchemy `session.execute`、Django `raw/RawSQL`、`pandas.read_sql`
   等，以及名称明显疑似数据库执行、但定义无法在项目内解析的函数
   （启发式，单独低危规则）。
4. **参数化判定**：`execute(query, params)` 这类接口中，**只有查询文本
   位置**出现污点才报告；污点仅出现在参数绑定位置（`?`、`:name`、
   `%s` 对应的实参）时视为安全，不报告。

## 风险等级

| 等级 | 规则 | 含义 |
| --- | --- | --- |
| HIGH | SQLI-001 | 不可信输入进入查询文本，且该调用没有参数化实参 |
| MEDIUM | SQLI-001 | 不可信输入被拼进查询文本，但调用同时带了参数化实参（拼接部分仍可注入） |
| LOW | SQLI-002 | 数据经名称疑似数据库执行的不可解析函数传递，需人工确认 |

像 `int(x)` 这类结果无法承载注入片段的内置转换会清除污点；
与数据库无关的字符串拼接不会产生发现。

## 报告格式

### 文本报告

每条发现包含：规则编号与等级、简短原因、**输入来源**（文件:行号 +
代码）、**危险调用**（文件:行号 + 代码）、**传递路径**（逐跳列出经过的
函数、文件、行号与调用代码）。同一源头到同一危险位置只报一次（多条路径
时保留最短路径），报告顺序按文件/行号等稳定排序。无法解析的语法错误
文件会在末尾单列，绝不静默跳过。

### JSON 报告

顶层结构：

```json
{
  "target": "/abs/path/of/project",
  "summary": {
    "scanned_files": 7,
    "findings": 9,
    "errors": 1,
    "by_severity": {"high": 7, "medium": 1, "low": 1}
  },
  "findings": [
    {
      "rule_id": "SQLI-001",
      "severity": "HIGH",
      "severity_level": 3,
      "file": "pkg/dao",
      "line": 16,
      "sink_function": "execute",
      "code": "cursor.execute(query)",
      "has_params": false,
      "reason": "不可信输入经函数传递后进入 execute() 的查询文本……",
      "origin": {
        "file": "pkg/web", "line": 15,
        "source_kind": "request.args",
        "code": "request.args.get('id')"
      },
      "flow_path": [
        {"file": "pkg/web", "line": 17,
         "function": "unsafe_endpoint -> fetch_user",
         "code": "fetch_user(...)"}
      ]
    }
  ],
  "analysis_errors": [
    {"file": "broken_syntax", "line": 4,
     "error_type": "SyntaxError", "message": "invalid syntax"}
  ],
  "scanned_files": ["app", "pkg/dao"]
}
```

文件位置统一使用相对扫描目标的模块路径（去掉 `.py`）。

## 示例与测试

仓库自带一个覆盖各类场景的示例项目：

```bash
python3 -m sqlaudit examples/vuln_project --no-color
```

它包含直接拼接/ f-string / `%` / `.format` 注入、跨函数与跨文件传递、
`self` 字段跨方法传递、部分参数化（中危）、安全参数绑定、无关字符串
拼接、不可解析的启发式调用，以及一个含语法错误的文件。

运行自动化测试（29 个，使用标准库 `unittest`，无第三方依赖）：

```bash
python3 -m unittest discover -t . -s tests -v
```

测试覆盖：直接风险、跨函数/跨文件/跨方法风险、多层包装的完整传递路径、
安全参数绑定不报、净化函数、无关拼接不报、启发式低危、语法错误显式报告、
去重与稳定排序、等级过滤、JSON schema、现代语法（海象运算符/match）与
CLI 退出码。

## 已知边界

静态分析不做指针/对象的全量建模：仅识别 `变量 = 类名(...)` 形式的本地
对象类型来解析 `obj.method()`；动态属性、`getattr`、猴子补丁等无法解析
的调用按保守策略透传污点（可能产生少量需人工确认的低危提示）。
启发式 sink 规则刻意保守，宁可提示人工确认也不漏掉明显的封装执行点。
