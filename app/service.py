"""Role management operations, including failure auditing.

Every public operation writes exactly one audit record.  On success the
role assignment change and its audit record (plus baseline commitment) commit
in a single transaction.  On failure the rejected change is discarded while
the failure record is still committed: validation runs inside the
transaction, but the exception is raised only after the transaction has
committed the audit record.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from typing import Any

from .canonical import utc_now_iso
from .rules import get_rule_set, rule_set_digest
from .store import AuditError, Store


class PermissionDenied(Exception):
    pass


@dataclass(frozen=True)
class Actor:
    admin_id: str
    username: str
    org_id: str | None
    is_super: bool = False

    @property
    def label(self) -> str:
        return self.username


class RoleService:
    def __init__(self, store: Store) -> None:
        self.store = store

    # -- authorisation -------------------------------------------------------

    def _org(self, org_id: str) -> dict[str, Any]:
        org = self.store.get_org(org_id)
        if org is None:
            raise KeyError(f"unknown organisation: {org_id}")
        return org

    def _check_admin_scope(self, actor: Actor, org_id: str) -> None:
        """Normal admins are confined to their own organisation.

        A denied cross-organisation attempt still leaves a trace, written to
        the actor's own organisation when the actor belongs to one.
        """
        if actor.is_super or actor.org_id == org_id:
            return
        if actor.org_id:
            org = self.store.get_org(actor.org_id)
            if org is not None:
                try:
                    with self.store.tx() as conn:
                        self.store.append_audit(
                            conn,
                            org_id=actor.org_id,
                            action="access.denied",
                            outcome="failure",
                            actor=actor.label,
                            target=org_id,
                            role=None,
                            changes={"before": None, "after": None},
                            rule_set=org["rule_set"],
                            detail={
                                "error_code": "cross_org_denied",
                                "rule": "管理员只能操作本组织",
                                "requested_org": org_id,
                            },
                        )
                except (AuditError, OSError, sqlite3.Error):
                    # Never let a best-effort denial trace mask the denial.
                    pass
        raise PermissionDenied("管理员只能操作本组织")

    # -- operations ----------------------------------------------------------

    def grant_role(
        self,
        actor: Actor,
        *,
        org_id: str,
        subject: str,
        role: str,
        reason: str | None = None,
    ) -> dict[str, Any]:
        self._check_admin_scope(actor, org_id)
        org = self._org(org_id)
        rule_set = org["rule_set"]
        rules = get_rule_set(rule_set)
        detail: dict[str, Any] = {
            "subject": subject,
            "role": role,
            "rule_set_digest": rule_set_digest(rule_set),
        }

        record: dict[str, Any] | None = None
        error: str | None = None
        with self.store.tx() as conn:
            current = _current_roles(conn, org_id, subject)
            if not subject.strip():
                error = "被授权主体不能为空"
            elif role not in rules["allowed_roles"]:
                error = f"角色 {role!r} 不在规则集 {rule_set} 的允许列表中"
            elif not rules["allow_self_change"] and subject == actor.admin_id:
                error = "不允许修改自己的角色"
            elif role in current:
                error = "角色已存在，重复授予被拒绝"
            elif len(current) >= rules["max_roles_per_subject"]:
                error = f"超出角色上限 {rules['max_roles_per_subject']}"

            if error is not None:
                detail["error_code"] = "policy_rejected"
                detail["rule"] = error
                self.store.append_audit(
                    conn,
                    org_id=org_id,
                    action="role.grant",
                    outcome="failure",
                    actor=actor.label,
                    target=subject,
                    role=role,
                    changes={"before": list(current), "after": None},
                    rule_set=rule_set,
                    reason=reason,
                    detail=detail,
                )
            else:
                granted_at = utc_now_iso()
                conn.execute(
                    """
                    INSERT INTO role_assignments
                        (org_id, subject, role, granted_at, granted_by)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (org_id, subject, role, granted_at, actor.label),
                )
                record = self.store.append_audit(
                    conn,
                    org_id=org_id,
                    action="role.grant",
                    outcome="success",
                    actor=actor.label,
                    target=subject,
                    role=role,
                    changes={
                        "before": sorted(current),
                        "after": sorted([*current, role]),
                        "granted_at": granted_at,
                    },
                    rule_set=rule_set,
                    reason=reason,
                    detail=detail,
                )
        if error is not None:
            raise PermissionDenied(error)
        assert record is not None
        return record

    def revoke_role(
        self,
        actor: Actor,
        *,
        org_id: str,
        subject: str,
        role: str,
        reason: str | None = None,
    ) -> dict[str, Any]:
        self._check_admin_scope(actor, org_id)
        org = self._org(org_id)
        rule_set = org["rule_set"]
        rules = get_rule_set(rule_set)
        detail: dict[str, Any] = {
            "subject": subject,
            "role": role,
            "rule_set_digest": rule_set_digest(rule_set),
        }

        record: dict[str, Any] | None = None
        error: str | None = None
        with self.store.tx() as conn:
            current = _current_roles(conn, org_id, subject)
            if not subject.strip():
                error = "被操作主体不能为空"
            elif role in rules["protected_roles"]:
                error = f"角色 {role!r} 受规则集 {rule_set} 保护，不能收回"
            elif not rules["allow_self_change"] and subject == actor.admin_id:
                error = "不允许修改自己的角色"
            elif role not in current:
                error = "该主体没有此角色，收回请求被拒绝"

            if error is not None:
                detail["error_code"] = "policy_rejected"
                detail["rule"] = error
                self.store.append_audit(
                    conn,
                    org_id=org_id,
                    action="role.revoke",
                    outcome="failure",
                    actor=actor.label,
                    target=subject,
                    role=role,
                    changes={"before": list(current), "after": None},
                    rule_set=rule_set,
                    reason=reason,
                    detail=detail,
                )
            else:
                conn.execute(
                    "DELETE FROM role_assignments"
                    " WHERE org_id = ? AND subject = ? AND role = ?",
                    (org_id, subject, role),
                )
                record = self.store.append_audit(
                    conn,
                    org_id=org_id,
                    action="role.revoke",
                    outcome="success",
                    actor=actor.label,
                    target=subject,
                    role=role,
                    changes={
                        "before": sorted(current),
                        "after": sorted(set(current) - {role}),
                        "revoked_at": utc_now_iso(),
                    },
                    rule_set=rule_set,
                    reason=reason,
                    detail=detail,
                )
        if error is not None:
            raise PermissionDenied(error)
        assert record is not None
        return record

    def change_role(
        self,
        actor: Actor,
        *,
        org_id: str,
        subject: str,
        old_role: str,
        new_role: str,
        reason: str | None = None,
    ) -> dict[str, Any]:
        """Atomic replace: revoke *old_role* and grant *new_role*.

        Either both the permission change and the audit record land, or
        neither does.
        """
        self._check_admin_scope(actor, org_id)
        org = self._org(org_id)
        rule_set = org["rule_set"]
        rules = get_rule_set(rule_set)
        detail: dict[str, Any] = {
            "subject": subject,
            "old_role": old_role,
            "new_role": new_role,
            "rule_set_digest": rule_set_digest(rule_set),
        }

        record: dict[str, Any] | None = None
        error: str | None = None
        with self.store.tx() as conn:
            current = _current_roles(conn, org_id, subject)
            if not subject.strip():
                error = "被操作主体不能为空"
            elif old_role not in current:
                error = "该主体没有要替换的角色"
            elif new_role not in rules["allowed_roles"]:
                error = f"角色 {new_role!r} 不在规则集 {rule_set} 的允许列表中"
            elif old_role in rules["protected_roles"]:
                error = f"角色 {old_role!r} 受规则集 {rule_set} 保护，不能替换"
            elif not rules["allow_self_change"] and subject == actor.admin_id:
                error = "不允许修改自己的角色"
            elif new_role in current:
                error = "目标角色已存在"

            if error is not None:
                detail["error_code"] = "policy_rejected"
                detail["rule"] = error
                self.store.append_audit(
                    conn,
                    org_id=org_id,
                    action="role.change",
                    outcome="failure",
                    actor=actor.label,
                    target=subject,
                    role=new_role,
                    changes={"before": list(current), "after": None},
                    rule_set=rule_set,
                    reason=reason,
                    detail=detail,
                )
            else:
                granted_at = utc_now_iso()
                conn.execute(
                    "DELETE FROM role_assignments"
                    " WHERE org_id = ? AND subject = ? AND role = ?",
                    (org_id, subject, old_role),
                )
                conn.execute(
                    """
                    INSERT INTO role_assignments
                        (org_id, subject, role, granted_at, granted_by)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (org_id, subject, new_role, granted_at, actor.label),
                )
                record = self.store.append_audit(
                    conn,
                    org_id=org_id,
                    action="role.change",
                    outcome="success",
                    actor=actor.label,
                    target=subject,
                    role=new_role,
                    changes={
                        "before": sorted(current),
                        "after": sorted((set(current) - {old_role}) | {new_role}),
                        "old_role": old_role,
                        "new_role": new_role,
                        "granted_at": granted_at,
                    },
                    rule_set=rule_set,
                    reason=reason,
                    detail=detail,
                )
        if error is not None:
            raise PermissionDenied(error)
        assert record is not None
        return record


def _current_roles(conn: Any, org_id: str, subject: str) -> list[str]:
    return [
        row["role"]
        for row in conn.execute(
            "SELECT role FROM role_assignments WHERE org_id = ? AND subject = ?"
            " ORDER BY role",
            (org_id, subject),
        )
    ]
