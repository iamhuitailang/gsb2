#!/usr/bin/env python3
"""Developer convenience: run the backend test suite.

Usage:
    python3 scripts/verify.py            # full suite
    python3 scripts/verify.py -k demo    # pass pytest args

Kept separate from ``backend`` so the app package is importable exactly the
way ``python3 -m app`` imports it.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1] / "backend"


def main() -> int:
    if not (BACKEND / "app").is_dir():
        print(f"backend not found at {BACKEND}", file=sys.stderr)
        return 2
    command = [sys.executable, "-m", "pytest", "-q", *sys.argv[1:]]
    return subprocess.call(command, cwd=BACKEND)


if __name__ == "__main__":
    raise SystemExit(main())
