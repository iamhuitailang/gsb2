"""Discovery, deterministic ordering and report shape."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from conftest import REPO_ROOT, find, scan


RISKY = '''
import os

def handler(request):
    os.system("echo " + request.args["x"])
'''


def test_default_excludes_skip_venv_git_and_cache(write_project):
    root = write_project(
        {
            "app.py": RISKY,
            ".git/hooks/hook.py": RISKY,
            ".venv/lib/site.py": RISKY,
            "venv/lib/site.py": RISKY,
            "__pycache__/cached.py": RISKY,
            "node_modules/pkg/index.py": RISKY,
            ".mypy_cache/x.py": RISKY,
            "src/ok.py": "x = 1\n",
        }
    )
    result = scan(root)
    assert [finding.file for finding in result.findings] == ["app.py"]


def test_extra_exclude_accepts_paths_and_globs(write_project):
    root = write_project(
        {
            "keep.py": RISKY,
            "generated/skip.py": RISKY,
            "tests/fixture_skip.py": RISKY,
            "nested/deep/also.py": RISKY,
        }
    )
    result = scan(root, excludes=["generated", "tests/*", "nested/deep"])
    assert [finding.file for finding in result.findings] == ["keep.py"]


def test_results_are_sorted_and_stable(write_project):
    files = {
        "b.py": "\nimport os\n\ndef h(request):\n    os.system(request.args['b'])\n",
        "a.py": "\nimport os\n\ndef h(request):\n    os.system(request.args['a'])\n",
        "c.py": "\nimport os\n\ndef h(request):\n    os.system(request.args['c'])\n",
    }
    root = write_project(files)
    first = scan(root)
    second = scan(root)
    keys_first = [(f.file, f.line, f.column, f.rule_id) for f in first.findings]
    keys_second = [(f.file, f.line, f.column, f.rule_id) for f in second.findings]
    assert keys_first == sorted(keys_first)
    assert keys_first == keys_second
    assert [f.file for f in first.findings] == ["a.py", "b.py", "c.py"]


def test_single_file_scan(write_project):
    root = write_project({"only.py": RISKY, "other.py": RISKY})
    result = scan(root / "only.py")
    # Files are keyed by basename when a single file is scanned.
    assert len(result.findings) == 1


def test_report_json_shape(write_project):
    root = write_project({"app.py": RISKY})
    result = scan(root)
    payload = result.to_dict()
    assert payload["schema"] == "taintscan/report/1"
    assert payload["summary"]["findings"] == 1
    finding = payload["findings"][0]
    for field in (
        "rule_id",
        "severity",
        "file",
        "line",
        "sink",
        "source",
        "flow",
        "advice",
    ):
        assert field in finding
    json.dumps(payload)  # must be serialisable


def test_examples_directory_offline_scan():
    """The shipped examples run without network or third-party packages."""

    result = scan(REPO_ROOT / "examples")
    rules = {finding.rule_id for finding in result.findings}
    assert {"TS001", "TS002", "TS003", "TS004", "TS005"} <= rules
    assert result.files_failed == 0


def test_cli_json_and_exit_codes(write_project, tmp_path):
    root = write_project({"app.py": RISKY})
    report = tmp_path / "report.json"
    completed = subprocess.run(
        [
            sys.executable,
            "-m",
            "taintscan",
            str(root),
            "--json",
            str(report),
            "--fail-on",
            "high",
        ],
        cwd=str(REPO_ROOT),
        capture_output=True,
        text=True,
    )
    assert completed.returncode == 1, completed.stderr
    payload = json.loads(report.read_text(encoding="utf-8"))
    assert payload["summary"]["findings"] == 1
    assert "TS001" in completed.stdout


def test_cli_safe_code_exits_zero(write_project, tmp_path):
    root = write_project({"app.py": "x = 1\n"})
    completed = subprocess.run(
        [sys.executable, "-m", "taintscan", str(root), "--fail-on", "low"],
        cwd=str(REPO_ROOT),
        capture_output=True,
        text=True,
    )
    assert completed.returncode == 0, completed.stderr


def test_cli_baseline_workflow(write_project, tmp_path):
    root = write_project({"app.py": RISKY})
    baseline = tmp_path / "baseline.json"
    save = subprocess.run(
        [
            sys.executable,
            "-m",
            "taintscan",
            str(root),
            "--save-baseline",
            str(baseline),
        ],
        cwd=str(REPO_ROOT),
        capture_output=True,
        text=True,
    )
    assert save.returncode == 0, save.stderr
    assert baseline.exists()

    again = subprocess.run(
        [
            sys.executable,
            "-m",
            "taintscan",
            str(root),
            "--baseline",
            str(baseline),
            "--json",
            "-",
        ],
        cwd=str(REPO_ROOT),
        capture_output=True,
        text=True,
    )
    assert again.returncode == 0, again.stderr
    # With --json -, stdout is pure JSON and the human report goes to stderr.
    payload = json.loads(again.stdout)
    assert payload["baseline"]["new"] == 0
    assert payload["baseline"]["existing"] == 1
    assert "EXISTING" in again.stderr


def test_cli_corrupt_baseline_fails_with_reason(write_project, tmp_path):
    root = write_project({"app.py": RISKY})
    baseline = tmp_path / "bad.json"
    baseline.write_text("{oops", encoding="utf-8")
    completed = subprocess.run(
        [
            sys.executable,
            "-m",
            "taintscan",
            str(root),
            "--baseline",
            str(baseline),
        ],
        cwd=str(REPO_ROOT),
        capture_output=True,
        text=True,
    )
    assert completed.returncode == 2
    assert "not valid JSON" in completed.stderr
