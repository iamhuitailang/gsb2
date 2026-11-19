"""Application service layer: scan lifecycle, identity, reviews, baselines, export."""

from __future__ import annotations

import csv
import io
import json
import os
import secrets as py_secrets
import stat
import tempfile
import threading
import time
import uuid
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Sequence, Tuple

from .rules import (
    RuleConfigError,
    RuleSet,
    load_rules,
    save_rules_text,
    validate_rules_text,
)
from .scanner import (
    DEFAULT_EXCLUDED_DIRS,
    SKIP_REASONS,
    ScanOptions,
    ScanOutput,
    scan_project,
)
from .store import Store
from .utils import (
    clamp_int,
    from_iso,
    hmac_hex,
    is_within,
    safe_message,
    to_iso,
    utc_now,
)

DETECTED_STATUSES = ("new", "persistent")
ALL_STATUSES = ("new", "persistent", "resolved", "unreviewable")
REVIEW_STATES = ("pending", "accepted", "ignored", "ignore_expired", "needs_rereview")
DEFAULT_IGNORE_DAYS = 30
MAX_IGNORE_DAYS = 3650
MAX_REASON_CHARS = 2000

FINDING_STATUS_LABELS = {
    "new": "新增",
    "persistent": "持续存在",
    "resolved": "已消失",
    "unreviewable": "无法复核",
}
REVIEW_STATE_LABELS = {
    "pending": "待复核",
    "accepted": "已接受",
    "ignored": "已忽略（未到期）",
    "ignore_expired": "忽略已到期",
    "needs_rereview": "需重新复核",
}
SKIP_REASON_LABELS = {
    "symlink": "符号链接（未跟随）",
    "symlink_outside_root": "越界符号链接（未跟随）",
    "binary": "二进制文件",
    "too_large": "文件过大",
    "total_size_limit": "累计大小上限",
    "file_limit": "文件数量上限",
    "unreadable": "无法读取",
    "not_regular_file": "非普通文件",
    "outside_root": "越出项目根目录",
    "excluded": "按规则排除",
    "line_limit": "超长行截断",
}


class WorkbenchError(ValueError):
    """A user-facing error with a stable machine code."""

    def __init__(self, code: str, message: str, status: int = 400):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


def review_state_for(
    review: Optional[Dict[str, Any]],
    stale_reviews: Sequence[Dict[str, Any]],
    now: datetime,
) -> Tuple[str, Optional[Dict[str, Any]], str]:
    """Return (state, relevant/stale review, human explanation)."""
    if review is not None:
        if review["decision"] == "accept":
            return "accepted", review, "复核理由：%s" % (review.get("reason") or "")
        ignore_until = review.get("ignore_until")
        if ignore_until:
            try:
                deadline = from_iso(ignore_until)
            except ValueError:
                deadline = now
            if deadline > now:
                return "ignored", review, "忽略到期时间：%s" % ignore_until
            return "ignore_expired", review, "忽略已于 %s 到期，需要重新确认" % ignore_until
        return "ignore_expired", review, "忽略记录缺少到期时间，按到期处理"
    if stale_reviews:
        return (
            "needs_rereview",
            stale_reviews[0],
            "存在旧规则版本留下的复核结论；规则含义已变化，旧结论不会自动套用",
        )
    return "pending", None, ""


class ReviewIndex:
    """In-memory index of reviews, so decorating a large result set is O(1) per row."""

    def __init__(self, reviews: Sequence[Dict[str, Any]]):
        self._exact: Dict[Tuple[str, str, str], Dict[str, Any]] = {}
        self._by_fp: Dict[Tuple[str, str], List[Dict[str, Any]]] = {}
        for review in reviews:
            key = (review["fingerprint"], review["family"], review["semantic_hash"])
            self._exact[key] = review
            self._by_fp.setdefault((review["fingerprint"], review["family"]), []).append(review)

    def resolve(
        self, fingerprint: str, family: str, semantic_hash: str, now: datetime
    ) -> Tuple[str, Optional[Dict[str, Any]], str]:
        exact = self._exact.get((fingerprint, family, semantic_hash))
        stale = [
            item
            for item in self._by_fp.get((fingerprint, family), [])
            if item["semantic_hash"] != semantic_hash
        ]
        return review_state_for(exact, stale, now)


class Workbench:
    def __init__(self, data_dir: str, rules_path: Optional[str] = None):
        self.data_dir = os.path.abspath(data_dir)
        os.makedirs(self.data_dir, exist_ok=True)
        self.db_path = os.path.join(self.data_dir, "state.db")
        self.key_path = os.path.join(self.data_dir, "fingerprint.key")
        self.rules_path = os.path.abspath(rules_path) if rules_path else os.path.join(self.data_dir, "rules.json")
        self.store = Store(self.db_path)
        self._key = self._load_or_create_key()
        self._rules_lock = threading.Lock()
        self._scan_lock = threading.Lock()
        self._active_scans: Dict[str, threading.Thread] = {}
        if not os.path.exists(self.rules_path):
            self._write_default_rules()
        try:
            self.rule_set: RuleSet = load_rules(self.rules_path)
        except RuleConfigError as exc:
            raise WorkbenchError("rules_invalid", str(exc), 500) from None

    # --------------------------------------------------------------- key mgmt
    def _load_or_create_key(self) -> bytes:
        try:
            with open(self.key_path, "rb") as handle:
                key = handle.read()
        except FileNotFoundError:
            key = b""
        if len(key) == 32:
            return key
        key = py_secrets.token_bytes(32)
        directory = os.path.dirname(self.key_path)
        fd, temp_path = tempfile.mkstemp(prefix=".key-", dir=directory)
        try:
            os.write(fd, key)
            os.fsync(fd)
        finally:
            os.close(fd)
        os.chmod(temp_path, stat.S_IRUSR | stat.S_IWUSR)
        os.replace(temp_path, self.key_path)
        return key

    def fingerprint(self, family: str, secret: str) -> str:
        """Keyed, content-based identity.

        The key lives outside the database and outside the project, so a leaked
        export cannot be turned back into credential values, and the same
        credential keeps the same identity across moves and line shifts.
        """
        normalised = secret.replace("\r\n", "\n").replace("\r", "\n").strip()
        return hmac_hex(self._key, "v1\x1f%s\x1f%s" % (family, normalised))

    # ----------------------------------------------------------------- rules
    def _write_default_rules(self) -> None:
        from .default_rules import default_rules

        text = json.dumps(default_rules(), ensure_ascii=False, indent=2) + "\n"
        validate_rules_text(text, self.rules_path)
        save_rules_text(self.rules_path, text)

    def current_rules(self) -> RuleSet:
        with self._rules_lock:
            return self.rule_set

    def rules_text(self) -> str:
        with self._rules_lock:
            with open(self.rules_path, "r", encoding="utf-8") as handle:
                return handle.read()

    def validate_rules(self, text: str) -> RuleSet:
        return validate_rules_text(text, "<validation>")

    def update_rules(self, text: str) -> RuleSet:
        rule_set = validate_rules_text(text, self.rules_path)
        with self._rules_lock:
            save_rules_text(self.rules_path, text)
            self.rule_set = rule_set
        return rule_set

    def rule_change_impact(self, text: str) -> Dict[str, Any]:
        """Explain which families keep or change meaning before saving."""
        proposed = validate_rules_text(text, self.rules_path)
        before = self.current_rules().by_family()
        after = proposed.by_family()
        changed = sorted(
            family
            for family in set(before) & set(after)
            if before[family].semantic_hash != after[family].semantic_hash
        )
        cosmetic = sorted(
            family
            for family in set(before) & set(after)
            if before[family].semantic_hash == after[family].semantic_hash
            and before[family].version != after[family].version
        )
        return {
            "version": proposed.version,
            "semantic_change_families": changed,
            "cosmetic_change_families": cosmetic,
            "added_families": sorted(set(after) - set(before)),
            "removed_families": sorted(set(before) - set(after)),
            "warning": (
                "以下规则含义已改变，旧复核不会自动套用到新发现：%s" % ", ".join(changed)
                if changed
                else ""
            ),
        }

    # ----------------------------------------------------------------- scans
    def resolve_root(self, path: str) -> str:
        if not isinstance(path, str) or not path.strip():
            raise WorkbenchError("root_required", "请选择本机项目目录")
        candidate = os.path.abspath(os.path.expanduser(path.strip()))
        if not os.path.isdir(candidate):
            raise WorkbenchError("root_invalid", "目录不存在或不是目录：%s" % candidate)
        real = os.path.realpath(candidate)
        if not os.path.isdir(real):
            raise WorkbenchError("root_invalid", "目录不可访问")
        return real

    def start_scan(
        self,
        root: str,
        options: Optional[Dict[str, Any]] = None,
        exclude_patterns: Optional[Sequence[str]] = None,
    ) -> Dict[str, Any]:
        real_root = self.resolve_root(root)
        data_dir_real = os.path.realpath(self.data_dir)
        if is_within(real_root, data_dir_real) or is_within(data_dir_real, real_root):
            raise WorkbenchError(
                "root_overlaps_data",
                "项目目录与工作台数据目录互相包含；请换一个目录或移动数据目录",
            )
        scan_options = ScanOptions()
        options = options or {}
        scan_options.max_file_bytes = clamp_int(
            options.get("max_file_bytes"), scan_options.max_file_bytes, 1024, 64 * 1024 * 1024
        )
        scan_options.max_total_bytes = clamp_int(
            options.get("max_total_bytes"),
            scan_options.max_total_bytes,
            1024,
            2 * 1024 * 1024 * 1024,
        )
        scan_options.max_files = clamp_int(
            options.get("max_files"), scan_options.max_files, 1, 500000
        )
        scan_options.max_line_chars = clamp_int(
            options.get("max_line_chars"), scan_options.max_line_chars, 1000, 200000
        )
        if exclude_patterns is not None:
            patterns = []
            for item in exclude_patterns:
                if not isinstance(item, str) or not item or len(item) > 200:
                    raise WorkbenchError("invalid_exclude", "排除模式必须是 1-200 字符的字符串")
                patterns.append(item)
            scan_options.exclude_patterns = tuple(patterns)
        rules = self.current_rules()
        previous = self.store.latest_completed_scan(real_root)
        scan = self.store.create_scan(
            root=real_root,
            root_real=real_root,
            ruleset_version=rules.version,
            ruleset_snapshot=rules.snapshot(),
            options=scan_options.public_dict(),
            status="queued",
        )
        if previous:
            self.store.update_scan(scan["id"], prev_scan_id=previous["id"])
        thread = threading.Thread(
            target=self._run_scan,
            args=(scan["id"], real_root, scan_options, rules),
            name="scan-%s" % scan["id"][:8],
            daemon=True,
        )
        with self._scan_lock:
            self._active_scans[scan["id"]] = thread
        thread.start()
        return self.get_scan(scan["id"])

    def _run_scan(
        self, scan_id: str, real_root: str, options: ScanOptions, rules: RuleSet
    ) -> None:
        started = to_iso(utc_now())
        try:
            self.store.update_scan(scan_id, status="running", started_at=started)

            def progress(
                processed: int, discovered: int, inspected: int, skipped: int, lines: int
            ) -> None:
                self.store.update_scan(
                    scan_id,
                    stats={
                        "processed": processed,
                        "discovered": discovered,
                        "inspected": inspected,
                        "skipped": skipped,
                        "lines": lines,
                        "phase": "scanning",
                    },
                )

            output = scan_project(real_root, rules, options, progress=progress)
            now = to_iso(utc_now())
            scan_row = self.store.get_scan(scan_id) or {}
            prev_id = scan_row.get("prev_scan_id")
            prev_findings = self.store.list_findings(prev_id) if prev_id else []
            stored = self._materialise_findings(scan_id, output, prev_findings, rules, now)
            self.store.replace_scan_findings(scan_id, stored)
            self.store.replace_skipped(
                scan_id, [skip.public_dict() for skip in output.skipped]
            )
            self.store.update_scan(
                scan_id,
                status="completed",
                finished_at=now,
                stats={
                    "files_seen": output.files_seen,
                    "files_inspected": output.files_inspected,
                    "bytes_read": output.bytes_read,
                    "lines_scanned": output.line_count,
                    "findings": len(stored),
                    "skipped": len(output.skipped),
                    "new": sum(1 for item in stored if item["status"] == "new"),
                    "persistent": sum(1 for item in stored if item["status"] == "persistent"),
                    "resolved": sum(1 for item in stored if item["status"] == "resolved"),
                    "unreviewable": sum(1 for item in stored if item["status"] == "unreviewable"),
                    "phase": "complete",
                },
            )
        except BaseException as exc:  # noqa: BLE001 - the status must always be persisted
            self.store.update_scan(
                scan_id,
                status="failed",
                finished_at=to_iso(utc_now()),
                error=safe_message(exc),
            )
        finally:
            with self._scan_lock:
                self._active_scans.pop(scan_id, None)

    def _materialise_findings(
        self,
        scan_id: str,
        output: ScanOutput,
        prev_findings: Sequence[Dict[str, Any]],
        rules: RuleSet,
        now: str,
    ) -> List[Dict[str, Any]]:
        rule_by_family = rules.by_family()
        rule_by_id = rules.by_id()
        # "resolved" rows are history from the previous scan; they must not make
        # a credential that reappears look like a pre-existing finding.
        carried = [item for item in prev_findings if item["status"] in ("new", "persistent", "unreviewable")]
        prev_by_fp: Dict[str, List[Dict[str, Any]]] = {}
        for item in carried:
            prev_by_fp.setdefault(item["fingerprint"], []).append(item)
        skipped_by_path = {skip.path: skip for skip in output.skipped}
        inspected_paths = output.inspected_paths
        produced: List[Dict[str, Any]] = []
        seen: set = set()
        current_fingerprints: set = set()

        for raw in output.findings:
            secret = str(raw.pop("_secret", ""))
            family = str(raw["family"])
            rule = rule_by_family.get(family) or rule_by_id.get(str(raw["rule_id"]))
            fingerprint = self.fingerprint(family, secret)
            location = (fingerprint, family, str(raw["path"]), int(raw["line"]))
            if location in seen:
                continue
            seen.add(location)
            current_fingerprints.add((fingerprint, family))
            status = "persistent" if fingerprint in prev_by_fp else "new"
            reason = ""
            produced.append(
                {
                    "id": uuid.uuid4().hex,
                    "scan_id": scan_id,
                    "fingerprint": fingerprint,
                    "match_key": "%s:%s" % (family, fingerprint[:16]),
                    "family": family,
                    "rule_id": str(raw["rule_id"]),
                    "rule_name": rule.name if rule else str(raw["rule_id"]),
                    "rule_version": str(raw["rule_version"]),
                    "rule_semantic_hash": str(raw["rule_semantic_hash"]),
                    "severity": str(raw["severity"]),
                    "path": str(raw["path"]),
                    "line": int(raw["line"]),
                    "column": int(raw["column"]),
                    "end_column": int(raw["end_column"]),
                    "preview": str(raw["preview"]),
                    "context_hash": str(raw["context_hash"]),
                    "secret_length": int(raw["secret_length"]),
                    "secret_entropy": float(raw["secret_entropy"]),
                    "block": bool(raw.get("block")),
                    "block_line_count": int(raw.get("block_line_count", 1)),
                    "terminated": bool(raw.get("terminated", True)),
                    "overlaps": list(raw.get("overlaps") or []),
                    "status": status,
                    "verification": "verified",
                    "verification_reason": reason,
                    "location_source": "scan",
                    "created_at": now,
                }
            )

        # Carry forward previous findings that this scan could not confirm.
        # A credential that merely moved is still identified by its fingerprint,
        # so it is not reported again at the old location.
        for prev in carried:
            if (prev["fingerprint"], prev["family"]) in current_fingerprints:
                continue
            location = (prev["fingerprint"], prev["family"], prev["path"], int(prev["line"]))
            if location in seen:
                continue
            skip = skipped_by_path.get(prev["path"])
            if skip is not None:
                status = "unreviewable"
                verification = "unverified"
                verification_reason = "本次扫描未检查该文件（%s），无法确认问题是否仍然存在" % (
                    SKIP_REASON_LABELS.get(skip.reason, skip.reason)
                )
            elif prev["path"] in inspected_paths:
                status = "resolved"
                verification = "verified"
                verification_reason = "本次扫描未再发现该凭据"
            else:
                status = "resolved"
                verification = "verified"
                verification_reason = "本次扫描未再发现该凭据（文件可能已删除）"
            seen.add(location)
            produced.append(
                {
                    "id": uuid.uuid4().hex,
                    "scan_id": scan_id,
                    "fingerprint": prev["fingerprint"],
                    "match_key": prev["match_key"],
                    "family": prev["family"],
                    "rule_id": prev["rule_id"],
                    "rule_name": prev["rule_name"],
                    "rule_version": prev["rule_version"],
                    "rule_semantic_hash": prev["rule_semantic_hash"],
                    "severity": prev["severity"],
                    "path": prev["path"],
                    "line": int(prev["line"]),
                    "column": int(prev["column"]),
                    "end_column": int(prev["end_column"]),
                    "preview": prev["preview"],
                    "context_hash": prev["context_hash"],
                    "secret_length": int(prev["secret_length"]),
                    "secret_entropy": float(prev["secret_entropy"]),
                    "block": bool(prev["block"]),
                    "block_line_count": int(prev["block_line_count"]),
                    "terminated": bool(prev["terminated"]),
                    "overlaps": list(prev["overlaps"]),
                    "status": status,
                    "verification": verification,
                    "verification_reason": verification_reason,
                    "location_source": "previous_scan",
                    "created_at": now,
                }
            )
        return produced

    # ------------------------------------------------------------- scan views
    def get_scan(self, scan_id: str) -> Dict[str, Any]:
        scan = self.store.get_scan(scan_id)
        if not scan:
            raise WorkbenchError("scan_not_found", "扫描不存在", 404)
        return self.decorate_scan(scan)

    def list_scans(self, limit: int = 50) -> List[Dict[str, Any]]:
        return [self.decorate_scan(scan) for scan in self.store.list_scans(limit)]

    def decorate_scan(self, scan: Dict[str, Any]) -> Dict[str, Any]:
        result = dict(scan)
        with self._scan_lock:
            result["active"] = scan["id"] in self._active_scans
        grouped: Dict[str, int] = {}
        for item in self.store.list_skipped(scan["id"]):
            grouped[item["reason"]] = grouped.get(item["reason"], 0) + 1
        result["skipped_count"] = sum(grouped.values())
        result["skipped_by_reason"] = grouped
        result["ruleset"] = scan["ruleset_snapshot"]
        return result

    def wait_for_scan(self, scan_id: str, timeout: float = 60.0) -> Dict[str, Any]:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            scan = self.store.get_scan(scan_id)
            if scan and scan["status"] in ("completed", "failed"):
                return self.decorate_scan(scan)
            time.sleep(0.05)
        return self.get_scan(scan_id)

    def scan_results(
        self, scan_id: str, filters: Optional[Dict[str, Any]] = None
    ) -> List[Dict[str, Any]]:
        scan = self.store.get_scan(scan_id)
        if not scan:
            raise WorkbenchError("scan_not_found", "扫描不存在", 404)
        now = utc_now()
        index = ReviewIndex(self.store.all_reviews())
        rules = self.current_rules().by_id()
        decorated = [
            self._decorate_finding(item, index, rules, now)
            for item in self.store.list_findings(scan_id)
        ]
        return apply_filters(decorated, filters or {})

    def all_scan_findings(
        self, scan_id: str, filters: Optional[Dict[str, Any]] = None
    ) -> List[Dict[str, Any]]:
        return self.scan_results(scan_id, filters)

    def _decorate_finding(
        self,
        finding: Dict[str, Any],
        index: ReviewIndex,
        rules: Dict[str, Any],
        now: datetime,
    ) -> Dict[str, Any]:
        result = dict(finding)
        state, review, explanation = index.resolve(
            finding["fingerprint"], finding["family"], finding["rule_semantic_hash"], now
        )
        result["review_state"] = state
        result["review_state_label"] = REVIEW_STATE_LABELS[state]
        result["review"] = review
        result["review_note"] = explanation
        result["status_label"] = FINDING_STATUS_LABELS.get(finding["status"], finding["status"])
        rule = rules.get(finding["rule_id"])
        result["rule_current_version"] = rule.version if rule else None
        result["rule_changed_since_scan"] = bool(
            rule and rule.version != finding["rule_version"]
        )
        result["identity"] = finding["fingerprint"][:16]
        return result

    def decorate_finding(self, finding: Dict[str, Any]) -> Dict[str, Any]:
        index = ReviewIndex(self.store.all_reviews())
        return self._decorate_finding(finding, index, self.current_rules().by_id(), utc_now())

    def skip_details(self, scan_id: str) -> Dict[str, Any]:
        if not self.store.get_scan(scan_id):
            raise WorkbenchError("scan_not_found", "扫描不存在", 404)
        skipped = self.store.list_skipped(scan_id)
        return {
            "scan_id": scan_id,
            "total": len(skipped),
            "by_reason": _count_by(skipped, "reason"),
            "items": [
                dict(item, label=SKIP_REASON_LABELS.get(item["reason"], item["reason"]))
                for item in skipped
            ],
            "reasons": SKIP_REASONS,
        }

    # --------------------------------------------------------------- reviews
    def review_finding(
        self,
        finding_id: str,
        decision: str,
        reason: str,
        ignore_days: Optional[int] = None,
        ignore_until: Optional[str] = None,
        actor: str = "",
        expected_fingerprint: Optional[str] = None,
    ) -> Dict[str, Any]:
        finding = self.store.get_finding(finding_id)
        if not finding:
            raise WorkbenchError("finding_not_found", "发现不存在", 404)
        if finding["status"] == "unreviewable":
            raise WorkbenchError(
                "finding_unverifiable",
                "该发现本次未完成核查，不能直接复核；请让对应文件恢复可扫描并重新扫描",
                409,
            )
        if finding["status"] == "resolved":
            raise WorkbenchError(
                "finding_resolved",
                "该发现已不在当前结果中，无需复核",
                409,
            )
        if expected_fingerprint and expected_fingerprint != finding["fingerprint"]:
            raise WorkbenchError(
                "identity_mismatch", "页面上的发现标识已过期，请刷新后重试", 409
            )
        if decision not in ("accept", "ignore"):
            raise WorkbenchError("invalid_decision", "复核结论只能是接受或忽略")
        cleaned_reason = (reason or "").strip()
        if not cleaned_reason:
            raise WorkbenchError("reason_required", "请填写复核理由")
        if len(cleaned_reason) > MAX_REASON_CHARS:
            raise WorkbenchError("reason_too_long", "复核理由不能超过 %s 字符" % MAX_REASON_CHARS)
        now = utc_now()
        ignore_until_iso = None
        if decision == "ignore":
            if ignore_until:
                try:
                    deadline = from_iso(ignore_until)
                except ValueError:
                    raise WorkbenchError("invalid_ignore_until", "忽略到期时间格式无效") from None
                if deadline <= now:
                    raise WorkbenchError("invalid_ignore_until", "忽略到期时间必须晚于当前时间")
                if deadline > now + timedelta(days=MAX_IGNORE_DAYS):
                    raise WorkbenchError(
                        "invalid_ignore_until", "忽略到期时间不能超过 %s 天" % MAX_IGNORE_DAYS
                    )
                ignore_until_iso = to_iso(deadline)
            else:
                days = clamp_int(ignore_days, DEFAULT_IGNORE_DAYS, 1, MAX_IGNORE_DAYS)
                ignore_until_iso = to_iso(now + timedelta(days=days))
        review = self.store.upsert_review(
            fingerprint=finding["fingerprint"],
            family=finding["family"],
            semantic_hash=finding["rule_semantic_hash"],
            decision=decision,
            reason=cleaned_reason,
            actor=(actor or "").strip()[:120],
            ignore_until=ignore_until_iso,
            now=to_iso(now),
        )
        self.store.add_review_event(
            scan_id=finding["scan_id"],
            finding_id=finding["id"],
            fingerprint=finding["fingerprint"],
            family=finding["family"],
            semantic_hash=finding["rule_semantic_hash"],
            decision=decision,
            reason=cleaned_reason,
            actor=review["actor"],
            ignore_until=ignore_until_iso,
            now=to_iso(now),
        )
        return self.decorate_finding(self.store.get_finding(finding_id) or finding)

    def clear_review(self, finding_id: str) -> Dict[str, Any]:
        finding = self.store.get_finding(finding_id)
        if not finding:
            raise WorkbenchError("finding_not_found", "发现不存在", 404)
        removed = self.store.delete_review(
            finding["fingerprint"], finding["family"], finding["rule_semantic_hash"]
        )
        if not removed:
            raise WorkbenchError("review_not_found", "没有可清除的复核记录", 404)
        return self.decorate_finding(finding)

    def reviews(self) -> List[Dict[str, Any]]:
        return self.store.all_reviews()

    def review_events(self) -> List[Dict[str, Any]]:
        return self.store.review_events()

    # -------------------------------------------------------------- baselines
    def create_baseline(
        self, scan_id: str, name: str, note: str = "", include: str = "all"
    ) -> Dict[str, Any]:
        scan = self.store.get_scan(scan_id)
        if not scan:
            raise WorkbenchError("scan_not_found", "扫描不存在", 404)
        if scan["status"] != "completed":
            raise WorkbenchError("scan_incomplete", "只能基于已完成的扫描保存基线", 409)
        cleaned_name = (name or "").strip()
        if not cleaned_name:
            raise WorkbenchError("name_required", "请填写基线名称")
        if len(cleaned_name) > 120:
            raise WorkbenchError("name_too_long", "基线名称不能超过 120 字符")
        if len(note or "") > MAX_REASON_CHARS:
            raise WorkbenchError("note_too_long", "基线备注不能超过 %s 字符" % MAX_REASON_CHARS)
        if include not in ("all", "accepted", "open"):
            raise WorkbenchError("invalid_include", "include 只能是 all / accepted / open")
        now = utc_now()
        index = ReviewIndex(self.store.all_reviews())
        rules = self.current_rules().by_id()
        decorated = [
            self._decorate_finding(item, index, rules, now)
            for item in self.store.detected_findings(scan_id)
        ]
        if include == "accepted":
            selected = [item for item in decorated if item["review_state"] == "accepted"]
        elif include == "open":
            selected = [
                item
                for item in decorated
                if item["review_state"] not in ("accepted", "ignored")
            ]
        else:
            selected = decorated
        if not selected:
            raise WorkbenchError("baseline_empty", "所选范围内没有可保存基线的发现")
        baseline = self.store.create_baseline(
            name=cleaned_name,
            note=(note or "").strip(),
            root_real=scan["root_real"],
            scan_id=scan_id,
            ruleset_version=scan["ruleset_version"],
            ruleset_snapshot=scan["ruleset_snapshot"],
            findings=selected,
        )
        baseline["finding_count"] = len(selected)
        return baseline

    def list_baselines(self) -> List[Dict[str, Any]]:
        return self.store.list_baselines()

    def compare_baseline(self, scan_id: str, baseline_id: str) -> Dict[str, Any]:
        scan = self.store.get_scan(scan_id)
        if not scan:
            raise WorkbenchError("scan_not_found", "扫描不存在", 404)
        if scan["status"] != "completed":
            raise WorkbenchError("scan_incomplete", "只能比较已完成的扫描", 409)
        baseline = self.store.get_baseline(baseline_id)
        if not baseline:
            raise WorkbenchError("baseline_not_found", "基线不存在", 404)
        if baseline["root_real"] != scan["root_real"]:
            raise WorkbenchError(
                "baseline_root_mismatch", "基线属于另一个项目目录，不能跨项目比较", 409
            )
        baseline_findings = self.store.baseline_findings(baseline_id)
        now = utc_now()
        index = ReviewIndex(self.store.all_reviews())
        rules = self.current_rules().by_id()
        current_all = [
            self._decorate_finding(item, index, rules, now)
            for item in self.store.list_findings(scan_id)
        ]
        current_detected = [
            item for item in current_all if item["status"] in DETECTED_STATUSES
        ]
        unreviewable_now = [
            item for item in current_all if item["status"] == "unreviewable"
        ]

        baseline_by_fp: Dict[str, List[Dict[str, Any]]] = {}
        for item in sorted(baseline_findings, key=lambda row: (row["path"], row["line"])):
            baseline_by_fp.setdefault(item["fingerprint"], []).append(item)
        current_by_fp: Dict[str, List[Dict[str, Any]]] = {}
        for item in current_detected:
            current_by_fp.setdefault(item["fingerprint"], []).append(item)
        unverified_fps = {item["fingerprint"] for item in unreviewable_now}

        new_items: List[Dict[str, Any]] = []
        still_present: List[Dict[str, Any]] = []
        relocated: List[Dict[str, Any]] = []
        for fingerprint, items in current_by_fp.items():
            bases = baseline_by_fp.get(fingerprint)
            if not bases:
                new_items.extend(dict(item, matched_by="none") for item in items)
                continue
            for position, item in enumerate(items):
                base = bases[min(position, len(bases) - 1)]
                moved = (
                    base["path"] != item["path"]
                    or base["line"] != item["line"]
                    or base["context_hash"] != item["context_hash"]
                )
                decorated = dict(
                    item,
                    matched_by="fingerprint",
                    baseline_location={"path": base["path"], "line": base["line"]},
                )
                still_present.append(decorated)
                if moved:
                    relocated.append(
                        dict(decorated, match_notes="路径或行号发生变化，身份保持稳定")
                    )

        resolved: List[Dict[str, Any]] = []
        unverifiable: List[Dict[str, Any]] = []
        for fingerprint, bases in baseline_by_fp.items():
            remaining = list(bases)
            for _ in current_by_fp.get(fingerprint, []):
                if remaining:
                    remaining.pop(0)
            for base in remaining:
                if fingerprint in unverified_fps:
                    unverifiable.append(
                        dict(
                            base,
                            current_status="unreviewable",
                            note="本次未检查对应文件，无法确认是否消失",
                        )
                    )
                else:
                    resolved.append(base)

        for collection in (new_items, still_present, relocated):
            collection.sort(key=lambda item: (item["path"], item["line"], item["rule_id"]))
        resolved.sort(key=lambda item: (item["path"], item["line"], item["rule_id"]))
        unverifiable.sort(key=lambda item: (item["path"], item["line"], item["rule_id"]))
        return {
            "scan_id": scan_id,
            "baseline_id": baseline_id,
            "baseline_name": baseline["name"],
            "baseline_created_at": baseline["created_at"],
            "baseline_scan_id": baseline["scan_id"],
            "baseline_ruleset_version": baseline["ruleset_version"],
            "scan_ruleset_version": scan["ruleset_version"],
            "ruleset_changed": baseline["ruleset_version"] != scan["ruleset_version"],
            "summary": {
                "new": len(new_items),
                "persistent": len(still_present),
                "relocated": len(relocated),
                "resolved": len(resolved),
                "unverifiable": len(unverifiable),
                "baseline_total": len(baseline_findings),
                "current_total": len(current_detected),
            },
            "new": new_items,
            "changed": relocated,
            "still_present": still_present,
            "resolved": resolved,
            "unverifiable": unverifiable,
        }

    # ------------------------------------------------------------------ export
    def export_report(
        self,
        scan_id: str,
        fmt: str = "json",
        filters: Optional[Dict[str, Any]] = None,
        baseline_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        scan = self.store.get_scan(scan_id)
        if not scan:
            raise WorkbenchError("scan_not_found", "扫描不存在", 404)
        findings = self.all_scan_findings(scan_id, filters)
        skipped = self.store.list_skipped(scan_id)
        comparison = self.compare_baseline(scan_id, baseline_id) if baseline_id else None
        report = build_report(scan, findings, skipped, comparison)
        rules_version = report["ruleset"]["version"]
        if fmt == "json":
            return {
                "content_type": "application/json; charset=utf-8",
                "filename": "scan-%s-report.json" % scan_id[:8],
                "content": json.dumps(report, ensure_ascii=False, indent=2),
            }
        if fmt == "csv":
            return {
                "content_type": "text/csv; charset=utf-8",
                "filename": "scan-%s-report.csv" % scan_id[:8],
                "content": findings_to_csv(
                    report["findings"],
                    {
                        "scan_id": scan_id,
                        "scan_finished_at": scan.get("finished_at") or "",
                        "ruleset_version": rules_version,
                    },
                ),
            }
        raise WorkbenchError("invalid_format", "导出格式只支持 json 或 csv")

    def delete_baseline(self, baseline_id: str) -> None:
        if not self.store.delete_baseline(baseline_id):
            raise WorkbenchError("baseline_not_found", "基线不存在", 404)


def apply_filters(
    findings: Sequence[Dict[str, Any]], filters: Dict[str, Any]
) -> List[Dict[str, Any]]:
    severities = _as_str_list(filters.get("severity"))
    statuses = _as_str_list(filters.get("status"))
    review_states = _as_str_list(filters.get("review_state") or filters.get("review"))
    rules = _as_str_list(filters.get("rule"))
    families = _as_str_list(filters.get("family"))
    path_terms = _as_str_list(filters.get("path"))
    query = str(filters.get("q") or "").strip().lower()
    if severities:
        findings = [item for item in findings if item["severity"] in severities]
    if statuses:
        findings = [item for item in findings if item["status"] in statuses]
    if review_states:
        findings = [item for item in findings if item["review_state"] in review_states]
    if rules:
        findings = [
            item
            for item in findings
            if item["rule_id"] in rules or item["rule_name"] in rules
        ]
    if families:
        findings = [item for item in findings if item["family"] in families]
    if path_terms:
        findings = [
            item
            for item in findings
            if any(_path_matches(item["path"], term) for term in path_terms)
        ]
    if query:

        def haystack(item: Dict[str, Any]) -> str:
            return " ".join(
                str(item.get(key) or "")
                for key in (
                    "path",
                    "rule_id",
                    "rule_name",
                    "family",
                    "status",
                    "review_state",
                    "preview",
                )
            ).lower()

        findings = [item for item in findings if query in haystack(item)]
    return list(findings)


def _as_str_list(value: Any) -> List[str]:
    if value is None or value == "":
        return []
    if isinstance(value, str):
        return [item.strip() for item in value.split(",") if item.strip()]
    if isinstance(value, (list, tuple)):
        return [str(item).strip() for item in value if str(item).strip()]
    return []


def _path_matches(path: str, term: str) -> bool:
    import fnmatch

    if any(char in term for char in "*?["):
        return fnmatch.fnmatchcase(path, term)
    return term.lower() in path.lower()


def _count_by(items: Sequence[Dict[str, Any]], key: str) -> Dict[str, int]:
    counts: Dict[str, int] = {}
    for item in items:
        counts[str(item.get(key))] = counts.get(str(item.get(key)), 0) + 1
    return counts


def _public_finding(item: Dict[str, Any]) -> Dict[str, Any]:
    """Allow-list everything that may leave the process (UI/export)."""
    allowed = (
        "id",
        "scan_id",
        "fingerprint",
        "match_key",
        "family",
        "rule_id",
        "rule_name",
        "rule_version",
        "rule_semantic_hash",
        "severity",
        "path",
        "line",
        "column",
        "end_column",
        "preview",
        "context_hash",
        "secret_length",
        "secret_entropy",
        "block",
        "block_line_count",
        "terminated",
        "overlaps",
        "status",
        "status_label",
        "verification",
        "verification_reason",
        "location_source",
        "review_state",
        "review_state_label",
        "review_note",
        "review",
    )
    result = {key: item.get(key) for key in allowed if key in item}
    if isinstance(result.get("review"), dict):
        result["review"] = {
            key: result["review"].get(key)
            for key in ("decision", "reason", "actor", "updated_at", "ignore_until")
        }
    return result


def build_report(
    scan: Dict[str, Any],
    findings: Sequence[Dict[str, Any]],
    skipped: Sequence[Dict[str, Any]],
    comparison: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    rules = scan["ruleset_snapshot"]
    summary = {
        "total": len(findings),
        "by_severity": _count_by(findings, "severity"),
        "by_status": _count_by(findings, "status"),
        "by_review_state": _count_by(findings, "review_state"),
        "by_rule": _count_by(findings, "rule_id"),
        "by_family": _count_by(findings, "family"),
        "skipped_files": len(skipped),
        "skipped_by_reason": _count_by(skipped, "reason"),
    }
    report: Dict[str, Any] = {
        "schema_version": "1.0",
        "generated_at": to_iso(utc_now()),
        "scan": {
            "id": scan["id"],
            "root": scan["root"],
            "status": scan["status"],
            "created_at": scan["created_at"],
            "started_at": scan["started_at"],
            "finished_at": scan["finished_at"],
            "stats": scan["stats"],
            "options": scan["options"],
        },
        "ruleset": {
            "version": rules["version"],
            "source_path": rules.get("source_path", ""),
            "rules": rules["rules"],
        },
        "summary": summary,
        "findings": [_public_finding(item) for item in findings],
        "not_inspected": [
            {
                "path": item["path"],
                "reason": item["reason"],
                "reason_label": SKIP_REASON_LABELS.get(item["reason"], item["reason"]),
                "size": item["size"],
                "message": item["message"] or SKIP_REASONS.get(item["reason"], ""),
            }
            for item in skipped
        ],
        "redaction": {
            "matched_text_included": False,
            "note": "报告仅包含遮蔽后的行预览、长度与熵值；不包含匹配原文。",
        },
    }
    if comparison is not None:
        report["baseline_comparison"] = {
            "baseline_id": comparison["baseline_id"],
            "baseline_name": comparison["baseline_name"],
            "baseline_created_at": comparison["baseline_created_at"],
            "baseline_ruleset_version": comparison["baseline_ruleset_version"],
            "scan_ruleset_version": comparison["scan_ruleset_version"],
            "ruleset_changed": comparison["ruleset_changed"],
            "summary": comparison["summary"],
            "new": [_public_finding(item) for item in comparison["new"]],
            "changed": [_public_finding(item) for item in comparison["changed"]],
            "still_present": [
                _public_finding(item) for item in comparison["still_present"]
            ],
            "resolved": [
                {
                    "fingerprint": item["fingerprint"],
                    "family": item["family"],
                    "rule_id": item["rule_id"],
                    "rule_name": item["rule_name"],
                    "severity": item["severity"],
                    "path": item["path"],
                    "line": item["line"],
                    "preview": item["preview"],
                }
                for item in comparison["resolved"]
            ],
            "unverifiable": [
                {
                    "fingerprint": item["fingerprint"],
                    "family": item["family"],
                    "rule_id": item["rule_id"],
                    "path": item["path"],
                    "line": item["line"],
                    "preview": item["preview"],
                }
                for item in comparison["unverifiable"]
            ],
        }
    return report


_FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")


def _csv_safe(value: Any) -> str:
    text = "" if value is None else str(value)
    if text.startswith(_FORMULA_PREFIXES):
        return "'" + text
    return text


def findings_to_csv(
    findings: Sequence[Dict[str, Any]], metadata: Optional[Dict[str, Any]] = None
) -> str:
    """CSV export. The redacted preview column is the only content-derived text."""
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    if metadata:
        # A leading comment block keeps the export self-describing without
        # breaking standard CSV parsers (which ignore '#' by convention here).
        writer.writerow(
            [
                "# scan_id=%s" % _csv_safe(metadata.get("scan_id")),
                "scan_finished_at=%s" % _csv_safe(metadata.get("scan_finished_at")),
                "ruleset_version=%s" % _csv_safe(metadata.get("ruleset_version")),
                "matched_text_included=false",
            ]
        )
    writer.writerow(
        [
            "fingerprint",
            "rule_id",
            "rule_name",
            "severity",
            "status",
            "review_state",
            "path",
            "line",
            "column",
            "preview_redacted",
            "secret_length",
            "block",
            "rule_version",
            "rule_semantic_hash",
        ]
    )
    for item in findings:
        writer.writerow(
            [
                _csv_safe(item.get("fingerprint")),
                _csv_safe(item.get("rule_id")),
                _csv_safe(item.get("rule_name")),
                _csv_safe(item.get("severity")),
                _csv_safe(item.get("status")),
                _csv_safe(item.get("review_state")),
                _csv_safe(item.get("path")),
                item.get("line"),
                item.get("column"),
                _csv_safe(item.get("preview")),
                item.get("secret_length"),
                "true" if item.get("block") else "false",
                _csv_safe(item.get("rule_version")),
                _csv_safe(item.get("rule_semantic_hash")),
            ]
        )
    return buffer.getvalue()
