"""限流器核心规则测试：双层窗口、隔离、清理边界、持久化、并发计数。"""
from __future__ import annotations

import os
import tempfile
import threading
import unittest

# 每个用例使用独立临时数据目录；必须在导入 Config 前设置默认值
_TMP_ROOT = tempfile.mkdtemp(prefix="login-svc-test-")
os.environ.setdefault("LOGIN_SVC_DATA_DIR", os.path.join(_TMP_ROOT, "default"))

from app.config import Config  # noqa: E402
from app.rate_limit import GENERIC_FAILURE  # noqa: E402
from app.service import LoginService  # noqa: E402


class ServiceTestBase(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = tempfile.mkdtemp(dir=_TMP_ROOT)
        # 冻结时钟：时间只在显式 advance/reset 时变化，避免墙钟流逝让窗口在断言中途过期。
        # 每个用例使用独立数据目录，因此固定基准不会读到其他用例持久化的时钟偏移；
        # 重启用例复用同一目录时基准必须保持不变，否则旧窗口会在新基准下立刻过期。
        self.frozen_now = 1_000_000_000
        self.svc = LoginService(
            Config(data_dir=self.dir), time_func=lambda: self.frozen_now
        )
        self.limiter = self.svc.limiter
        # 额外测试账号，避免与演示账号 jia/yi 互相干扰
        self.svc.accounts.create("bing", "bing-pass")

    def tearDown(self) -> None:
        self.svc.close()

    def fail(self, username: str, source: str, password: str = "wrong"):
        return self.limiter.attempt(username, password, source)

    def succeed(self, username: str, password: str, source: str):
        return self.limiter.attempt(username, password, source)


class SampleScenarioTest(ServiceTestBase):
    """需求中的样例：两个来源累计让 jia 失败 3 次后，新来源也要被限制。"""

    def test_sample_walkthrough(self) -> None:
        # jia 在来源 A 失败 2 次、来源 B 失败 1 次：账号累计 3 次
        for _ in range(2):
            r = self.fail("jia", "demo-src-A")
            self.assertFalse(r.success)
        r = self.fail("jia", "demo-src-B")
        self.assertFalse(r.success)

        acct = self.limiter.account_state("jia")
        self.assertEqual(acct.failures, 3)
        self.assertTrue(acct.blocked)
        self.assertIsNotNone(acct.deadline)

        # 账号层已达上限：换新来源 C 仍然被拦，且不再增加来源计数（密码都没校验）
        src_c_before = self.limiter.source_state("demo-src-C").failures
        r = self.fail("jia", "demo-src-C")
        self.assertFalse(r.success)
        self.assertEqual(r.blocked_layer, "account")
        self.assertEqual(self.limiter.source_state("demo-src-C").failures, src_c_before)

        # yi 在另一个用量未满的来源仍能登录
        r = self.succeed("yi", "yi-pass-123", "demo-src-C")
        self.assertTrue(r.success)

        # 推进时钟，越过账号窗口截止时间
        self.svc.clock.advance(self.svc.config.account_window_seconds + 1)
        self.assertFalse(self.limiter.account_state("jia").blocked)

        # jia 用正确密码登录成功
        r = self.succeed("jia", "jia-pass-123", "demo-src-C")
        self.assertTrue(r.success)
        self.assertEqual(self.limiter.account_state("jia").failures, 0)

        # 对外失败提示始终一致
        self.assertEqual(GENERIC_FAILURE, "用户名或密码错误")

    def test_uniform_failure_message(self) -> None:
        # 密码错误与被限流返回的 message 完全相同
        r1 = self.fail("bing", "src-uniform")
        self.assertEqual(r1.message, GENERIC_FAILURE)
        for _ in range(2):
            self.fail("bing", "src-uniform")
        r2 = self.fail("bing", "src-uniform")  # 第 4 次：账号层锁定
        self.assertFalse(r2.success)
        self.assertEqual(r2.message, r1.message)
        self.assertEqual(r2.blocked_layer, "account")


class TwoLayerIsolationTest(ServiceTestBase):
    def test_same_source_different_accounts_cannot_retry_forever(self) -> None:
        """来源相同账号不同：来源层计数跨账号累计，第 6 次开始被来源层拦截。"""
        for i in range(5):
            r = self.fail(f"user{i}", "shared-source")
            self.assertFalse(r.success)
            self.assertIsNone(r.blocked_layer)  # 前 5 次都是普通密码失败

        src = self.limiter.source_state("shared-source")
        self.assertEqual(src.failures, 5)
        self.assertTrue(src.blocked)

        # 第 6 次换一个全新账号，来源层直接拦截
        r = self.fail("never-seen-user", "shared-source")
        self.assertFalse(r.success)
        self.assertEqual(r.blocked_layer, "source")
        # 被来源层拦截时，新账号自己的计数没有被写入
        self.assertEqual(self.limiter.account_state("never-seen-user").failures, 0)

    def test_same_account_different_sources_cannot_reset_account_counter(self) -> None:
        """账号相同来源不同：账号层计数与来源无关，切来源不能清空。"""
        self.fail("bing", "s1")
        self.fail("bing", "s2")
        r = self.fail("bing", "s3")  # 第 3 次，账号层锁定
        self.assertEqual(r.account_state.failures, 3)
        self.assertTrue(r.account_state.blocked)

        # 任何来源都被账号层拦下
        for src in ("s1", "s2", "brand-new"):
            r = self.fail("bing", src)
            self.assertEqual(r.blocked_layer, "account")

    def test_independent_deadlines(self) -> None:
        """两套窗口截止时间不同：账号窗过期后来源窗可能仍锁着。"""
        cfg = self.svc.config
        self.assertLess(cfg.account_window_seconds, cfg.source_window_seconds)

        # bing 在 s-x 失败 3 次：账号层锁定（3/3），来源层仅 3/5
        for _ in range(3):
            self.fail("bing", "s-x")
        self.assertTrue(self.limiter.account_state("bing").blocked)
        self.assertFalse(self.limiter.source_state("s-x").blocked)

        # 只越过账号窗口：账号层解锁，但来源层还在自己的窗口里
        self.svc.clock.advance(cfg.account_window_seconds + 1)
        self.assertFalse(self.limiter.account_state("bing").blocked)
        src = self.limiter.source_state("s-x")
        self.assertEqual(src.failures, 3)  # 来源窗口未过期，计数保留

        # 再来 2 次失败把来源层推到 5/5
        self.fail("bing", "s-x")
        self.fail("bing", "s-x")
        self.assertTrue(self.limiter.source_state("s-x").blocked)

        # 越过来源窗口后来源层解锁
        self.svc.clock.advance(cfg.source_window_seconds + 1)
        self.assertFalse(self.limiter.source_state("s-x").blocked)

    def test_success_clears_only_own_account_counter(self) -> None:
        """成功登录清自己的账号计数，但来源计数和其他账号都不动。"""
        # bing 失败 2 次；同来源下 jia 失败 1 次（来源累计 3）
        self.fail("bing", "shared-2")
        self.fail("bing", "shared-2")
        self.fail("jia", "shared-2")
        self.assertEqual(self.limiter.source_state("shared-2").failures, 3)

        # bing 成功登录
        r = self.succeed("bing", "bing-pass", "shared-2")
        self.assertTrue(r.success)

        # bing 自己的账号计数被清空
        self.assertEqual(self.limiter.account_state("bing").failures, 0)
        # 来源计数保留，jia 的账号计数也保留
        self.assertEqual(self.limiter.source_state("shared-2").failures, 3)
        self.assertEqual(self.limiter.account_state("jia").failures, 1)

        # bing 重新拥有完整的 3 次账号额度：换一个用量未满的来源，
        # 避免来源层先到上限把请求挡在账号计数之前
        for _ in range(3):
            self.fail("bing", "shared-fresh")
        # 第 3 次失败在计数后即达上限；以限流后的实时状态为准
        self.assertTrue(self.limiter.account_state("bing").blocked)
        self.assertEqual(self.limiter.account_state("bing").failures, 3)

    def test_unknown_account_still_counts(self) -> None:
        """账号不存在也按统一文案失败，且两层计数照常累计。"""
        r = self.fail("ghost", "src-ghost")
        self.assertFalse(r.success)
        self.assertEqual(r.message, GENERIC_FAILURE)
        self.assertEqual(self.limiter.account_state("ghost").failures, 1)
        self.assertEqual(self.limiter.source_state("src-ghost").failures, 1)


class ExpiryTest(ServiceTestBase):
    def test_window_reopens_after_deadline(self) -> None:
        for _ in range(3):
            self.fail("bing", "exp-src")
        self.assertTrue(self.limiter.account_state("bing").blocked)

        # 未到截止时间，时钟推进一点仍锁定
        self.svc.clock.advance(10)
        self.assertTrue(self.limiter.account_state("bing").blocked)

        # 越过截止时间后窗口作废，下一次失败开新窗，计数从 1 开始
        self.svc.clock.advance(self.svc.config.account_window_seconds)
        state = self.limiter.account_state("bing")
        self.assertFalse(state.blocked)
        r = self.fail("bing", "exp-src")
        self.assertEqual(r.account_state.failures, 1)
        self.assertIsNone(r.blocked_layer)

    def test_clock_rollback_keeps_deadline_valid(self) -> None:
        self.fail("bing", "rb-src")
        deadline = self.limiter.account_state("bing").deadline
        self.svc.clock.advance(60)
        self.svc.clock.advance(-60)  # 回拨
        self.assertEqual(self.limiter.account_state("bing").deadline, deadline)
        self.assertEqual(self.limiter.account_state("bing").failures, 1)


class PersistenceTest(ServiceTestBase):
    def test_counters_and_deadlines_survive_restart(self) -> None:
        for _ in range(2):
            self.fail("bing", "persist-src")
        deadline_before = self.limiter.account_state("bing").deadline
        offset_now = self.svc.clock.now()

        # 模拟服务重启：新建服务实例，复用同一数据目录与同一时间源
        self.svc.close()
        restarted = LoginService(
            Config(data_dir=self.dir), time_func=lambda: self.frozen_now
        )
        try:
            state = restarted.limiter.account_state("bing")
            self.assertEqual(state.failures, 2)
            self.assertEqual(state.deadline, deadline_before)
            # 演示时钟偏移同样持久化
            self.assertEqual(restarted.clock.now(), offset_now)

            # 重启后再失败一次即把账号计数推到上限（本次仍按密码失败处理）
            r = restarted.limiter.attempt("bing", "wrong", "persist-src")
            self.assertFalse(r.success)
            self.assertIsNone(r.blocked_layer)
            self.assertTrue(restarted.limiter.account_state("bing").blocked)

            # 下一次请求才被账号层拦截，截止时间仍是重启前那个窗口
            r = restarted.limiter.attempt("bing", "wrong", "persist-src")
            self.assertEqual(r.blocked_layer, "account")

            # 推进过期限后，重启的实例也按原截止时间判断为解锁
            restarted.clock.advance(restarted.config.account_window_seconds + 1)
            self.assertFalse(restarted.limiter.account_state("bing").blocked)
        finally:
            restarted.close()


class ConcurrencyTest(ServiceTestBase):
    def test_parallel_failures_count_exactly(self) -> None:
        """同时到达的失败请求：每个请求都必须被计数，不丢不重。"""
        n_threads = 40
        barrier = threading.Barrier(n_threads)

        def worker():
            barrier.wait()  # 尽量让所有线程同时进入
            self.limiter.attempt("bing", "wrong", "conc-src")

        threads = [threading.Thread(target=worker) for _ in range(n_threads)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        # 账号层上限 3：窗口内只有前 3 次计入失败，第 4 次起被账号层拦截
        self.assertEqual(self.limiter.account_state("bing").failures, 3)
        # 来源层前 3 次同样累计（被账号层拦截的请求不再写来源计数）
        self.assertEqual(self.limiter.source_state("conc-src").failures, 3)

    def test_parallel_source_failures_across_accounts(self) -> None:
        """不同账号同一来源并发：来源层精确累计到上限 5。"""
        n_threads = 30
        barrier = threading.Barrier(n_threads)

        def worker(i):
            barrier.wait()
            self.limiter.attempt(f"u{i}", "wrong", "conc-shared")

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(n_threads)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        self.assertEqual(self.limiter.source_state("conc-shared").failures, 5)

    def test_concurrent_success_does_not_clear_other_account(self) -> None:
        self.fail("jia", "mix-src")
        self.fail("bing", "mix-src")

        def login_bing():
            self.limiter.attempt("bing", "bing-pass", "mix-src")

        t = threading.Thread(target=login_bing)
        t.start()
        t.join()

        self.assertEqual(self.limiter.account_state("bing").failures, 0)
        self.assertEqual(self.limiter.account_state("jia").failures, 1)
        self.assertEqual(self.limiter.source_state("mix-src").failures, 2)


class AdminLogTest(ServiceTestBase):
    def test_log_marks_effective_layer(self) -> None:
        for _ in range(3):
            self.fail("bing", "log-src")
        r = self.fail("bing", "log-src")
        self.assertEqual(r.blocked_layer, "account")

        entries = self.svc.admin_log.recent()
        blocked = [e for e in entries if e["kind"] == "login_blocked"]
        self.assertTrue(blocked)
        self.assertEqual(blocked[-1]["layer"], "account")
        self.assertEqual(blocked[-1]["username"], "bing")
        self.assertEqual(blocked[-1]["source"], "log-src")

        # 来源层拦截也有独立标注
        for i in range(5):
            self.fail(f"l{i}", "log-shared")
        r = self.fail("lx", "log-shared")
        self.assertEqual(r.blocked_layer, "source")
        entries = self.svc.admin_log.recent()
        source_blocks = [e for e in entries if e["kind"] == "login_blocked" and e["layer"] == "source"]
        self.assertTrue(source_blocks)

    def test_log_file_written(self) -> None:
        self.fail("bing", "file-src")
        self.assertTrue(os.path.exists(self.svc.config.admin_log_path))
        with open(self.svc.config.admin_log_path, encoding="utf-8") as f:
            lines = [line for line in f if line.strip()]
        self.assertEqual(len(lines), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
