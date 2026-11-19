"""Command-line interface: init-db / import / login / report."""

from __future__ import annotations

import argparse
import getpass
import json
import logging
import sys

from .store import Store


def _add_db(p):
    p.add_argument("--db", default="authdemo.db", help="SQLite database path")


def main(argv=None) -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    parser = argparse.ArgumentParser(
        prog="authdemo",
        description="Local demo of versioned password digest migration.",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("init-db", help="create the database schema")
    _add_db(p)

    p = sub.add_parser("import", help="import a legacy accounts JSONL file")
    p.add_argument("path")
    _add_db(p)

    p = sub.add_parser("login", help="verify a login (upgrades legacy digests)")
    p.add_argument("username")
    p.add_argument("--password", help="omit to be prompted (recommended)")
    _add_db(p)

    p = sub.add_parser("report", help="admin view of migration state")
    p.add_argument("--json", action="store_true", help="machine-readable output")
    _add_db(p)

    p = sub.add_parser("events", help="show the audit/migration event log")
    p.add_argument("--username")
    _add_db(p)

    args = parser.parse_args(argv)

    if args.cmd == "init-db":
        Store(args.db)
        print(f"database ready: {args.db}")
        return 0

    if args.cmd == "import":
        report = Store(args.db).import_jsonl(args.path)
        print(json.dumps(report, indent=2, ensure_ascii=False))
        return 0

    if args.cmd == "login":
        password = args.password or getpass.getpass("Password: ")
        result = Store(args.db).login(args.username, password)
        if result.ok:
            note = " (digest upgraded to current format)" if result.migrated else ""
            print(f"login OK{note}")
            return 0
        # Deliberately vague: never reveal whether the account exists.
        print("login failed: invalid credentials or unavailable account")
        return 1

    if args.cmd == "report":
        rows = Store(args.db).report()
        if args.json:
            print(json.dumps(rows, indent=2, ensure_ascii=False))
            return 0
        print(f"{'username':<16} {'version':<8} {'state':<14} "
              f"{'logins':<7} migrated_at")
        print("-" * 70)
        for r in rows:
            print(f"{r['username']:<16} "
                  f"{str(r['digest_version']):<8} "
                  f"{r['migration_state']:<14} "
                  f"{r['login_count']:<7} "
                  f"{r['migrated_at'] or ''}")
        counts = {}
        for r in rows:
            counts[r["migration_state"]] = counts.get(r["migration_state"], 0) + 1
        print("-" * 70)
        print("summary: " + ", ".join(f"{k}={v}" for k, v in sorted(counts.items())))
        return 0

    if args.cmd == "events":
        events = Store(args.db).migration_events(args.username)
        print(json.dumps(events, indent=2, ensure_ascii=False))
        return 0

    return 2


if __name__ == "__main__":
    sys.exit(main())
