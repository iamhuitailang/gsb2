"""把 sample_data/ 下的样例文件逐份导入本地服务。

需要服务已启动（见 README），默认地址 http://localhost:8000，可用环境变量 BASE_URL 覆盖。
导入顺序：三天初版 -> 11 日修订版；最后再重传一次初版，演示重复文件提示。

用法：.venv/bin/python scripts/load_sample_data.py
"""

from __future__ import annotations

import os
from pathlib import Path

import httpx

BASE_URL = os.environ.get("BASE_URL", "http://localhost:8000")
FILES = [
    "boardings_2026-11-10.csv",
    "boardings_2026-11-11.csv",
    "boardings_2026-11-12.csv",
    "boardings_2026-11-11_revised.csv",
]


def main() -> None:
    sample_dir = Path(__file__).resolve().parent.parent / "sample_data"
    with httpx.Client(base_url=BASE_URL, timeout=30) as client:
        for name in FILES:
            with (sample_dir / name).open("rb") as f:
                resp = client.post("/api/import", files={"file": (name, f, "text/csv")})
            if resp.status_code == 200:
                v = resp.json()["version"]
                tip = f"，替换 v{v['replaced_version']}" if v["replaced_version"] else ""
                print(f"[成功] {name} -> v{v['version_id']}（{v['biz_date']}，{v['total_boardings']} 人{tip}）")
            elif resp.status_code == 409:
                ev = resp.json()["detail"]["existing_version"]
                print(f"[重复] {name} 已存在：v{ev['version_id']}，未重复入库")
            else:
                print(f"[失败] {name} HTTP {resp.status_code}: {resp.text}")

        # 演示同文件重传
        name = "boardings_2026-11-11.csv"
        with (sample_dir / name).open("rb") as f:
            resp = client.post("/api/import", files={"file": (name, f, "text/csv")})
        if resp.status_code == 409:
            ev = resp.json()["detail"]["existing_version"]
            print(f"[重传演示] {name} -> 提示已有版本 v{ev['version_id']}（HTTP 409，符合预期）")


if __name__ == "__main__":
    main()
