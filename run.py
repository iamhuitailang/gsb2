"""入口：初始化数据库、写入示例运单（两个库区）、启动本地导出服务。

用法: python3 run.py [--port 8000] [--db export.db] [--dir exports]
"""

import argparse
import os
from datetime import date

import db
import web


def seed(conn):
    """仓库自带两个库区的运单：A区 4 件、B区 6 件。"""
    if conn.execute("SELECT COUNT(*) AS c FROM waybills").fetchone()["c"] > 0:
        return
    today = date.today().isoformat()
    db.add_waybill(conn, "WB-1001", "A区", 4, today)
    db.add_waybill(conn, "WB-2001", "B区", 6, today)


def main():
    parser = argparse.ArgumentParser(description="门店发货清单本地导出服务")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--db", default="export.db")
    parser.add_argument("--dir", default="exports", help="生成文件目录")
    args = parser.parse_args()

    os.makedirs(args.dir, exist_ok=True)
    conn = db.connect(args.db)
    db.init_db(conn)
    seed(conn)
    conn.close()

    web.serve(args.db, args.dir, args.port)


if __name__ == "__main__":
    main()
