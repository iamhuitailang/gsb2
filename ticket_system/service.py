"""领域逻辑：登录、工单分页、批量关闭预览与执行。"""

from __future__ import annotations

import hashlib
import json
import sqlite3
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable, Iterator

from . import security

CLOSABLE_STATUSES = ("open", "processing")
ALL_STATUSES = ("open", "processing", "closed", "archived")
# 这些原因下结果只允许带编号，不能带标题/状态（组外与不存在统一按组外处理）
NO_CONTENT_REASONS = ("no_permission",)
STATUS_LABELS = {
    "open": "待处理",
    "processing": "处理中",
    "closed": "已关闭",
    "archived": "已归档",
}
SESSION_TTL = timedelta(hours=12)
MAX_PAGE_SIZE = 100


class ApiError(Exception):
    """带 HTTP 状态码与稳定错误码的业务异常。"""

    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@contextmanager
def transaction(conn: sqlite3.Connection) -> Iterator[None]:
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    else:
        conn.execute("COMMIT")


@dataclass(frozen=True)
class User:
    id: int
    username: str
    role: str
    group_id: int | None
    group_name: str | None

    @property
    def is_supervisor(self) -> bool:
        return self.role == "supervisor"

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "username": self.username,
            "role": self.role,
            "group_id": self.group_id,
            "group_name": self.group_name,
        }


# --------------------------------------------------------------------------
# 用户与登录
# --------------------------------------------------------------------------

def get_user(conn: sqlite3.Connection, user_id: int) -> User | None:
    row = conn.execute(
        """
        SELECT u.id, u.username, u.role, u.group_id, g.name AS group_name
        FROM users u LEFT JOIN work_groups g ON g.id = u.group_id
        WHERE u.id = ?
        """,
        (user_id,),
    ).fetchone()
    return _user_from_row(row) if row else None


def _user_from_row(row: sqlite3.Row) -> User:
    return User(
        id=row["id"],
        username=row["username"],
        role=row["role"],
        group_id=row["group_id"],
        group_name=row["group_name"],
    )


def authenticate(conn: sqlite3.Connection, username: str, password: str) -> User:
    row = conn.execute(
        "SELECT id, username, password_hash, role, group_id FROM users WHERE username = ?",
        (username,),
    ).fetchone()
    if not row or not security.verify_password(password, row["password_hash"]):
        raise ApiError(401, "invalid_credentials", "用户名或密码错误")
    user = get_user(conn, row["id"])
    assert user is not None
    return user


def create_session(conn: sqlite3.Connection, user: User) -> dict[str, str]:
    token = security.new_session_token()
    csrf_token = security.new_session_token()
    now = datetime.now(timezone.utc)
    # 顺手清理过期会话，避免表无限增长
    conn.execute("DELETE FROM sessions WHERE expires_at <= ?", (now.isoformat(timespec="seconds"),))
    conn.execute(
        "INSERT INTO sessions (token_hash, user_id, csrf_token, created_at, expires_at)"
        " VALUES (?, ?, ?, ?, ?)",
        (
            _token_hash(token),
            user.id,
            csrf_token,
            now.isoformat(timespec="seconds"),
            (now + SESSION_TTL).isoformat(timespec="seconds"),
        ),
    )
    return {"token": token, "csrf_token": csrf_token}


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def user_for_token(conn: sqlite3.Connection, token: str) -> User | None:
    row = conn.execute(
        "SELECT user_id, expires_at FROM sessions WHERE token_hash = ?",
        (_token_hash(token),),
    ).fetchone()
    if not row:
        return None
    if datetime.fromisoformat(row["expires_at"]) <= datetime.now(timezone.utc):
        delete_session(conn, token)
        return None
    return get_user(conn, row["user_id"])


def session_csrf_token(conn: sqlite3.Connection, token: str) -> str | None:
    row = conn.execute(
        "SELECT csrf_token FROM sessions WHERE token_hash = ?",
        (_token_hash(token),),
    ).fetchone()
    return row["csrf_token"] if row else None


def delete_session(conn: sqlite3.Connection, token: str) -> None:
    conn.execute("DELETE FROM sessions WHERE token_hash = ?", (_token_hash(token),))


# --------------------------------------------------------------------------
# 工单查询
# --------------------------------------------------------------------------

def list_group_tickets(
    conn: sqlite3.Connection,
    *,
    group_id: int,
    page: int,
    page_size: int,
) -> dict[str, Any]:
    if page < 1:
        raise ApiError(400, "invalid_page", "页码必须从 1 开始")
    if not 1 <= page_size <= MAX_PAGE_SIZE:
        raise ApiError(400, "invalid_page_size", f"每页数量需在 1-{MAX_PAGE_SIZE} 之间")

    total = conn.execute(
        "SELECT COUNT(*) FROM tickets WHERE group_id = ?", (group_id,)
    ).fetchone()[0]
    rows = conn.execute(
        """
        SELECT id, title, status, created_at, updated_at
        FROM tickets WHERE group_id = ?
        ORDER BY id ASC
        LIMIT ? OFFSET ?
        """,
        (group_id, page_size, (page - 1) * page_size),
    ).fetchall()
    total_pages = max(1, (total + page_size - 1) // page_size)
    return {
        "page": page,
        "page_size": page_size,
        "total": total,
        "total_pages": total_pages,
        "items": [
            {
                "ticket_id": row["id"],
                "title": row["title"],
                "status": row["status"],
                "status_label": STATUS_LABELS[row["status"]],
                "updated_at": row["updated_at"],
            }
            for row in rows
        ],
    }


def get_ticket(conn: sqlite3.Connection, ticket_id: int) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT id, group_id, title, status, created_at, updated_at FROM tickets WHERE id = ?",
        (ticket_id,),
    ).fetchone()


def normalize_ids(ticket_ids: Iterable[Any]) -> list[int]:
    if not isinstance(ticket_ids, (list, tuple)):
        raise ApiError(400, "invalid_ticket_ids", "工单编号必须是数组")
    if not ticket_ids:
        raise ApiError(400, "empty_ticket_ids", "请至少选择一张工单")
    if len(ticket_ids) > 500:
        raise ApiError(400, "too_many_tickets", "单批最多 500 张工单")

    seen: set[int] = set()
    normalized: list[int] = []
    for raw in ticket_ids:
        if isinstance(raw, bool) or not isinstance(raw, int):
            raise ApiError(400, "invalid_ticket_id", "工单编号必须是整数")
        if raw <= 0:
            raise ApiError(400, "invalid_ticket_id", "工单编号必须为正整数")
        if raw in seen:
            continue
        seen.add(raw)
        normalized.append(raw)
    return normalized


# --------------------------------------------------------------------------
# 批量关闭
# --------------------------------------------------------------------------

def _visible_ticket_summary(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "ticket_id": row["id"],
        "title": row["title"],
        "status": row["status"],
        "status_label": STATUS_LABELS[row["status"]],
    }


def _judge(ticket: sqlite3.Row | None, supervisor: User) -> tuple[bool, str | None]:
    """返回 (是否可关闭, 不可关闭原因)。

    不存在的编号按组外处理，避免用编号探测工单是否存在。
    """
    if ticket is None:
        return False, "no_permission"
    if ticket["group_id"] != supervisor.group_id:
        return False, "no_permission"
    if ticket["status"] == "archived":
        return False, "archived"
    if ticket["status"] == "closed":
        return False, "already_closed"
    if ticket["status"] not in CLOSABLE_STATUSES:
        return False, "invalid_status"
    return True, None


def preview_batch(
    conn: sqlite3.Connection, supervisor: User, ticket_ids: Iterable[Any]
) -> dict[str, Any]:
    if not supervisor.is_supervisor:
        raise ApiError(403, "not_supervisor", "只有主管可以批量关闭工单")
    ids = normalize_ids(ticket_ids)
    items: list[dict[str, Any]] = []
    closable_count = 0
    for ticket_id in ids:
        row = get_ticket(conn, ticket_id)
        closable, reason = _judge(row, supervisor)
        if closable:
            closable_count += 1
            items.append({**_visible_ticket_summary(row), "closable": True})
            continue
        if reason in NO_CONTENT_REASONS:
            items.append(
                {"ticket_id": ticket_id, "closable": False, "reason": reason}
            )
        else:
            assert row is not None  # 非组外原因必然取到了工单
            items.append(
                {
                    **_visible_ticket_summary(row),
                    "closable": False,
                    "reason": reason,
                }
            )
    return {
        "total": len(ids),
        "closable_count": closable_count,
        "items": items,
    }


def _request_hash(ids: list[int]) -> str:
    # 顺序无关：同一组编号换个顺序仍视为同一批，可安全重放
    payload = json.dumps({"ticket_ids": sorted(ids)}, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def close_batch(
    conn: sqlite3.Connection,
    supervisor: User,
    ticket_ids: Iterable[Any],
    batch_key: str,
) -> dict[str, Any]:
    if not supervisor.is_supervisor:
        raise ApiError(403, "not_supervisor", "只有主管可以批量关闭工单")
    if not isinstance(batch_key, str) or not batch_key.strip():
        raise ApiError(400, "invalid_batch_key", "缺少批次标识 batch_key")
    batch_key = batch_key.strip()
    if len(batch_key) > 128:
        raise ApiError(400, "invalid_batch_key", "批次标识过长")
    ids = normalize_ids(ticket_ids)
    digest = _request_hash(ids)

    with transaction(conn):
        existing = conn.execute(
            """
            SELECT id, request_hash, result_json FROM close_batches
            WHERE supervisor_id = ? AND batch_key = ?
            """,
            (supervisor.id, batch_key),
        ).fetchone()
        if existing:
            if existing["request_hash"] != digest:
                raise ApiError(
                    409,
                    "batch_key_conflict",
                    "该批次标识已用于另一批不同的工单，请更换批次标识",
                )
            result = json.loads(existing["result_json"])
            result["replayed"] = True
            return result

        now = utc_now()
        # 先占住 (主管, batch_key)：唯一约束保证同一批只落一条批次记录
        cursor = conn.execute(
            """
            INSERT INTO close_batches
                (supervisor_id, batch_key, request_hash, created_at, result_json)
            VALUES (?, ?, ?, ?, '{}')
            """,
            (supervisor.id, batch_key, digest, now),
        )
        batch_id = int(cursor.lastrowid)

        closed: list[dict[str, Any]] = []
        unprocessed: list[dict[str, Any]] = []

        for ticket_id in ids:
            row = get_ticket(conn, ticket_id)
            closable, reason = _judge(row, supervisor)
            if not closable:
                if reason in NO_CONTENT_REASONS:
                    unprocessed.append({"ticket_id": ticket_id, "reason": reason})
                else:
                    assert row is not None
                    unprocessed.append(
                        {
                            "ticket_id": ticket_id,
                            "reason": reason,
                            "title": row["title"],
                            "status": row["status"],
                            "status_label": STATUS_LABELS[row["status"]],
                        }
                    )
                continue

            assert row is not None
            # 条件更新：执行时重新确认小组与状态，避免并发下越权
            cursor = conn.execute(
                """
                UPDATE tickets
                SET status = 'closed', updated_at = ?
                WHERE id = ? AND group_id = ? AND status IN ('open', 'processing')
                """,
                (now, ticket_id, supervisor.group_id),
            )
            if cursor.rowcount != 1:
                # 读与写之间被并发改了（转组/关闭）：重新判定，避免把旧归属写进结果
                latest = get_ticket(conn, ticket_id)
                _, latest_reason = _judge(latest, supervisor)
                unprocessed.append(
                    {"ticket_id": ticket_id, "reason": latest_reason or "state_changed"}
                )
                continue
            try:
                conn.execute(
                    """
                    INSERT INTO close_records
                        (batch_id, ticket_id, supervisor_id, from_status, created_at)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (batch_id, ticket_id, supervisor.id, row["status"], now),
                )
            except sqlite3.IntegrityError:
                # 已有历史关闭记录：撤销本次状态更新，保证一张工单只有一条关闭记录
                conn.execute(
                    "UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?",
                    (row["status"], row["updated_at"], ticket_id),
                )
                unprocessed.append(
                    {
                        "ticket_id": ticket_id,
                        "reason": "already_closed",
                        "title": row["title"],
                        "status": "closed",
                        "status_label": STATUS_LABELS["closed"],
                    }
                )
                continue
            conn.execute(
                """
                INSERT INTO ticket_audit
                    (ticket_id, action, from_value, to_value, actor_id, created_at)
                VALUES (?, 'close', ?, 'closed', ?, ?)
                """,
                (ticket_id, row["status"], supervisor.id, now),
            )
            closed.append({"ticket_id": ticket_id, "title": row["title"]})

        result = {
            "batch_id": batch_id,
            "batch_key": batch_key,
            "replayed": False,
            "closed": closed,
            "unprocessed": unprocessed,
            "closed_count": len(closed),
            "unprocessed_count": len(unprocessed),
        }
        conn.execute(
            "UPDATE close_batches SET result_json = ? WHERE id = ?",
            (json.dumps(result, ensure_ascii=False), batch_id),
        )
        return result


# --------------------------------------------------------------------------
# 管理操作：转移工单、批次与审计查询
# --------------------------------------------------------------------------

def transfer_ticket(
    conn: sqlite3.Connection, actor: User, ticket_id: int, to_group_id: int
) -> dict[str, Any]:
    if not actor.is_admin:
        raise ApiError(403, "not_admin", "只有管理员可以转移工单")
    with transaction(conn):
        row = get_ticket(conn, ticket_id)
        if row is None:
            raise ApiError(404, "ticket_not_found", "工单不存在")
        if row["status"] == "archived":
            # 归档即冻结：连管理员也不再改动其归属
            raise ApiError(409, "ticket_archived", "工单已归档，不能转移")
        group = conn.execute(
            "SELECT id, name FROM work_groups WHERE id = ?", (to_group_id,)
        ).fetchone()
        if group is None:
            raise ApiError(404, "group_not_found", "目标小组不存在")
        if row["group_id"] == to_group_id:
            return {
                "ticket_id": row["id"],
                "group_id": to_group_id,
                "group_name": group["name"],
                "changed": False,
            }
        now = utc_now()
        conn.execute(
            "UPDATE tickets SET group_id = ?, updated_at = ? WHERE id = ?",
            (to_group_id, now, ticket_id),
        )
        conn.execute(
            """
            INSERT INTO ticket_audit
                (ticket_id, action, from_value, to_value, actor_id, created_at)
            VALUES (?, 'transfer', ?, ?, ?, ?)
            """,
            (ticket_id, str(row["group_id"]), str(to_group_id), actor.id, now),
        )
        return {
            "ticket_id": row["id"],
            "group_id": to_group_id,
            "group_name": group["name"],
            "changed": True,
        }


def list_groups(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = conn.execute("SELECT id, name FROM work_groups ORDER BY id").fetchall()
    return [{"id": r["id"], "name": r["name"]} for r in rows]


def get_batch(conn: sqlite3.Connection, supervisor: User, batch_id: int) -> dict[str, Any]:
    row = conn.execute(
        "SELECT id, supervisor_id, batch_key, created_at, result_json FROM close_batches WHERE id = ?",
        (batch_id,),
    ).fetchone()
    if row is None or (
        not supervisor.is_admin and row["supervisor_id"] != supervisor.id
    ):
        raise ApiError(404, "batch_not_found", "批次不存在")
    result = json.loads(row["result_json"])
    result["batch_id"] = row["id"]
    result["created_at"] = row["created_at"]
    return result


def audit_log(conn: sqlite3.Connection, ticket_id: int) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT action, from_value, to_value, actor_id, created_at
        FROM ticket_audit WHERE ticket_id = ? ORDER BY id ASC
        """,
        (ticket_id,),
    ).fetchall()
    return [dict(r) for r in rows]


def count_close_records(conn: sqlite3.Connection, ticket_id: int) -> int:
    return conn.execute(
        "SELECT COUNT(*) FROM close_records WHERE ticket_id = ?", (ticket_id,)
    ).fetchone()[0]


# --------------------------------------------------------------------------
# 基础写操作（用于初始化与测试）
# --------------------------------------------------------------------------

def create_group(conn: sqlite3.Connection, name: str) -> int:
    cursor = conn.execute("INSERT INTO work_groups (name) VALUES (?)", (name,))
    return int(cursor.lastrowid)


def create_user(
    conn: sqlite3.Connection,
    username: str,
    password: str,
    role: str,
    group_id: int | None = None,
) -> int:
    if role not in ("admin", "supervisor", "agent"):
        raise ValueError(f"未知角色: {role}")
    cursor = conn.execute(
        """
        INSERT INTO users (username, password_hash, role, group_id, created_at)
        VALUES (?, ?, ?, ?, ?)
        """,
        (username, security.hash_password(password), role, group_id, utc_now()),
    )
    return int(cursor.lastrowid)


def create_ticket(
    conn: sqlite3.Connection,
    group_id: int,
    title: str,
    status: str = "open",
) -> int:
    if status not in ALL_STATUSES:
        raise ValueError(f"非法状态: {status}")
    now = utc_now()
    cursor = conn.execute(
        """
        INSERT INTO tickets (group_id, title, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        """,
        (group_id, title, status, now, now),
    )
    return int(cursor.lastrowid)


def set_ticket_status(conn: sqlite3.Connection, ticket_id: int, status: str) -> None:
    conn.execute(
        "UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?",
        (status, utc_now(), ticket_id),
    )

