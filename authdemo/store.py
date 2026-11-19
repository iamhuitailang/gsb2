"""SQLite-backed account store: import, login verification, digest migration.

Safety rules enforced here:
  * Plaintext passwords are never stored, logged, or returned.
  * Failed logins perform no writes to account rows.
  * Digest upgrades use a compare-and-swap UPDATE keyed on the old digest,
    so a slow concurrent legacy login cannot overwrite an already-upgraded
    digest, and the upgrade touches only digest/version/migrated_at —
    never other account state such as login_count.
  * Audit records and log lines carry usernames and version numbers only:
    no passwords, no full digests.
"""

from __future__ import annotations

import contextlib
import json
import logging
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone

from . import digest

log = logging.getLogger("authdemo")

SCHEMA = """
CREATE TABLE IF NOT EXISTS accounts (
    username          TEXT PRIMARY KEY,
    digest            TEXT,              -- NULL for needs_review rows
    version           INTEGER,           -- parsed digest version, NULL if unknown
    imported_version  INTEGER,           -- version as first imported
    status            TEXT NOT NULL,     -- 'active' | 'needs_review'
    login_count       INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT NOT NULL,
    migrated_at       TEXT
);
CREATE TABLE IF NOT EXISTS migration_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    username     TEXT NOT NULL,
    event        TEXT NOT NULL,
    from_version INTEGER,
    to_version   INTEGER,
    detail       TEXT,                   -- never contains passwords or digests
    ts           TEXT NOT NULL
);
"""

STATUS_ACTIVE = "active"
STATUS_NEEDS_REVIEW = "needs_review"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@dataclass
class LoginResult:
    ok: bool
    migrated: bool
    reason: str  # 'ok' | 'invalid_credentials' | 'account_unavailable'


class Store:
    def __init__(self, db_path: str):
        self.db_path = db_path
        # Test hook: callable invoked inside _upgrade before the write.
        self.before_upgrade_write = None
        self.init_db()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout = 10000")
        return conn

    @contextlib.contextmanager
    def _tx(self):
        """Connection as a commit-on-success block that always closes."""
        conn = self._connect()
        try:
            with conn:
                yield conn
        finally:
            conn.close()

    def init_db(self) -> None:
        with self._tx() as conn:
            conn.executescript(SCHEMA)

    # ------------------------------------------------------------------ audit

    def _audit(self, conn, username, event, from_version=None, to_version=None,
               detail=None):
        conn.execute(
            "INSERT INTO migration_log (username, event, from_version,"
            " to_version, detail, ts) VALUES (?,?,?,?,?,?)",
            (username, event, from_version, to_version, detail, _now()),
        )

    # ----------------------------------------------------------------- import

    def import_records(self, records) -> dict:
        """Import legacy account records (dicts with username/digest[/version]).

        Returns a report dict. Problem records become needs_review rows (if a
        username is present) or are counted as errors (if not). Existing
        usernames are never overwritten.
        """
        report = {"imported": 0, "needs_review": 0, "duplicates": 0,
                  "errors": 0, "messages": []}
        for rec in records:
            self._import_one(rec, report)
        log.info(
            "import done imported=%d needs_review=%d duplicates=%d errors=%d",
            report["imported"], report["needs_review"], report["duplicates"],
            report["errors"],
        )
        return report

    def _import_one(self, rec, report):
        if not isinstance(rec, dict) or not rec.get("username"):
            report["errors"] += 1
            report["messages"].append("record without username skipped")
            return
        username = str(rec["username"])
        raw_digest = rec.get("digest")
        declared = rec.get("version")

        problem = None
        version = None
        if raw_digest is None:
            problem = "missing digest field"
        else:
            try:
                version = digest.version_of(raw_digest)
            except digest.UnknownVersionError:
                problem = "unknown digest version"
            except digest.DigestError:
                problem = "corrupt digest record"
            else:
                if declared is not None and declared != version:
                    problem = (f"declared version {declared!r} inconsistent "
                               f"with digest format v{version}")

        with self._tx() as conn:
            exists = conn.execute(
                "SELECT 1 FROM accounts WHERE username = ?", (username,)
            ).fetchone()
            if exists:
                report["duplicates"] += 1
                self._audit(conn, username, "import_duplicate",
                            detail="duplicate import skipped")
                return

            if problem:
                report["needs_review"] += 1
                conn.execute(
                    "INSERT INTO accounts (username, digest, version,"
                    " imported_version, status, created_at)"
                    " VALUES (?,?,?,?,?,?)",
                    (username, None, None, None, STATUS_NEEDS_REVIEW, _now()),
                )
                self._audit(conn, username, "import_needs_review",
                            detail=problem)
                log.warning("import needs_review user=%s reason=%s",
                            username, problem)
                return

            report["imported"] += 1
            conn.execute(
                "INSERT INTO accounts (username, digest, version,"
                " imported_version, status, created_at)"
                " VALUES (?,?,?,?,?,?)",
                (username, raw_digest, version, version, STATUS_ACTIVE, _now()),
            )
            self._audit(conn, username, "imported", from_version=version)

    def import_jsonl(self, path: str) -> dict:
        records = []
        with open(path, "r", encoding="utf-8") as fh:
            for line_no, line in enumerate(fh, 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    records.append(json.loads(line))
                except json.JSONDecodeError:
                    records.append({"__unparseable_line__": line_no})
        return self.import_records(records)

    # ------------------------------------------------------------------ login

    def login(self, username: str, password: str) -> LoginResult:
        with self._tx() as conn:
            row = conn.execute(
                "SELECT * FROM accounts WHERE username = ?", (username,)
            ).fetchone()

        if row is None:
            log.info("login failed user=%s reason=no_such_account", username)
            return LoginResult(False, False, "invalid_credentials")

        if row["status"] != STATUS_ACTIVE or not row["digest"]:
            log.info("login failed user=%s reason=account_not_active", username)
            with self._tx() as conn:
                self._audit(conn, username, "login_rejected",
                            detail="account not active")
            return LoginResult(False, False, "account_unavailable")

        try:
            version = digest.version_of(row["digest"])
            if row["version"] != version:
                raise digest.DigestError("stored version column inconsistent")
            ok = digest.verify(row["digest"], password)
        except digest.DigestError:
            # Fail closed: unknown/corrupt/inconsistent formats never pass.
            log.warning("login failed user=%s reason=unusable_digest_format",
                        username)
            with self._tx() as conn:
                self._audit(conn, username, "login_rejected",
                            detail="unusable digest format")
            return LoginResult(False, False, "account_unavailable")

        if not ok:
            # Failed logins never write to account data.
            log.info("login failed user=%s reason=bad_password", username)
            return LoginResult(False, False, "invalid_credentials")

        with self._tx() as conn:
            conn.execute(
                "UPDATE accounts SET login_count = login_count + 1"
                " WHERE username = ?", (username,),
            )

        migrated = False
        if version < digest.CURRENT_VERSION:
            try:
                migrated = self._upgrade(username, row["digest"], version,
                                         password)
            except Exception:  # migration is best-effort; never lock user out
                log.exception("migration error user=%s", username)
                with self._tx() as conn:
                    self._audit(conn, username, "migration_failed",
                                from_version=version,
                                to_version=digest.CURRENT_VERSION)

        log.info("login ok user=%s version=%d migrated=%s",
                 username, version, migrated)
        return LoginResult(True, migrated, "ok")

    def _upgrade(self, username, old_digest, old_version, password) -> bool:
        """Atomically replace a legacy digest with the current format.

        The UPDATE only applies if the row still holds the exact digest we
        verified; if a concurrent login already upgraded it, rowcount is 0
        and we leave the newer digest alone.
        """
        if self.before_upgrade_write is not None:
            self.before_upgrade_write()
        new_digest = digest.hash_current(password)
        with self._tx() as conn:
            cur = conn.execute(
                "UPDATE accounts SET digest = ?, version = ?, migrated_at = ?"
                " WHERE username = ? AND digest = ? AND version = ?",
                (new_digest, digest.CURRENT_VERSION, _now(),
                 username, old_digest, old_version),
            )
            if cur.rowcount == 1:
                self._audit(conn, username, "migrated",
                            from_version=old_version,
                            to_version=digest.CURRENT_VERSION)
                log.info("digest upgraded user=%s v%d->v%d",
                         username, old_version, digest.CURRENT_VERSION)
                return True
            self._audit(conn, username, "migration_skipped",
                        from_version=old_version,
                        to_version=digest.CURRENT_VERSION,
                        detail="already migrated by a concurrent login")
            log.info("digest upgrade skipped user=%s (already migrated)",
                     username)
            return False

    # ----------------------------------------------------------------- report

    def report(self) -> list[dict]:
        """Admin view of migration state. Contains no digests or passwords."""
        with self._tx() as conn:
            rows = conn.execute(
                "SELECT username, version, imported_version, status,"
                " login_count, migrated_at FROM accounts ORDER BY username"
            ).fetchall()
        out = []
        for r in rows:
            if r["status"] == STATUS_NEEDS_REVIEW:
                state = "needs_review"
            elif r["version"] is None:
                state = "needs_review"
            elif r["version"] < digest.CURRENT_VERSION:
                state = "unmigrated"
            elif (r["imported_version"] is not None
                  and r["imported_version"] < digest.CURRENT_VERSION):
                state = "migrated"
            else:
                state = "current"
            out.append({
                "username": r["username"],
                "digest_version": r["version"],
                "migration_state": state,
                "login_count": r["login_count"],
                "migrated_at": r["migrated_at"],
            })
        return out

    def migration_events(self, username: str | None = None) -> list[dict]:
        with self._tx() as conn:
            if username is None:
                rows = conn.execute(
                    "SELECT * FROM migration_log ORDER BY id").fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM migration_log WHERE username = ?"
                    " ORDER BY id", (username,)).fetchall()
        return [dict(r) for r in rows]

    def get_account(self, username: str) -> dict | None:
        """Full row including digest — for tests and internal use only,
        never exposed via the CLI report."""
        with self._tx() as conn:
            row = conn.execute(
                "SELECT * FROM accounts WHERE username = ?", (username,)
            ).fetchone()
        return dict(row) if row else None
