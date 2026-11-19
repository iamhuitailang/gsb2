"""复核：副本与清单的一致性检查。

复核分两层，结果按类别归类并按相对路径排序，保证重复运行输出稳定：

1. 清单完整性：MANIFEST.json 是否可解析、SHA-256 校验和是否匹配；
2. 逐条目核对：
   - missing：清单记录已采集，但副本缺失或不是普通文件；
   - changed：副本仍在，但大小或 SHA-256 与清单不一致（内容被篡改）；
   - unexpected：copies/ 中出现清单未登记的文件（意外新增）；
   - entry_problem：清单中保留的失败/越界/冲突/超限条目（原样列出，
     提醒这些内容从未被成功采集，而不是被当作完整证据）。

可选 ``--check-source`` 同时对比源根目录当前状态，报告源端变化；
不开启时复核完全离线，只依赖案件目录自身。
"""

from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass, field
from typing import Optional

from .manifest import check_manifest_integrity, copy_root
from .models import (
    STATUS_COLLECTED,
    STATUS_CONFLICT,
    STATUS_FAILED,
    STATUS_LIMIT_EXCEEDED,
    STATUS_OUT_OF_BOUNDS,
    TYPE_REGULAR,
)
from .paths import relative_posix
from .scanner import scan_tree

CHUNK = 1024 * 1024

# 复核视角下“从未成功采集”的终态问题；pending 是可恢复中间态，
# 由采集流程处理，不计入复核的历史问题清单。
TERMINAL_PROBLEM_STATUSES = frozenset(
    {
        STATUS_FAILED,
        STATUS_CONFLICT,
        STATUS_OUT_OF_BOUNDS,
        STATUS_LIMIT_EXCEEDED,
    }
)


@dataclass
class VerificationReport:
    case_dir: str
    manifest_ok: bool
    manifest_problem: Optional[str]
    missing: list = field(default_factory=list)       # 副本缺失
    changed: list = field(default_factory=list)       # 内容/大小变化
    unexpected: list = field(default_factory=list)    # 意外新增
    entry_problems: list = field(default_factory=list)  # 清单内历史问题条目
    source_drift: list = field(default_factory=list)  # 源端变化（可选）
    verified_files: int = 0
    verified_bytes: int = 0

    @property
    def ok(self) -> bool:
        """严格意义上的“可复核通过”：清单完好且无任何差异。"""
        return (
            self.manifest_ok
            and not self.missing
            and not self.changed
            and not self.unexpected
            and not self.source_drift
        )

    def as_dict(self) -> dict:
        return {
            "case_dir": self.case_dir,
            "manifest_ok": self.manifest_ok,
            "manifest_problem": self.manifest_problem,
            "verified_files": self.verified_files,
            "verified_bytes": self.verified_bytes,
            "missing": self.missing,
            "changed": self.changed,
            "unexpected": self.unexpected,
            "entry_problems": self.entry_problems,
            "source_drift": self.source_drift,
        }


def _sha256_of(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(CHUNK), b""):
            h.update(chunk)
    return h.hexdigest()


def verify_case(case_dir: str, check_source: bool = False) -> VerificationReport:
    ok, problem, manifest = check_manifest_integrity(case_dir)
    report = VerificationReport(
        case_dir=case_dir,
        manifest_ok=ok,
        manifest_problem=problem,
    )
    if not ok or manifest is None:
        return report

    entries = manifest.get("entries", [])
    copies_dir = copy_root(case_dir)
    registered_copy_paths: set[str] = set()

    for raw in entries:
        rel = raw["rel_path"]
        status = raw["status"]

        if status in TERMINAL_PROBLEM_STATUSES:
            report.entry_problems.append(
                {
                    "rel_path": rel,
                    "status": status,
                    "reason": raw.get("reason"),
                    "detail": raw.get("detail"),
                }
            )
            continue

        if status != STATUS_COLLECTED:
            # recorded / skipped 等条目没有副本，无需核对文件
            continue

        copy_rel = raw.get("copy_path")
        if not copy_rel:
            report.missing.append(
                {"rel_path": rel, "detail": "清单缺少 copy_path"}
            )
            continue
        dest = os.path.join(case_dir, copy_rel)
        registered_copy_paths.add(os.path.normpath(dest))
        if not os.path.isfile(dest) or os.path.islink(dest):
            report.missing.append(
                {"rel_path": rel, "detail": f"副本缺失或不是普通文件: {copy_rel}"}
            )
            continue
        try:
            st = os.lstat(dest)
            digest = _sha256_of(dest)
        except OSError as exc:
            report.missing.append(
                {"rel_path": rel, "detail": f"副本无法读取: {exc}"}
            )
            continue
        if st.st_size != raw.get("size"):
            report.changed.append(
                {
                    "rel_path": rel,
                    "detail": (
                        f"大小变化: 清单={raw.get('size')} 副本={st.st_size}"
                    ),
                }
            )
            continue
        if digest != raw.get("sha256"):
            report.changed.append(
                {
                    "rel_path": rel,
                    "detail": "SHA-256 不一致，副本内容已被篡改或损坏",
                }
            )
            continue
        report.verified_files += 1
        report.verified_bytes += st.st_size

    # ---- 意外新增：copies/ 里存在但清单未登记的普通文件 ----
    if os.path.isdir(copies_dir):
        for dirpath, dirnames, filenames in os.walk(copies_dir):
            dirnames.sort()
            for name in sorted(filenames):
                full = os.path.join(dirpath, name)
                if os.path.basename(full).startswith(".copy-"):
                    continue  # 采集临时文件残留，单独提示更合适，这里忽略
                if os.path.normpath(full) not in registered_copy_paths:
                    report.unexpected.append(
                        {
                            "rel_path": relative_posix(copies_dir, full),
                            "detail": "副本目录中存在清单未登记的文件",
                        }
                    )

    # ---- 可选：源端漂移检查（只读，不修改案件） ----
    if check_source:
        source_root = manifest.get("source_root")
        if source_root and os.path.isdir(source_root):
            scanned, _errors = scan_tree(source_root)
            current = {e.rel_path: e for e in scanned}
            recorded = {
                raw["rel_path"]: raw
                for raw in entries
                if raw["status"] == STATUS_COLLECTED
            }
            for rel, raw in sorted(recorded.items()):
                entry = current.get(rel)
                if entry is None:
                    report.source_drift.append(
                        {
                            "rel_path": rel,
                            "detail": "源文件已不存在（副本仍保留）",
                        }
                    )
                    continue
                if entry.size != raw.get("size"):
                    report.source_drift.append(
                        {
                            "rel_path": rel,
                            "detail": (
                                f"源文件大小变化: 采集时={raw.get('size')} "
                                f"当前={entry.size}"
                            ),
                        }
                    )
                    continue
                try:
                    current_hash = _sha256_of(entry.abs_path)
                except OSError as exc:
                    report.source_drift.append(
                        {"rel_path": rel, "detail": f"源文件当前无法读取: {exc}"}
                    )
                    continue
                if current_hash != raw.get("sha256"):
                    report.source_drift.append(
                        {
                            "rel_path": rel,
                            "detail": "源文件 SHA-256 与采集时不一致，源端内容已变化",
                        }
                    )
            # 只有源端新增的普通文件才算漂移；目录/链接等条目本来就只
            # 登记不复制，且已在清单中以其他状态出现，不应重复报告。
            known_rels = {raw["rel_path"] for raw in entries}
            for entry in sorted(
                (e for e in scanned if e.entry_type == TYPE_REGULAR),
                key=lambda e: e.rel_path,
            ):
                rel = entry.rel_path
                if rel in known_rels:
                    continue
                report.source_drift.append(
                    {
                        "rel_path": rel,
                        "detail": "源目录中存在采集清单未记录的新普通文件",
                    }
                )

    for key in ("missing", "changed", "unexpected", "entry_problems",
                "source_drift"):
        getattr(report, key).sort(key=lambda item: item["rel_path"])
    return report
