"""端到端测试：导入、去重、修订替换、分区裁剪、导出。

运行：.venv/bin/pytest -q
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("BUS_DATA_DIR", str(tmp_path / "data"))
    # 延迟导入，确保 Storage 读到测试用的 BUS_DATA_DIR
    import importlib

    import app.main as main

    importlib.reload(main)
    from fastapi.testclient import TestClient

    with TestClient(main.app) as c:
        yield c, main.storage


def csv_bytes(biz_date: str, rows: list[tuple[str, str, str, int]]) -> bytes:
    lines = ["业务日期,线路,站点,时段,人数"]
    for route, station, slot, count in rows:
        lines.append(f"{biz_date},{route},{station},{slot},{count}")
    return ("\n".join(lines) + "\n").encode("utf-8")


def upload(client, name, raw):
    c, _ = client
    return c.post("/api/import", files={"file": (name, raw, "text/csv")})


DAY1 = [
    ("1路", "火车站", "早高峰", 100),
    ("1路", "人民广场", "晚高峰", 60),
    ("2路", "体育馆", "平峰", 30),
]
DAY2 = [
    ("1路", "火车站", "早高峰", 110),
    ("2路", "体育馆", "晚高峰", 40),
]
DAY2_REVISED = [
    ("1路", "火车站", "早高峰", 200),  # 修订：人数变化
    ("2路", "体育馆", "晚高峰", 40),
]


def test_import_and_query(client):
    resp = upload(client, "d1.csv", csv_bytes("2026-11-10", DAY1))
    assert resp.status_code == 200, resp.text
    v = resp.json()["version"]
    assert v["biz_date"] == "2026-11-10"
    assert v["total_boardings"] == 190
    assert v["row_count"] == 3
    assert v["is_current"] == 1
    assert v["replaced_version"] is None

    c, storage = client
    # Parquet 分区目录已生成
    partition = storage.active_dir / "biz_date=2026-11-10" / "part.parquet"
    assert partition.exists()
    # 归档目录保留原始 CSV 与不可变 Parquet
    archive = Path(v["archive_path"])
    assert (archive / "source.csv").exists()
    assert (archive / f"boardings_{v['version_id']}.parquet").exists()

    q = c.get("/api/query", params={"start_date": "2026-11-10", "end_date": "2026-11-10"}).json()
    assert q["总上车人数"] == 190
    assert q["读取日期"] == ["2026-11-10"]
    assert q["读取分区数"] == 1
    assert {r["线路"]: r["上车人数"] for r in q["线路汇总"]} == {"1路": 160, "2路": 30}


def test_duplicate_same_file_rejected(client):
    raw = csv_bytes("2026-11-10", DAY1)
    assert upload(client, "a.csv", raw).status_code == 200
    # 文件名不同但内容完全一致 -> 409 并指出已有版本
    resp = upload(client, "b.csv", raw)
    assert resp.status_code == 409
    detail = resp.json()["detail"]
    assert "已存在" in detail["message"]
    assert detail["existing_version"]["version_id"] == 1


def test_revision_replaces_day_without_affecting_others(client):
    upload(client, "d1.csv", csv_bytes("2026-11-10", DAY1))
    upload(client, "d2.csv", csv_bytes("2026-11-11", DAY2))
    resp = upload(client, "d2r.csv", csv_bytes("2026-11-11", DAY2_REVISED))
    assert resp.status_code == 200
    v3 = resp.json()["version"]
    assert v3["replaced_version"] == 2  # 替换的是同一天的旧版

    c, storage = client
    # 再查询：11 日只算新的一份（240 而非 150）
    q = c.get("/api/query", params={"start_date": "2026-11-11", "end_date": "2026-11-11"}).json()
    assert q["总上车人数"] == 240
    assert q["读取分区数"] == 1

    # 10 日不受影响
    q10 = c.get("/api/query", params={"start_date": "2026-11-10", "end_date": "2026-11-10"}).json()
    assert q10["总上车人数"] == 190

    # active 下每个业务日期只有一个分区文件
    partitions = list((storage.active_dir).glob("biz_date=*/part.parquet"))
    assert len(partitions) == 2

    # 归档记录：旧版仍在，带收到时间与总人数，且标记为非当前
    versions = c.get("/api/versions").json()
    assert len(versions) == 3
    old, new = versions[1], versions[2]
    assert old["biz_date"] == "2026-11-11" and old["is_current"] == 0
    assert old["total_boardings"] == 150 and old["received_at"]
    assert new["is_current"] == 1 and new["total_boardings"] == 240
    assert old["checksum"] != new["checksum"]

    # 旧版归档 Parquet 内容未被改动
    import pyarrow.parquet as pq

    old_total = pq.read_table(
        Path(old["archive_path"]) / f"boardings_{old['version_id']}.parquet"
    ).column("人数").to_pylist()
    assert sum(old_total) == 150


def test_partition_pruning_single_day_reads_one_partition(client):
    upload(client, "d1.csv", csv_bytes("2026-11-10", DAY1))
    upload(client, "d2.csv", csv_bytes("2026-11-11", DAY2))
    c, _ = client

    # 单日查询只读取当天分区
    q = c.get("/api/query", params={"start_date": "2026-11-11", "end_date": "2026-11-11"}).json()
    assert q["读取日期"] == ["2026-11-11"]

    # 区间查询读取区间内存在的分区
    q = c.get("/api/query", params={"start_date": "2026-11-10", "end_date": "2026-11-11"}).json()
    assert q["读取日期"] == ["2026-11-10", "2026-11-11"]
    assert q["总上车人数"] == 190 + 150

    # 区间内无数据
    q = c.get("/api/query", params={"start_date": "2026-12-01", "end_date": "2026-12-02"}).json()
    assert q["读取分区数"] == 0
    assert q["总上车人数"] == 0

    # 线路过滤
    q = c.get(
        "/api/query",
        params={"start_date": "2026-11-10", "end_date": "2026-11-11", "route": "2路"},
    ).json()
    assert q["总上车人数"] == 70
    assert {r["线路"] for r in q["站点明细"]} == {"2路"}


def test_export_csv(client):
    upload(client, "d1.csv", csv_bytes("2026-11-10", DAY1))
    c, _ = client
    resp = c.get(
        "/api/export",
        params={"start_date": "2026-11-10", "end_date": "2026-11-10", "level": "line"},
    )
    assert resp.status_code == 200
    assert "text/csv" in resp.headers["content-type"]
    body = resp.content.decode("utf-8-sig")
    assert "线路,上车人数" in body
    assert "1路,160" in body


def test_invalid_files_rejected(client):
    c, _ = client
    # 缺列
    bad = "业务日期,线路,人数\n2026-11-10,1路,5\n".encode()
    assert upload(client, "bad.csv", bad).status_code == 400
    # 一份文件含两个业务日期
    two_dates = (
        "业务日期,线路,站点,时段,人数\n"
        "2026-11-10,1路,火车站,早高峰,5\n"
        "2026-11-11,1路,火车站,早高峰,6\n"
    ).encode()
    assert upload(client, "two.csv", two_dates).status_code == 400
    # 人数非法
    bad_count = csv_bytes("2026-11-10", [("1路", "火车站", "早高峰", -1)])
    assert upload(client, "neg.csv", bad_count).status_code == 400
    # 没有产生任何版本
    assert c.get("/api/versions").json() == []
