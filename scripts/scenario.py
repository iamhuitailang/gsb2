"""端到端复现题目场景（纯服务层，不启动 HTTP）。

运行：python3 -m scripts.scenario
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

if __package__ in (None, ""):  # 支持 python3 scripts/scenario.py 直接运行
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ticket_system import service
from ticket_system.db import init_db
from ticket_system.seed import seed_demo


def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        conn = init_db(str(Path(tmp) / "scenario.db"))
        ids = seed_demo(conn)
        supervisor = service.authenticate(conn, "supervisor_a", "demo1234")
        admin = service.authenticate(conn, "admin", "demo1234")

        first = ids["ticket_first"]
        second = ids["ticket_second"]
        foreign = ids["ticket_other_group"]
        batch = [first, second, foreign]

        preview = service.preview_batch(conn, supervisor, batch)
        print(f"预览：共 {preview['total']} 张，可关闭 {preview['closable_count']} 张")

        service.transfer_ticket(conn, admin, second, ids["group_b"])
        print(f"已把甲组第二张（#{second}）转到乙组")

        result = service.close_batch(conn, supervisor, batch, "demo-batch")
        print("提交结果：")
        print(json.dumps(result, ensure_ascii=False, indent=2))

        print("最终状态：")
        for ticket_id in batch:
            row = service.get_ticket(conn, ticket_id)
            print(
                f"  #{ticket_id} 组={row['group_id']} 状态={row['status']} "
                f"关闭记录={service.count_close_records(conn, ticket_id)}"
            )
        conn.close()


if __name__ == "__main__":
    main()
