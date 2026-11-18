"""本地状态存储：核查历史、基线快照、例外与审计日志。

- 所有状态保存在工具自身的数据目录（默认 ./.audit_data），永不写入被核查目录；
- JSON 原子写入（临时文件 + rename）；状态文件损坏时抛出 StoreCorruptError，
  由上层明确提示，不静默沿用旧结果；
- 所有路径以被核查目录为根的相对路径保存，不记录本机绝对路径；
- 写入前对文本字段统一做敏感内容遮蔽。
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
import time
from calendar import timegm

from .errors import StoreCorruptError
from .masking import redact_line, scrub_free_text

SCHEMA_VERSION = 1
MAX_RUNS_PER_ROOT = 20


def _slug(path: str) -> str:
    return hashlib.sha1(path.encode("utf-8")).hexdigest()[:16]


def _sanitize(text: str) -> str:
    """任何自由文本在落盘前过一遍遮蔽（行级规则 + 高熵令牌兜底）。"""
    lines = [redact_line(line) for line in str(text).splitlines()]
    return "\n".join(scrub_free_text(line) for line in lines)


class Store:
    def __init__(self, data_dir: str):
        self.data_dir = os.path.realpath(data_dir)
        self.roots_dir = os.path.join(self.data_dir, "roots")
        self.log_path = os.path.join(self.data_dir, "audit.log")
        os.makedirs(self.roots_dir, exist_ok=True)
        version_file = os.path.join(self.data_dir, "schema.json")
        if not os.path.exists(version_file):
            self._write_json(version_file, {"schema_version": SCHEMA_VERSION})

    # ---------- 基础读写 ----------

    def _root_dir(self, root_real: str) -> str:
        path = os.path.join(self.roots_dir, _slug(root_real))
        os.makedirs(path, exist_ok=True)
        registry = os.path.join(self.data_dir, "roots.json")
        roots = self._read_json(registry, default={})
        # 只保存展示名（basename），不保存绝对路径
        roots.setdefault(_slug(root_real), {"label": os.path.basename(root_real) or "/"})
        self._write_json(registry, roots)
        return path

    def _read_json(self, path: str, default=None):
        if not os.path.exists(path):
            return [] if default is None else default
        try:
            with open(path, "r", encoding="utf-8") as handle:
                return json.load(handle)
        except (json.JSONDecodeError, OSError, UnicodeDecodeError) as exc:
            raise StoreCorruptError("state", path, str(exc)) from exc

    def _write_json(self, path: str, payload) -> None:
        directory = os.path.dirname(path)
        os.makedirs(directory, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=directory, suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, ensure_ascii=False, indent=2, sort_keys=True)
            os.replace(tmp, path)
        except OSError:
            if os.path.exists(tmp):
                os.unlink(tmp)
            raise

    # ---------- 审计日志（不含敏感内容、不含绝对路径） ----------

    def append_log(self, event: str, detail: str = "") -> None:
        line = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "event": event,
            "detail": _sanitize(detail)[:500],
        }
        with open(self.log_path, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(line, ensure_ascii=False) + "\n")

    def read_log(self, limit: int = 200) -> list[dict]:
        if not os.path.exists(self.log_path):
            return []
        try:
            with open(self.log_path, "r", encoding="utf-8") as handle:
                lines = handle.readlines()[-limit:]
            return [json.loads(line) for line in lines if line.strip()]
        except (json.JSONDecodeError, OSError, UnicodeDecodeError) as exc:
            raise StoreCorruptError("audit-log", self.log_path, str(exc)) from exc

    # ---------- 核查历史 ----------

    def _runs_path(self, root_real: str) -> str:
        return os.path.join(self._root_dir(root_real), "runs.json")

    def load_runs(self, root_real: str) -> list[dict]:
        return self._read_json(self._runs_path(root_real), default=[])

    def save_run(self, root_real: str, run: dict) -> None:
        runs = self.load_runs(root_real)
        runs.append(run)
        self._write_json(self._runs_path(root_real), runs[-MAX_RUNS_PER_ROOT:])

    def get_run(self, root_real: str, run_id: str) -> dict | None:
        for run in reversed(self.load_runs(root_real)):
            if run["run_id"] == run_id:
                return run
        return None

    # ---------- 基线 ----------

    def _baseline_path(self, root_real: str) -> str:
        return os.path.join(self._root_dir(root_real), "baseline.json")

    def load_baseline(self, root_real: str) -> dict | None:
        path = self._baseline_path(root_real)
        if not os.path.exists(path):
            return None
        return self._read_json(path, default=None)

    def save_baseline(self, root_real: str, run: dict, rule_version: str, rule_fingerprint: str) -> dict:
        baseline = {
            "baseline_id": "B-" + hashlib.sha1(os.urandom(16)).hexdigest()[:12],
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "source_run_id": run["run_id"],
            "rule_version": rule_version,
            "rule_fingerprint": rule_fingerprint,
            "findings": [
                {
                    "id": f["id"],
                    "rule_id": f["rule_id"],
                    "rel_path": f["rel_path"],
                    "aspect": f["aspect"],
                    "change_fingerprint": f["change_fingerprint"],
                }
                for f in run["findings"]
            ],
        }
        self._write_json(self._baseline_path(root_real), baseline)
        return baseline

    # ---------- 例外 ----------

    def _exceptions_path(self, root_real: str) -> str:
        return os.path.join(self._root_dir(root_real), "exceptions.json")

    def load_exceptions(self, root_real: str) -> list[dict]:
        return self._read_json(self._exceptions_path(root_real), default=[])

    def add_exception(self, root_real: str, finding_id: str, scope: str,
                      expires_at: str, reason: str, now_ts: int | None = None) -> dict:
        now_ts = now_ts if now_ts is not None else int(time.time())
        exceptions = self.load_exceptions(root_real)
        # 同一发现只保留一条有效例外，重复添加视为更新
        exceptions = [e for e in exceptions if e["finding_id"] != finding_id]
        record = {
            "exception_id": "E-" + hashlib.sha1(os.urandom(16)).hexdigest()[:12],
            "finding_id": finding_id,
            "scope": scope,            # rule | path | finding
            "expires_at": expires_at,  # ISO8601 UTC，空串表示永久（仍受范围约束）
            "reason": _sanitize(reason)[:300],
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "created_ts": now_ts,
            "revoked": False,
        }
        exceptions.append(record)
        self._write_json(self._exceptions_path(root_real), exceptions)
        return record

    def revoke_exception(self, root_real: str, exception_id: str) -> bool:
        exceptions = self.load_exceptions(root_real)
        changed = False
        for item in exceptions:
            if item["exception_id"] == exception_id:
                item["revoked"] = True
                changed = True
        if changed:
            self._write_json(self._exceptions_path(root_real), exceptions)
        return changed

    def active_exception_map(self, root_real: str, now_ts: int | None = None) -> dict[str, dict]:
        """返回当前生效的例外映射；过期/已撤销的不返回。

        映射键严格使用发现 id（规则+相对路径+维度的哈希），路径或规则不再
        对应时旧例外不会匹配到任何新发现。
        """
        now_ts = now_ts if now_ts is not None else int(time.time())
        active: dict[str, dict] = {}
        for item in self.load_exceptions(root_real):
            if item.get("revoked"):
                continue
            if item["expires_at"]:
                try:
                    # 存储为 UTC（不带时区后缀），按 UTC 解释为 epoch
                    exp = timegm(time.strptime(item["expires_at"], "%Y-%m-%dT%H:%M:%S"))
                except (ValueError, OverflowError):
                    continue
                if exp < now_ts:
                    continue
            active[item["finding_id"]] = item
        return active


def apply_exceptions(run_findings: list[dict], active_map: dict[str, dict]) -> list[dict]:
    """把例外信息附加到发现项；过期后发现重新显示为普通项。"""
    for finding in run_findings:
        exc = active_map.get(finding["id"])
        finding["exception"] = (
            {
                "exception_id": exc["exception_id"],
                "scope": exc["scope"],
                "expires_at": exc["expires_at"],
                "reason": exc["reason"],
            }
            if exc
            else None
        )
    return run_findings


def compare_with_baseline(run: dict, baseline: dict | None,
                          current_rule_fingerprint: str) -> list[str]:
    """产生基线相关的明确提示（规则版本变化/基线损坏由调用方处理）。"""
    warnings: list[str] = []
    if baseline is None:
        return warnings
    if baseline.get("rule_fingerprint") != current_rule_fingerprint:
        warnings.append(
            f"规则版本已变化（基线使用 {baseline.get('rule_version', '未知')}），"
            "基线比对结果仅供参考，请重新保存基线。"
        )
    base_ids = {f["id"] for f in baseline.get("findings", [])}
    base_fp = {f["id"]: f["change_fingerprint"] for f in baseline.get("findings", [])}
    for finding in run["findings"]:
        if finding["id"] not in base_ids:
            finding["baseline_state"] = "new_since_baseline"
        elif base_fp.get(finding["id"]) != finding["change_fingerprint"]:
            finding["baseline_state"] = "changed_since_baseline"
        else:
            finding["baseline_state"] = "in_baseline"
    return warnings
