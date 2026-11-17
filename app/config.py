"""服务配置。所有项均可通过环境变量覆盖，测试时用临时数据目录隔离。"""
from __future__ import annotations

import os
from dataclasses import dataclass


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    return int(raw) if raw not in (None, "") else default


@dataclass(frozen=True)
class Config:
    # 数据目录：SQLite、管理员日志都放在这里
    data_dir: str = os.environ.get("LOGIN_SVC_DATA_DIR", os.path.join(os.getcwd(), "data"))
    host: str = os.environ.get("LOGIN_SVC_HOST", "127.0.0.1")
    port: int = _env_int("LOGIN_SVC_PORT", 8080)

    # 样例规格：账号上限 3 次，来源上限 5 次
    account_limit: int = _env_int("LOGIN_SVC_ACCOUNT_LIMIT", 3)
    source_limit: int = _env_int("LOGIN_SVC_SOURCE_LIMIT", 5)

    # 两套窗口各自独立计时，窗口长度也分开配置，截止时间分别落在不同时刻
    account_window_seconds: int = _env_int("LOGIN_SVC_ACCOUNT_WINDOW", 300)
    source_window_seconds: int = _env_int("LOGIN_SVC_SOURCE_WINDOW", 600)

    # 演示用来源标识的合法格式（本地测试入口）
    source_pattern: str = r"^[A-Za-z0-9_-]{1,64}$"

    max_body_bytes: int = 64 * 1024

    @property
    def db_path(self) -> str:
        return os.path.join(self.data_dir, "login.db")

    @property
    def admin_log_path(self) -> str:
        return os.path.join(self.data_dir, "admin.log")
