"""逐文件采集、副本保存与中断恢复。

每个普通文件的采集流程（任一步失败都不会记为成功）：

1. 采集前 ``lstat`` 快照（大小、mtime、inode，不跟随符号链接）；
2. 以 ``O_RDONLY | O_NOFOLLOW`` 打开，分块读取并同步计算 SHA-256，
   写入副本目录下的同目录临时文件；
3. 读取字节数必须与采集前大小一致，否则判为 short_read；
4. 采集后再次 ``lstat``，大小/mtime/inode 任一变化即判为
   changed_during_read，删除半成品副本；
5. ``fsync`` + ``os.replace`` 原子落盘，更新清单并原子重写。

中断恢复：每处理完一个条目就重写一次清单，因此中断时清单始终自洽；
``.in_progress`` 标记区分“半成品”与完整案件。续采时校验已有副本的
大小与 SHA-256，完好则复用，损坏或失败的条目重新处理。
"""

from __future__ import annotations

import datetime
import os
import uuid
from typing import Callable, Optional

from .manifest import (
    append_event,
    atomic_write,
    check_manifest_integrity,
    copy_root,
    in_progress_path,
    write_case_meta,
    write_manifest,
    MANIFEST_VERSION,
)
from .models import (
    CASE_COMPLETE,
    CASE_FAILED,
    CASE_IN_PROGRESS,
    CASE_NEW,
    CASE_PARTIAL,
    CollectionResult,
    CollectionStats,
    Entry,
    ManifestEntry,
    REASON_CHANGED_DURING_READ,
    REASON_INTERRUPTED,
    REASON_PERMISSION_DENIED,
    REASON_READ_ERROR,
    REASON_SHORT_READ,
    REASON_SOURCE_MISSING,
    REASON_SPECIAL_FILE,
    STATUS_COLLECTED,
    STATUS_CONFLICT,
    STATUS_FAILED,
    STATUS_LIMIT_EXCEEDED,
    STATUS_OUT_OF_BOUNDS,
    STATUS_PENDING,
    STATUS_RECORDED,
    STATUS_SKIPPED,
    UNSUCCESSFUL_STATUSES,
)
from .paths import normalize_root, safe_join_copy_root
from .planner import plan_entries
from .scanner import scan_tree

COPY_CHUNK = 1024 * 1024  # 1 MiB


class CollectionError(Exception):
    """采集流程级别的致命错误（区别于单文件失败）。

    单文件采集失败时也用本异常，但通过 ``reason`` 携带稳定的机器可读
    原因码（见 models.REASON_*），``detail`` 携带人类可读说明，
    避免依赖对错误文本做字符串切分。
    """

    def __init__(self, reason: str, detail: str | None = None):
        self.reason = reason
        self.detail = detail
        super().__init__(reason if detail is None else f"{reason}: {detail}")


def _utc_now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )


def new_case_id() -> str:
    return "case-" + datetime.datetime.now(datetime.timezone.utc).strftime(
        "%Y%m%d-%H%M%S"
    ) + "-" + uuid.uuid4().hex[:8]


# ---------------------------------------------------------------- 案件创建

def create_case(case_dir: str, source_root: str,
                max_files: Optional[int] = None,
                max_bytes: Optional[int] = None) -> dict:
    """创建空案件目录。目标已存在且非空时拒绝，杜绝覆盖原有证据。"""
    if os.path.exists(case_dir):
        if os.listdir(case_dir):
            raise CollectionError(
                f"目标案件目录已存在且非空，拒绝覆盖: {case_dir}"
            )
    root = normalize_root(source_root)
    os.makedirs(os.path.join(case_dir, "copies"), exist_ok=True)
    case_id = new_case_id()
    meta = {
        "case_id": case_id,
        "case_status": CASE_NEW,
        "source_root": root,
        "created_at": _utc_now(),
        "updated_at": _utc_now(),
        "limits": {"max_files": max_files, "max_bytes": max_bytes},
        "manifest": "MANIFEST.json",
    }
    write_case_meta(case_dir, meta)
    write_manifest(
        case_dir,
        {
            "manifest_version": MANIFEST_VERSION,
            "case_id": case_id,
            "source_root": root,
            "created_at": meta["created_at"],
            "collected_at": None,
            "limits": meta["limits"],
            "stats": {},
            "entries": [],
        },
    )
    append_event(case_dir, f"案件已创建，源根目录: {root}")
    return meta


def _load_case(case_dir: str) -> dict:
    meta_path = os.path.join(case_dir, "case.json")
    if not os.path.isfile(meta_path):
        raise CollectionError(
            f"目录存在但不是本工具管理的案件（缺少 case.json）: {case_dir}"
        )
    import json
    with open(meta_path, "rb") as fh:
        meta = json.loads(fh.read().decode("utf-8"))
    required = {"case_id", "case_status", "source_root", "limits"}
    if not required.issubset(meta):
        raise CollectionError("case.json 结构不完整，拒绝继续以免破坏证据")
    return meta


# ------------------------------------------------------------- 单文件采集

def _lstat_snapshot(path: str) -> os.stat_result:
    return os.lstat(path)


def copy_regular_file(
    entry: Entry,
    dest_path: str,
    mid_read_hook: Optional[Callable[[Entry, int], None]] = None,
) -> tuple[str, int]:
    """采集单个普通文件，返回 ``(sha256, 实际读取字节数)``。

    失败时抛 :class:`CollectionError`，并保证不留下半成品副本。
    ``mid_read_hook`` 仅供测试注入（例如在读取过程中改动源文件）。
    """
    import hashlib

    pre = _lstat_snapshot(entry.abs_path)
    import stat as stat_mod
    if not stat_mod.S_ISREG(pre.st_mode):
        raise CollectionError(
            REASON_READ_ERROR, "采集前复核发现条目已不是普通文件"
        )

    os.makedirs(os.path.dirname(dest_path), exist_ok=True)
    tmp_fd, tmp_path = None, None
    fd, out_fh = None, None
    bytes_read = 0
    digest = hashlib.sha256()
    try:
        # O_NOFOLLOW：防御性兜底，符号链接会直接失败而不是被读取内容
        flags = os.O_RDONLY
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        try:
            fd = os.open(entry.abs_path, flags)
        except PermissionError as exc:
            raise CollectionError(REASON_PERMISSION_DENIED, str(exc))
        except OSError as exc:
            raise CollectionError(REASON_READ_ERROR, str(exc))

        tmp_fd, tmp_path = _make_temp(dest_path)
        out_fh = os.fdopen(tmp_fd, "wb")
        tmp_fd = None
        hook_called = False
        while True:
            try:
                chunk = os.read(fd, COPY_CHUNK)
            except PermissionError as exc:
                raise CollectionError(REASON_PERMISSION_DENIED, str(exc))
            except OSError as exc:
                raise CollectionError(REASON_READ_ERROR, str(exc))
            if not chunk:
                break
            out_fh.write(chunk)
            digest.update(chunk)
            bytes_read += len(chunk)
            if mid_read_hook is not None and not hook_called:
                hook_called = True
                mid_read_hook(entry, bytes_read)
        out_fh.flush()
        os.fsync(out_fh.fileno())
    except BaseException:
        # 任何异常（含 KeyboardInterrupt）都不允许留下半成品副本
        _safe_unlink(tmp_path)
        raise
    finally:
        if out_fh is not None:
            out_fh.close()
        if fd is not None:
            os.close(fd)

    # 读取完整性：实际字节数必须等于采集前大小
    if bytes_read != pre.st_size:
        _safe_unlink(tmp_path)
        raise CollectionError(
            REASON_SHORT_READ,
            f"预期 {pre.st_size} 字节，实际读取 {bytes_read} 字节",
        )

    # 采集后变化检测：大小 / mtime / inode 任一变化即失败；
    # 源文件在读取过程中被删除同样视为采集中变化。
    try:
        post = _lstat_snapshot(entry.abs_path)
    except FileNotFoundError:
        _safe_unlink(tmp_path)
        raise CollectionError(
            REASON_CHANGED_DURING_READ, "源文件在采集过程中被删除"
        )
    except OSError as exc:
        _safe_unlink(tmp_path)
        raise CollectionError(REASON_READ_ERROR, str(exc))
    changed = (
        post.st_size != pre.st_size
        or post.st_mtime_ns != pre.st_mtime_ns
        or post.st_ino != pre.st_ino
    )
    if changed:
        _safe_unlink(tmp_path)
        raise CollectionError(
            REASON_CHANGED_DURING_READ,
            f"采集前(size={pre.st_size},mtime_ns={pre.st_mtime_ns},"
            f"ino={pre.st_ino}) 采集后(size={post.st_size},"
            f"mtime_ns={post.st_mtime_ns},ino={post.st_ino})",
        )

    os.replace(tmp_path, dest_path)
    return digest.hexdigest(), bytes_read


def _make_temp(dest_path: str) -> tuple[int, str]:
    import tempfile
    directory = os.path.dirname(dest_path)
    return tempfile.mkstemp(prefix=".copy-", dir=directory)


def _safe_unlink(path: Optional[str]) -> None:
    if path and os.path.exists(path):
        try:
            os.unlink(path)
        except OSError:
            pass


def _copy_is_valid(me: ManifestEntry, case_dir: str) -> bool:
    """续采时复核已有副本是否与清单记录一致。"""
    if not me.copy_path or not me.sha256:
        return False
    dest = os.path.join(case_dir, me.copy_path)
    try:
        st = os.lstat(dest)
    except OSError:
        return False
    import stat as stat_mod
    if not stat_mod.S_ISREG(st.st_mode) or st.st_size != me.size:
        return False
    import hashlib
    h = hashlib.sha256()
    try:
        with open(dest, "rb") as fh:
            for chunk in iter(lambda: fh.read(COPY_CHUNK), b""):
                h.update(chunk)
    except OSError:
        return False
    return h.hexdigest() == me.sha256


# ----------------------------------------------------------------- 主流程

def collect(
    case_dir: str,
    source_root: Optional[str] = None,
    max_files: Optional[int] = None,
    max_bytes: Optional[int] = None,
    mid_read_hook: Optional[Callable[[Entry, int], None]] = None,
) -> CollectionResult:
    """执行采集（首次采集或中断续采），返回汇总结果。"""
    # ---- 案件装载 / 创建 ----
    prior_entries: dict[str, ManifestEntry] = {}
    if os.path.exists(case_dir):
        meta = _load_case(case_dir)
        if meta["case_status"] == CASE_COMPLETE:
            raise CollectionError(
                "该案件已完整采集，拒绝覆盖。如需重新采集请创建新案件目录。"
            )
        ok, problem, old_manifest = check_manifest_integrity(case_dir)
        if not ok:
            raise CollectionError(
                f"已有清单损坏，拒绝在原案件上继续: {problem}"
            )
        valid_keys = set(ManifestEntry.__dataclass_fields__)
        for raw in old_manifest.get("entries", []):
            unknown = set(raw) - valid_keys
            if unknown:
                raise CollectionError(
                    "清单条目包含无法识别的字段，拒绝继续以免误解证据: "
                    + ", ".join(sorted(unknown))
                )
            prior_entries[raw["rel_path"]] = ManifestEntry(**raw)
        root = normalize_root(meta["source_root"])
        if source_root is not None and normalize_root(source_root) != root:
            raise CollectionError(
                "指定的源根目录与案件记录不一致，拒绝混用证据来源"
            )
        limits = meta.get("limits", {})
        max_files = limits.get("max_files")
        max_bytes = limits.get("max_bytes")
        case_id = meta["case_id"]
        created_at = old_manifest["created_at"]
        append_event(case_dir, "续采开始：重新扫描源目录并复核已有副本")
    else:
        if source_root is None:
            raise CollectionError("案件不存在且未提供源根目录，无法采集")
        root = normalize_root(source_root)
        meta = create_case(case_dir, root, max_files, max_bytes)
        case_id = meta["case_id"]
        created_at = meta["created_at"]
        append_event(case_dir, "首次采集开始")

    # ---- 中断/半成品标记 ----
    marker = in_progress_path(case_dir)
    atomic_write(
        marker,
        ("pid=%d\nstarted_at=%s\n" % (os.getpid(), _utc_now())).encode("utf-8"),
    )

    # ---- 重新扫描 + 规划 ----
    scanned, scan_errors = scan_tree(root)
    planned = plan_entries(root, scanned, scan_errors, max_files, max_bytes)
    planned_map = {me.rel_path: me for me in planned}

    # ---- 与历史清单合并：源已消失的条目显式标注 ----
    merged: list[ManifestEntry] = []
    for me in planned:
        old = prior_entries.get(me.rel_path)
        if old is not None and old.status == STATUS_COLLECTED:
            if _copy_is_valid(old, case_dir):
                kept = ManifestEntry(**old.to_dict())
                kept.detail = _join_detail(kept.detail, "续采：副本校验通过，直接复用")
                merged.append(kept)
            else:
                merged.append(me)  # 副本缺失/损坏，重新处理
        else:
            merged.append(me)
    for rel, old in prior_entries.items():
        if rel not in planned_map:
            kept = ManifestEntry(**old.to_dict())
            if kept.status == STATUS_COLLECTED:
                kept.detail = _join_detail(
                    kept.detail, "续采：源文件已消失，保留原有副本与记录"
                )
            else:
                kept.status = STATUS_FAILED
                kept.reason = REASON_SOURCE_MISSING
                kept.detail = _join_detail(kept.detail, "续采：源条目已不存在")
            merged.append(kept)
    merged.sort(key=lambda me: me.rel_path)

    stats = CollectionStats()
    problems: list[tuple[str, str, str]] = []
    interrupted = False
    copies_dir = copy_root(case_dir)

    def persist() -> None:
        write_manifest(
            case_dir,
            {
                "manifest_version": MANIFEST_VERSION,
                "case_id": case_id,
                "source_root": root,
                "created_at": created_at,
                "collected_at": _utc_now(),
                "limits": {"max_files": max_files, "max_bytes": max_bytes},
                "stats": stats.as_dict(),
                "entries": [m.to_dict() for m in merged],
            },
        )

    try:
        for me in merged:
            old = prior_entries.get(me.rel_path)

            if me.status == STATUS_COLLECTED:
                stats.collected += 1
                stats.total_bytes += me.size
                stats.reused += 1
                continue

            if me.status in (STATUS_RECORDED,):
                stats.recorded += 1
                persist()
                continue
            if me.status == STATUS_SKIPPED:
                stats.skipped += 1
                if me.reason is None:
                    me.reason = REASON_SPECIAL_FILE
                problems.append((me.rel_path, me.status, me.reason))
                persist()
                continue

            # pending 是唯一可继续处理的状态，必须在“未成功终态”分支之前。
            if me.status == STATUS_PENDING:
                entry = _find_entry(scanned, me.rel_path)
                if entry is None:
                    me.status = STATUS_FAILED
                    me.reason = REASON_SOURCE_MISSING
                    me.detail = "处理时源条目已不存在"
                    stats.failed += 1
                    problems.append((me.rel_path, me.status, me.reason))
                    persist()
                    continue

                if old is not None and old.status in (
                    STATUS_FAILED,
                    STATUS_PENDING,
                ):
                    stats.reprocessed += 1

                dest = safe_join_copy_root(copies_dir, me.rel_path)
                try:
                    digest, nbytes = copy_regular_file(entry, dest, mid_read_hook)
                except CollectionError as exc:
                    me.status = STATUS_FAILED
                    me.reason = exc.reason if exc.reason in (
                        REASON_PERMISSION_DENIED,
                        REASON_READ_ERROR,
                        REASON_SHORT_READ,
                        REASON_CHANGED_DURING_READ,
                    ) else REASON_READ_ERROR
                    me.detail = exc.detail or str(exc)
                    me.copy_path = None
                    me.sha256 = None
                    stats.failed += 1
                    problems.append((me.rel_path, me.status, me.reason))
                    append_event(case_dir, f"采集失败 {me.rel_path}: {me.reason}")
                    persist()
                    continue

                me.status = STATUS_COLLECTED
                me.sha256 = digest
                me.copy_path = os.path.relpath(dest, case_dir).replace(os.sep, "/")
                me.reason = None
                me.detail = None
                stats.collected += 1
                stats.total_bytes += nbytes
                persist()
                continue

            # 其余未成功状态均为终态（failed/conflict/out_of_bounds/
            # limit_exceeded），计数并报告，不尝试读取。
            if me.status in UNSUCCESSFUL_STATUSES:
                _count_unsuccessful(stats, me.status)
                problems.append((me.rel_path, me.status, me.reason or me.status))
                persist()
                continue

    except KeyboardInterrupt:
        interrupted = True
        append_event(case_dir, "采集被用户中断，剩余条目标记为 interrupted")
        for me in merged:
            if me.status == STATUS_PENDING:
                me.status = STATUS_FAILED
                me.reason = REASON_INTERRUPTED
                me.detail = "采集过程被中断，条目尚未处理"
                stats.failed += 1
                problems.append((me.rel_path, me.status, me.reason))
        persist()

    # ---- 案件状态定级 ----
    hard_failures = [
        m for m in merged if m.status == STATUS_FAILED
    ]
    soft_problems = [
        m for m in merged
        if m.status in (
            STATUS_CONFLICT,
            STATUS_OUT_OF_BOUNDS,
            STATUS_LIMIT_EXCEEDED,
        )
    ]
    if interrupted:
        case_status = CASE_IN_PROGRESS
    elif stats.collected == 0 and hard_failures:
        # 没有任何成功文件且存在读取失败/中断条目：整体失败
        case_status = CASE_FAILED
    elif hard_failures or soft_problems:
        # 受限、冲突、越界或部分失败但仍有/本应有可用证据：部分完成
        case_status = CASE_PARTIAL
    elif stats.collected == 0 and stats.recorded == 0:
        # 空源目录：视为完整（确实没有遗漏任何东西）
        case_status = CASE_COMPLETE
    else:
        case_status = CASE_COMPLETE

    if not interrupted and os.path.exists(marker):
        os.unlink(marker)

    persist()
    meta = _load_case(case_dir) if os.path.isfile(os.path.join(case_dir, "case.json")) else {}
    meta.update(
        {
            "case_status": case_status,
            "updated_at": _utc_now(),
            "source_root": root,
            "limits": {"max_files": max_files, "max_bytes": max_bytes},
        }
    )
    write_case_meta(case_dir, meta)
    append_event(
        case_dir,
        f"采集结束：状态={case_status}，成功={stats.collected}，"
        f"复用={stats.reused}，问题条目={len(hard_failures) + len(soft_problems)}",
    )

    message = _summary_message(case_status, stats, interrupted, len(merged))
    return CollectionResult(
        case_dir=case_dir,
        case_status=case_status,
        stats=stats,
        interrupted=interrupted,
        message=message,
        problems=problems,
    )


def _count_unsuccessful(stats: CollectionStats, status: str) -> None:
    if status == STATUS_FAILED:
        stats.failed += 1
    elif status == STATUS_CONFLICT:
        stats.conflict += 1
    elif status == STATUS_OUT_OF_BOUNDS:
        stats.out_of_bounds += 1
    elif status == STATUS_LIMIT_EXCEEDED:
        stats.limit_exceeded += 1
    elif status == STATUS_PENDING:
        stats.pending += 1


def _find_entry(entries: list[Entry], rel_path: str) -> Optional[Entry]:
    for e in entries:
        if e.rel_path == rel_path:
            return e
    return None


def _join_detail(existing: Optional[str], note: str) -> str:
    return f"{existing}；{note}" if existing else note


def _summary_message(status: str, stats: CollectionStats,
                     interrupted: bool, total: int) -> str:
    parts = [
        f"条目总数={total}",
        f"成功采集={stats.collected}",
        f"仅登记={stats.recorded}",
        f"跳过={stats.skipped}",
        f"失败={stats.failed}",
        f"路径冲突={stats.conflict}",
        f"越界={stats.out_of_bounds}",
        f"超限={stats.limit_exceeded}",
        f"采集字节={stats.total_bytes}",
    ]
    prefix = "采集中断" if interrupted else f"案件状态: {status}"
    return prefix + "（" + "，".join(parts) + "）"
