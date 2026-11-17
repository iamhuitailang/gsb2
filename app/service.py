"""服务门面：组装存储、时钟、账号、限流与日志，并负责演示数据播种。"""
from __future__ import annotations

import re
from typing import Callable

from .accounts import AccountStore
from .admin_log import AdminLogger
from .clock import DemoClock
from .config import Config
from .rate_limit import RateLimiter
from .storage import Storage

# 演示账号（仅本地演示用，README 中公开密码）
DEMO_ACCOUNTS = {
    "jia": "jia-pass-123",
    "yi": "yi-pass-123",
}


class LoginService:
    def __init__(
        self,
        config: Config | None = None,
        time_func: Callable[[], float] | None = None,
    ) -> None:
        self.config = config or Config()
        self.storage = Storage(self.config.db_path)
        self.clock = DemoClock(self.storage, time_func=time_func)
        self.accounts = AccountStore(self.storage, self.clock)
        self.admin_log = AdminLogger(self.storage, self.clock, self.config.admin_log_path)
        self.limiter = RateLimiter(
            self.storage, self.clock, self.config, self.accounts, self.admin_log
        )
        self._source_re = re.compile(self.config.source_pattern)
        self.seed_demo_accounts()

    def seed_demo_accounts(self) -> None:
        for username, password in DEMO_ACCOUNTS.items():
            if self.accounts.get(username) is None:
                self.accounts.create(username, password)

    def is_valid_source(self, source: str) -> bool:
        return bool(self._source_re.fullmatch(source or ""))

    def close(self) -> None:
        self.storage.close()
