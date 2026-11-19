# taintscan

离线 Python 源码安全检查工具。它用 AST 做污点分析，追踪用户输入经过项目内的函数参数、返回值和跨文件调用后，进入命令执行、SQL、动态代码、反序列化和文件路径等危险操作的情况。

- **不执行被检查的代码**：只读取文本并调用 `ast.parse`，不 import、不运行目标项目。
- **不访问网络**：只处理本地源码和本地报告，无账号、无外部服务。
- **纯标准库**：运行时零第三方依赖；测试只额外需要 `pytest`。

---

## 快速开始

要求 Python 3.10+（用于 `match` 语句支持）。以下命令在干净环境中可直接执行（示例使用仓库自带的 `examples/` 目录）：

```bash
# 方式一：安装后使用命令行入口
pip install -e .
taintscan examples/risky

# 方式二：不安装，直接从仓库运行
python3 -m taintscan examples/risky

# 保存机器可读报告
python3 -m taintscan examples/risky --json report.json

# 只做检测并在存在高危问题时返回退出码 1
python3 -m taintscan examples/risky --fail-on high

# 第一次：保存基线；之后：只看新问题
python3 -m taintscan examples/risky --save-baseline baseline.json
python3 -m taintscan examples/risky --baseline baseline.json --only-new
```

运行测试：

```bash
pip install -e ".[test]"
python3 -m pytest
```

---

## 命令行参数

```
taintscan [PATH] [选项]

PATH                     要扫描的目录或单个 .py 文件（默认当前目录）
--exclude PATH           额外排除路径；可重复。支持相对路径、绝对路径、
                         shell 通配符（tests/*）或裸目录名（vendor）
--json FILE              把机器可读 JSON 报告写入 FILE（'-' 表示 stdout）
--baseline FILE          读取已有基线，标记 new / existing / resolved
--save-baseline FILE     把本次结果保存为基线
--only-new               配合 --baseline，仅输出新增问题
--fail-on LEVEL          存在不低于该严重程度的问题时退出码为 1
                         （critical/high/medium/low/info）
--version                显示版本
```

默认跳过：`.git/ .hg/ .svn/ __pycache__/ .mypy_cache/ .pytest_cache/ .ruff_cache/ .tox/ .nox/ .venv/ venv/ env/ site-packages/ node_modules/ build/ dist/ .idea/ .vscode/` 等常见虚拟环境、版本控制和缓存目录。扫描不跟随符号链接，并用最大 5 MiB 的单文件上限避免内存耗尽。

退出码：`0` 正常，`1` 达到 `--fail-on` 阈值，`2` 用法/基线/路径错误。

---

## 支持的风险范围

| 规则 | 风险 | 严重程度 | 典型危险调用 |
| --- | --- | --- | --- |
| `TS001` | 命令执行使用不可信输入 | CRITICAL | `os.system`、`os.popen`、`subprocess.*`、`asyncio.create_subprocess_shell` |
| `TS002` | SQL 由不可信输入拼接 | HIGH | `cursor.execute`/`executemany`、`conn.execute`、`session.execute`、`sqlalchemy.text` |
| `TS003` | 动态执行不可信代码 | CRITICAL | `eval`、`exec`、`compile`、`__import__`、`importlib.import_module` |
| `TS004` | 不安全反序列化 | CRITICAL | `pickle.loads`、`yaml.load`（非安全 Loader）、`marshal.loads`、`dill`、`torch.load` |
| `TS005` | 文件路径由不可信输入构造 | HIGH | `open`、`os.remove`/`rename`、`shutil.*`、`pathlib.Path`、`send_file` |
| `TS006` | 动态属性/名称访问 | MEDIUM | `getattr`、`setattr`、`delattr`、`operator.attrgetter` |

**识别的输入源**（可按需在 `taintscan/rules.py` 的 `SOURCES` 中扩充）：Flask/Quart/Bottle/Sanic 风格的 `request.args/form/values/json/data/cookies/headers/files/get_json`，Django 的 `django.http.HttpRequest.GET/POST`，以及 `sys.argv`、`os.environ`/`os.getenv`、`input`/`raw_input`。

### 分析能力

- **跨函数参数传递**：`handler -> middle -> inner -> os.system`，跨任意层数和跨文件、跨 import 别名。
- **返回值传递**：`def read(): return request.args[...]`，调用方拿到的返回值仍带污点。
- **类与方法**：方法调用、`self.method()`、继承的基类方法（`BaseLoader.load`）。
- **分支合并**：`if/else` 取并集；一个分支 `return`/`raise` 时，只保留存活分支的状态。
- **上下文相关的净化**：见下一节。
- **稳定结果**：按 `(file, line, column, rule_id, fingerprint)` 排序；同一份代码重复扫描结果一致；指纹不含行号，代码上下移动不会误判为新问题。

---

## 净化（sanitizer）按风险类型判断

同一种处理不会无差别地让所有问题消失：

| 处理 | 对哪些风险有效 | 对哪些无效 |
| --- | --- | --- |
| `int()` / `float()` / `bool()` / `len()` | 全部（结果不是字符串） | — |
| `shlex.quote()` / `pipes.quote()` | 仅命令执行 `TS001` | SQL、路径、反序列化 |
| `os.path.basename()` / `secure_filename()` | 仅文件路径 `TS005` | 命令、SQL |
| `ast.literal_eval()` | 仅动态代码 `TS003` | SQL、命令 |
| `yaml.load(..., Loader=yaml.SafeLoader)` | 视为安全（结构识别） | 其他 Loader 仍报告 |
| `DB.escape_string()` / `db.escape()` | 仅 SQL `TS002` | 命令、路径 |
| `html.escape()` / `urllib.parse.quote()` / `os.path.realpath()` | **不视为净化** | 不消除任何发现 |

另外：
- **参数化 SQL**：`cursor.execute(sql, (value,))` 只检查第 1 个参数（SQL 文本），参数元组不报。
- **命令列表形式**：`subprocess.run(["ls", "-l", name], shell=False)` 只要求 `argv[0]` 常量，`name` 不报；`shell=True` 时字符串拼接才报。
- **白名单检查**：`if x not in {"a","b"}: raise ...` 或 `if not child.is_relative_to(root): raise ...` 之后的 `x` 视为已净化（只在该存活分支内）。

---

## 报告字段

终端输出的每条发现包含：

```
app.py:12:5  [HIGH] TS002 SQL 语句由不可信输入拼接
  sink     : cursor.execute
  source   : request.args (app.py:9)
  flow     : request.args (app.py:9) -> build_query() -> return build_query -> handle -> !! cursor.execute
  advice   : 改用参数化查询 ...
```

`--json` 报告结构：

```jsonc
{
  "schema": "taintscan/report/1",
  "tool": "taintscan",
  "tool_version": "0.1.0",
  "root": "/abs/path/to/scan",
  "summary": {
    "files_scanned": 3,
    "files_failed": 1,
    "findings": 2,
    "warnings": 1
  },
  "findings": [
    {
      "rule_id": "TS002",
      "rule_title": "SQL 语句由不可信输入拼接",
      "severity": "HIGH",
      "severity_rank": 4,
      "message": "……",
      "advice": "改用参数化查询……",
      "file": "app.py",          // 相对扫描根的路径
      "line": 12,                // 1-based
      "column": 4,               // 0-based
      "sink": "cursor.execute",
      "source": "request.args",
      "source_file": "app.py",
      "source_line": 9,
      "flow": [
        {"kind": "source", "label": "request.args", "file": "app.py", "line": 9},
        {"kind": "call",   "label": "build_query()", "file": "app.py", "line": 9, "function": "handle"},
        {"kind": "return", "label": "build_query return", "file": "app.py", "line": 5, "function": "build_query"},
        {"kind": "sink",   "label": "cursor.execute", "file": "app.py", "line": 12, "function": "handle", "rule_id": "TS002"}
      ],
      "flow_label": "request.args (app.py:9) -> build_query() -> return build_query -> handle -> !! cursor.execute",
      "fingerprint": "…",        // 稳定标识，用于基线比较
      "status": "new"            // new | existing（无基线时恒为 new）
    }
  ],
  "warnings": [
    {
      "file": "broken.py",
      "line": 1,
      "column": 0,
      "kind": "syntax-error",    // syntax-error | decode-error | io-error | parse-error
      "message": "invalid syntax: def oops(:"
    }
  ],
  "baseline": {                  // 仅在传入 --baseline 时出现
    "new": 1,
    "existing": 2,
    "resolved": 1,
    "resolved_findings": [ {"fingerprint": "…", "rule_id": "TS001", "file": "…", "line": 7, "sink": "…"} ]
  }
}
```

### 基线与状态

- `--save-baseline FILE` 生成 `taintscan/baseline/1` 文档，按指纹排序，含版本号和指纹算法。
- 指纹由「相对路径 + 规则 + sink 名 + sink 源码片段 + 经过的函数链 + 来源签名 + 来源片段」计算，**不含行号**。
- 后续 `--baseline FILE` 会把当前发现标为 `new` / `existing`，并在报告与摘要中列出 `resolved`（基线有、本次无）。
- 基线损坏（空文件、非 JSON、schema/版本/指纹算法不兼容）会以退出码 2 失败，并在 stderr 说明具体原因，**绝不静默当成空基线**。

### 解析失败

单个文件语法错误或编码错误只产生一条带 `file:line` 的可定位 `warning`，其余文件继续扫描，已得到的发现不会丢失。`summary.files_failed` 记录失败文件数。

---

## 仓库结构

```
taintscan/
  cli.py         命令行入口
  discovery.py   文件发现与默认/自定义排除
  parse_utils.py 只读解析、PEP 263 编码、错误转 warning
  project.py     跨模块符号索引（函数/方法/类/import 别名）
  analyzer.py    污点分析：函数摘要不动点 + 最终遍历
  rules.py       源、汇、净化器与修复建议
  baseline.py    基线读写与比较（含损坏检测）
  reporter.py    终端与 JSON 报告
examples/
  risky/         每类规则的漏洞样例（含跨文件、方法、返回值）
  safe/          对应的安全写法
tests/           规则覆盖、跨函数传递、净化、基线、解析失败
```

---

## 已知局限

taintscan 是一个面向「用户输入 -> 危险操作」的启发式静态检查器，不是完备的数据流证明工具。已知局限：

1. **跨 `__init__` 的实例属性不传播**：`self.x = taint` 在类内部可追踪，但 `Runner(taint)` 后 `runner.start()` 读取 `self.x` 的跨对象流不会报告（需要更重的指针/字段分析）。
2. **动态特性不可见**：`getattr(obj, "method")()`、`globals()/locals()`、`setattr` 注入、元类、猴子补丁、`functools.wraps` 以外的装饰器改写、`__getattr__` 代理等不会精确建模；无法解析的调用按「参数受污染」保守传播。
3. **第三方库语义靠内置清单**：只有 `rules.py` 中显式列出的 API 才被视为 source/sink/sanitizer；其他库（自研 ORM、模板引擎、消息队列等）默认不识别，需要通过配置扩充。
4. **净化器是白名单式**：正确但不在名单内的净化（自研校验函数、复杂的正则白名单）不会被识别，可能产生误报。反之，如果自研函数恰好与内置净化器同名（例如自定义 `quote`）不会被误当作净化，但同名 sink 仍会命中。
5. **分支与循环是保守并集**：不建模路径条件、循环次数、异常抛出路径；复杂控制流可能产生误报，或把已校验的值当成未校验（当校验写法不在识别范围内时）。
6. **别名与反射有限**：仅解析 `import ... as ...` / `from ... import ...` 这类静态别名；`importlib` 动态导入、`exec` 生成的函数、`*` 导入的符号无法完全解析。
7. **单文件大小与类型**：超过 5 MiB 或非 Python 后缀的文件被跳过；`.pyi` 不在扫描范围。
8. **不提供修复补丁**：只给出修复建议文本与数据流路径，需要人工确认上下文。
9. **不访问网络、不执行代码**：因此无法做运行时污染验证，也不会自动安装依赖或调用真实账号/外部服务。

---

## 许可

MIT
