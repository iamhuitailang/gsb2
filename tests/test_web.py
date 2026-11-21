"""Flask 接口冒烟测试：上传、处理、导出、批量、失败隔离。"""

import io
import os

import cv2
import numpy as np
import pytest

from sketchclean.web.app import create_app


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("SKETCHCLEAN_WORKSPACE", str(tmp_path / "ws"))
    app = create_app()
    app.config["TESTING"] = True
    return app.test_client()


def _png_bytes():
    img = np.full((300, 400), 230, np.uint8)
    cv2.line(img, (60, 150), (340, 150), 70, 3)
    ok, buf = cv2.imencode(".png", img)
    assert ok
    return io.BytesIO(buf.tobytes())


def test_upload_process_export_flow(client):
    r = client.post("/api/upload", data={"file": ( _png_bytes(), "a.png")},
                    content_type="multipart/form-data")
    j = r.get_json()
    assert j["ok"] and len(j["histogram"]) == 256
    sid = j["session"]

    r = client.post(f"/api/process/{sid}", json={"params": {}})
    pj = r.get_json()
    assert pj["ok"] and "counts" in pj and len(pj["hist_cleaned"]) == 256

    for kind in ("cleaned", "inspect", "background", "original"):
        assert client.get(f"/api/image/{sid}/{kind}").status_code == 200

    r = client.post(f"/api/export/{sid}", json={"params": {}})
    ej = r.get_json()
    assert ej["ok"] and ej["width"] == 400 and os.path.exists(ej["output"])
    assert client.get(f"/api/download/{sid}?file=cleaned.full.png").status_code == 200
    assert client.get(f"/api/download/{sid}?file=../evil").status_code == 400


def test_upload_garbage_rejected(client):
    r = client.post("/api/upload",
                    data={"file": (io.BytesIO(b"xxxx"), "bad.png")},
                    content_type="multipart/form-data")
    assert r.status_code == 400 and not r.get_json()["ok"]


def test_batch_endpoint_failure_isolation(client, tmp_path):
    good = tmp_path / "g.png"
    cv2.imwrite(str(good), np.full((120, 160), 225, np.uint8))
    bad = tmp_path / "b.png"
    bad.write_bytes(b"garbage")
    r = client.post("/api/batch", json={
        "paths": [str(good), str(bad)],
        "outdir": str(tmp_path / "batchout"),
        "params": {},
    })
    j = r.get_json()
    assert j["ok"]
    assert len(j["report"]["succeeded"]) == 1
    assert len(j["report"]["failed"]) == 1


def test_unknown_session_404(client):
    assert client.get("/api/image/nope/cleaned").status_code == 404
    assert client.post("/api/process/nope", json={}).status_code == 404
