"""命令行入口：初始化演示数据并启动服务。"""

from __future__ import annotations

import argparse
from pathlib import Path

from .db import init_db
from .seed import DEMO_PASSWORD, create_demo_database
from .server import serve


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="本地小型工单系统")
    parser.add_argument("--db", default="tickets.db", help="SQLite 数据库文件路径")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument(
        "--reset-demo", action="store_true", help="清空数据库并写入演示数据"
    )
    parser.add_argument("--quiet", action="store_true", help="关闭访问日志")
    args = parser.parse_args(argv)

    db_path = Path(args.db)
    if args.reset_demo or not db_path.exists():
        create_demo_database(str(db_path))
        print("已写入演示数据。")
        print(f"  甲组主管: supervisor_a / {DEMO_PASSWORD}")
        print(f"  乙组主管: supervisor_b / {DEMO_PASSWORD}")
        print(f"  管理员:   admin / {DEMO_PASSWORD}")
    else:
        init_db(str(db_path)).close()

    serve(str(db_path), args.host, args.port, verbose=not args.quiet)
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
