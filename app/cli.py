"""CLI entry point: serve the web UI or run the demo seed/verification."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .demo import build_records, run_demo, seed
from .store import Store
from .web import App, serve


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="gsb2", description="本地角色管理后台")
    parser.add_argument("--data-dir", default="data", type=Path)
    sub = parser.add_subparsers(dest="command")

    serve_parser = sub.add_parser("serve", help="启动本地 Web 后台")
    serve_parser.add_argument("--host", default="127.0.0.1")
    serve_parser.add_argument("--port", default=8787, type=int)

    init_parser = sub.add_parser("init", help="创建演示数据（两个机构、六条记录）")
    init_parser.add_argument("--reset", action="store_true")

    demo_parser = sub.add_parser("demo", help="重建演示数据并打印导出/校验结果")
    demo_parser.add_argument(
        "--reset", action="store_true", help="删除现有数据后重建"
    )

    args = parser.parse_args(argv)
    data_dir: Path = args.data_dir
    store = Store(data_dir / "gsb2.db", data_dir / "audit-baseline.db")

    if args.command == "init":
        if args.reset and data_dir.exists():
            import shutil

            shutil.rmtree(data_dir)
        store.initialize()
        seed(store)
        build_records(store)
        print(f"已写入演示数据: {data_dir}")
        print("管理员: jia / yi，密码见 app/demo.py 中的 PASSWORD 常量")
        return 0

    if args.command == "demo":
        if store.db_path.exists() and not getattr(args, "reset", False):
            print(
                "演示数据库已存在；如需重建请加 --reset。",
                file=sys.stderr,
            )
            return 1
        if getattr(args, "reset", False) and data_dir.exists():
            import shutil

            shutil.rmtree(data_dir)
            store = Store(data_dir / "gsb2.db", data_dir / "audit-baseline.db")
        store.initialize()
        seed(store)
        build_records(store)
        result = run_demo(store, data_dir / "exports")
        print(json.dumps(result, ensure_ascii=False, indent=2))
        print(f"演示数据与导出副本位于: {data_dir}")
        return 0

    if args.command == "serve" or args.command is None:
        host = getattr(args, "host", "127.0.0.1")
        port = getattr(args, "port", 8787)
        if not store.db_path.exists():
            print("未找到数据库，正在创建演示数据…", file=sys.stderr)
            store.initialize()
            seed(store)
            build_records(store)
            run_demo(store, data_dir / "exports")
        app = App(store, copies_dir=data_dir / "exports")
        server = serve(app, host, port)
        print(f"服务已启动: http://{host}:{port}/")
        print("管理员: jia（甲公司）、yi（乙公司）；密码见 app/demo.py")
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("\n已停止")
        finally:
            server.server_close()
        return 0

    parser.print_help()
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
