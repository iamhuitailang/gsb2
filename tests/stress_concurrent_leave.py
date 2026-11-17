"""高并发压测：20 名有效管理员各自会话、同时点击退出。

不变量：机构 A 最终恰好剩 1 名有效管理员；
成功的退出事务恰好 19 个，被拦截 1 个（事务内检查到将无人可登录）。
通过 HTTP 压真实服务，模拟 20 个浏览器同时点击。
"""

from __future__ import annotations

import http.cookiejar
import tempfile
import threading
import urllib.parse
import urllib.request
from pathlib import Path

from app import db, service
from app.server import create_server

ORG_A = 1
N_ADMINS = 20


def opener_for(port, username, password):
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    data = urllib.parse.urlencode(
        {"username": username, "password": password}
    ).encode()
    opener.open(urllib.request.Request(
        f"http://127.0.0.1:{port}/login", data=data))
    return opener


def main() -> None:
    tmp = tempfile.TemporaryDirectory()
    db_path = Path(tmp.name) / "stress.db"
    db.init_db(db_path)

    # 再造 18 名管理员（连同种子里的甲、乙共 20 名有效管理员）
    conn = db.connect(db_path)
    try:
        for i in range(N_ADMINS - 2):
            username = f"u{i:02d}"
            conn.execute(
                "INSERT INTO users (username, display_name, password_hash) "
                "VALUES (?, ?, ?)",
                (username, f"户{i:02d}", db.hash_password("pass1234")),
            )
            uid = conn.execute(
                "SELECT id FROM users WHERE username = ?", (username,)
            ).fetchone()["id"]
            conn.execute(
                "INSERT INTO memberships (org_id, user_id, role, is_active) "
                "VALUES (?, ?, 'admin', 1)", (ORG_A, uid),
            )
        assert service.count_active_admins(conn, ORG_A) == N_ADMINS
    finally:
        conn.close()

    httpd = create_server(host="127.0.0.1", port=0, db_path=db_path)
    port = httpd.server_address[1]
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()

    usernames = ["jia", "yi"] + [f"u{i:02d}" for i in range(N_ADMINS - 2)]
    openers = [opener_for(port, name, "pass1234") for name in usernames]
    barrier = threading.Barrier(N_ADMINS)
    outcomes = []
    lock = threading.Lock()

    def fire(opener):
        barrier.wait()
        for attempt in range(5):  # 突发连接可能在 accept 排队，有限重试
            try:
                resp = opener.open(urllib.request.Request(
                    f"http://127.0.0.1:{port}/orgs/{ORG_A}/leave",
                    data=b"", method="POST"))
                with lock:
                    outcomes.append(
                        (resp.status, urllib.parse.urlparse(resp.geturl()).path))
                return
            except (ConnectionResetError, OSError):
                if attempt == 4:
                    raise

    threads = [threading.Thread(target=fire, args=(o,)) for o in openers]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)

    successes = [o for o in outcomes if o[1] == "/"]
    blocked = [o for o in outcomes if "/orgs/" in o[1]]
    print(f"总请求 {len(outcomes)}，成功退出 {len(successes)}，被拦截 {len(blocked)}")

    conn = db.connect(db_path)
    try:
        admins = service.count_active_admins(conn, ORG_A)
        members = [(m["username"], m["role"], m["is_active"])
                   for m in service.list_members(conn, ORG_A)]
        logs = service.list_audit_logs(conn, ORG_A)
        blocked_logs = [l for l in logs if l["result"] == "blocked"]
        success_logs = [l for l in logs if l["result"] == "success"]
    finally:
        conn.close()
    print(f"机构 A 剩余成员 {members}，有效管理员 {admins} 名")
    print(f"审计：成功 {len(success_logs)} 条，blocked {len(blocked_logs)} 条")

    httpd.shutdown()
    httpd.server_close()
    tmp.cleanup()

    assert len(outcomes) == N_ADMINS
    assert len(successes) == N_ADMINS - 1
    assert len(blocked) == 1
    assert admins == 1
    assert len(success_logs) == N_ADMINS - 1
    assert len(blocked_logs) == 1
    print("PASS")


if __name__ == "__main__":
    main()
