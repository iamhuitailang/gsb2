"""基线文件: 记录已确认的发现, 支持只看新增问题。

基线为 JSON 格式, 每条记录只保存指纹与定位/规则元数据, 不保存
凭据原文。指纹与行号无关, 因此文件前后增加无关行 (行号整体平移)
不会让旧发现被误报为新问题。

条目状态:
- active: 仍在本次扫描中出现;
- expired: 带 expires_on 且该日期已过, 即便仍命中也按新问题处理,
  并在报告中单独列出;
- missing: 基线里有、本次扫描已消失的条目, 单独列出而不是静默
  继续视为有效。
"""

from __future__ import annotations

import datetime as _dt
import json
import os
import tempfile
from dataclasses import dataclass

from .errors import BaselineError
from .models import Finding

BASELINE_FORMAT_VERSION = 1
_REQUIRED_ENTRY_FIELDS = {
    "fingerprint",
    "path",
    "rule_id",
    "severity",
    "reason",
    "match_length",
    "first_seen",
}


@dataclass(frozen=True)
class BaselineEntry:
    fingerprint: str
    path: str
    rule_id: str
    severity: str
    reason: str
    match_length: int
    first_seen: str
    expires_on: str | None = None
    note: str | None = None

    def to_dict(self) -> dict:
        data = {
            "fingerprint": self.fingerprint,
            "path": self.path,
            "rule_id": self.rule_id,
            "severity": self.severity,
            "reason": self.reason,
            "match_length": self.match_length,
            "first_seen": self.first_seen,
            "expires_on": self.expires_on,
            "note": self.note,
        }
        return data

    @classmethod
    def from_finding(
        cls, finding: Finding, first_seen: str, expires_on: str | None = None
    ) -> "BaselineEntry":
        return cls(
            fingerprint=finding.fingerprint,
            path=finding.path,
            rule_id=finding.rule_id,
            severity=finding.severity,
            reason=finding.reason,
            match_length=finding.match_length,
            first_seen=first_seen,
            expires_on=expires_on,
        )


def _today() -> str:
    return _dt.date.today().isoformat()


def _parse_iso_date(value: str, field_name: str) -> _dt.date:
    try:
        return _dt.date.fromisoformat(value)
    except ValueError as exc:
        raise BaselineError(
            f"基线条目的 {field_name} 不是合法 ISO 日期 (YYYY-MM-DD): {value!r}"
        ) from exc


def load_baseline(path: str) -> dict[str, BaselineEntry]:
    """读取基线并做严格结构校验, 损坏时抛出 BaselineError。"""

    try:
        with open(path, "rb") as handle:
            raw = json.load(handle)
    except FileNotFoundError as exc:
        raise BaselineError(f"基线文件不存在: {path}") from exc
    except json.JSONDecodeError as exc:
        raise BaselineError(f"基线文件不是合法 JSON: {exc}") from exc
    except OSError as exc:
        raise BaselineError(f"基线文件无法读取: {exc}") from exc

    if not isinstance(raw, dict):
        raise BaselineError("基线根节点必须是 JSON 对象")
    if raw.get("format_version") != BASELINE_FORMAT_VERSION:
        raise BaselineError(
            f"基线 format_version 必须为 {BASELINE_FORMAT_VERSION}, "
            f"实际为 {raw.get('format_version')!r}"
        )
    entries = raw.get("entries")
    if not isinstance(entries, list):
        raise BaselineError("基线 entries 必须是数组")

    result: dict[str, BaselineEntry] = {}
    for index, item in enumerate(entries):
        if not isinstance(item, dict):
            raise BaselineError(f"基线第 {index + 1} 条记录不是对象")
        missing = _REQUIRED_ENTRY_FIELDS - set(item)
        if missing:
            raise BaselineError(
                f"基线第 {index + 1} 条记录缺少字段: {', '.join(sorted(missing))}"
            )
        fingerprint = item["fingerprint"]
        if not isinstance(fingerprint, str) or not fingerprint:
            raise BaselineError(f"基线第 {index + 1} 条记录指纹非法")
        if fingerprint in result:
            raise BaselineError(f"基线指纹重复: {fingerprint}")
        expires_on = item.get("expires_on")
        if expires_on is not None:
            if not isinstance(expires_on, str):
                raise BaselineError(
                    f"基线条目 {fingerprint} 的 expires_on 必须是字符串"
                )
            _parse_iso_date(expires_on, "expires_on")
        _parse_iso_date(item["first_seen"], "first_seen")
        note = item.get("note")
        if note is not None and not isinstance(note, str):
            raise BaselineError(f"基线条目 {fingerprint} 的 note 必须是字符串")
        result[fingerprint] = BaselineEntry(
            fingerprint=fingerprint,
            path=str(item["path"]),
            rule_id=str(item["rule_id"]),
            severity=str(item["severity"]),
            reason=str(item["reason"]),
            match_length=int(item["match_length"]),
            first_seen=str(item["first_seen"]),
            expires_on=expires_on,
            note=note,
        )
    return result


def is_expired(entry: BaselineEntry, today: _dt.date | None = None) -> bool:
    if entry.expires_on is None:
        return False
    current = today or _dt.date.today()
    return _parse_iso_date(entry.expires_on, "expires_on") <= current


@dataclass
class BaselineDiff:
    """本次扫描与基线比对的结果。"""

    new_findings: list[Finding]
    acknowledged: list[Finding]  # 命中未过期基线的发现
    expired: list[tuple[Finding, BaselineEntry]]  # 命中但基线已过期
    missing: list[BaselineEntry]  # 基线中存在但本次未出现

    @property
    def has_new(self) -> bool:
        return bool(self.new_findings)


def diff_against_baseline(
    findings: list[Finding], entries: dict[str, BaselineEntry]
) -> BaselineDiff:
    new_findings: list[Finding] = []
    acknowledged: list[Finding] = []
    expired: list[tuple[Finding, BaselineEntry]] = []
    today = _dt.date.today()

    matched_fingerprints: set[str] = set()
    for finding in findings:
        entry = entries.get(finding.fingerprint)
        if entry is None:
            new_findings.append(finding)
            continue
        matched_fingerprints.add(finding.fingerprint)
        if is_expired(entry, today):
            expired.append((finding, entry))
            new_findings.append(finding)
        else:
            acknowledged.append(finding)

    missing = [
        entry
        for fingerprint, entry in entries.items()
        if fingerprint not in matched_fingerprints
    ]
    return BaselineDiff(
        new_findings=new_findings,
        acknowledged=acknowledged,
        expired=expired,
        missing=missing,
    )


def write_baseline(
    path: str,
    findings: list[Finding],
    previous: dict[str, BaselineEntry] | None = None,
) -> None:
    """把当前发现原子写入基线。

    已在旧基线中存在的指纹保留其 first_seen / expires_on / note,
    新指纹的 first_seen 取当天; 旧基线中已消失的条目不写入。
    """

    previous = previous or {}
    entries: list[BaselineEntry] = []
    for finding in findings:
        old = previous.get(finding.fingerprint)
        if old is not None:
            entries.append(
                BaselineEntry(
                    fingerprint=old.fingerprint,
                    path=finding.path,
                    rule_id=finding.rule_id,
                    severity=finding.severity,
                    reason=finding.reason,
                    match_length=finding.match_length,
                    first_seen=old.first_seen,
                    expires_on=old.expires_on,
                    note=old.note,
                )
            )
        else:
            entries.append(BaselineEntry.from_finding(finding, _today()))
    entries.sort(key=lambda item: item.fingerprint)
    payload = {
        "format_version": BASELINE_FORMAT_VERSION,
        "generated_on": _today(),
        "entries": [entry.to_dict() for entry in entries],
    }

    directory = os.path.dirname(os.path.abspath(path)) or "."
    os.makedirs(directory, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".baseline-", dir=directory)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
        os.replace(temporary, path)
    except OSError as exc:
        if os.path.exists(temporary):
            os.unlink(temporary)
        raise BaselineError(f"基线文件写入失败: {exc}") from exc
