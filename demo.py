#!/usr/bin/env python3
"""演示程序：分别发出直连请求和经代理的请求，验证来源检查。

场景：
1. 经可信代理、模拟范围内 IPv4 地址（并附带伪造的 X-Forwarded-For，
   验证代理会覆盖客户端自带的来源信息） -> 应允许
2. 直连业务服务，附带同样的 X-Forwarded-For -> 应拒绝
   （直连只认实际连接地址 127.0.0.1，不采信来源字段）
3. 经可信代理、模拟范围内 IPv6 地址 -> 应允许
4. 经可信代理、模拟范围外地址 -> 应拒绝
5. 从 policy.json 删除 IPv4 允许规则后，重发场景 1 的请求 -> 应拒绝
   （策略修改后下一次请求即按新配置判断；演示结束自动恢复策略文件）
"""
import http.client
import json
import sys
import time
from pathlib import Path

PROXY = ("127.0.0.1", 18080)
BACKEND = ("127.0.0.1", 18081)
POLICY_PATH = Path(__file__).with_name("policy.json")

results = []


def call(addr, headers, label):
    conn = http.client.HTTPConnection(*addr, timeout=5)
    conn.request("GET", "/admin", headers=headers)
    resp = conn.getresponse()
    resp.read()
    decision = resp.getheader("X-Access-Decision")
    source = resp.getheader("X-Access-Source")
    rule = resp.getheader("X-Access-Rule")
    print(f"{label}")
    print(f"  -> HTTP {resp.status}  判定={decision}  采信来源={source}  命中规则={rule}")
    conn.close()
    return decision


def expect(actual, wanted):
    ok = actual == wanted
    results.append(ok)
    print(f"  期望 {wanted}：{'符合预期 ✓' if ok else '不符合预期 ✗'}\n")


def wait_for_servers():
    for _ in range(50):
        try:
            c1 = http.client.HTTPConnection(*PROXY, timeout=1)
            c1.connect()
            c1.close()
            c2 = http.client.HTTPConnection(*BACKEND, timeout=1)
            c2.connect()
            c2.close()
            return True
        except OSError:
            time.sleep(0.1)
    return False


def main():
    if not wait_for_servers():
        print("请先启动服务：python3 app.py 和 python3 proxy.py")
        return 1

    print("== 场景 1：经可信代理，模拟范围内 IPv4 地址（附带伪造来源字段） ==")
    d = call(PROXY, {
        "X-Demo-Client-IP": "203.0.113.10",
        "X-Forwarded-For": "1.2.3.4",  # 客户端伪造，代理应覆盖
    }, "[代理] 模拟客户端 203.0.113.10，自带 X-Forwarded-For: 1.2.3.4")
    expect(d, "allow")

    print("== 场景 2：直连业务服务，附带同样的来源字段 ==")
    d = call(BACKEND, {"X-Forwarded-For": "203.0.113.10"},
             "[直连] 附带 X-Forwarded-For: 203.0.113.10")
    expect(d, "deny")

    print("== 场景 3：经可信代理，模拟范围内 IPv6 地址 ==")
    d = call(PROXY, {"X-Demo-Client-IP": "2001:db8:10::1"},
             "[代理] 模拟客户端 2001:db8:10::1")
    expect(d, "allow")

    print("== 场景 4：经可信代理，模拟范围外地址 ==")
    d = call(PROXY, {"X-Demo-Client-IP": "198.51.100.9"},
             "[代理] 模拟客户端 198.51.100.9（不在允许范围）")
    expect(d, "deny")

    print("== 场景 5：删除 IPv4 允许规则后，重发场景 1 的请求 ==")
    original = POLICY_PATH.read_text(encoding="utf-8")
    try:
        policy = json.loads(original)
        policy["allow_rules"] = [
            r for r in policy["allow_rules"] if r["name"] != "hq-office-v4"
        ]
        POLICY_PATH.write_text(json.dumps(policy, indent=2), encoding="utf-8")
        print("  （已从 policy.json 删除规则 hq-office-v4）")
        d = call(PROXY, {"X-Demo-Client-IP": "203.0.113.10"},
                 "[代理] 再次模拟客户端 203.0.113.10")
        expect(d, "deny")
    finally:
        POLICY_PATH.write_text(original, encoding="utf-8")
        print("  （已恢复 policy.json）")

    print(f"结果：{sum(results)}/{len(results)} 符合预期")
    print("提示：经代理用范围内地址访问 http://127.0.0.1:18080/admin "
          "可在页面中查看管理员日志（采信来源与命中规则）")
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
