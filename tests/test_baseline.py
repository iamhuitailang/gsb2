"""Baseline creation, comparison and corruption handling."""

from __future__ import annotations

import json

from conftest import scan

from taintscan.baseline import Baseline, BaselineError, compare


RISKY = '''
import os

def handler(request):
    os.system("echo " + request.args["x"])
'''

SAFE = '''
def handler(request):
    request.args.get("x")
'''


def test_round_trip_and_status(write_project, tmp_path):
    root = write_project({"app.py": RISKY})
    first = scan(root)
    baseline_path = tmp_path / "baseline.json"
    Baseline.from_findings(first.findings, root=str(root)).save(baseline_path)

    second = scan(root)
    loaded = Baseline.load(baseline_path)
    comparison = compare(second.findings, loaded)
    assert comparison.new == []
    assert len(comparison.existing) == 1
    assert comparison.resolved == []


def test_new_and_resolved_are_reported(write_project, tmp_path):
    root = write_project({"app.py": RISKY})
    baseline_path = tmp_path / "baseline.json"
    Baseline.from_findings(scan(root).findings, root=str(root)).save(baseline_path)

    # Replace the risky call with a safe one and add a different risky call.
    write_project(
        {
            "app.py": '''
import os

def handler(request):
    request.args.get("x")

def other(request):
    os.system("id " + request.args["y"])
'''
        },
        root=root,
    )
    loaded = Baseline.load(baseline_path)
    comparison = compare(scan(root).findings, loaded)

    assert len(comparison.new) == 1
    assert comparison.new[0].source_line == 8
    assert len(comparison.resolved) == 1
    assert comparison.resolved[0]["rule_id"] == "TS001"


def test_fingerprint_survives_line_shift(write_project, tmp_path):
    root = write_project({"app.py": RISKY})
    baseline_path = tmp_path / "baseline.json"
    Baseline.from_findings(scan(root).findings, root=str(root)).save(baseline_path)

    shifted = "\n\n\n" + RISKY
    write_project({"app.py": shifted}, root=root)
    comparison = compare(scan(root).findings, Baseline.load(baseline_path))
    assert comparison.new == []
    assert len(comparison.existing) == 1


def test_corrupt_baseline_is_an_error(tmp_path, write_project):
    root = write_project({"app.py": SAFE})
    path = tmp_path / "baseline.json"
    path.write_text("{not json", encoding="utf-8")
    try:
        Baseline.load(path)
    except BaselineError as exc:
        assert "not valid JSON" in str(exc)
    else:  # pragma: no cover
        raise AssertionError("corrupt baseline should not load")


def test_incompatible_version_is_an_error(tmp_path):
    path = tmp_path / "baseline.json"
    path.write_text(
        json.dumps(
            {
                "schema": "taintscan/baseline/1",
                "version": 999,
                "fingerprint_algorithm": "sha256:24",
                "findings": [],
            }
        ),
        encoding="utf-8",
    )
    try:
        Baseline.load(path)
    except BaselineError as exc:
        assert "version" in str(exc)
        assert "999" in str(exc)
    else:  # pragma: no cover
        raise AssertionError("incompatible baseline should not load")


def test_wrong_schema_is_an_error(tmp_path):
    path = tmp_path / "baseline.json"
    path.write_text(
        json.dumps(
            {
                "schema": "other-format",
                "version": 1,
                "fingerprint_algorithm": "sha256:24",
                "findings": [],
            }
        ),
        encoding="utf-8",
    )
    try:
        Baseline.load(path)
    except BaselineError as exc:
        assert "schema" in str(exc)
    else:  # pragma: no cover
        raise AssertionError("wrong schema should not load")


def test_empty_baseline_file_is_an_error(tmp_path):
    path = tmp_path / "baseline.json"
    path.write_text("", encoding="utf-8")
    try:
        Baseline.load(path)
    except BaselineError as exc:
        assert "empty" in str(exc)
    else:  # pragma: no cover
        raise AssertionError("empty baseline should not load")


def test_missing_baseline_file_is_an_error(tmp_path):
    try:
        Baseline.load(tmp_path / "missing.json")
    except BaselineError as exc:
        assert "not found" in str(exc)
    else:  # pragma: no cover
        raise AssertionError("missing baseline should not load")


def test_baseline_file_is_valid_json_with_sorted_entries(write_project, tmp_path):
    root = write_project(
        {
            "a.py": RISKY,
            "b.py": '''
import os

def handler(request):
    os.system("echo " + request.args["z"])
''',
        }
    )
    baseline_path = tmp_path / "baseline.json"
    Baseline.from_findings(scan(root).findings, root=str(root)).save(baseline_path)
    payload = json.loads(baseline_path.read_text(encoding="utf-8"))
    fingerprints = [entry["fingerprint"] for entry in payload["findings"]]
    assert fingerprints == sorted(fingerprints)
    assert payload["fingerprint_algorithm"] == "sha256:24"
