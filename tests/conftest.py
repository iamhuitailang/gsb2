"""共用的测试夹具。"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.db import Database
from app.main import create_app


@pytest.fixture()
def db(tmp_path: Path) -> Database:
    database = Database(tmp_path / "policy.db")
    yield database
    database.close()


@pytest.fixture()
def client(db: Database):
    from fastapi.testclient import TestClient

    app = create_app(db)
    with TestClient(app) as test_client:
        yield test_client


def load_sample(filename: str) -> str:
    from app.samples import read_sample

    return read_sample(filename)["text"]


def import_payload(text: str, **overrides):
    payload = {
        "document_text": text,
        "source_note": "pytest 来源说明",
        "base_generation": 0,
    }
    payload.update(overrides)
    return payload
