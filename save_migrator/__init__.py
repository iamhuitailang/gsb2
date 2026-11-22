"""存档迁移检查器 / Save migration inspector.

策划用: 读入虚构游戏的旧存档, 依次升级到当前版本, 在写入前后校验收关键字段,
并给出人类可读的改动预览。只依赖标准库。
"""

from .errors import MigrationError, SaveReadError, UnknownVersionError, ValidationError
from .migrate import (
    OutputConflictError,
    check_save,
    inspect_save,
    migrate_file,
    preview_save,
    resolve_rules,
)

__all__ = [
    "MigrationError",
    "UnknownVersionError",
    "SaveReadError",
    "ValidationError",
    "OutputConflictError",
    "inspect_save",
    "check_save",
    "preview_save",
    "migrate_file",
    "resolve_rules",
]
