"""pytest 公共夹具。"""
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from core.demo_data import generate_all            # noqa: E402


@pytest.fixture(scope="session")
def demo_dir() -> Path:
    d = ROOT / "demo"
    if not (d / "ground_truth.json").exists():
        generate_all(d)
    return d


@pytest.fixture(scope="session")
def ground_truth(demo_dir) -> dict:
    return json.loads((demo_dir / "ground_truth.json").read_text(encoding="utf-8"))
