"""数据结构与状态常量。

状态词汇表在采集、清单与复核三个阶段共用，保证报告口径一致。
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Optional

# ---- 条目类型 ----
TYPE_REGULAR = "regular"      # 普通文件
TYPE_DIRECTORY = "directory"  # 目录
TYPE_SYMLINK = "symlink"      # 符号链接（只记录链接本身）
TYPE_SPECIAL = "special"      # FIFO、套接字、设备文件等特殊文件

# ---- 条目处理状态 ----
STATUS_COLLECTED = "collected"          # 普通文件完整采集
STATUS_RECORDED = "recorded"            # 目录/边界内符号链接：仅登记属性，不复制内容
STATUS_SKIPPED = "skipped"              # 特殊文件等按规则跳过
STATUS_FAILED = "failed"                # 读取失败、权限错误、采集中变化等
STATUS_CONFLICT = "conflict"            # 相对路径冲突
STATUS_OUT_OF_BOUNDS = "out_of_bounds"  # 链接/路径指向根目录之外
STATUS_LIMIT_EXCEEDED = "limit_exceeded"  # 命中文件数或总字节上限
STATUS_PENDING = "pending"              # 已规划但尚未处理（中断恢复时可见）

# 未成功采集、需要在汇总中显式暴露的状态
UNSUCCESSFUL_STATUSES = frozenset(
    {
        STATUS_FAILED,
        STATUS_CONFLICT,
        STATUS_OUT_OF_BOUNDS,
        STATUS_LIMIT_EXCEEDED,
        STATUS_PENDING,
    }
)

# ---- 案件整体状态 ----
CASE_NEW = "new"                  # 仅创建案件，尚未采集
CASE_IN_PROGRESS = "in_progress"  # 采集中或被中断
CASE_COMPLETE = "complete"        # 全部条目处理完毕，无失败/越界/超限
CASE_PARTIAL = "partial"          # 有成功采集的文件，但存在失败或超限
CASE_FAILED = "failed"            # 没有任何文件成功采集

# ---- 失败原因码（reason 字段，便于机器判读） ----
REASON_READ_ERROR = "read_error"
REASON_PERMISSION_DENIED = "permission_denied"
REASON_CHANGED_DURING_READ = "changed_during_read"
REASON_SHORT_READ = "short_read"
REASON_SPECIAL_FILE = "special_file"
REASON_SYMLINK_NOT_FOLLOWED = "symlink_not_followed"
REASON_SYMLINK_ESCAPE = "symlink_escape"
REASON_PATH_ESCAPE = "path_escape"
REASON_DUPLICATE_RELPATH = "duplicate_relpath"
REASON_CASE_COLLISION = "case_insensitive_collision"
REASON_UNREADABLE_DIR = "unreadable_directory"
REASON_MAX_FILES = "max_files_limit"
REASON_MAX_BYTES = "max_bytes_limit"
REASON_INTERRUPTED = "interrupted"
REASON_SOURCE_MISSING = "source_missing"


@dataclass
class Entry:
    """扫描阶段得到的原始条目（不含处理状态）。"""

    rel_path: str           # 相对根目录的 POSIX 风格路径
    abs_path: str           # 不解析符号链接的绝对路径
    entry_type: str
    size: int = 0
    mode: int = 0
    uid: int = 0
    gid: int = 0
    inode: int = 0
    nlink: int = 1
    mtime_ns: int = 0
    is_symlink: bool = False
    symlink_target: Optional[str] = None  # 符号链接原始目标字符串

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class ManifestEntry:
    """清单中的单个条目，覆盖扫描属性与采集结果。"""

    rel_path: str
    entry_type: str
    status: str
    size: int = 0
    mode: str = ""          # 八进制字符串，例如 "0o100644"
    uid: int = 0
    gid: int = 0
    inode: int = 0
    nlink: int = 1
    mtime_ns: int = 0
    sha256: Optional[str] = None
    symlink_target: Optional[str] = None
    copy_path: Optional[str] = None  # 相对案件目录的副本路径
    reason: Optional[str] = None
    detail: Optional[str] = None     # 人类可读的补充说明

    def to_dict(self) -> dict:
        return {k: v for k, v in asdict(self).items() if v is not None}


@dataclass
class CollectionStats:
    """一次采集（含恢复续采）的计数汇总。"""

    collected: int = 0
    recorded: int = 0
    skipped: int = 0
    failed: int = 0
    conflict: int = 0
    out_of_bounds: int = 0
    limit_exceeded: int = 0
    pending: int = 0
    total_bytes: int = 0          # 成功采集文件的字节数
    reused: int = 0               # 续采时直接复用的已有副本
    reprocessed: int = 0          # 续采时重新处理的条目

    def as_dict(self) -> dict:
        return asdict(self)


@dataclass
class CollectionResult:
    case_dir: str
    case_status: str
    stats: CollectionStats
    interrupted: bool = False
    message: str = ""
    problems: list = field(default_factory=list)  # (rel_path, status, reason)
