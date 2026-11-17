#!/usr/bin/env python3
"""自动演示：启用二次验证 → 双窗口进入待验证 → 同一备用码并发提交。

用临时数据库起一个真实的 HTTP 服务，两个各自持有 Cookie 的客户端模拟两个窗口。
运行：python3 manage.py demo
"""

from __future__ import annotations

import html
import http.client
import logging
import os
import re
import shutil
import sys
import tempfile
import threading
import time
from urllib.parse import urlencode

import app
import otp


class Result:
    def __init__(self, verbose: bool = True) -> None:
        self.checks: list[tuple[bool, str]] = []
        self.verbose = verbose

    def section(self, title: str) -> None:
        if self.verbose:
            print(f"\n{title}")

    def check(self, ok: bool, label: str, detail: str = "") -> bool:
        self.checks.append((ok, label))
        if self.verbose:
            suffix = f" — {detail}" if detail else ""
            print(f"  [{'PASS' if ok else 'FAIL'}] {label}{suffix}")
        return ok

    @property
    def failed(self) -> int:
        return sum(1 for ok, _ in self.checks if not ok)


class Client:
    """一个“浏览器窗口”：自己管理 sid Cookie，不共享任何状态。"""

    def __init__(self, host: str, port: int, name: str) -> None:
        self.host = host
        self.port = port
        self.name = name
        self.cookie: str | None = None

    def request(self, method: str, path: str, body: bytes = b"", *, follow: bool = False):
        headers = {"Content-Type": "application/x-www-form-urlencoded"}
        if self.cookie:
            headers["Cookie"] = f"sid={self.cookie}"
        if body:
            headers["Content-Length"] = str(len(body))
        conn = http.client.HTTPConnection(self.host, self.port, timeout=15)
        try:
            conn.request(method, path, body=body or None, headers=headers)
            response = conn.getresponse()
            text = response.read().decode("utf-8", "replace")
            set_cookie = response.getheader("Set-Cookie") or ""
            match = re.search(r"sid=([^;]*)", set_cookie)
            if match:
                self.cookie = match.group(1) or None
            status = response.status
            location = response.getheader("Location")
        finally:
            conn.close()
        if follow and status == 303 and location:
            return self.request("GET", location, follow=True)
        return status, text, location

    def get(self, path: str, *, follow: bool = False):
        return self.request("GET", path, follow=follow)

    def post(self, path: str, fields: dict[str, str], *, follow: bool = False):
        return self.request("POST", path, urlencode(fields).encode("utf-8"), follow=follow)


class LogCollector(logging.Handler):
    def __init__(self) -> None:
        super().__init__(level=logging.DEBUG)
        self.messages: list[str] = []

    def emit(self, record) -> None:
        self.messages.append(record.getMessage())

    def text(self) -> str:
        return "\n".join(self.messages)


def extract_csrf(page_text: str) -> str | None:
    match = re.search(r'name="csrf" value="([^"]+)"', page_text)
    return html.unescape(match.group(1)) if match else None


def extract_secret(page_text: str) -> str | None:
    """取“手动输入用的密钥”那一块：20 字节密钥的 base32 正好 32 个字符。"""
    match = re.search(r'class="reveal">([A-Z2-7]{32})</div>', page_text)
    return match.group(1) if match else None


def extract_codes(page_text: str) -> list[str]:
    return re.findall(r"<li>([A-Z0-9]{5}-[A-Z0-9]{5})</li>", page_text)


def hmac_sha256_present(stored: str) -> bool:
    """摘要都是 64 位十六进制；原文是 5-5 的大写字母数字。"""
    digests = stored.split()
    return bool(digests) and all(len(d) == 64 and re.fullmatch(r"[0-9a-f]+", d) for d in digests)


def wrong_totp_code(secret: str) -> str:
    """找一个当前窗口内一定不会通过的口令（避开 ±1 步的容差）。"""
    now = time.time()
    valid = {
        otp.totp_code(secret, now + delta * otp.TOTP_PERIOD)
        for delta in (-1, 0, 1)
    }
    candidate = "000000"
    while candidate in valid:
        candidate = f"{(int(candidate) + 1) % 1000000:06d}"
    return candidate


def login(client: Client, result: Result, expect: str) -> None:
    status, _, location = client.post(
        "/login", {"username": app.DEMO_USERNAME, "password": app.DEMO_PASSWORD}
    )
    result.check(
        status == 303 and location == expect,
        f"{client.name}：密码登录后跳转到 {expect}",
        f"status={status} location={location}",
    )


def logout(client: Client) -> None:
    _, text, _ = client.get("/", follow=True)
    csrf = extract_csrf(text) or ""
    client.post("/logout", {"csrf": csrf})


def enable_totp(result: Result, client: Client, center) -> tuple[str, list[str]]:
    status, text, _ = client.get("/settings", follow=True)
    csrf = extract_csrf(text) or ""
    result.check(status == 200 and bool(csrf), "安全设置页可访问并带 CSRF")

    status, _, location = client.post("/settings/totp/setup", {"csrf": csrf})
    result.check(
        status == 303 and location == "/settings/totp/confirm",
        "生成待启用的验证器配置",
        f"status={status} location={location}",
    )

    status, text, _ = client.get("/settings/totp/confirm", follow=True)
    secret = extract_secret(text)
    pending = center.find_user(app.DEMO_USERNAME)
    result.check(secret is not None, "配置页展示密钥与 otpauth URI")
    # 页面解析失败时退回数据库里的待启用密钥，保证后续流程仍可验证。
    if secret is None:
        secret = pending["totp_pending_secret"]
    result.check(
        bool(pending["totp_pending_secret"])
        and pending["totp_pending_secret"] == secret
        and pending["totp_enabled"] == 0,
        "此时只是待启用，二次验证尚未生效",
    )

    _, settings_page, _ = client.get("/settings", follow=True)
    result.check((secret or "\0") not in settings_page, "安全设置页不回显待启用密钥")

    _, refreshed, _ = client.get("/settings/totp/confirm", follow=True)
    result.check((secret or "\0") not in refreshed, "确认页刷新后不再回显密钥")

    probe = Client(client.host, client.port, "临时窗口")
    probe.get("/login", follow=True)
    probe_status, _, probe_location = probe.post(
        "/login", {"username": app.DEMO_USERNAME, "password": app.DEMO_PASSWORD}
    )
    result.check(
        probe_status == 303 and probe_location == "/",
        "待启用配置不影响登录：仅密码即可进入（与启用后不同）",
        f"status={probe_status} location={probe_location}",
    )
    # 收尾把这个临时会话销毁，避免后面绕过第二步。
    _, probe_page, _ = probe.get("/", follow=True)
    probe_csrf = extract_csrf(probe_page) or ""
    if probe_csrf:
        probe.post("/logout", {"csrf": probe_csrf})
    result.check(probe.cookie is None, "临时窗口已退出")

    csrf = extract_csrf(text) or ""
    wrong = wrong_totp_code(secret or "")
    status, _, _ = client.post("/settings/totp/confirm", {"csrf": csrf, "code": wrong})
    result.check(
        status == 401 and center.find_user(app.DEMO_USERNAME)["totp_enabled"] == 0,
        "错误的一次性口令不会启用二次验证",
    )
    result.check(
        center.find_user(app.DEMO_USERNAME)["totp_pending_secret"] == secret,
        "错误口令后待启用配置保持不变",
    )

    status, _, _ = client.post(
        "/settings/totp/confirm", {"csrf": csrf, "code": otp.totp_code(secret or "")}
    )
    user = center.find_user(app.DEMO_USERNAME)
    result.check(
        status == 303 and user["totp_enabled"] == 1,
        "正确的一次性口令确认后才真正启用",
    )
    result.check(
        user["totp_secret"] == pending["totp_pending_secret"]
        and user["totp_pending_secret"] is None,
        "待启用密钥转为已启用密钥",
    )

    status, text, _ = client.get("/settings/backup-codes", follow=True)
    codes = extract_codes(text)
    result.check(len(codes) == 10, "启用后自动生成 10 个备用码", f"拿到 {len(codes)} 个")

    status, again, _ = client.get("/settings/backup-codes", follow=True)
    result.check(not extract_codes(again), "备用码原文刷新后不再展示")
    return secret or "", codes


def concurrent_submit(
    result: Result, clients: dict[str, Client], code: str
) -> dict[str, tuple[int, str | None]]:
    csrf_by_name: dict[str, str] = {}
    for name, client in clients.items():
        _, text, _ = client.get("/verify", follow=True)
        csrf_by_name[name] = extract_csrf(text) or ""

    results: dict[str, tuple[int, str | None]] = {}
    barrier = threading.Barrier(len(clients))

    def submit(name: str) -> None:
        barrier.wait()
        status, _, location = clients[name].post(
            "/verify", {"csrf": csrf_by_name[name], "code": code}
        )
        results[name] = (status, location)

    threads = [threading.Thread(target=submit, args=(name,)) for name in clients]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    return results


def _finish(result: Result) -> int:
    total = len(result.checks)
    passed = total - result.failed
    print(f"\n结果：{passed}/{total} 项通过")
    return 0 if result.failed == 0 else 1


def run(verbose: bool = True, rounds: int = 20) -> int:
    workdir = tempfile.mkdtemp(prefix="gsb2-demo-")
    db_path = os.path.join(workdir, "app.db")
    key_path = os.path.join(workdir, "backup.key")
    result = Result(verbose=verbose)

    center = app.AccountCenter(db_path=db_path, key_path=key_path)
    center.ensure_demo_user(reset=True)
    collector = LogCollector()
    center.logger.addHandler(collector)
    center.logger.setLevel(logging.DEBUG)

    server = app.create_server("127.0.0.1", 0, center)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    if verbose:
        print(f"临时服务：http://127.0.0.1:{port}（临时数据库，结束后删除）")

    try:
        result.section("1) 启用二次验证")
        alice = Client("127.0.0.1", port, "窗口A")
        alice.get("/login", follow=True)
        login(alice, result, expect="/")
        secret, codes = enable_totp(result, alice, center)
        if not secret or len(codes) != 10:
            return _finish(result)

        result.section("2) 两个窗口：只提交正确密码时停在待验证，个人资料不返回")
        logout(alice)
        bob = Client("127.0.0.1", port, "窗口B")
        bob.get("/login", follow=True)
        login(bob, result, expect="/verify")
        login(alice, result, expect="/verify")
        for client in (alice, bob):
            status, text, _ = client.get("/profile")
            result.check(
                status == 403 and "demo@example.test" not in text,
                f"{client.name}：待验证状态读不到个人资料",
                f"status={status}",
            )

        result.section("3) 同一个备用码在两个窗口同时提交")
        used_code = codes[0]
        outcome = concurrent_submit(result, {"A": alice, "B": bob}, used_code)
        winners = [name for name, (status, _) in outcome.items() if status == 303]
        losers = [name for name, (status, _) in outcome.items() if status == 401]
        result.check(
            len(winners) == 1 and len(losers) == 1,
            "只有一个窗口成功，另一个停在验证页",
            f"{outcome}",
        )
        if len(winners) != 1:
            return _finish(result)

        winner_name = winners[0]
        winner = alice if winner_name == "A" else bob
        loser = bob if winner_name == "A" else alice
        for name, client in (("A", alice), ("B", bob)):
            status, text, _ = client.get("/", follow=True)
            entered = status == 200 and "已完成密码 + 第二步验证" in text
            result.check(
                entered == (name == winner_name),
                f"窗口{name}：{'进入首页' if name == winner_name else '仍停在验证页'}",
                f"status={status}",
            )
            status, text, _ = client.get("/profile")
            if name == winner_name:
                result.check(
                    status == 200 and "demo@example.test" in text,
                    f"窗口{name}：第二步通过后可读个人资料",
                )
            else:
                result.check(
                    status == 403 and "demo@example.test" not in text,
                    f"窗口{name}：第二步未通过，个人资料仍不返回",
                )

        result.section("4) 重新生成备用码后旧码立即失效")
        _, text, _ = winner.get("/settings", follow=True)
        csrf = extract_csrf(text) or ""
        status, _, _ = winner.post("/settings/backup-codes", {"csrf": csrf})
        result.check(status == 303, "重新生成备用码")
        _, text, _ = winner.get("/settings/backup-codes", follow=True)
        new_codes = extract_codes(text)
        result.check(
            len(new_codes) == 10 and not set(new_codes) & set(codes),
            "新的一组与旧的一组完全不重叠",
        )

        old_unused = next(c for c in codes[1:] if c not in new_codes)
        carol = Client("127.0.0.1", port, "窗口C")
        carol.get("/login", follow=True)
        login(carol, result, expect="/verify")
        _, text, _ = carol.get("/verify", follow=True)
        csrf = extract_csrf(text) or ""
        status, text, _ = carol.post("/verify", {"csrf": csrf, "code": old_unused})
        result.check(
            status == 401 and "无效" in text,
            "旧备用码（未用过）也被拒绝",
            f"旧码 {old_unused}",
        )
        status, _, _ = carol.post("/verify", {"csrf": csrf, "code": new_codes[0]})
        result.check(status == 303, "新的一组的备用码可以登录", f"新码 {new_codes[0]}")

        result.section("5) 凭据与备用码原文不出现在普通页面或日志里")
        normal_pages = {
            "首页": winner.get("/", follow=True)[1],
            "个人资料": winner.get("/profile", follow=True)[1],
            "安全设置": winner.get("/settings", follow=True)[1],
            "第二步验证": loser.get("/verify", follow=True)[1],
        }
        for name, text in normal_pages.items():
            result.check(secret not in text, f"{name}页不含验证器密钥")
            leaked_codes = [c for c in codes + new_codes if c in text]
            result.check(not leaked_codes, f"{name}页不含备用码原文", ",".join(leaked_codes))

        rows = []
        conn = center.connect()
        try:
            rows = conn.execute("SELECT code_hash FROM backup_codes").fetchall()
        finally:
            conn.close()
        stored = " ".join(row["code_hash"] for row in rows)
        result.check(
            all(c not in stored for c in codes + new_codes),
            "数据库里只存备用码摘要，没有原文",
            f"{len(rows)} 行",
        )
        result.check(
            hmac_sha256_present(stored), "备用码摘要确实是 HMAC-SHA256 十六进制"
        )

        logs = collector.text()
        leaked = [c for c in codes + new_codes if c in logs]
        result.check(
            not leaked and secret not in logs,
            "操作日志不含密钥或备用码原文",
            f"已扫描 {len(collector.messages)} 条日志",
        )
        result.check(app.DEMO_PASSWORD not in logs, "操作日志不含密码原文")
        result.check(
            "code=" not in logs and "csrf=" not in logs and "sid=" not in logs,
            "操作日志不含表单内容或 Cookie",
        )

        result.section(f"6) 并发压力：{rounds} 轮 × 8 线程抢同一个备用码")
        user = center.find_user(app.DEMO_USERNAME)
        bad_round = None
        for i in range(rounds):
            code = center.generate_backup_batch(user["id"], count=1)[0]
            outcomes: list[bool] = []
            barrier = threading.Barrier(8)

            def worker(target_code=code):
                barrier.wait()
                outcomes.append(center.consume_backup_code(user["id"], target_code))

            threads = [threading.Thread(target=worker) for _ in range(8)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()
            if sum(outcomes) != 1:
                bad_round = f"第 {i + 1} 轮成功 {sum(outcomes)} 次"
                break
        result.check(bad_round is None, "每轮都恰好只有一个请求成功", bad_round or "")

    finally:
        server.shutdown()
        server.server_close()
        center.logger.removeHandler(collector)
        shutil.rmtree(workdir, ignore_errors=True)

    return _finish(result)


if __name__ == "__main__":
    sys.exit(run())
