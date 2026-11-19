"""演示数据：甲组两张开启工单，乙组一张同名工单。"""

from __future__ import annotations

import sqlite3

from . import service
from .db import reset_db

DEMO_PASSWORD = "demo1234"
DEMO_TICKET_TITLE = "打印机离线，无法出单"


def seed_demo(conn: sqlite3.Connection) -> dict[str, int]:
    """写入演示数据并返回各编号；数据库需为空。"""
    if conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]:
        raise RuntimeError("数据库已有数据，演示数据不会重复写入")

    a = service.create_group(conn, "甲组")
    b = service.create_group(conn, "乙组")

    service.create_user(conn, "admin", DEMO_PASSWORD, "admin")
    service.create_user(conn, "supervisor_a", DEMO_PASSWORD, "supervisor", a)
    service.create_user(conn, "supervisor_b", DEMO_PASSWORD, "supervisor", b)

    first = service.create_ticket(conn, a, DEMO_TICKET_TITLE, "open")
    second = service.create_ticket(conn, a, DEMO_TICKET_TITLE, "open")
    other = service.create_ticket(conn, b, DEMO_TICKET_TITLE, "open")

    return {
        "group_a": a,
        "group_b": b,
        "ticket_first": first,
        "ticket_second": second,
        "ticket_other_group": other,
    }


def create_demo_database(db_path: str) -> dict[str, int]:
    conn = reset_db(db_path)
    try:
        return seed_demo(conn)
    finally:
        conn.close()
