"""双层失败计数限流器（本服务的核心）。

两层窗口相互独立、各自截止时间独立：

* 账号层 ``scope='account'``：按用户名计数，上限 ``account_limit``。
  同一账号即使切换来源也无法清空计数 —— 账号计数不携带来源维度。
* 来源层 ``scope='source'``：按来源标识计数，上限 ``source_limit``。
  同一来源下即使换账号也无法无限重试 —— 来源计数不携带账号维度。

并发安全：每次登录尝试整体在 :class:`~app.storage.Storage` 的同一把进程锁 +
单个 SQLite 即时事务内完成「读旧值 → 判过期 → 判定 → 写新值」，
同时到达的请求被串行化，计数不会丢失或重复。

持久化：计数与窗口截止时间（deadline）落库，重启后按原 deadline 继续判断。
"""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass

from .accounts import AccountStore
from .admin_log import AdminLogger
from .clock import DemoClock
from .config import Config
from .storage import Storage

SCOPE_ACCOUNT = "account"
SCOPE_SOURCE = "source"

# 对外保持一致的失败提示，不透露是密码错、账号锁还是来源锁
GENERIC_FAILURE = "用户名或密码错误"


@dataclass(frozen=True)
class WindowState:
    scope: str
    key: str
    failures: int
    limit: int
    deadline: int | None          # None 表示当前无活动窗口
    window_seconds: int
    blocked: bool
    retry_after: int | None       # 距截止还剩多少秒（演示时钟），未锁定为 None


@dataclass(frozen=True)
class LoginResult:
    success: bool
    # 对外统一文案；仅成功时为 None
    message: str | None
    # 生效的限制层，仅内部/管理员日志使用：'account' | 'source' | None
    blocked_layer: str | None
    account_state: WindowState
    source_state: WindowState


class RateLimiter:
    def __init__(
        self,
        storage: Storage,
        clock: DemoClock,
        config: Config,
        accounts: AccountStore,
        admin_log: AdminLogger,
    ) -> None:
        self._storage = storage
        self._clock = clock
        self._config = config
        self._accounts = accounts
        self._admin_log = admin_log

    # ---- 内部工具 -------------------------------------------------------

    def _load_row(self, conn: sqlite3.Connection, scope: str, key: str) -> sqlite3.Row | None:
        return conn.execute(
            "SELECT failures, deadline FROM failure_counters WHERE scope = ? AND key = ?",
            (scope, key),
        ).fetchone()

    def _effective(self, row: sqlite3.Row | None, now: int) -> tuple[int, int | None]:
        """返回 (当前有效失败次数, 窗口截止时间)。惰性判定已过期窗口。"""
        if row is None or row["deadline"] <= now:
            return 0, None
        return int(row["failures"]), int(row["deadline"])

    def _purge_if_expired(
        self, conn: sqlite3.Connection, scope: str, key: str, now: int
    ) -> None:
        """在事务内删除已过期的计数行，避免后续写入复用陈旧窗口。"""
        conn.execute(
            "DELETE FROM failure_counters WHERE scope = ? AND key = ? AND deadline <= ?",
            (scope, key, now),
        )

    def _bump(
        self,
        conn: sqlite3.Connection,
        scope: str,
        key: str,
        now: int,
        window_seconds: int,
    ) -> tuple[int, int]:
        """失败一次：旧窗口过期则开新窗，否则在原窗口内累加。返回 (新次数, 截止时间)。"""
        self._purge_if_expired(conn, scope, key, now)
        row = self._load_row(conn, scope, key)
        if row is None:
            failures = 0
            deadline = now + window_seconds
        else:
            failures = int(row["failures"])
            deadline = int(row["deadline"])
        failures += 1
        conn.execute(
            "INSERT INTO failure_counters(scope, key, failures, deadline) VALUES(?, ?, ?, ?) "
            "ON CONFLICT(scope, key) DO UPDATE SET failures = excluded.failures, "
            "deadline = excluded.deadline",
            (scope, key, failures, deadline),
        )
        return failures, deadline

    def _clear(self, conn: sqlite3.Connection, scope: str, key: str) -> None:
        conn.execute(
            "DELETE FROM failure_counters WHERE scope = ? AND key = ?",
            (scope, key),
        )

    def _window_seconds(self, scope: str) -> int:
        return (
            self._config.account_window_seconds
            if scope == SCOPE_ACCOUNT
            else self._config.source_window_seconds
        )

    def _limit(self, scope: str) -> int:
        return (
            self._config.account_limit
            if scope == SCOPE_ACCOUNT
            else self._config.source_limit
        )

    def _state(self, scope: str, key: str) -> WindowState:
        now = self._clock.now()
        with self._storage.lock:
            row = self._load_row(self._storage.conn, scope, key)
        failures, deadline = self._effective(row, now)
        limit = self._limit(scope)
        blocked = failures >= limit
        retry_after = max(deadline - now, 0) if blocked and deadline is not None else None
        return WindowState(
            scope=scope,
            key=key,
            failures=failures,
            limit=limit,
            deadline=deadline,
            window_seconds=self._window_seconds(scope),
            blocked=blocked,
            retry_after=retry_after,
        )

    # ---- 对外只读视图 ---------------------------------------------------

    def account_state(self, username: str) -> WindowState:
        return self._state(SCOPE_ACCOUNT, username)

    def source_state(self, source: str) -> WindowState:
        return self._state(SCOPE_SOURCE, source)

    # ---- 登录尝试（判定 + 计数，单事务原子完成） -------------------------

    def attempt(self, username: str, password: str, source: str) -> LoginResult:
        cfg = self._config
        # 整个判定与计数在一个即时事务 + 进程锁内，并发请求串行化。
        # 管理员日志在事务提交后再写，避免日志自身的 commit 提前结束事务。
        with self._storage.transaction() as conn:
            now = self._clock.now()

            # 先清理两层各自的过期窗口，后续所有判定都基于有效计数
            self._purge_if_expired(conn, SCOPE_ACCOUNT, username, now)
            self._purge_if_expired(conn, SCOPE_SOURCE, source, now)

            acct_row = self._load_row(conn, SCOPE_ACCOUNT, username)
            acct_failures, acct_deadline = self._effective(acct_row, now)
            src_row = self._load_row(conn, SCOPE_SOURCE, source)
            src_failures, src_deadline = self._effective(src_row, now)

            acct_snap = self._snapshot(SCOPE_ACCOUNT, username, acct_failures, acct_deadline, now)
            src_snap = self._snapshot(SCOPE_SOURCE, source, src_failures, src_deadline, now)

            # 1) 先判账号层：同账号切来源也绕不过
            if acct_failures >= cfg.account_limit:
                event = (
                    "login_blocked", SCOPE_ACCOUNT,
                    f"账号窗口已达上限 {cfg.account_limit}，截止 {acct_deadline}",
                )
                result = LoginResult(False, GENERIC_FAILURE, SCOPE_ACCOUNT, acct_snap, src_snap)
            # 2) 再判来源层：同来源换账号也绕不过
            elif src_failures >= cfg.source_limit:
                event = (
                    "login_blocked", SCOPE_SOURCE,
                    f"来源窗口已达上限 {cfg.source_limit}，截止 {src_deadline}",
                )
                result = LoginResult(False, GENERIC_FAILURE, SCOPE_SOURCE, acct_snap, src_snap)
            else:
                # 3) 未被限流才校验密码（避免对已锁定窗口继续做无意义的密码尝试）
                account = self._accounts.get(username)
                password_ok = account is not None and self._accounts.verify(account, password)

                if not password_ok:
                    # 账号、来源两层各自 +1，截止时间相互独立
                    new_acct, acct_dl = self._bump(
                        conn, SCOPE_ACCOUNT, username, now, cfg.account_window_seconds
                    )
                    new_src, src_dl = self._bump(
                        conn, SCOPE_SOURCE, source, now, cfg.source_window_seconds
                    )
                    event = (
                        "login_failure", None,
                        f"账号失败 {new_acct}/{cfg.account_limit}（截止 {acct_dl}）；"
                        f"来源失败 {new_src}/{cfg.source_limit}（截止 {src_dl}）",
                    )
                    result = LoginResult(
                        False, GENERIC_FAILURE, None,
                        self._snapshot(SCOPE_ACCOUNT, username, new_acct, acct_dl, now),
                        self._snapshot(SCOPE_SOURCE, source, new_src, src_dl, now),
                    )
                else:
                    # 4) 成功：只清本账号自己的失败计数；来源计数与其他账号均不受影响
                    self._clear(conn, SCOPE_ACCOUNT, username)
                    event = (
                        "login_success", None,
                        "成功登录，已清除该账号自身的失败计数（来源计数保留）",
                    )
                    result = LoginResult(
                        True, None, None,
                        self._snapshot(SCOPE_ACCOUNT, username, 0, None, now),
                        self._snapshot(SCOPE_SOURCE, source, src_failures, src_deadline, now),
                    )

        kind, layer, detail = event
        self._admin_log.log(kind, username=username, source=source, layer=layer, detail=detail)
        return result

    def _snapshot(
        self, scope: str, key: str, failures: int, deadline: int | None, now: int
    ) -> WindowState:
        limit = self._limit(scope)
        blocked = failures >= limit
        retry_after = max(deadline - now, 0) if blocked and deadline is not None else None
        return WindowState(
            scope=scope,
            key=key,
            failures=failures,
            limit=limit,
            deadline=deadline,
            window_seconds=self._window_seconds(scope),
            blocked=blocked,
            retry_after=retry_after,
        )
