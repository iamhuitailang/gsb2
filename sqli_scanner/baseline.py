"""问题清单（基线）的保存与对比。

清单按稳定标识 finding_id 记录；再次扫描时对比得到：
* new：清单里没有、本次新出现的问题
* existing：清单里有、本次仍然存在的问题
* missing：清单里有、本次已经消失的问题（代码修复或问题移动后标识变化）
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Dict, List, Optional

from .model import Finding

BASELINE_VERSION = 1
TOOL_NAME = "sqli_scanner"


@dataclass
class BaselineDiff:
    new: List[Finding]
    existing: List[Finding]
    missing: List[Finding]

    @property
    def is_empty(self) -> bool:
        return not (self.new or self.existing or self.missing)


def baseline_payload(result_root: str, findings: List[Finding]) -> dict:
    return {
        "tool": TOOL_NAME,
        "baseline_version": BASELINE_VERSION,
        "root": result_root,
        "findings": [f.to_dict() for f in findings],
    }


def save_baseline(path: str, result_root: str, findings: List[Finding]) -> None:
    payload = baseline_payload(result_root, findings)
    directory = os.path.dirname(os.path.abspath(path))
    os.makedirs(directory, exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2, sort_keys=True)
        fh.write("\n")


def load_baseline(path: str) -> Dict[str, Finding]:
    """加载清单，返回 finding_id -> Finding。"""
    with open(path, "r", encoding="utf-8") as fh:
        payload = json.load(fh)
    result: Dict[str, Finding] = {}
    for item in payload.get("findings", []):
        finding = Finding.from_dict(item)
        result[finding.finding_id] = finding
    return result


def diff_against_baseline(
    findings: List[Finding], baseline: Optional[Dict[str, Finding]]
) -> BaselineDiff:
    if not baseline:
        return BaselineDiff(new=list(findings), existing=[], missing=[])
    current_ids = {f.finding_id for f in findings}
    new = [f for f in findings if f.finding_id not in baseline]
    existing = [f for f in findings if f.finding_id in baseline]
    missing = [f for fid, f in baseline.items() if fid not in current_ids]
    new.sort(key=lambda f: (f.path, f.sink_lineno, f.finding_id))
    existing.sort(key=lambda f: (f.path, f.sink_lineno, f.finding_id))
    missing.sort(key=lambda f: (f.path, f.sink_lineno, f.finding_id))
    return BaselineDiff(new=new, existing=existing, missing=missing)
