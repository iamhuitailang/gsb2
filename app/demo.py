"""Seed and demo: two organisations, six ordinary admin audit records.

Scenario
--------
* Org ``org-alpha`` (admin 甲 / ``jia``): three records (grant, revoke,
  failed grant).
* Org ``org-beta`` (admin 乙 / ``yi``): three records.

Then:
1. 甲 exports the three org-alpha records -> verification says order and
   content match.
2. A copy containing only the last two org-alpha records -> verification
   reports the missing first segment.
3. The original audit page still shows all three records.

Usage::

    python -m app.demo [--data-dir data] [--reset]
"""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

from .auth import hash_password
from .report import build_bundle, verify_bundle, write_bundle
from .service import Actor, PermissionDenied, RoleService
from .store import Store

ORG_ALPHA = "org-alpha"
ORG_BETA = "org-beta"
PASSWORD = "Demo-Passw0rd!"


def seed(store: Store) -> None:
    """Create the demo database from scratch.

    Audit records are append-only in normal operation, so seeding refuses to
    touch a database that already has data; use ``--reset`` to start over.
    """
    store.initialize()
    existing = store.list_audit(ORG_ALPHA) + store.list_audit(ORG_BETA)
    if existing:
        raise SystemExit("演示数据库已存在审计记录；如需重建请使用 --reset")
    if store.get_org(ORG_ALPHA) is not None:
        return
    with store.tx() as conn:
        conn.executemany(
            "INSERT INTO orgs (org_id, name, rule_set) VALUES (?, ?, ?)",
            [
                (ORG_ALPHA, "甲公司", "rbac-cn-2026.1"),
                (ORG_BETA, "乙公司", "rbac-cn-2026.2"),
            ],
        )
        conn.executemany(
            """
            INSERT INTO admins
                (admin_id, username, display_name, org_id, password_hash, is_super)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            [
                ("admin-jia", "jia", "甲管理员", ORG_ALPHA, hash_password(PASSWORD), 0),
                ("admin-yi", "yi", "乙管理员", ORG_BETA, hash_password(PASSWORD), 0),
            ],
        )


def build_records(store: Store) -> None:
    service = RoleService(store)
    jia = Actor("admin-jia", "jia", ORG_ALPHA)
    yi = Actor("admin-yi", "yi", ORG_BETA)

    # Org alpha: exactly three ordinary admin records.
    service.grant_role(
        jia, org_id=ORG_ALPHA, subject="user-1001", role="operator",
        reason="新入职运维",
    )
    service.revoke_role(
        jia, org_id=ORG_ALPHA, subject="user-1001", role="operator",
        reason="调岗",
    )
    try:
        service.grant_role(
            jia, org_id=ORG_ALPHA, subject="admin-jia", role="org_admin",
            reason="尝试给自己授予组织管理员角色",
        )
    except PermissionDenied:
        pass

    # Org beta: three records under its own rule set.
    service.grant_role(
        yi, org_id=ORG_BETA, subject="user-2001", role="viewer",
        reason="外部审计只读",
    )
    service.grant_role(
        yi, org_id=ORG_BETA, subject="user-2001", role="billing",
        reason="负责计费",
    )
    try:
        service.revoke_role(
            yi, org_id=ORG_BETA, subject="user-2001", role="billing",
            reason="尝试收回受保护角色",
        )
    except PermissionDenied:
        pass


def run_demo(store: Store, copies_dir: Path) -> dict:
    copies_dir.mkdir(parents=True, exist_ok=True)
    for stale in copies_dir.glob("*.json"):
        stale.unlink()

    alpha = store.list_audit(ORG_ALPHA)
    beta = store.list_audit(ORG_BETA)
    assert len(alpha) == 3, f"org-alpha 应有 3 条审计记录，实际 {len(alpha)}"
    assert len(beta) == 3, f"org-beta 应有 3 条审计记录，实际 {len(beta)}"

    full = build_bundle(store, ORG_ALPHA, exported_by="jia")
    full_path = write_bundle(full, copies_dir / "org-alpha-full.json")

    trimmed = build_bundle(store, ORG_ALPHA, first_seq=alpha[1]["seq"], exported_by="jia")
    trimmed_path = write_bundle(trimmed, copies_dir / "org-alpha-tail-only.json")

    full_report = verify_bundle(
        json.loads(full_path.read_text("utf-8")),
        store.baseline_path,
        live_db_path=store.db_path,
        expected_org_id=ORG_ALPHA,
    )
    trimmed_report = verify_bundle(
        json.loads(trimmed_path.read_text("utf-8")),
        store.baseline_path,
        live_db_path=store.db_path,
        expected_org_id=ORG_ALPHA,
    )
    after = store.list_audit(ORG_ALPHA)

    return {
        "alpha_sequences": [r["seq"] for r in alpha],
        "beta_sequences": [r["seq"] for r in beta],
        "beta_actions": [f"{r['action']}:{r['outcome']}" for r in beta],
        "full_copy": str(full_path),
        "full_report_status": full_report["status"],
        "full_report_summary": full_report["summary"],
        "full_report_errors": full_report["errors"],
        "tail_copy": str(trimmed_path),
        "tail_report_status": trimmed_report["status"],
        "tail_report_summary": trimmed_report["summary"],
        "tail_report_missing": trimmed_report["missing_ranges"],
        "audit_page_after": [r["seq"] for r in after],
        "audit_page_count_unchanged": len(after) == len(alpha),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="gsb2 demo seed and verification")
    parser.add_argument("--data-dir", default="data", type=Path)
    parser.add_argument("--reset", action="store_true", help="delete existing data first")
    args = parser.parse_args(argv)

    data_dir: Path = args.data_dir
    if args.reset and data_dir.exists():
        shutil.rmtree(data_dir)
    store = Store(data_dir / "gsb2.db", data_dir / "audit-baseline.db")
    store.initialize()
    seed(store)
    build_records(store)
    result = run_demo(store, data_dir / "exports")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
