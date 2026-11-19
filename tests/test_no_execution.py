"""Verify the scanner parses but never executes the analysed code."""

from __future__ import annotations

from conftest import scan


def test_scanned_code_is_never_executed(write_project, tmp_path):
    marker = tmp_path / "executed.marker"
    root = write_project(
        {
            "danger.py": f'''
from pathlib import Path

Path({str(marker)!r}).write_text("executed")
raise SystemExit(1)
''',
        }
    )
    result = scan(root)
    assert not marker.exists()
    assert result.warnings == []
