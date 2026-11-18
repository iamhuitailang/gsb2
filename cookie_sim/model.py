"""Cookie 与拒收记录的数据模型。"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Optional


class SameSite(str, Enum):
    """SameSite 属性的三种取值。未显式填写时在解析阶段归一化为 LAX。"""

    STRICT = "Strict"
    LAX = "Lax"
    NONE = "None"


@dataclass
class Cookie:
    """一条已入库的 cookie。

    domain 始终为小写规范化形式; host_only=True 时表示没有 Domain 属性,
    只对完全相同的主机生效。
    """

    name: str
    value: str
    domain: str
    path: str
    host_only: bool
    secure: bool
    http_only: bool
    same_site: SameSite
    # None 表示会话 cookie; 否则为绝对过期时间(unix 秒)
    expires: Optional[float]
    created_at: float
    # 入库序号, 同键更新时重新取号, 用于稳定排序
    seq: int

    def key(self) -> tuple:
        """RFC 6265 的 cookie 标识: 名称 + 域 + 路径。"""
        return (self.name, self.domain, self.path)

    def is_expired(self, now: float) -> bool:
        return self.expires is not None and now >= self.expires

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "value": self.value,
            "domain": self.domain,
            "path": self.path,
            "host_only": self.host_only,
            "secure": self.secure,
            "http_only": self.http_only,
            "same_site": self.same_site.value,
            "expires": self.expires,
            "created_at": self.created_at,
            "seq": self.seq,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "Cookie":
        return cls(
            name=data["name"],
            value=data["value"],
            domain=data["domain"],
            path=data["path"],
            host_only=bool(data["host_only"]),
            secure=bool(data["secure"]),
            http_only=bool(data["http_only"]),
            same_site=SameSite(data["same_site"]),
            expires=data.get("expires"),
            created_at=float(data["created_at"]),
            seq=int(data["seq"]),
        )


@dataclass
class RejectedCookie:
    """被拒收的 Set-Cookie 及其可读原因(不静默丢弃)。"""

    raw: str
    source_host: str
    reason: str
    at: float
    detail: str = ""

    def to_dict(self) -> dict:
        return {
            "raw": self.raw,
            "source_host": self.source_host,
            "reason": self.reason,
            "detail": self.detail,
            "at": self.at,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "RejectedCookie":
        return cls(
            raw=data["raw"],
            source_host=data["source_host"],
            reason=data["reason"],
            detail=data.get("detail", ""),
            at=float(data["at"]),
        )
