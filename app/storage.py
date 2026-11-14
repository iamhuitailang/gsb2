"""Parquet 归档与查询的核心逻辑。

目录布局（数据根目录由环境变量 ``BUS_DATA_DIR`` 指定，默认 ./data）::

    data/
      registry.db                       SQLite 版本登记
      archive/version_N/
        boardings_N.parquet             收到的原始明细（不可变）
        source.csv                      收到的原始 CSV（不可变）
      active/biz_date=YYYY-MM-DD/
        part.parquet                    当前生效版本，查询只读这里

查询使用 pyarrow.dataset 按 Hive 分区 biz_date 做分区裁剪；
替换某一天时只覆盖该日期的 active 分区，其他日期不受影响。
"""

from __future__ import annotations

import csv
import hashlib
import io
import os
import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Any

import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq
from pyarrow import dataset as ds

REQUIRED_FIELDS = ["业务日期", "线路", "站点", "时段", "人数"]

SCHEMA = pa.schema(
    [
        pa.field("业务日期", pa.string()),
        pa.field("线路", pa.string()),
        pa.field("站点", pa.string()),
        pa.field("时段", pa.string()),
        pa.field("人数", pa.int64()),
    ]
)

DB_SCHEMA = """
CREATE TABLE IF NOT EXISTS versions (
    version_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    biz_date        TEXT NOT NULL,
    received_at     TEXT NOT NULL,
    checksum        TEXT NOT NULL,
    total_boardings INTEGER NOT NULL,
    row_count       INTEGER NOT NULL,
    archive_path    TEXT NOT NULL,
    is_current      INTEGER NOT NULL DEFAULT 0,
    replaces        INTEGER,
    UNIQUE (biz_date, checksum)
);
"""


class ImportError_(Exception):
    """文件内容不合法（HTTP 400）。"""


def _fragment_partition_value(frag: ds.Fragment, key: str) -> str:
    """从 Hive 分区片段的文件路径中取出指定分区键的值（如 biz_date=2026-11-10）。"""
    path = frag.path if hasattr(frag, "path") else ""
    needle = f"{key}="
    for part in Path(path).parts:
        if part.startswith(needle):
            return part[len(needle):]
    raise ValueError(f"片段路径中找不到分区 {key}：{path}")


class DuplicateFile(Exception):
    """同一天同一份文件（按内容校验和判断）重复上传（HTTP 409）。"""

    def __init__(self, existing: dict[str, Any]):
        self.existing = existing
        super().__init__(f"该文件已存在：版本 {existing['version_id']}")


def get_data_dir() -> Path:
    return Path(os.environ.get("BUS_DATA_DIR", Path(__file__).resolve().parent.parent / "data"))


class Storage:
    def __init__(self, data_dir: Path | str | None = None):
        self.data_dir = Path(data_dir) if data_dir else get_data_dir()
        self.archive_dir = self.data_dir / "archive"
        self.active_dir = self.data_dir / "active"
        self.db_path = self.data_dir / "registry.db"
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.archive_dir.mkdir(parents=True, exist_ok=True)
        self.active_dir.mkdir(parents=True, exist_ok=True)
        with self._connect() as conn:
            conn.executescript(DB_SCHEMA)

    # ---------- 基础 ----------

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    # ---------- 解析与校验 ----------

    @staticmethod
    def parse_csv(raw: bytes) -> list[dict[str, Any]]:
        """解析上传的 CSV，返回行字典列表。支持带 BOM 的 UTF-8 与 GBK。"""
        for encoding in ("utf-8-sig", "gbk"):
            try:
                text = raw.decode(encoding)
                break
            except UnicodeDecodeError:
                continue
        else:
            raise ImportError_("文件编码无法识别，请使用 UTF-8 或 GBK 编码的 CSV")

        reader = csv.DictReader(io.StringIO(text))
        if reader.fieldnames is None:
            raise ImportError_("空文件或缺少表头")
        missing = [f for f in REQUIRED_FIELDS if f not in reader.fieldnames]
        if missing:
            raise ImportError_(f"缺少必需列：{', '.join(missing)}；必需列为 {', '.join(REQUIRED_FIELDS)}")

        rows: list[dict[str, Any]] = []
        for line_no, row in enumerate(reader, start=2):
            values = {f: (row.get(f) or "").strip() for f in REQUIRED_FIELDS}
            if not any(values.values()):
                continue  # 跳过完全空白的行
            try:
                datetime.strptime(values["业务日期"], "%Y-%m-%d")
            except ValueError:
                raise ImportError_(f"第 {line_no} 行业务日期格式错误：{values['业务日期']!r}，应为 YYYY-MM-DD")
            if not values["线路"] or not values["站点"] or not values["时段"]:
                raise ImportError_(f"第 {line_no} 行存在空的线路/站点/时段")
            try:
                count = int(values["人数"])
                if count < 0:
                    raise ValueError
            except ValueError:
                raise ImportError_(f"第 {line_no} 行人数不是非负整数：{values['人数']!r}")
            values["人数"] = count
            rows.append(values)

        if not rows:
            raise ImportError_("文件中没有数据行")
        dates = {r["业务日期"] for r in rows}
        if len(dates) > 1:
            raise ImportError_(f"一份文件只能包含一个业务日期，实际包含：{', '.join(sorted(dates))}")
        return rows

    # ---------- 导入 ----------

    def import_file(self, filename: str, raw: bytes) -> dict[str, Any]:
        """导入一份 CSV：归档、登记、原子替换当天 active 分区。"""
        checksum = hashlib.sha256(raw).hexdigest()
        rows = self.parse_csv(raw)
        biz_date = rows[0]["业务日期"]
        received_at = datetime.now().replace(microsecond=0).isoformat()

        with self._connect() as conn:
            existing = conn.execute(
                "SELECT * FROM versions WHERE biz_date = ? AND checksum = ?",
                (biz_date, checksum),
            ).fetchone()
            if existing is not None:
                raise DuplicateFile(dict(existing))

            previous = conn.execute(
                "SELECT * FROM versions WHERE biz_date = ? AND is_current = 1",
                (biz_date,),
            ).fetchone()

            cur = conn.execute(
                "INSERT INTO versions (biz_date, received_at, checksum, total_boardings, row_count, "
                "archive_path, is_current, replaces) VALUES (?, ?, ?, ?, ?, '', 1, ?)",
                (
                    biz_date,
                    received_at,
                    checksum,
                    sum(r["人数"] for r in rows),
                    len(rows),
                    previous["version_id"] if previous else None,
                ),
            )
            version_id = cur.lastrowid

            version_dir = self.archive_dir / f"version_{version_id}"
            version_dir.mkdir(parents=True)
            try:
                (version_dir / "source.csv").write_bytes(raw)
                table = pa.Table.from_pylist(rows, schema=SCHEMA)
                pq.write_table(
                    table,
                    version_dir / f"boardings_{version_id}.parquet",
                    compression="snappy",
                )
                conn.execute(
                    "UPDATE versions SET archive_path = ? WHERE version_id = ?",
                    (str(version_dir), version_id),
                )
            except Exception:
                # 归档失败：回滚登记与半成品目录
                conn.rollback()
                if version_dir.exists():
                    for p in version_dir.iterdir():
                        p.unlink()
                    version_dir.rmdir()
                raise

            if previous is not None:
                conn.execute(
                    "UPDATE versions SET is_current = 0 WHERE version_id = ?",
                    (previous["version_id"],),
                )

            # 原子替换 active 分区：先写临时目录，再 rename 覆盖
            partition_dir = self.active_dir / f"biz_date={biz_date}"
            tmp_dir = self.active_dir / f".tmp-{biz_date}-{version_id}"
            backup = self.active_dir / f".old-{biz_date}-{version_id}"
            tmp_dir.mkdir(parents=True, exist_ok=False)
            try:
                pq.write_table(
                    table.drop(["业务日期"]),
                    tmp_dir / "part.parquet",
                    compression="snappy",
                )
                if partition_dir.exists():
                    partition_dir.rename(backup)
                    tmp_dir.rename(partition_dir)
                    for p in backup.iterdir():
                        p.unlink()
                    backup.rmdir()
                else:
                    tmp_dir.rename(partition_dir)
            except Exception:
                # 分区替换失败：回滚数据库事务，恢复旧分区（若已被挪走）
                conn.rollback()
                if tmp_dir.exists():
                    for p in tmp_dir.iterdir():
                        p.unlink()
                    tmp_dir.rmdir()
                if not partition_dir.exists() and backup.exists():
                    backup.rename(partition_dir)
                raise

            result = dict(
                conn.execute("SELECT * FROM versions WHERE version_id = ?", (version_id,)).fetchone()
            )
        result["filename"] = filename
        result["replaced_version"] = previous["version_id"] if previous else None
        return result

    # ---------- 查询 ----------

    def query(
        self,
        start_date: str,
        end_date: str,
        route: str | None = None,
    ) -> dict[str, Any]:
        """按日期区间（可选线路）汇总上车人数。"""
        for label, value in (("开始日期", start_date), ("结束日期", end_date)):
            try:
                datetime.strptime(value, "%Y-%m-%d")
            except (ValueError, TypeError):
                raise ImportError_(f"{label}格式错误：{value!r}，应为 YYYY-MM-DD")
        if start_date > end_date:
            raise ImportError_("开始日期不能晚于结束日期")

        empty_result = {
            "开始日期": start_date,
            "结束日期": end_date,
            "线路": route or "",
            "读取分区数": 0,
            "读取日期": [],
            "总上车人数": 0,
            "线路汇总": [],
            "站点明细": [],
        }
        if not any(self.active_dir.glob("biz_date=*/**/*.parquet")):
            return empty_result

        dataset = ds.dataset(self.active_dir, format="parquet", partitioning="hive")
        filter_ = pc.field("biz_date") >= pa.scalar(start_date, pa.string())
        filter_ = pc.and_kleene(filter_, pc.field("biz_date") <= pa.scalar(end_date, pa.string()))
        if route:
            filter_ = pc.and_kleene(filter_, pc.field("线路") == pa.scalar(route, pa.string()))

        fragments = list(dataset.get_fragments(filter=filter_))
        scanner = dataset.scanner(filter=filter_)
        table = scanner.to_table()

        # 过滤后实际命中的分区，即本次实际读取的业务日期
        read_dates = sorted({_fragment_partition_value(frag, "biz_date") for frag in fragments})

        total_boardings = 0
        lines: dict[str, int] = {}
        details: dict[tuple[str, str], int] = {}
        if table.num_rows:
            for route_name, station_name, count in zip(
                table.column("线路").to_pylist(),
                table.column("站点").to_pylist(),
                table.column("人数").to_pylist(),
            ):
                total_boardings += count
                lines[route_name] = lines.get(route_name, 0) + count
                key = (route_name, station_name)
                details[key] = details.get(key, 0) + count

        line_totals = [
            {"线路": r, "上车人数": n}
            for r, n in sorted(lines.items(), key=lambda kv: (-kv[1], kv[0]))
        ]
        station_details = [
            {"线路": r, "站点": s, "上车人数": n}
            for (r, s), n in sorted(details.items(), key=lambda kv: (-kv[1], kv[0]))
        ]
        empty_result.update(
            {
                "读取分区数": len(read_dates),
                "读取日期": read_dates,
                "总上车人数": total_boardings,
                "线路汇总": line_totals,
                "站点明细": station_details,
            }
        )
        return empty_result

    def list_routes(self) -> list[str]:
        if not any(self.active_dir.glob("biz_date=*/**/*.parquet")):
            return []
        table = ds.dataset(self.active_dir, format="parquet", partitioning="hive").to_table(
            columns=["线路"]
        )
        return sorted(set(table.column("线路").to_pylist()))

    # ---------- 归档记录 ----------

    def list_versions(self, biz_date: str | None = None) -> list[dict[str, Any]]:
        with self._connect() as conn:
            if biz_date:
                rows = conn.execute(
                    "SELECT * FROM versions WHERE biz_date = ? ORDER BY version_id", (biz_date,)
                ).fetchall()
            else:
                rows = conn.execute("SELECT * FROM versions ORDER BY version_id").fetchall()
            return [dict(r) for r in rows]

    def get_version(self, version_id: int) -> dict[str, Any] | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM versions WHERE version_id = ?", (version_id,)
            ).fetchone()
            return dict(row) if row else None


# ---------- 导出 ----------

def to_csv_bytes(result: dict[str, Any], level: str = "station") -> bytes:
    """把查询结果导出为带 BOM 的 UTF-8 CSV，Excel 可直接打开。"""
    buf = io.StringIO()
    if level == "line":
        writer = csv.DictWriter(buf, fieldnames=["线路", "上车人数"])
        writer.writeheader()
        writer.writerows(result["线路汇总"])
    else:
        writer = csv.DictWriter(buf, fieldnames=["线路", "站点", "上车人数"])
        writer.writeheader()
        writer.writerows(result["站点明细"])
    return b"\xef\xbb\xbf" + buf.getvalue().encode("utf-8")
