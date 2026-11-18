"""核查编排：把扫描器、状态模型、基线与例外串成一次完整核查。"""

from __future__ import annotations

import hashlib
import os
import time

from . import rules, scanner
from .errors import RootNotAccessible, StoreCorruptError, TOOL_ERROR
from .models import diff_findings
from .store import Store, apply_exceptions, compare_with_baseline


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


class Auditor:
    def __init__(self, data_dir: str):
        self.store = Store(data_dir)

    def resolve_root(self, raw_path: str) -> str:
        """把用户输入解析为真实绝对路径并校验可访问性。"""
        if not raw_path or not raw_path.strip():
            raise RootNotAccessible("未提供核查目录。")
        root = os.path.realpath(os.path.abspath(os.path.expanduser(raw_path.strip())))
        if not os.path.exists(root):
            raise RootNotAccessible(f"目录不存在：{os.path.basename(root) or '/'}")
        if not os.path.isdir(root):
            raise RootNotAccessible("所选路径不是目录。")
        if not os.access(root, os.R_OK | os.X_OK):
            raise RootNotAccessible("目录不可读或不可进入（权限不足）。")
        return root

    def run_scan(self, raw_path: str) -> dict:
        root_real = self.resolve_root(raw_path)
        return self.scan_resolved(root_real)

    def scan_resolved(self, root_real: str) -> dict:
        """对已校验的真实路径执行完整核查编排。"""
        self.store.append_log("scan_start", f"root={os.path.basename(root_real)}")

        # 工具自身数据目录即使位于被核查树内也必须排除
        excluded = {self.store.data_dir}
        result = scanner.scan(root_real, excluded_realpaths=excluded)
        findings, notices = result["findings"], result["notices"]

        # 与上一次核查比对，得到 新增/仍存在/变化/消失 状态
        runs = self.store.load_runs(root_real)
        previous = runs[-1]["findings"] if runs else None
        findings = diff_findings(findings, previous)

        # 基线加载：损坏要显式报错，不能静默沿用
        baseline_warnings: list[str] = []
        try:
            baseline = self.store.load_baseline(root_real)
        except StoreCorruptError as exc:
            notices.append(
                {"category": TOOL_ERROR, "code": "baseline_corrupt",
                 "rel": ".", "detail": f"基线文件损坏，本次不使用基线比对：{type(exc).__name__}"}
            )
            baseline = None
        if baseline is not None:
            baseline_warnings = compare_with_baseline(
                {"findings": findings}, baseline, rules.rules_fingerprint()
            )

        # 例外：按严格身份匹配，过期自动失效
        active_map = self.store.active_exception_map(root_real)
        findings = apply_exceptions(findings, active_map)

        run = {
            "run_id": "R-" + hashlib.sha1(os.urandom(16)).hexdigest()[:12],
            "started_at": _now_iso(),
            "root_label": os.path.basename(root_real) or "/",
            "rule_version": rules.RULES_VERSION,
            "rule_fingerprint": rules.rules_fingerprint(),
            "stats": result["stats"],
            "findings": findings,
            "notices": notices,
            "warnings": baseline_warnings,
        }
        self.store.save_run(root_real, run)
        self.store.append_log(
            "scan_complete",
            f"root={run['root_label']} findings={run['stats']['findings_total']} "
            f"notices={run['stats']['notices_total']}",
        )
        return {"root_real": root_real, "run": run}

    # ---------- 历史与基线 ----------

    def list_runs(self, root_real: str) -> list[dict]:
        return self.store.load_runs(root_real)

    def get_run(self, root_real: str, run_id: str) -> dict | None:
        return self.store.get_run(root_real, run_id)

    def save_baseline(self, root_real: str, run_id: str | None = None) -> dict:
        run = (
            self.store.get_run(root_real, run_id)
            if run_id
            else (self.store.load_runs(root_real) or [None])[-1]
        )
        if run is None:
            raise RootNotAccessible("还没有核查结果，无法保存基线。")
        baseline = self.store.save_baseline(
            root_real, run, rules.RULES_VERSION, rules.rules_fingerprint()
        )
        self.store.append_log("baseline_saved", f"baseline={baseline['baseline_id']}")
        return baseline

    def get_baseline(self, root_real: str):
        return self.store.load_baseline(root_real)

    # ---------- 例外 ----------

    def add_exception(self, root_real: str, finding_id: str, scope: str,
                      expires_at: str, reason: str) -> dict:
        if scope not in ("rule", "path", "finding"):
            raise ValueError("scope 只能是 rule / path / finding")
        record = self.store.add_exception(
            root_real, finding_id, scope, expires_at, reason
        )
        self.store.append_log(
            "exception_added",
            f"finding={finding_id} scope={scope} expires={expires_at or 'never'}",
        )
        return record

    def revoke_exception(self, root_real: str, exception_id: str) -> bool:
        ok = self.store.revoke_exception(root_real, exception_id)
        if ok:
            self.store.append_log("exception_revoked", f"exception={exception_id}")
        return ok

    def list_exceptions(self, root_real: str) -> list[dict]:
        return self.store.load_exceptions(root_real)

    # ---------- 导出 ----------

    def export_report(self, root_real: str, run_id: str | None = None) -> dict:
        """生成安全导出结构：只有相对路径、规则版本、核查时间，无原文敏感值。"""
        run = (
            self.store.get_run(root_real, run_id)
            if run_id
            else (self.store.load_runs(root_real) or [None])[-1]
        )
        if run is None:
            raise RootNotAccessible("还没有核查结果，无法导出。")

        def clean_finding(f: dict) -> dict:
            return {
                "id": f["id"],
                "rule_id": f["rule_id"],
                "severity": f["severity"],
                "title": f["title"],
                "status": f.get("status"),
                "baseline_state": f.get("baseline_state"),
                "rel_path": f["rel_path"],
                "aspect": f["aspect"],
                "reason": f["reason"],
                "remediation": f["remediation"],
                "evidence": f["evidence"],
                "exception": f.get("exception"),
            }

        return {
            "report_format": "baseline-audit-report/1",
            "exported_at": _now_iso(),
            "rule_version": run["rule_version"],
            "rule_fingerprint": run["rule_fingerprint"],
            "scanned_at": run["started_at"],
            "root_label": run["root_label"],
            "stats": run["stats"],
            "warnings": run.get("warnings", []),
            "findings": [clean_finding(f) for f in run["findings"]],
            "notices": run["notices"],
        }

    def read_audit_log(self) -> list[dict]:
        return self.store.read_log()
