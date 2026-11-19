"""Rule-coverage tests: every rule finds risky code and ignores safe code."""

from __future__ import annotations

import pytest

from conftest import find, scan


RISKY = {
    "command": '''
import os

def handler(request):
    host = request.args.get("host")
    os.system("ping -c 1 " + host)
''',
    "sql": '''
def handler(request, conn):
    name = request.args.get("name")
    conn.execute("SELECT * FROM users WHERE name = '" + name + "'")
''',
    "code": '''
def handler(request):
    expression = request.args.get("expr")
    return eval(expression)
''',
    "deserialize": '''
import pickle

def handler(request):
    payload = request.cookies.get("session")
    return pickle.loads(payload)
''',
    "path": '''
import os

def handler(request):
    name = request.args.get("file")
    return open(os.path.join("/srv/data", name))
''',
    "attribute": '''
def handler(request):
    name = request.args.get("attr")
    return getattr(object(), name)
''',
}

EXPECTED_RULES = {
    "command": "TS001",
    "sql": "TS002",
    "code": "TS003",
    "deserialize": "TS004",
    "path": "TS005",
    "attribute": "TS006",
}


@pytest.mark.parametrize("category", sorted(RISKY))
def test_each_rule_finds_risky_flow(write_project, category):
    root = write_project({"app.py": RISKY[category]})
    result = scan(root)
    expected = EXPECTED_RULES[category]
    matches = find(result.findings, rule_id=expected)
    assert matches, f"expected {expected} for {category}, got {result.findings}"
    finding = matches[0]
    assert finding.source_file == "app.py"
    assert finding.source_line >= 1
    assert finding.line >= 1
    assert finding.advice
    assert finding.severity.name in {"MEDIUM", "HIGH", "CRITICAL"}
    assert finding.flow[0]["kind"] == "source"
    assert finding.flow[-1]["kind"] == "sink"


SAFE = {
    "command": '''
import subprocess

def handler(request):
    name = request.args["file"]
    subprocess.run(["ls", "-l", name], shell=False)
''',
    "sql": '''
def handler(request, conn):
    name = request.args.get("name")
    conn.execute("SELECT * FROM users WHERE name = ?", (name,))
''',
    "code": '''
from ast import literal_eval

def handler(request):
    return literal_eval(request.args.get("payload"))
''',
    "deserialize": '''
import json

def handler(request):
    return json.loads(request.data)
''',
    "path": '''
from werkzeug.utils import secure_filename

def handler(request):
    return open("/srv/data/" + secure_filename(request.args["file"]))
''',
    "attribute": '''
def handler(request):
    data = {"a": 1}
    key = request.args.get("key")
    if key not in {"a"}:
        raise KeyError(key)
    return data[key]
''',
}


@pytest.mark.parametrize("category", sorted(SAFE))
def test_safe_usage_is_not_reported(write_project, category):
    root = write_project({"safe.py": SAFE[category]})
    result = scan(root)
    assert result.findings == [], [f.flow_label for f in result.findings]


def test_sanitizer_is_context_sensitive(write_project):
    """shlex.quote silences a command finding but must not silence SQL."""

    root = write_project(
        {
            "app.py": '''
import os
import shlex

def command_safe(request):
    host = shlex.quote(request.args.get("host"))
    os.system("ping -c 1 " + host)

def sql_unsafe(request, conn):
    name = shlex.quote(request.args.get("name"))
    conn.execute(f"SELECT * FROM users WHERE name = {name}")
''',
        }
    )
    result = scan(root)
    command_hits = find(result.findings, rule_id="TS001")
    sql_hits = find(result.findings, rule_id="TS002")
    assert command_hits == [], "shlex.quote should neutralise the command sink"
    assert len(sql_hits) == 1, "shlex.quote must not neutralise SQL"
    assert any(step.get("kind") == "sanitize" for step in sql_hits[0].flow)


def test_int_cast_is_effective_for_every_sink(write_project):
    root = write_project(
        {
            "app.py": '''
import os
import subprocess

def handler(request, conn):
    value = int(request.args.get("id"))
    os.system(f"echo {value}")
    conn.execute(f"SELECT * FROM t WHERE id = {value}")
    subprocess.run(["ls", str(value)])
''',
        }
    )
    result = scan(root)
    assert result.findings == [], [f.flow_label for f in result.findings]


def test_html_escape_does_not_silence_command_or_sql(write_project):
    root = write_project(
        {
            "app.py": '''
import html
import os

def handler(request):
    value = html.escape(request.args.get("v"))
    os.system("echo " + value)
''',
        }
    )
    result = scan(root)
    assert len(find(result.findings, rule_id="TS001")) == 1


def test_allowlist_guard_makes_sink_safe(write_project):
    root = write_project(
        {
            "app.py": '''
import os

ALLOWED = {"alpha", "beta"}

def handler(request):
    host = request.args.get("host")
    if host not in ALLOWED:
        raise ValueError("nope")
    os.system("ping -c 1 " + host)
''',
        }
    )
    result = scan(root)
    assert result.findings == [], [f.flow_label for f in result.findings]


def test_yaml_safe_loader_is_not_reported(write_project):
    root = write_project(
        {
            "app.py": '''
import yaml

def handler(request):
    return yaml.load(request.data, Loader=yaml.SafeLoader)
''',
        }
    )
    result = scan(root)
    assert len(find(result.findings, rule_id="TS004")) == 0


def test_yaml_unsafe_loader_is_reported(write_project):
    root = write_project(
        {
            "app.py": '''
import yaml

def handler(request):
    return yaml.load(request.data, Loader=yaml.FullLoader)
''',
        }
    )
    result = scan(root)
    assert len(find(result.findings, rule_id="TS004")) == 1


def test_sql_parameter_tuple_is_not_a_sink_argument(write_project):
    root = write_project(
        {
            "app.py": '''
def handler(request, cursor):
    value = request.args["q"]
    cursor.execute("SELECT * FROM t WHERE a = ?", (value,))
''',
        }
    )
    result = scan(root)
    assert result.findings == []
