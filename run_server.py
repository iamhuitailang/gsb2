#!/usr/bin/env python3
"""本地工作台启动入口。

用法：
    python3 run_server.py
环境变量（可选）：
    SECBENCH_HOST   监听地址，默认 127.0.0.1
    SECBENCH_PORT   监听端口，默认 8080
    SECBENCH_DB     SQLite 文件路径，默认 ./secbench_data/secbench.db
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from secbench import server, storage  # noqa: E402


def main() -> None:
    with storage.connect() as conn:
        storage.init_db(conn)
    host = os.environ.get("SECBENCH_HOST", "127.0.0.1")
    port = int(os.environ.get("SECBENCH_PORT", "8080"))
    server.serve(host, port)


if __name__ == "__main__":
    main()
