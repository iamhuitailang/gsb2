"""Pytest bootstrap: makes the ``app`` package importable from backend/.

Tests can be run either from ``backend/`` (``pytest -q``) or from the repo root
(``pytest backend``); this file adds the backend directory to ``sys.path`` in
both cases.
"""

from __future__ import annotations

import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))
