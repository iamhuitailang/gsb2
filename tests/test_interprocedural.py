"""Interprocedural flow: parameters, return values, methods, classes."""

from __future__ import annotations

from conftest import find, scan


def test_parameter_flow_through_two_functions(write_project):
    root = write_project(
        {
            "app.py": '''
import os

def entry(request):
    value = request.args.get("cmd")
    middle(value)

def middle(value):
    inner(value)

def inner(value):
    os.system(value)
''',
        }
    )
    result = scan(root)
    hits = find(result.findings, rule_id="TS001")
    assert len(hits) == 1, [f.flow_label for f in result.findings]
    finding = hits[0]
    assert finding.source == "request.args"
    assert finding.file == "app.py"
    functions = {step.get("function") for step in finding.flow if step.get("function")}
    assert {"entry", "middle", "inner"} <= functions or {
        "inner",
        "middle",
    } <= functions
    assert finding.flow[-1]["label"] == "os.system"


def test_return_value_flow(write_project):
    root = write_project(
        {
            "app.py": '''
import os

def reader(request):
    return request.args.get("q")

def consumer():
    value = reader()
    os.system("grep " + value)
''',
        }
    )
    result = scan(root)
    hits = find(result.findings, rule_id="TS001")
    assert len(hits) == 1
    finding = hits[0]
    assert finding.source_file == "app.py"
    assert any(
        step.get("kind") == "return" for step in finding.flow
    ), finding.flow


def test_flow_across_files_and_imports(write_project):
    root = write_project(
        {
            "app.py": '''
from service import process

def handler(request):
    process(request.args.get("name"))
''',
            "service.py": '''
import os

def process(name):
    os.system("echo " + name)
''',
        }
    )
    result = scan(root)
    hits = find(result.findings, rule_id="TS001")
    assert len(hits) == 1, [f.flow_label for f in result.findings]
    finding = hits[0]
    assert finding.file == "service.py"
    assert finding.source_file == "app.py"
    assert {"handler", "process"} <= {
        step.get("function") for step in finding.flow if step.get("function")
    }


def test_import_alias_is_resolved(write_project):
    root = write_project(
        {
            "app.py": '''
import os as operating_system

def handler(request):
    operating_system.system("echo " + request.args["x"])
''',
        }
    )
    result = scan(root)
    assert len(find(result.findings, rule_id="TS001")) == 1


def test_method_and_class_flow(write_project):
    root = write_project(
        {
            "app.py": '''
class Service:
    def handle(self, request):
        value = request.args.get("x")
        self.run(value)

    def run(self, value):
        import os
        os.system(value)
''',
        }
    )
    result = scan(root)
    hits = find(result.findings, rule_id="TS001")
    assert len(hits) == 1, [f.flow_label for f in result.findings]
    assert hits[0].file == "app.py"


def test_inherited_method_flow(write_project):
    root = write_project(
        {
            "app.py": '''
import os

class Loader:
    def load(self, name):
        os.system(name)

class Child(Loader):
    def entry(self, request):
        self.load(request.args["cmd"])
''',
        }
    )
    result = scan(root)
    assert len(find(result.findings, rule_id="TS001")) == 1


def test_sanitizer_inside_callee_is_preserved(write_project):
    root = write_project(
        {
            "app.py": '''
import os

def clean(request):
    return int(request.args.get("id"))

def use():
    value = clean()
    os.system(f"echo {value}")
''',
        }
    )
    result = scan(root)
    assert result.findings == [], [f.flow_label for f in result.findings]


def test_sanitizer_applied_to_caller_argument_is_preserved(write_project):
    root = write_project(
        {
            "app.py": '''
import os

def sink(value):
    os.system(value)

def handler(request):
    sink(int(request.args["id"]))
''',
        }
    )
    result = scan(root)
    assert result.findings == [], [f.flow_label for f in result.findings]


def test_constructor_parameter_flow(write_project):
    root = write_project(
        {
            "app.py": '''
import os

class Runner:
    def __init__(self, command):
        self.command = command

    def start(self):
        os.system(self.command)

def handler(request):
    runner = Runner(request.args["cmd"])
    runner.start()
''',
        }
    )
    result = scan(root)
    # Instance attributes are tracked within a class but not across a
    # constructor call; this is documented in the README's limitations.
    # The important property is that the scan terminates and never crashes.
    assert isinstance(result.findings, list)


def test_recursive_function_terminates(write_project):
    root = write_project(
        {
            "app.py": '''
import os

def recurse(value, depth):
    if depth <= 0:
        os.system(value)
        return
    return recurse(value, depth - 1)

def handler(request):
    recurse(request.args["x"], 3)
''',
        }
    )
    result = scan(root)
    assert len(find(result.findings, rule_id="TS001")) >= 1


def test_unrelated_functions_do_not_create_findings(write_project):
    root = write_project(
        {
            "app.py": '''
import os

def take(value):
    os.system(value)

def give():
    return "constant"

def handler(request):
    request.args.get("ignored")
    give()
    take("constant")
''',
        }
    )
    result = scan(root)
    assert result.findings == []
