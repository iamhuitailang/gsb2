#!/usr/bin/env python3
"""端到端演示：直接请求 vs 可信代理请求的来源检查。

场景：
  A. 直连，真实地址在允许范围内            -> 允许（用实际连接地址）
  B. 直连，伪造与 C 相同的来源字段         -> 拒绝（直连不采信来源字段）
  C. 经可信代理，客户端还自带伪造 XFF      -> 允许（代理覆盖为范围内地址）
  D. 经可信代理（IPv6）                    -> 允许（IPv6 范围匹配）
  E. 删除允许规则后重发 C                  -> 拒绝（策略即时生效）
  F. 恢复规则后重发 C                      -> 允许

运行：python3 demo.py
"""
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
POLICY_PATH = os.path.join(BASE_DIR, "policy.json")
BACKEND_PORT = 18000
PROXY_V4_PORT = 18080
PROXY_V6_PORT = 18081

results = []


def lan_ipv4():
    """探测本机局域网 IPv4：优先取物理网卡地址（默认路由可能被 VPN 占用）。"""
    for iface in ("en0", "en1", "en2"):
        try:
            out = subprocess.check_output(
                ["ipconfig", "getifaddr", iface],
                stderr=subprocess.DEVNULL).decode().strip()
            if out:
                return out
        except (OSError, subprocess.CalledProcessError):
            continue
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)  # UDP connect 不实际发包
    try:
        s.connect(("192.0.2.1", 80))
        return s.getsockname()[0]
    finally:
        s.close()


def get(url, headers=None):
    req = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()
    except OSError as e:
        return None, str(e)


def check(label, got, want):
    ok = got == want
    results.append(ok)
    print(f"  [{'PASS' if ok else 'FAIL'}] {label}: HTTP {got}（期望 {want}）")


def write_policy(allow_ranges):
    with open(POLICY_PATH, "w", encoding="utf-8") as f:
        json.dump({
            "trusted_proxies": ["127.0.0.1/32", "::1/128"],
            "proxy_token": "demo-shared-secret-change-me",
            "allow_ranges": allow_ranges,
        }, f, ensure_ascii=False, indent=2)


def wait_ready(url, timeout=10):
    deadline = time.time() + timeout
    while time.time() < deadline:
        status, _ = get(url)
        if status is not None:
            return True
        time.sleep(0.2)
    return False


def main():
    lan = lan_ipv4()
    lan_cidr = f"{lan.rsplit('.', 1)[0]}.0/24"
    print(f"本机局域网地址: {lan}，演示允许范围: {lan_cidr} 与 ::1/128\n")

    backup = POLICY_PATH + ".bak"
    shutil.copy(POLICY_PATH, backup)
    env = dict(os.environ,
               BACKEND_PORT=str(BACKEND_PORT),
               PROXY_V4_PORT=str(PROXY_V4_PORT),
               PROXY_V6_PORT=str(PROXY_V6_PORT))
    procs = []
    try:
        write_policy([lan_cidr, "::1/128"])
        procs = [
            subprocess.Popen([sys.executable, os.path.join(BASE_DIR, "server.py")], env=env),
            subprocess.Popen([sys.executable, os.path.join(BASE_DIR, "proxy.py")], env=env),
        ]
        if not wait_ready(f"http://127.0.0.1:{BACKEND_PORT}/admin/logs"):
            print("业务服务启动失败")
            return 1
        if not wait_ready(f"http://127.0.0.1:{PROXY_V4_PORT}/admin/logs"):
            print("代理启动失败")
            return 1

        backend = f"http://127.0.0.1:{BACKEND_PORT}"
        backend_lan = f"http://{lan}:{BACKEND_PORT}"
        proxy = f"http://{lan}:{PROXY_V4_PORT}"

        print("A. 直连，真实连接地址在允许范围内（用实际连接地址）")
        status, _ = get(backend_lan + "/")
        check("直连（范围内真实地址）", status, 200)

        print("B. 直连，附带与 C 相同的来源字段（不应被采信）")
        status, _ = get(backend + "/", headers={"X-Forwarded-For": lan})
        check("直连伪造来源字段", status, 403)

        print("C. 经可信代理，客户端自带伪造 XFF（代理应覆盖为范围内地址）")
        status, _ = get(proxy + "/", headers={"X-Forwarded-For": "203.0.113.99"})
        check("可信代理转发", status, 200)

        print("D. 经可信代理（IPv6 ::1，命中 ::1/128）")
        status, _ = get(f"http://[::1]:{PROXY_V6_PORT}/")
        check("IPv6 代理转发", status, 200)

        print("E. 删除允许规则后，重发与 C 完全相同的请求（策略即时生效）")
        write_policy(["::1/128"])
        status, _ = get(proxy + "/", headers={"X-Forwarded-For": "203.0.113.99"})
        check("删除规则后的代理请求", status, 403)

        print("F. 恢复允许规则后重发 C")
        write_policy([lan_cidr, "::1/128"])
        status, _ = get(proxy + "/", headers={"X-Forwarded-For": "203.0.113.99"})
        check("恢复规则后的代理请求", status, 200)

        # 管理员日志页：展示实际采信的来源与命中的规则
        _, page = get(backend + "/admin/logs")
        print("\n管理员日志页（最近判定记录，列：时间|路径|连接对端|收到的XFF|"
              "令牌|采信方式|采信来源|命中规则|结果）")
        rows = re.findall(r"<tr>(.*?)</tr>", page, re.S)[1:7]
        for row in rows:
            cells = [re.sub(r"<[^>]+>", "", c).strip()
                     for c in re.findall(r"<td[^>]*>(.*?)</td>", row, re.S)]
            print("  " + " | ".join(cells))
        print(f"\n交互查看: python3 server.py 后打开 {backend}/admin/logs")

        failed = results.count(False)
        print(f"\n结果: {len(results) - failed}/{len(results)} 通过")
        return 1 if failed else 0
    finally:
        for p in procs:
            p.terminate()
        for p in procs:
            p.wait()
        shutil.move(backup, POLICY_PATH)


if __name__ == "__main__":
    sys.exit(main())
