"""API tests using FastAPI's in-process test client."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

fastapi = pytest.importorskip("fastapi")
pytest.importorskip("httpx")

from fastapi.testclient import TestClient  # noqa: E402

from app.main import create_app  # noqa: E402


@pytest.fixture()
def client(tmp_path: Path):
    app = create_app(db_path=tmp_path / "test.sqlite3")
    with TestClient(app) as test_client:
        yield test_client


def _config_payload():
    return {
        "name": "API 测试配置",
        "entries": [
            {"value": "10.0.0.0/8", "label": "内网代理"},
            {"value": "192.0.2.0/24", "label": "CDN"},
        ],
        "fields": {
            "x_forwarded_for": {"enabled": True, "max_hops": 4},
            "forwarded": {"enabled": False, "max_hops": 4},
            "x_real_ip": {"enabled": False, "max_hops": 1},
            "cf_connecting_ip": {"enabled": False, "max_hops": 1},
        },
    }


def test_health_and_meta(client):
    health = client.get("/api/health")
    assert health.status_code == 200
    assert health.json()["outbound_requests"] is False
    meta = client.get("/api/meta")
    assert meta.status_code == 200
    assert "x_forwarded_for" in meta.json()["fields"]


def test_demo_endpoints(client):
    listing = client.get("/api/demos").json()
    assert listing["items"]
    slugs = {item["slug"] for item in listing["items"]}
    assert {"trusted-chain", "spoofed-header", "ipv4-ipv6-mixed", "field-conflict", "malformed-input"} <= slugs

    for item in listing["items"]:
        response = client.post(f"/api/demos/{item['slug']}/run", json={"save": True})
        assert response.status_code == 200, item["slug"]
        body = response.json()
        assert body["expectation_check"]["passed"] is True, item["slug"]
        assert body["analysis_id"]


def test_unknown_demo_returns_404(client):
    assert client.get("/api/demos/nope").status_code == 404
    assert client.post("/api/demos/nope/run", json={}).status_code == 404


def test_config_validation_reports_errors(client):
    bad = _config_payload()
    bad["entries"] = [{"value": "10.0.0.5/8", "label": "坏网段"}]
    response = client.post("/api/configs/validate", json={"config": bad})
    assert response.status_code == 200
    body = response.json()
    assert body["valid"] is False
    assert "10.0.0.0/8" in body["errors"][0]["message"]


def test_config_save_and_load(client):
    response = client.post("/api/configs", json={"config": _config_payload()})
    assert response.status_code == 201
    saved = response.json()
    assert saved["id"]

    listing = client.get("/api/configs").json()
    assert len(listing["items"]) == 1
    assert listing["items"][0]["config"]["name"] == "API 测试配置"

    update = _config_payload()
    update["name"] = "改名后的配置"
    updated = client.post(
        "/api/configs", json={"config": update, "config_id": saved["id"]}
    )
    assert updated.status_code == 201
    assert updated.json()["id"] == saved["id"]

    fetched = client.get(f"/api/configs/{saved['id']}").json()
    assert fetched["name"] == "改名后的配置"

    assert client.delete(f"/api/configs/{saved['id']}").status_code == 200
    assert client.get(f"/api/configs/{saved['id']}").status_code == 404


def test_invalid_config_not_saved(client):
    bad = _config_payload()
    bad["entries"] = []
    response = client.post("/api/configs", json={"config": bad})
    assert response.status_code == 422
    assert response.json()["errors"]


def test_analyze_and_persistence(client):
    response = client.post(
        "/api/analyze",
        json={
            "peer": "10.0.0.5",
            "headers": {"x_forwarded_for": "203.0.113.42, 192.0.2.10"},
            "config": _config_payload(),
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["result"]["verdict"]["final_client"] == "203.0.113.42"
    analysis_id = body["analysis_id"]
    assert analysis_id

    listing = client.get("/api/analyses").json()
    assert listing["total"] == 1
    assert listing["items"][0]["outcome"] == "trusted_chain"

    detail = client.get(f"/api/analyses/{analysis_id}").json()
    assert detail["peer_raw"] == "10.0.0.5"
    assert detail["config_snapshot"]["name"] == "API 测试配置"
    assert detail["result"]["verdict"]["final_client"] == "203.0.113.42"


def test_analyze_rejects_unknown_header(client):
    response = client.post(
        "/api/analyze",
        json={
            "peer": "10.0.0.5",
            "headers": {"x-backend-ip": "1.2.3.4"},
            "config": _config_payload(),
        },
    )
    assert response.status_code == 422
    assert response.json()["errors"]


def test_analyze_rejects_invalid_config(client):
    bad = _config_payload()
    bad["fields"]["x_real_ip"] = {"enabled": True, "max_hops": 4}
    response = client.post(
        "/api/analyze",
        json={"peer": "10.0.0.5", "headers": {}, "config": bad},
    )
    assert response.status_code == 422
    assert any(item["code"] == "conflict" for item in response.json()["errors"])


def test_filtering_by_outcome_and_status(client):
    for peer, headers, expected in [
        ("10.0.0.5", {"x_forwarded_for": "203.0.113.42, 192.0.2.10"}, "trusted_chain"),
        ("198.51.100.1", {"x_forwarded_for": "10.0.0.1"}, "untrusted_peer"),
    ]:
        client.post(
            "/api/analyze",
            json={"peer": peer, "headers": headers, "config": _config_payload()},
        )
    trusted = client.get("/api/analyses", params={"outcome": "trusted_chain"}).json()
    assert trusted["total"] == 1
    spoofed = client.get("/api/analyses", params={"status": "determined"}).json()
    assert spoofed["total"] == 2


def test_export_has_no_local_paths(client, tmp_path):
    client.post(
        "/api/analyze",
        json={
            "peer": "10.0.0.5",
            "headers": {"x_forwarded_for": "203.0.113.42, 192.0.2.10"},
            "config": _config_payload(),
        },
    )
    response = client.get("/api/export", params={"format": "json"})
    assert response.status_code == 200
    text = response.text
    assert str(tmp_path) not in text
    assert str(Path.home()) not in text
    assert "sqlite" not in text.lower()
    payload = json.loads(text)
    assert payload["record_count"] == 1
    verdict = payload["records"][0]["result"]["verdict"]
    assert verdict["final_client"] == "203.0.113.42"

    csv_response = client.get("/api/export", params={"format": "csv"})
    assert csv_response.status_code == 200
    assert "203.0.113.42" in csv_response.text
    assert str(Path.home()) not in csv_response.text


def test_export_filters_apply(client):
    for peer, xff in (
        ("10.0.0.5", "203.0.113.42, 192.0.2.10"),
        ("198.51.100.1", "10.0.0.5"),
    ):
        client.post(
            "/api/analyze",
            json={
                "peer": peer,
                "headers": {"x_forwarded_for": xff},
                "config": _config_payload(),
            },
        )
    response = client.get(
        "/api/export", params={"format": "json", "outcome": "untrusted_peer"}
    )
    payload = response.json()
    assert payload["record_count"] == 1
    assert payload["records"][0]["peer"] == "198.51.100.1"


def test_demo_data_reset(client):
    client.post("/api/demos/trusted-chain/run", json={"save": True})
    client.post(
        "/api/analyze",
        json={
            "peer": "10.0.0.5",
            "headers": {"x_forwarded_for": "203.0.113.42, 192.0.2.10"},
            "config": _config_payload(),
            "source": "manual",
        },
    )
    reset = client.post("/api/demo-data/reset")
    assert reset.status_code == 200
    assert reset.json()["deleted"] == 1
    assert client.get("/api/analyses").json()["total"] == 1


def test_analysis_404(client):
    assert client.get("/api/analyses/9999").status_code == 404
    assert client.delete("/api/analyses/9999").status_code == 404
