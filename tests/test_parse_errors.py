"""Parsing failures, warnings and scan resilience."""

from __future__ import annotations

from conftest import find, scan


def test_syntax_error_produces_warning_and_continues(write_project):
    root = write_project(
        {
            "broken.py": "def oops(:\n    pass\n",
            "good.py": '''
import os

def handler(request):
    os.system("echo " + request.args["x"])
''',
        }
    )
    result = scan(root)
    assert len(result.warnings) == 1
    warning = result.warnings[0]
    assert warning.file == "broken.py"
    assert warning.line is not None and warning.line >= 1
    assert warning.kind == "syntax-error"
    assert len(find(result.findings, rule_id="TS001")) == 1
    assert result.files_failed == 1
    assert result.files_scanned == 1


def test_undecodable_file_produces_warning(write_project, tmp_path):
    root = write_project(
        {
            "ok.py": "x = 1\n",
        }
    )
    (root / "binary.py").write_bytes(b"\xff\xfe\x00def broken(:\n")
    result = scan(root)
    assert any(warning.file == "binary.py" for warning in result.warnings)
    assert result.files_failed == 1
    assert result.files_scanned == 1


def test_one_broken_file_does_not_lose_findings_across_files(write_project):
    root = write_project(
        {
            "a.py": '''
import os

def a(request):
    os.system(request.args["a"])
''',
            "z_broken.py": "class X(:\n",
            "m.py": '''
import os

def m(request, conn):
    conn.execute("SELECT " + request.args["q"])
''',
        }
    )
    result = scan(root)
    rules = {finding.rule_id for finding in result.findings}
    assert {"TS001", "TS002"} <= rules
    assert len(result.warnings) == 1


def test_multiple_errors_are_all_reported(write_project):
    root = write_project(
        {
            "one.py": "def a(:\n",
            "two.py": "def b(:\n",
            "three.py": "print('ok')\n",
        }
    )
    result = scan(root)
    assert {warning.file for warning in result.warnings} == {"one.py", "two.py"}
    assert result.files_failed == 2


def test_nonexistent_path_raises(tmp_path):
    try:
        scan(tmp_path / "does-not-exist")
    except FileNotFoundError:
        pass
    else:  # pragma: no cover
        raise AssertionError("missing scan path should raise")


def test_empty_file_is_not_an_error(write_project):
    root = write_project({"empty.py": ""})
    result = scan(root)
    assert result.warnings == []
    assert result.findings == []
