"""迁移过程中的错误类型。

每个错误都带一个 ``kind``, CLI 用它决定退出码和提示措辞。
"""

from __future__ import annotations


class MigrationError(Exception):
    """所有迁移相关错误的基类。"""

    kind = "migration"

    def __init__(self, message: str, *, detail: str | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.detail = detail

    def as_dict(self) -> dict:
        return {"kind": self.kind, "message": self.message, "detail": self.detail}


class SaveReadError(MigrationError):
    """源文件不是合法 JSON, 或缺少必要的顶层结构。"""

    kind = "save-read"


class UnknownVersionError(MigrationError):
    """无法识别版本号; 不能猜测, 必须拒绝。"""

    kind = "unknown-version"

    def __init__(self, message: str, *, found: object, supported: list[int]) -> None:
        super().__init__(message)
        self.found = found
        self.supported = supported

    def as_dict(self) -> dict:
        data = super().as_dict()
        data.update({"found": self.found, "supported": self.supported})
        return data


class ValidationError(MigrationError):
    """迁移后的关键字段没有通过校验, 因此不产生输出。"""

    kind = "validation"

    def __init__(self, message: str, *, problems: list[dict]) -> None:
        super().__init__(message)
        self.problems = problems

    def as_dict(self) -> dict:
        data = super().as_dict()
        data["problems"] = list(self.problems)
        return data
