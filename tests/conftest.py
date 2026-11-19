"""Shared helpers for the test suite."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from taintscan.analyzer import Scanner  # noqa: E402
from taintscan.models import Finding  # noqa: E402


@pytest.fixture
def write_project(tmp_path):
    """Write ``{relpath: source}`` into a temporary project and return its root."""

    def _write(files: dict[str, str], root: Path | None = None) -> Path:
        base = root or tmp_path
        for relpath, source in files.items():
            target = base / relpath
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(source, encoding="utf-8")
        return base

    return _write


def scan(root: Path, excludes=()):
    return Scanner(str(root), excludes).scan()


def find(findings: list[Finding], *, rule_id: str = "", file: str = "", sink: str = ""):
    matched = [
        finding
        for finding in findings
        if (not rule_id or finding.rule_id == rule_id)
        and (not file or finding.file == file)
        and (not sink or finding.sink == sink)
    ]
    return matched


def functions_in_flow(finding: Finding) -> list[str]:
    return [
        step.get("function")
        for step in finding.flow
        if step.get("kind") in {"call", "return", "sink"} and step.get("function")
    ]
