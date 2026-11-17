"""Audit export bundles and read-only verification against the local baseline.

An export bundle carries enough information (canonicalisation rules, payload
fields, per-record digests and hash links) for a third party to independently
recompute record content and order.  Verification never trusts those embedded
values: it recomputes every digest from the record content and anchors the
result in the separately stored local baseline.

Nothing in this module opens the live database for writing.  The verify
entry point opens both the baseline and (optionally) the live audit database
with ``mode=ro``.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any, Iterable

from .canonical import (
    GENESIS_HASH,
    PAYLOAD_FIELDS,
    canonical_json,
    contains_sensitive,
    payload_digest,
    payload_from_record,
    record_hash,
    sha256_hex,
)
from .rules import rule_summary
from .store import Store, decode_record, sqlite_uri

EXPORT_FORMAT = "gsb2-audit-export/1"
CHAIN_ALGORITHM = "sha256(prev_hash + '\\n' + digest)"
DIGEST_ALGORITHM = "sha256(canonical_json(payload_fields))"


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------


def build_bundle(
    store: Store,
    org_id: str,
    *,
    first_seq: int | None = None,
    last_seq: int | None = None,
    exported_by: str = "",
) -> dict[str, Any]:
    org = store.get_org(org_id)
    if org is None:
        raise KeyError(f"unknown organisation: {org_id}")

    records = store.list_audit(org_id)
    if first_seq is not None:
        records = [item for item in records if item["seq"] >= first_seq]
    if last_seq is not None:
        records = [item for item in records if item["seq"] <= last_seq]
    if first_seq is not None and last_seq is not None and first_seq > last_seq:
        raise ValueError("起始序号不能大于结束序号")
    if not records:
        raise ValueError("导出范围内没有审计记录")

    selection = {
        "kind": "sequence_range" if first_seq is not None or last_seq is not None else "full_org",
        "org_id": org_id,
        "first_seq": records[0]["seq"] if records else None,
        "last_seq": records[-1]["seq"] if records else None,
        "count": len(records),
    }

    manifest = [
        {
            "seq": record["seq"],
            "audit_id": record["audit_id"],
            "digest": record["digest"],
            "prev_hash": record["prev_hash"],
            "record_hash": record["record_hash"],
        }
        for record in records
    ]
    bundle_digest = sha256_hex(
        canonical_json({"selection": selection, "manifest": manifest}).encode("utf-8")
    )

    bundle_records = [
        {field: record[field] for field in PAYLOAD_FIELDS}
        | {
            "prev_hash": record["prev_hash"],
            "digest": record["digest"],
            "record_hash": record["record_hash"],
        }
        for record in records
    ]
    if contains_sensitive(bundle_records):
        raise ValueError("审计导出中包含疑似凭据，已拒绝生成")

    return {
        "format": EXPORT_FORMAT,
        "exported_by": exported_by,
        "org": {
            "org_id": org["org_id"],
            "name": org["name"],
            "rule_set": rule_summary(org["rule_set"]),
        },
        "selection": selection,
        "integrity": {
            "digest_algorithm": DIGEST_ALGORITHM,
            "chain_algorithm": CHAIN_ALGORITHM,
            "payload_fields": list(PAYLOAD_FIELDS),
            "manifest": manifest,
            "first_prev_hash": records[0]["prev_hash"] if records else None,
            "last_record_hash": records[-1]["record_hash"] if records else None,
            "bundle_digest": bundle_digest,
            "baseline_note": (
                "校验时应以单独保存的本地审计基准为准，本文件内的摘要仅供独立复核，"
                "不得作为唯一依据。"
            ),
        },
        "records": bundle_records,
    }


def write_bundle(bundle: dict[str, Any], destination: Path) -> Path:
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(
        json.dumps(bundle, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return destination


# ---------------------------------------------------------------------------
# Read-only access to the separately stored baseline
# ---------------------------------------------------------------------------


def load_baseline(
    baseline_path: Path, org_id: str | None = None
) -> list[dict[str, Any]]:
    baseline_path = Path(baseline_path)
    if not baseline_path.exists():
        raise FileNotFoundError(f"本地审计基准不存在: {baseline_path}")
    conn = sqlite3.connect(
        sqlite_uri(baseline_path, "ro"), uri=True, isolation_level=None
    )
    try:
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout = 5000")
        sql = (
            "SELECT audit_id, org_id, seq, created_at, digest, prev_hash, record_hash"
            " FROM baseline_entries"
        )
        params: tuple[Any, ...] = ()
        if org_id is not None:
            sql += " WHERE org_id = ?"
            params = (org_id,)
        sql += " ORDER BY org_id, seq"
        return [dict(row) for row in conn.execute(sql, params)]
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Verification
# ---------------------------------------------------------------------------


def verify_bundle(
    bundle: dict[str, Any],
    baseline_path: Path,
    *,
    live_db_path: Path | None = None,
    expected_org_id: str | None = None,
) -> dict[str, Any]:
    """Verify an exported copy read-only against the local baseline.

    Returns a report.  ``status`` is:
      * ``verified``   - order and content match the baseline, coverage complete
      * ``incomplete`` - covered records match, but baseline entries are missing
      * ``failed``     - integrity/anchoring failures
    """
    errors: list[str] = []
    warnings: list[str] = []
    checks: dict[str, Any] = {}

    # -- structure ---------------------------------------------------------
    if bundle.get("format") != EXPORT_FORMAT:
        errors.append(f"未知的导出格式: {bundle.get('format')!r}")
    org = bundle.get("org")
    if not isinstance(org, dict):
        org = {}
        errors.append("导出文件缺少机构信息")
    org_id = org.get("org_id")
    if not isinstance(org_id, str) or not org_id:
        errors.append("导出文件缺少机构标识")
        org_id = None
    if expected_org_id is not None and org_id != expected_org_id:
        errors.append("导出文件所属机构与当前管理员范围不一致")
    declared_rules = org.get("rule_set")
    if org_id and isinstance(declared_rules, dict):
        declared_rule = declared_rules.get("name")
        try:
            actual_digest = rule_summary(declared_rule)["digest"]
        except (KeyError, TypeError):
            errors.append(f"导出文件声明的规则集不存在: {declared_rule!r}")
        else:
            if declared_rules.get("digest") != actual_digest:
                errors.append("导出文件声明的规则集摘要与本地规则定义不一致")
            checks["rule_set"] = {
                "name": declared_rule,
                "digest": actual_digest,
                "matches_local_definition": declared_rules.get("digest") == actual_digest,
            }
    elif org_id:
        errors.append("导出文件缺少规则集信息")

    records = bundle.get("records")
    if not isinstance(records, list) or not records:
        errors.append("导出文件没有可核对的记录")
        records = []

    # -- per-record content and self-consistency ---------------------------
    recomputed: list[dict[str, Any]] = []
    content_ok = True
    self_ok = True
    sensitive_found = False
    for index, record in enumerate(records):
        if not isinstance(record, dict):
            errors.append(f"第 {index + 1} 条记录不是 JSON 对象")
            content_ok = False
            continue
        missing_fields = [field for field in PAYLOAD_FIELDS if field not in record]
        if missing_fields:
            errors.append(f"第 {index + 1} 条记录缺少字段: {', '.join(missing_fields)}")
            content_ok = False
            continue
        if (
            not isinstance(record.get("audit_id"), str)
            or not isinstance(record.get("org_id"), str)
            or not isinstance(record.get("seq"), int)
            or isinstance(record.get("seq"), bool)
            or not isinstance(record.get("prev_hash"), str)
            or not isinstance(record.get("digest"), str)
            or not isinstance(record.get("record_hash"), str)
        ):
            errors.append(f"第 {index + 1} 条记录的标识或哈希字段类型无效")
            content_ok = False
            continue
        payload = payload_from_record(record)
        if contains_sensitive(payload):
            sensitive_found = True
            errors.append(f"第 {index + 1} 条记录仍含疑似凭据")
        try:
            digest = payload_digest(payload)
        except (TypeError, ValueError) as exc:
            content_ok = False
            errors.append(f"第 {index + 1} 条记录无法规范化计算摘要: {exc}")
            continue
        hash_value = record_hash(record.get("prev_hash", ""), digest)
        if digest != record.get("digest"):
            content_ok = False
            errors.append(
                f"第 {index + 1} 条记录（seq={record.get('seq')}）内容摘要与自身声明不一致"
            )
        if hash_value != record.get("record_hash"):
            self_ok = False
            errors.append(
                f"第 {index + 1} 条记录（seq={record.get('seq')}）哈希链值无法由内容重算"
            )
        recomputed.append(
            {
                "record": record,
                "payload": payload,
                "digest": digest,
                "record_hash": hash_value,
                "declared_digest": record.get("digest"),
                "declared_record_hash": record.get("record_hash"),
            }
        )
    checks["record_content"] = {
        "records_checked": len(recomputed),
        "content_matches_declared": content_ok,
        "no_credentials": not sensitive_found,
        "digest_algorithm": DIGEST_ALGORITHM,
    }
    checks["record_hashes"] = {"hash_chain_recomputable": self_ok}

    # -- order -------------------------------------------------------------
    seqs = [item["record"]["seq"] for item in recomputed]
    order_ok = seqs == sorted(seqs) and len(seqs) == len(set(seqs))
    contiguous = all(b - a == 1 for a, b in zip(seqs, seqs[1:]))
    if not order_ok:
        errors.append(f"导出记录顺序异常: {seqs}")
    if not contiguous and seqs:
        warnings.append("导出记录序号不连续，副本内部存在缺口")
    checks["record_order"] = {
        "sequence": seqs,
        "ascending": seqs == sorted(seqs),
        "unique": len(seqs) == len(set(seqs)),
        "contiguous": contiguous,
    }

    # -- baseline anchoring ------------------------------------------------
    try:
        baseline_entries = (
            load_baseline(Path(baseline_path), org_id) if org_id else []
        )
    except (OSError, sqlite3.Error) as exc:
        baseline_entries = []
        errors.append(f"本地审计基准不可读，无法核对: {exc}")
    by_id = {entry["audit_id"]: entry for entry in baseline_entries}
    baseline_by_seq = {entry["seq"]: entry for entry in baseline_entries}
    anchored = 0
    anchored_ok = True
    for item in recomputed:
        record = item["record"]
        entry = by_id.get(record.get("audit_id"))
        label = f"seq={record.get('seq')}"
        if entry is None:
            anchored_ok = False
            errors.append(f"{label} 不在本地审计基准中（无法核对，可能是伪造或跨机构记录）")
            continue
        mismatches = []
        if entry["org_id"] != record.get("org_id"):
            mismatches.append("机构")
        if entry["seq"] != record.get("seq"):
            mismatches.append("序号")
        if entry["created_at"] != record.get("created_at"):
            mismatches.append("时间")
        if entry["digest"] != item["digest"]:
            mismatches.append("内容摘要")
        if entry["prev_hash"] != record.get("prev_hash"):
            mismatches.append("前序哈希")
        if entry["record_hash"] != item["record_hash"]:
            mismatches.append("记录哈希")
        if mismatches:
            anchored_ok = False
            errors.append(f"{label} 与本地审计基准不一致: {', '.join(mismatches)}")
        else:
            anchored += 1
    checks["baseline_anchor"] = {
        "baseline_path": str(Path(baseline_path)),
        "records_anchored": anchored,
        "records_checked": len(recomputed),
        "all_anchored": bool(recomputed) and anchored_ok and anchored == len(recomputed),
    }

    # -- chain links -------------------------------------------------------
    chain_ok = True
    for previous, current in zip(recomputed, recomputed[1:]):
        if current["record"].get("prev_hash") != previous["record_hash"]:
            chain_ok = False
            errors.append(
                f"seq={current['record'].get('seq')} 未链接到前一条记录，副本哈希链断裂"
            )

    anchor_prev_ok = True
    if recomputed:
        first = recomputed[0]
        first_seq = first["record"].get("seq")
        expected_prev = GENESIS_HASH
        if isinstance(first_seq, int) and first_seq > 1:
            predecessor = baseline_by_seq.get(first_seq - 1)
            if predecessor is None:
                expected_prev = None
                warnings.append(
                    f"本地基准中找不到 seq={first_seq - 1}，无法核对副本起始链接"
                )
            else:
                expected_prev = predecessor["record_hash"]
        if expected_prev is not None and first["record"].get("prev_hash") != expected_prev:
            anchor_prev_ok = False
            label = "创世" if first_seq == 1 else f"seq={first_seq - 1}"
            errors.append(
                f"副本起始记录的前序哈希与本地基准中{label}的链接不一致"
            )
    checks["chain_link"] = {
        "internal_links_ok": chain_ok,
        "anchors_to_baseline_predecessor": anchor_prev_ok,
        "algorithm": CHAIN_ALGORITHM,
    }

    # -- coverage relative to the baseline ---------------------------------
    present = sorted(
        {
            item["record"]["seq"]
            for item in recomputed
            if isinstance(item["record"].get("seq"), int)
            and not isinstance(item["record"].get("seq"), bool)
        }
    )
    expected = sorted(baseline_by_seq)
    missing = [seq for seq in expected if seq not in present]
    extra = [seq for seq in present if seq not in baseline_by_seq]
    missing_ranges = _to_ranges(missing)
    covered_ranges = _to_ranges(present)
    if extra:
        errors.append(f"副本中存在本地基准没有的序号: {extra}")
    checks["coverage"] = {
        "baseline_sequence": expected,
        "covered_sequence": present,
        "covered_ranges": covered_ranges,
        "missing_sequence": missing,
        "missing_ranges": missing_ranges,
        "complete_for_org": not missing and not extra,
        "note": (
            "覆盖范围以本地审计基准为基准计算；导出文件自带的 selection 仅作参考。"
        ),
    }

    # -- optional live database cross-check (read-only) --------------------
    live_checked = 0
    live_matched = 0
    if live_db_path is not None and Path(live_db_path).exists() and recomputed:
        conn = sqlite3.connect(
            sqlite_uri(Path(live_db_path), "ro"), uri=True, isolation_level=None
        )
        try:
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA busy_timeout = 5000")
            for item in recomputed:
                row = conn.execute(
                    "SELECT * FROM audit_records WHERE audit_id = ?",
                    (item["record"].get("audit_id"),),
                ).fetchone()
                live_checked += 1
                if row is None:
                    continue
                live_payload = payload_from_record(decode_record(row))
                live_digest = payload_digest(live_payload)
                if (
                    live_digest == item["digest"]
                    and row["record_hash"] == item["record_hash"]
                ):
                    live_matched += 1
        finally:
            conn.close()
    checks["live_records"] = {
        "checked": live_checked,
        "matched": live_matched,
        "all_match": live_checked > 0 and live_matched == live_checked,
    }

    # -- embedded integrity block (informational, never authoritative) -----
    embedded = bundle.get("integrity")
    if not isinstance(embedded, dict):
        embedded = {}
    manifest = embedded.get("manifest")
    manifest_ok = isinstance(manifest, list) and len(manifest) == len(recomputed)
    if manifest_ok:
        for item, entry in zip(recomputed, manifest):
            if not isinstance(entry, dict) or (
                entry.get("audit_id") != item["record"].get("audit_id")
                or entry.get("seq") != item["record"].get("seq")
                or entry.get("digest") != item["declared_digest"]
                or entry.get("record_hash") != item["declared_record_hash"]
            ):
                manifest_ok = False
                break
    checks["embedded_integrity"] = {
        "manifest_consistent_with_records": manifest_ok,
        "note": "仅作参考；判定以本地审计基准与重算结果为准。",
    }

    if errors:
        status = "failed"
    elif missing or extra:
        status = "incomplete"
    else:
        status = "verified"

    summary = _summary(status, org_id, present, missing_ranges, errors, len(recomputed))
    return {
        "status": status,
        "org_id": org_id,
        "summary": summary,
        "missing_ranges": missing_ranges,
        "covered_ranges": covered_ranges,
        "errors": errors,
        "warnings": warnings,
        "checks": checks,
        "verified_readonly": True,
    }


def _to_ranges(numbers: Iterable[int]) -> list[list[int]]:
    ordered = sorted(numbers)
    ranges: list[list[int]] = []
    for number in ordered:
        if ranges and number == ranges[-1][1] + 1:
            ranges[-1][1] = number
        else:
            ranges.append([number, number])
    return ranges


def _summary(
    status: str,
    org_id: str | None,
    present: list[int],
    missing_ranges: list[list[int]],
    errors: list[str],
    count: int,
) -> str:
    coverage = _format_ranges(present)
    if status == "verified":
        return (
            f"机构 {org_id} 的副本共 {count} 条记录，顺序与内容均与本地审计基准一致，"
            f"覆盖完整（seq {coverage}）。"
        )
    if status == "incomplete":
        return (
            f"机构 {org_id} 的副本共 {count} 条记录，已包含部分的顺序与内容均与本地审计基准"
            f"一致（seq {coverage}），但缺少 seq {_format_ranges_flat(missing_ranges)}。"
        )
    return (
        f"机构 {org_id} 的副本未通过核对，发现 {len(errors)} 项问题，详见错误列表。"
    )


def _format_ranges(numbers: list[int]) -> str:
    return "、".join(
        f"{start}" if start == end else f"{start}-{end}"
        for start, end in _to_ranges(numbers)
    ) or "无"


def _format_ranges_flat(ranges: list[list[int]]) -> str:
    return "、".join(
        str(start) if start == end else f"{start}-{end}" for start, end in ranges
    ) or "无"
