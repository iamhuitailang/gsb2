"""Rule catalogue: sources, sinks, sanitisers and fix guidance.

Everything here is data.  The analyser consumes it and is responsible for
deciding whether a sanitiser is effective for a particular sink kind.
"""

from __future__ import annotations

import ast
from dataclasses import dataclass
from enum import IntEnum
from typing import Iterable, Optional


class Severity(IntEnum):
    """Ordered severities; higher numbers are more severe."""

    INFO = 1
    LOW = 2
    MEDIUM = 3
    HIGH = 4
    CRITICAL = 5

    @classmethod
    def parse(cls, value: "str | Severity") -> "Severity":
        if isinstance(value, Severity):
            return value
        try:
            return cls[value.strip().upper()]
        except KeyError as exc:
            allowed = ", ".join(item.name.lower() for item in cls)
            raise ValueError(
                f"unknown severity {value!r}; choose one of {allowed}"
            ) from exc

    @property
    def label(self) -> str:
        return self.name.title()


@dataclass(frozen=True)
class Rule:
    rule_id: str
    title: str
    severity: Severity
    description: str
    advice: str
    sink_kind: str


@dataclass(frozen=True)
class SinkSpec:
    qualname: str
    rule: str
    sink_kind: str
    severity: Severity
    message: str
    advice: str


@dataclass(frozen=True)
class Sanitizer:
    qualname: str
    kinds: frozenset[str]
    description: str


RULES: dict[str, Rule] = {
    "TS001": Rule(
        "TS001",
        "命令执行使用不可信输入",
        Severity.CRITICAL,
        "用户可控数据进入了 shell/命令执行接口。",
        "使用列表形式调用 subprocess（shell=False），可执行文件保持常量，"
        "并对必须进入参数的用户输入做白名单校验。",
        "command",
    ),
    "TS002": Rule(
        "TS002",
        "SQL 语句由不可信输入拼接",
        Severity.HIGH,
        "用户可控数据被拼接或格式化进 SQL 语句。",
        "改用参数化查询（占位符 + 参数元组），不要把输入拼进 SQL 字符串；"
        "表名、列名等无法参数化的位置使用白名单。",
        "sql",
    ),
    "TS003": Rule(
        "TS003",
        "动态执行不可信代码",
        Severity.CRITICAL,
        "用户可控数据进入 eval/exec/compile 或动态导入。",
        "移除对输入执行动态代码的逻辑；用显式映射表（字典/白名单）选择行为，"
        "确有必要时使用 ast.literal_eval 处理受限字面量。",
        "code",
    ),
    "TS004": Rule(
        "TS004",
        "不安全的反序列化",
        Severity.CRITICAL,
        "用户可控数据被交给可执行代码或可实例化任意对象的反序列化接口。",
        "改用 JSON 等纯数据格式；如必须使用 pickle/yaml，只能处理可信来源并施加"
        "签名校验，yaml 使用 safe_load。",
        "deserialize",
    ),
    "TS005": Rule(
        "TS005",
        "文件路径由不可信输入构造",
        Severity.HIGH,
        "用户可控数据被用作文件系统路径，可能导致目录穿越或任意文件访问。",
        "只允许白名单内的文件标识；对路径 resolve 后校验其仍位于允许的根目录内，"
        "不要仅依赖字符串替换 ../。",
        "path",
    ),
    "TS006": Rule(
        "TS006",
        "动态属性/名称访问使用不可信输入",
        Severity.MEDIUM,
        "用户可控数据被用作属性名，或传入 getattr/setattr/delattr。",
        "把允许的属性/键限制在固定白名单中，拒绝来自请求的任意名称。",
        "attribute",
    ),
}

ALL_SINK_KINDS = frozenset(rule.sink_kind for rule in RULES.values())


# ---------------------------------------------------------------------------
# Sources.  A longer attribute chain rooted at a source is also a source:
# ``request.args`` covers ``request.args.get`` and ``request.args["q"]``.
# Attribute/subscript access of a source is matched with a prefix rule.
# ---------------------------------------------------------------------------

SOURCES: frozenset[str] = frozenset(
    {
        # Flask / Quart / Bottle / Sanic / generic request objects
        "request.args",
        "request.form",
        "request.values",
        "request.json",
        "request.data",
        "request.cookies",
        "request.headers",
        "request.files",
        "request.GET",
        "request.POST",
        "request.body",
        "request.query_params",
        "request.params",
        "request.get_json",
        "flask.request.args",
        "flask.request.form",
        "flask.request.values",
        "flask.request.json",
        "flask.request.data",
        "flask.request.cookies",
        "flask.request.headers",
        "flask.request.files",
        "flask.request.get_json",
        "self.request.args",
        "self.request.form",
        "self.request.GET",
        "self.request.POST",
        "self.request.body",
        "self.request.query_params",
        "self.request.get_json",
        # Django
        "django.http.HttpRequest.GET",
        "django.http.HttpRequest.POST",
        # Process input
        "sys.argv",
        "os.environ",
        "os.environ.get",
        "os.getenv",
        "input",
        "raw_input",
    }
)

# A source accessed via call syntax keeps its taint regardless of arguments.
SOURCE_CALLS: frozenset[str] = frozenset(
    {
        "input",
        "raw_input",
        "os.getenv",
        "os.environ.get",
        "request.get_json",
        "flask.request.get_json",
        "self.request.get_json",
    }
)

_SOURCES_BY_LENGTH = sorted(SOURCES, key=len, reverse=True)


def match_source(canonical: Optional[str]) -> Optional[str]:
    """Return the source prefix matching a canonical dotted name."""

    if not canonical:
        return None
    for name in _SOURCES_BY_LENGTH:
        if canonical == name or canonical.startswith(name + "."):
            return name
    return None


# ---------------------------------------------------------------------------
# Sinks
# ---------------------------------------------------------------------------

SINKS: dict[str, SinkSpec] = {}


def _add_sink(
    qualname: str,
    rule_id: str,
    sink_kind: Optional[str] = None,
    severity: Optional[Severity] = None,
    message: Optional[str] = None,
    advice: Optional[str] = None,
) -> None:
    rule = RULES[rule_id]
    SINKS[qualname] = SinkSpec(
        qualname=qualname,
        rule=rule_id,
        sink_kind=sink_kind or rule.sink_kind,
        severity=severity or rule.severity,
        message=message or rule.description,
        advice=advice or rule.advice,
    )


for _name in (
    # shell / command execution
    "os.system",
    "os.popen",
    "os.spawnl",
    "os.spawnlp",
    "os.spawnv",
    "os.spawnvp",
    "os.execv",
    "os.execvp",
    "os.execl",
    "os.execlp",
    "commands.getoutput",
    "commands.getstatusoutput",
    "subprocess.getoutput",
    "subprocess.getstatusoutput",
    "subprocess.call",
    "subprocess.run",
    "subprocess.check_call",
    "subprocess.check_output",
    "subprocess.Popen",
    "asyncio.create_subprocess_shell",
    "asyncio.create_subprocess_exec",
    "os.startfile",
    "pty.spawn",
):
    _add_sink(_name, "TS001")

for _name in (
    # SQL
    "cursor.execute",
    "cursor.executemany",
    "connection.execute",
    "conn.execute",
    "engine.execute",
    "session.execute",
    "db.execute",
    "execute",
    "executemany",
    "psycopg2.sql.SQL",
    "sqlalchemy.text",
):
    _add_sink(_name, "TS002")

for _name in (
    # dynamic code execution / import
    "eval",
    "exec",
    "compile",
    "__import__",
    "importlib.import_module",
    "importlib.reload",
    "types.FunctionType",
    "code.interact",
    "builtins.eval",
    "builtins.exec",
):
    _add_sink(_name, "TS003")

for _name in (
    # unsafe deserialization
    "pickle.loads",
    "pickle.load",
    "cPickle.loads",
    "cPickle.load",
    "dill.loads",
    "dill.load",
    "marshal.loads",
    "shelve.open",
    "yaml.load",
    "yaml.unsafe_load",
    "yaml.full_load",
    "yaml.load_all",
    "jsonpickle.decode",
    "joblib.load",
    "torch.load",
    "pandas.read_pickle",
):
    _add_sink(_name, "TS004")

# yaml.load with an explicit safe loader is not a sink.
SAFE_YAML_LOADERS = frozenset({"yaml.SafeLoader", "yaml.CSafeLoader", "yaml.BaseLoader"})

for _name in (
    # filesystem paths
    "open",
    "builtins.open",
    "io.open",
    "os.open",
    "os.remove",
    "os.unlink",
    "os.rmdir",
    "os.rename",
    "os.replace",
    "os.makedirs",
    "os.mkdir",
    "os.listdir",
    "os.scandir",
    "os.walk",
    "shutil.copy",
    "shutil.copyfile",
    "shutil.copy2",
    "shutil.move",
    "shutil.rmtree",
    "pathlib.Path",
    "pathlib.PurePath",
    "sqlite3.connect",
    "send_file",
    "send_from_directory",
    "flask.send_file",
    "flask.send_from_directory",
    "django.http.FileResponse",
):
    _add_sink(_name, "TS005")

for _name in (
    # dynamic attribute access
    "getattr",
    "setattr",
    "delattr",
    "operator.attrgetter",
    "operator.itemgetter",
):
    _add_sink(_name, "TS006")

# Short method names that are only meaningful with a receiver we could not
# resolve (``cur.execute``, ``conn.executemany``).  They map to a canonical
# sink whose argument semantics apply.
SHORT_SINKS: dict[str, str] = {
    "execute": "cursor.execute",
    "executemany": "cursor.executemany",
    "execute_sql": "cursor.execute",
}

_SINKS_BY_LENGTH = sorted(SINKS, key=len, reverse=True)


def match_sink(canonical: Optional[str]) -> Optional[SinkSpec]:
    """Resolve a canonical call name to a sink specification."""

    if not canonical:
        return None
    spec = SINKS.get(canonical)
    if spec is not None:
        return spec
    last = canonical.rsplit(".", 1)[-1]
    if "." in canonical and last in SHORT_SINKS:
        return SINKS[SHORT_SINKS[last]]
    # Suffix match lets ``my_pickle.loads`` or ``engine.execute`` be caught
    # even when the receiver's type cannot be inferred.
    for name in _SINKS_BY_LENGTH:
        if "." in name and canonical.endswith("." + name):
            return SINKS[name]
    return None


# Positional argument indexes that can carry the dangerous value.  ``None``
# means every positional/keyword argument is inspected.
SINK_TAINT_ARGS: dict[str, Optional[tuple[int, ...]]] = {
    "cursor.execute": (0,),
    "cursor.executemany": (0,),
    "connection.execute": (0,),
    "conn.execute": (0,),
    "engine.execute": (0,),
    "session.execute": (0,),
    "db.execute": (0,),
    "execute": (0,),
    "executemany": (0,),
    "psycopg2.sql.SQL": None,
    "sqlalchemy.text": (0,),
    "eval": (0,),
    "exec": (0,),
    "compile": (0,),
    "__import__": (0,),
    "importlib.import_module": (0,),
    "importlib.reload": (0,),
    "types.FunctionType": (0,),
    "code.interact": (0,),
    "builtins.eval": (0,),
    "builtins.exec": (0,),
    "pickle.loads": (0,),
    "pickle.load": (0,),
    "cPickle.loads": (0,),
    "cPickle.load": (0,),
    "dill.loads": (0,),
    "dill.load": (0,),
    "marshal.loads": (0,),
    "shelve.open": (0,),
    "yaml.load": (0,),
    "yaml.unsafe_load": (0,),
    "yaml.full_load": (0,),
    "yaml.load_all": (0,),
    "jsonpickle.decode": (0,),
    "joblib.load": (0,),
    "torch.load": (0,),
    "pandas.read_pickle": (0,),
    "open": (0,),
    "builtins.open": (0,),
    "io.open": (0,),
    "os.open": (0,),
    "os.remove": (0,),
    "os.unlink": (0,),
    "os.rmdir": (0,),
    "os.rename": (0, 1),
    "os.replace": (0, 1),
    "os.makedirs": (0,),
    "os.mkdir": (0,),
    "os.listdir": (0,),
    "os.scandir": (0,),
    "os.walk": (0,),
    "shutil.copy": (0, 1),
    "shutil.copyfile": (0, 1),
    "shutil.copy2": (0, 1),
    "shutil.move": (0, 1),
    "shutil.rmtree": (0,),
    "pathlib.Path": (0,),
    "pathlib.PurePath": (0,),
    "sqlite3.connect": (0,),
    "send_file": (0,),
    "flask.send_file": (0,),
    "send_from_directory": (1,),
    "flask.send_from_directory": (1,),
    "django.http.FileResponse": (0,),
    "getattr": (1,),
    "setattr": (1,),
    "delattr": (1,),
    "operator.attrgetter": None,
    "operator.itemgetter": None,
}

# Keyword names that can carry the payload for each sink kind.  Everything
# else (e.g. SQL ``parameters``, ``mode``, ``shell``) is ignored.
SINK_KEYWORD_NAMES: dict[str, frozenset[str]] = {
    "command": frozenset({"args", "command", "cmd"}),
    "sql": frozenset({"query", "sql", "statement", "operation"}),
    "code": frozenset({"source", "code", "expression", "string", "object"}),
    "deserialize": frozenset({"data", "stream", "file", "s", "string", "payload"}),
    "path": frozenset(
        {"file", "path", "name", "filename", "directory", "dir", "src", "dst"}
    ),
    "attribute": frozenset({"name", "attr"}),
}


def taint_args_for(sink: SinkSpec) -> Optional[tuple[int, ...]]:
    return SINK_TAINT_ARGS.get(sink.qualname)


# subprocess-family sinks that accept a list-form argv.
LIST_FORM_COMMAND_SINKS = frozenset(
    {
        "subprocess.call",
        "subprocess.run",
        "subprocess.check_call",
        "subprocess.check_output",
        "subprocess.Popen",
        "asyncio.create_subprocess_exec",
    }
)


# ---------------------------------------------------------------------------
# Sanitisers.  Each is effective only for the listed sink kinds, so a
# ``shlex.quote`` cannot make a SQL finding disappear.
# ---------------------------------------------------------------------------

SANITIZERS: dict[str, Sanitizer] = {}


def _add_sanitizer(qualname: str, kinds: Iterable[str], description: str) -> None:
    SANITIZERS[qualname] = Sanitizer(qualname, frozenset(kinds), description)


for _name in ("int", "float", "bool", "len", "hash", "uuid.UUID", "decimal.Decimal"):
    _add_sanitizer(
        _name, ALL_SINK_KINDS, "转换为非字符串值，攻击载荷无法原样保留"
    )

for _name in ("shlex.quote", "pipes.quote"):
    _add_sanitizer(
        _name, {"command"}, "按 shell 规则引用，只对 shell 命令有效"
    )

for _name in (
    "os.path.basename",
    "werkzeug.utils.secure_filename",
    "secure_filename",
):
    _add_sanitizer(
        _name, {"path"}, "去除目录部分与路径分隔符，只对文件路径有效"
    )

_add_sanitizer(
    "ast.literal_eval", {"code"}, "只解析字面量，不执行任意代码"
)

for _name in (
    "MySQLdb.escape_string",
    "psycopg2.extensions.quoted_string",
    "db.escape",
):
    _add_sanitizer(
        _name, {"sql"}, "按 SQL 规则转义，只对 SQL 有效（仍推荐参数化查询）"
    )

# Deliberately NOT sanitisers:
#   html.escape / markupsafe.escape  -> HTML context only
#   urllib.parse.quote               -> URL context only
#   os.path.realpath / abspath       -> normalises but does not constrain
# These therefore do not silence command/SQL/path findings.


def match_sanitizer(canonical: Optional[str]) -> Optional[Sanitizer]:
    if not canonical:
        return None
    sanitizer = SANITIZERS.get(canonical)
    if sanitizer is not None:
        return sanitizer
    if "." not in canonical:
        return None
    last = canonical.rsplit(".", 1)[-1]
    # ``conn.escape_string`` (MySQLdb/psycopg2 style driver helpers).
    if last == "escape_string":
        return SANITIZERS.get("MySQLdb.escape_string")
    # A receiver-typed call such as ``obj.secure_filename``.
    if last == "secure_filename":
        return SANITIZERS.get("werkzeug.utils.secure_filename")
    return None


# ---------------------------------------------------------------------------
# AST helpers
# ---------------------------------------------------------------------------

def call_qualname(node: ast.AST) -> Optional[str]:
    """Best-effort dotted name for a call expression's func."""

    parts: list[str] = []
    cur: ast.AST = node
    while isinstance(cur, ast.Attribute):
        parts.append(cur.attr)
        cur = cur.value
    if isinstance(cur, ast.Name):
        parts.append(cur.id)
        parts.reverse()
        return ".".join(parts)
    return None


def rule_by_id(rule_id: str) -> Rule:
    try:
        return RULES[rule_id]
    except KeyError as exc:
        raise KeyError(f"unknown rule {rule_id!r}") from exc
