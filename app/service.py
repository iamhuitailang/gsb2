"""成员管理业务逻辑。

不变量：一个机构始终至少保留一名“有效管理员”
（role='admin' 且 is_active=1 的在册成员）。

所有会改变成员身份/角色/状态的操作，都在同一个 ``BEGIN IMMEDIATE``
事务内完成“剩余管理员检查 + 实际写入”，并在 audit_logs 中留痕
（成功与被拦截都记录，被拦截的原因写入 detail）。
"""

from __future__ import annotations

import secrets
import sqlite3
from dataclasses import dataclass

from . import db


class ServiceError(Exception):
    """业务校验失败（例如操作后将没有有效管理员）。"""


@dataclass
class ActionResult:
    ok: bool
    message: str


# ---------------------------------------------------------------- 读取辅助

def get_user_by_username(conn: sqlite3.Connection, username: str) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM users WHERE username = ?", (username,)
    ).fetchone()


def count_active_admins(conn: sqlite3.Connection, org_id: int) -> int:
    """有效管理员数：在册 + admin 角色 + 未停用。停用账号不计入。"""
    row = conn.execute(
        "SELECT COUNT(*) AS n FROM memberships "
        "WHERE org_id = ? AND role = 'admin' AND is_active = 1",
        (org_id,),
    ).fetchone()
    return row["n"]


def list_members(conn: sqlite3.Connection, org_id: int) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT m.id AS membership_id, m.role, m.is_active, m.joined_at, "
        "u.id AS user_id, u.username, u.display_name "
        "FROM memberships m JOIN users u ON u.id = m.user_id "
        "WHERE m.org_id = ? ORDER BY m.id",
        (org_id,),
    ).fetchall()


def get_membership(
    conn: sqlite3.Connection, org_id: int, user_id: int
) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM memberships WHERE org_id = ? AND user_id = ?",
        (org_id, user_id),
    ).fetchone()


def list_user_orgs(conn: sqlite3.Connection, user_id: int) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT o.id, o.name, m.role, m.is_active "
        "FROM memberships m JOIN orgs o ON o.id = m.org_id "
        "WHERE m.user_id = ? ORDER BY o.id",
        (user_id,),
    ).fetchall()


def list_audit_logs(conn: sqlite3.Connection, org_id: int) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT l.*, ua.display_name AS actor_name, ut.display_name AS target_name "
        "FROM audit_logs l "
        "LEFT JOIN users ua ON ua.id = l.actor_user_id "
        "LEFT JOIN users ut ON ut.id = l.target_user_id "
        "WHERE l.org_id = ? ORDER BY l.id DESC LIMIT 200",
        (org_id,),
    ).fetchall()


# ---------------------------------------------------------------- 审计留痕

def _audit(
    conn: sqlite3.Connection,
    *,
    org_id: int | None,
    actor_user_id: int | None,
    target_user_id: int | None,
    action: str,
    result: str,
    detail: str,
) -> None:
    conn.execute(
        "INSERT INTO audit_logs "
        "(org_id, actor_user_id, target_user_id, action, result, detail) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (org_id, actor_user_id, target_user_id, action, result, detail),
    )


# ---------------------------------------------------------------- 登录/会话

def login(db_path, username: str, password: str) -> tuple[str, sqlite3.Row]:
    """成功返回 (session_token, user_row)，失败抛 ServiceError。"""
    conn = db.connect(db_path)
    try:
        user = get_user_by_username(conn, username)
        if user is None or not db.verify_password(password, user["password_hash"]):
            raise ServiceError("用户名或密码不正确")
        token = secrets.token_urlsafe(32)
        conn.execute(
            "INSERT INTO sessions (token, user_id) VALUES (?, ?)",
            (token, user["id"]),
        )
        return token, user
    finally:
        conn.close()


def get_session_user(db_path, token: str | None) -> sqlite3.Row | None:
    if not token:
        return None
    conn = db.connect(db_path)
    try:
        return conn.execute(
            "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id "
            "WHERE s.token = ?",
            (token,),
        ).fetchone()
    finally:
        conn.close()


def logout(db_path, token: str | None) -> None:
    if not token:
        return
    conn = db.connect(db_path)
    try:
        conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
    finally:
        conn.close()


# ---------------------------------------------------------------- 权限校验

def _require_active_admin(
    conn: sqlite3.Connection, org_id: int, actor_id: int
) -> sqlite3.Row:
    """操作者必须是本机构未停用的管理员，否则拒绝。"""
    membership = get_membership(conn, org_id, actor_id)
    if membership is None:
        raise ServiceError("你不在该机构中，无权操作")
    if membership["role"] != "admin":
        raise ServiceError("只有机构管理员可以管理成员")
    if not membership["is_active"]:
        raise ServiceError("你的账号已在本机构停用，无权操作")
    return membership


def _require_target_in_org(
    conn: sqlite3.Connection, org_id: int, target_id: int
) -> sqlite3.Row:
    membership = get_membership(conn, org_id, target_id)
    if membership is None:
        raise ServiceError("目标成员不在该机构中")
    return membership


def _names(conn: sqlite3.Connection, *user_ids: int) -> dict[int, str]:
    if not user_ids:
        return {}
    placeholders = ",".join("?" * len(user_ids))
    rows = conn.execute(
        f"SELECT id, display_name FROM users WHERE id IN ({placeholders})",
        tuple(user_ids),
    ).fetchall()
    return {row["id"]: row["display_name"] for row in rows}


# ---------------------------------------------------------------- 变更操作

def _run_mutation(db_path, org_id: int, actor_id: int, action: str, target_id: int,
                  apply_change, *, end_state_desc: str) -> ActionResult:
    """通用事务骨架：BEGIN IMMEDIATE 后在同一事务内检查并写入。

    apply_change(conn) 返回 (would_lose_admin: bool, change_summary: str)。
    被拦截时不执行任何成员变更，但仍写入一条 blocked 审计记录并提交。
    """
    conn = db.connect(db_path)
    try:
        conn.execute("BEGIN IMMEDIATE")  # 立即获取写锁，串行化并发变更
        _require_active_admin(conn, org_id, actor_id)
        target = _require_target_in_org(conn, org_id, target_id)
        would_lose, change_summary = apply_change(conn, target)
        names = _names(conn, actor_id, target_id)
        if would_lose:
            remaining = count_active_admins(conn, org_id)
            reason = (
                f"操作被拒绝：{names[target_id]}{end_state_desc}后，"
                f"机构将没有任何可登录的有效管理员（当前有效管理员 {remaining} 名，"
                "停用的账号不计入）。请先保留或补充至少一名有效管理员。"
            )
            _audit(
                conn, org_id=org_id, actor_user_id=actor_id,
                target_user_id=target_id, action=action, result="blocked",
                detail=f"未执行任何变更。原因：{reason}",
            )
            conn.execute("COMMIT")
            return ActionResult(False, reason)
        _audit(
            conn, org_id=org_id, actor_user_id=actor_id,
            target_user_id=target_id, action=action, result="success",
            detail=change_summary,
        )
        conn.execute("COMMIT")
        return ActionResult(True, change_summary)
    except ServiceError:
        conn.execute("ROLLBACK")
        raise
    except Exception:
        conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()


def leave_org(db_path, org_id: int, actor_id: int) -> ActionResult:
    """管理员自己退出机构（移除自己的成员关系）。"""

    def apply_change(conn: sqlite3.Connection, target: sqlite3.Row):
        remaining_admins = count_active_admins(conn, org_id)
        is_active_admin = target["role"] == "admin" and target["is_active"] == 1
        would_lose = is_active_admin and remaining_admins <= 1
        names = _names(conn, actor_id)
        summary = (
            f"{names[actor_id]} 退出机构，其成员关系已移除"
            f"（退出前有效管理员 {remaining_admins} 名）"
        )
        if not would_lose:
            conn.execute(
                "DELETE FROM memberships WHERE org_id = ? AND user_id = ?",
                (org_id, actor_id),
            )
        return would_lose, summary

    return _run_mutation(
        db_path, org_id, actor_id, "leave", actor_id, apply_change,
        end_state_desc="退出机构",
    )


def set_role(db_path, org_id: int, actor_id: int, target_id: int,
             new_role: str) -> ActionResult:
    if new_role not in ("admin", "member"):
        raise ServiceError("角色只能是 admin 或 member")
    action = "promote" if new_role == "admin" else "demote"

    def apply_change(conn: sqlite3.Connection, target: sqlite3.Row):
        old_role = target["role"]
        names = _names(conn, target_id)
        if old_role == new_role:
            return False, f"{names[target_id]} 的角色已经是{_role_label(new_role)}，无变化"
        # 只有“管理员 -> 普通成员”的降级才可能减少有效管理员数。
        would_lose = (
            old_role == "admin"
            and target["is_active"] == 1
            and count_active_admins(conn, org_id) <= 1
        )
        if not would_lose:
            conn.execute(
                "UPDATE memberships SET role = ? WHERE org_id = ? AND user_id = ?",
                (new_role, org_id, target_id),
            )
        summary = (
            f"{names[target_id]} 角色由{_role_label(old_role)}"
            f"调整为{_role_label(new_role)}"
        )
        return would_lose, summary

    return _run_mutation(
        db_path, org_id, actor_id, action, target_id, apply_change,
        end_state_desc="被降级为普通成员",
    )


def set_active(db_path, org_id: int, actor_id: int, target_id: int,
               active: bool) -> ActionResult:
    action = "activate" if active else "disable"

    def apply_change(conn: sqlite3.Connection, target: sqlite3.Row):
        old_active = bool(target["is_active"])
        names = _names(conn, target_id)
        if old_active == active:
            state = "启用" if active else "停用"
            return False, f"{names[target_id]} 已经处于{state}状态，无变化"
        # 停用一名有效管理员可能导致无人可登录；启用不会。
        would_lose = (
            not active
            and target["role"] == "admin"
            and count_active_admins(conn, org_id) <= 1
        )
        if not would_lose:
            conn.execute(
                "UPDATE memberships SET is_active = ? WHERE org_id = ? AND user_id = ?",
                (1 if active else 0, org_id, target_id),
            )
        summary = (
            f"{names[target_id]} 账号状态由{_active_label(old_active)}"
            f"调整为{_active_label(active)}"
        )
        return would_lose, summary

    return _run_mutation(
        db_path, org_id, actor_id, action, target_id, apply_change,
        end_state_desc="被停用",
    )


def remove_member(db_path, org_id: int, actor_id: int, target_id: int) -> ActionResult:
    def apply_change(conn: sqlite3.Connection, target: sqlite3.Row):
        remaining_admins = count_active_admins(conn, org_id)
        is_active_admin = target["role"] == "admin" and target["is_active"] == 1
        would_lose = is_active_admin and remaining_admins <= 1
        names = _names(conn, target_id)
        if not would_lose:
            conn.execute(
                "DELETE FROM memberships WHERE org_id = ? AND user_id = ?",
                (org_id, target_id),
            )
        summary = f"{names[target_id]} 被移出机构，成员关系已删除"
        return would_lose, summary

    return _run_mutation(
        db_path, org_id, actor_id, "remove", target_id, apply_change,
        end_state_desc="被移除",
    )


def _role_label(role: str) -> str:
    return "管理员" if role == "admin" else "普通成员"


def _active_label(active: bool) -> str:
    return "启用" if active else "停用"
