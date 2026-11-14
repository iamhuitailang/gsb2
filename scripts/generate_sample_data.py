"""生成三天虚构刷卡汇总明细，其中 2026-11-11 附带一份修订版。

用法：
    python scripts/generate_sample_data.py            # 输出到 sample_data/
    python scripts/generate_sample_data.py /tmp/dir   # 自定义输出目录

生成文件：
    boardings_2026-11-10.csv
    boardings_2026-11-11.csv          （初版）
    boardings_2026-11-11_revised.csv  （修订版，同日期不同内容）
    boardings_2026-11-12.csv
"""

from __future__ import annotations

import csv
import sys
from pathlib import Path

ROUTES = {
    "1路": ["火车站", "人民广场", "市政府", "大学城"],
    "2路": ["客运中心", "体育馆", "中山公园", "中医院"],
    "地铁接驳3号线": ["地铁站", "科技园", "会展中心", "滨江住宅区"],
}
TIME_SLOTS = ["早高峰", "平峰", "晚高峰"]
DATES = ["2026-11-10", "2026-11-11", "2026-11-12"]

# 每个 (日期, 线路, 站点序号, 时段) 的基准人数，刻意取确定值保证可复现
BASE = {
    "2026-11-10": {"早高峰": 120, "平峰": 45, "晚高峰": 95},
    "2026-11-11": {"早高峰": 132, "平峰": 50, "晚高峰": 101},
    "2026-11-12": {"早高峰": 118, "平峰": 42, "晚高峰": 90},
}
# 站点序号权重（线路上越靠前的站上车越多），线路间也有差异
STATION_WEIGHT = [1.0, 0.7, 0.45, 0.25]
ROUTE_WEIGHT = {"1路": 1.0, "2路": 0.8, "地铁接驳3号线": 1.15}


def build_rows(biz_date: str, revised: bool = False) -> list[dict[str, int | str]]:
    rows: list[dict[str, int | str]] = []
    for route, stations in ROUTES.items():
        for idx, station in enumerate(stations):
            for slot in TIME_SLOTS:
                count = int(
                    BASE[biz_date][slot]
                    * STATION_WEIGHT[idx]
                    * ROUTE_WEIGHT[route]
                )
                # 修订版：补录晚高峰漏报的客流，并整体修正 1 路火车站早高峰
                if revised:
                    if slot == "晚高峰":
                        count += 30
                    if route == "1路" and station == "火车站" and slot == "早高峰":
                        count += 25
                rows.append(
                    {
                        "业务日期": biz_date,
                        "线路": route,
                        "站点": station,
                        "时段": slot,
                        "人数": count,
                    }
                )
    return rows


def write_csv(path: Path, rows: list[dict[str, int | str]]) -> None:
    with path.open("w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=["业务日期", "线路", "站点", "时段", "人数"])
        writer.writeheader()
        writer.writerows(rows)
    total = sum(int(r["人数"]) for r in rows)
    print(f"已生成 {path.name}：{len(rows)} 行，总人数 {total}")


def main() -> None:
    out_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / "sample_data"
    out_dir.mkdir(parents=True, exist_ok=True)
    for biz_date in DATES:
        write_csv(out_dir / f"boardings_{biz_date}.csv", build_rows(biz_date))
    write_csv(
        out_dir / "boardings_2026-11-11_revised.csv",
        build_rows("2026-11-11", revised=True),
    )


if __name__ == "__main__":
    main()
