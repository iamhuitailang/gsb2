"""Cookie 存储: 入库更新/删除、持久化与拒收记录。

更新与删除只作用于相同 (名称, 域, 路径) 的组合; 同名但不同域/路径的 cookie 并存。
"""
from __future__ import annotations

import json
import os
import threading
from typing import Optional

from .model import Cookie, RejectedCookie
from .timeutil import now_ts

_MAX_REJECTIONS = 200


class CookieJar:
    def __init__(self, now_func=now_ts):
        self._cookies: dict[tuple, Cookie] = {}
        self._rejections: list[RejectedCookie] = []
        self._seq = 0
        self._lock = threading.RLock()
        self._now = now_func

    # ---------- 入库 ----------
    def add(self, cookie: Cookie) -> Cookie:
        """存入或更新一条 cookie, 返回入库后的对象。"""
        with self._lock:
            now = self._now()
            if cookie.expires is not None and now >= cookie.expires:
                # 已过期(含 Max-Age=0、过去的 Expires): 删除同名/域/路径组合
                return self._remove_key(cookie.key(), reason="已过期或显式删除")
            self._seq += 1
            cookie.seq = self._seq
            cookie.created_at = now
            self._cookies[cookie.key()] = cookie
            return cookie

    def _remove_key(self, key: tuple, reason: str = "") -> Optional[Cookie]:
        with self._lock:
            return self._cookies.pop(key, None)

    def reject(self, raw: str, source_host: str, reason: str, detail: str = "") -> None:
        """保留一条可读的拒收记录(不静默丢弃)。"""
        with self._lock:
            self._rejections.append(
                RejectedCookie(
                    raw=raw,
                    source_host=source_host,
                    reason=reason,
                    detail=detail,
                    at=self._now(),
                )
            )
            if len(self._rejections) > _MAX_REJECTIONS:
                self._rejections = self._rejections[-_MAX_REJECTIONS:]

    # ---------- 查询 ----------
    def all_cookies(self) -> list[Cookie]:
        with self._lock:
            return list(self._cookies.values())

    def get(self, key: tuple) -> Optional[Cookie]:
        with self._lock:
            return self._cookies.get(key)

    def rejections(self) -> list[RejectedCookie]:
        with self._lock:
            return list(self._rejections)

    def purge_expired(self, now: Optional[float] = None) -> int:
        """清理所有已过期 cookie, 返回清理条数。

        now 可显式注入(测试/虚拟时钟); 缺省使用 jar 配置的时间源。
        """
        with self._lock:
            if now is None:
                now = self._now()
            dead = [k for k, c in self._cookies.items() if c.is_expired(now)]
            for k in dead:
                del self._cookies[k]
            return len(dead)

    def delete(self, name: str, domain: str, path: str) -> bool:
        """界面手动删除指定 名称/域/路径 组合。"""
        with self._lock:
            return self._cookies.pop((name, domain.lower().rstrip("."), path), None) is not None

    def clear(self) -> None:
        with self._lock:
            self._cookies.clear()
            self._rejections.clear()
            self._seq = 0

    def clear_rejections(self) -> None:
        with self._lock:
            self._rejections.clear()

    # ---------- 持久化 ----------
    def to_dict(self) -> dict:
        with self._lock:
            return {
                "cookies": [c.to_dict() for c in self._cookies.values()],
                "rejections": [r.to_dict() for r in self._rejections],
                "seq": self._seq,
            }

    def load_dict(self, data: dict) -> None:
        with self._lock:
            self._cookies.clear()
            self._rejections.clear()
            for item in data.get("cookies", []):
                cookie = Cookie.from_dict(item)
                self._cookies[cookie.key()] = cookie
            for item in data.get("rejections", []):
                self._rejections.append(RejectedCookie.from_dict(item))
            self._seq = int(data.get("seq", 0))

    def save(self, path: str) -> None:
        with self._lock:
            os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
            tmp = path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(self.to_dict(), fh, ensure_ascii=False, indent=2)
            os.replace(tmp, path)

    def load(self, path: str) -> bool:
        if not os.path.exists(path):
            return False
        with open(path, "r", encoding="utf-8") as fh:
            self.load_dict(json.load(fh))
        return True
