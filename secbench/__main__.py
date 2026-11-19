"""python -m secbench 启动本地工作台。"""
from __future__ import annotations

import os

from . import server, storage
from .server import serve


def main() -> None:
    with storage.connect() as conn:
        storage.init_db(conn)
    host = os.environ.get("SECBENCH_HOST", "127.0.0.1")
    port = int(os.environ.get("SECBENCH_PORT", "8080"))
    serve(host, port)


if __name__ == "__main__":
    main()
