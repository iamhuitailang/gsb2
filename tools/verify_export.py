#!/usr/bin/env python3
"""Independent checker for a gsb2 audit export JSON file.

This script deliberately does not import the application package: it
re-implements the documented digest rules with the standard library only, so
a third party can confirm record order and content on its own.

    python3 tools/verify_export.py copy.json [--baseline audit-baseline.db]
                                             [--org org-alpha]

Exit status 0 = content/order self-consistent (and, if a baseline was given,
anchored); 1 = failure.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
import sys
from pathlib import Path
from urllib.parse import quote

PAYLOAD_FIELDS = (
    "audit_id", "org_id", "seq", "created_at", "action", "outcome", "actor",
    "target", "role", "changes", "rule_set", "reason", "detail",
)


def canonical_json(value) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="独立核对审计导出副本")
    parser.add_argument("copy", type=Path)
    parser.add_argument("--baseline", type=Path)
    parser.add_argument("--org")
    args = parser.parse_args(argv)

    bundle = json.loads(args.copy.read_text("utf-8"))
    if not isinstance(bundle, dict):
        print("核对未通过：副本不是 JSON 对象")
        return 1
    problems: list[str] = []
    records = bundle.get("records")
    if not isinstance(records, list):
        problems.append("副本缺少 records 列表")
        records = []
    if not records:
        problems.append("副本中没有记录")

    org = bundle.get("org")
    org_id = org.get("org_id") if isinstance(org, dict) else None
    if args.org and org_id != args.org:
        problems.append(f"副本机构 {org_id!r} 与期望 {args.org!r} 不一致")

    integrity = bundle.get("integrity")
    integrity = integrity if isinstance(integrity, dict) else {}

    seqs = []
    previous_hash: str | None = None
    for record in records:
        if not isinstance(record, dict):
            problems.append("记录不是 JSON 对象")
            continue
        missing = [f for f in PAYLOAD_FIELDS if f not in record]
        if missing:
            problems.append(f"记录缺少字段: {missing}")
            continue
        if not isinstance(record.get("prev_hash"), str) or not isinstance(
            record.get("record_hash"), str
        ):
            problems.append(f"seq={record.get('seq')} 缺少哈希链接字段")
            continue
        if not isinstance(record.get("seq"), int) or isinstance(record.get("seq"), bool):
            problems.append("记录 seq 不是整数")
            continue
        try:
            payload = {field: record[field] for field in PAYLOAD_FIELDS}
            digest = sha(canonical_json(payload))
        except (TypeError, ValueError) as exc:
            problems.append(f"seq={record.get('seq')} 无法规范化: {exc}")
            continue
        if digest != record.get("digest"):
            problems.append(f"seq={record.get('seq')} 内容摘要不一致")
        if previous_hash is not None and record.get("prev_hash") != previous_hash:
            problems.append(f"seq={record.get('seq')} 与前一条的哈希链不衔接")
        recomputed_hash = sha(record["prev_hash"] + "\n" + digest)
        if recomputed_hash != record.get("record_hash"):
            problems.append(f"seq={record.get('seq')} 记录哈希无法由内容重算")
        previous_hash = recomputed_hash
        seqs.append(record.get("seq"))

    if seqs != sorted(seqs) or len(seqs) != len(set(seqs)):
        problems.append(f"记录顺序异常: {seqs}")

    manifest = integrity.get("manifest") or []
    if len(manifest) != len(records):
        problems.append("完整性清单与记录数量不一致")
    else:
        recalculated = sha(
            canonical_json(
                {"selection": bundle.get("selection"), "manifest": manifest}
            )
        )
        declared = integrity.get("bundle_digest")
        if declared and declared != recalculated:
            problems.append("bundle_digest 与重算结果不一致")

    missing_ranges: list[str] = []
    if args.baseline:
        if not args.baseline.exists():
            problems.append(f"本地审计基准不存在: {args.baseline}")
        elif not org_id:
            problems.append("副本缺少机构标识，无法核对本地基准")
        else:
            conn = sqlite3.connect(
                f"file:{quote(str(args.baseline.resolve()))}?mode=ro", uri=True
            )
            try:
                rows = conn.execute(
                    "SELECT seq, digest, prev_hash, record_hash FROM baseline_entries"
                    " WHERE org_id = ? ORDER BY seq",
                    (org_id,),
                ).fetchall()
            finally:
                conn.close()
            baseline = {row[0]: row for row in rows}
            for record in records:
                entry = baseline.get(record.get("seq"))
                if entry is None:
                    problems.append(f"seq={record.get('seq')} 不在本地基准中")
                    continue
                if entry[1] != record.get("digest") or entry[3] != record.get("record_hash"):
                    problems.append(f"seq={record.get('seq')} 与本地基准不一致")
            present = {record.get("seq") for record in records}
            missing = [seq for seq in baseline if seq not in present]
            for seq in missing:
                missing_ranges.append(str(seq))

    if problems:
        print("核对未通过：")
        for item in problems:
            print(" -", item)
        return 1
    print(f"核对通过：{len(records)} 条记录，顺序 {seqs}。")
    if missing_ranges:
        print(f"提示：本地基准中还有未包含的序号 {', '.join(missing_ranges)}。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
