#!/usr/bin/env python3
"""交接规则验收脚本：启动服务后逐项断言需求行为。"""
import json
import socket
import subprocess
import sys
import time
import urllib.request
import urllib.error
import urllib.parse
from concurrent.futures import ThreadPoolExecutor

with socket.socket() as s:  # 取一个空闲端口，避免撞车
    s.bind(("127.0.0.1", 0))
    PORT = s.getsockname()[1]
BASE = f"http://127.0.0.1:{PORT}"


def call(method, path, body=None):
    if "?" in path:  # 只转义查询串里的中文
        p, q = path.split("?", 1)
        path = p + "?" + urllib.parse.quote(q, safe="=&")
    req = urllib.request.Request(BASE + path, method=method)
    data = json.dumps(body).encode() if body else None
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, data) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def check(name, cond, extra=""):
    print(f"{'PASS' if cond else 'FAIL'}  {name} {extra}")
    if not cond:
        FAILURES.append(name)


FAILURES = []

server = subprocess.Popen([sys.executable, "server.py", str(PORT)],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    for _ in range(50):  # 等服务就绪
        try:
            call("GET", "/api/state?user=甲")
            break
        except Exception:
            time.sleep(0.1)

    # 初始：两个库、三名成员，甲是两个库的负责人
    _, s = call("GET", "/api/state?user=甲")
    check("两个资料库均可见", {l["name"] for l in s["libraries"]} == {"资料库一", "资料库二"})

    # 1. 乙接受前打不开资料库一的草稿
    code, _ = call("GET", "/api/draft?user=乙&lib=lib1&draft=d1")
    check("乙接受前打不开草稿(403)", code == 403)

    # 2. 甲发起 lib1 -> 乙，待接受期间甲仍可管理
    _, t = call("POST", "/api/transfer/initiate", {"user": "甲", "lib_id": "lib1", "to_user": "乙"})
    tid = t["id"]
    check("交接单为待接受", t["status"] == "pending")
    code, _ = call("POST", "/api/draft/save", {"user": "甲", "lib_id": "lib1", "draft_id": "d1", "content": "待接受期间仍可编辑"})
    check("待接受期间原负责人仍可保存草稿", code == 200)
    code, _ = call("GET", "/api/draft?user=乙&lib=lib1&draft=d1")
    check("待接受期间乙仍打不开草稿", code == 403)

    # 3. 两个确认同时到达，只能落一次
    with ThreadPoolExecutor(2) as ex:
        results = list(ex.map(
            lambda _: call("POST", "/api/transfer/accept", {"user": "乙", "transfer_id": tid}), range(2)))
    codes = sorted(c for c, _ in results)
    check("并发两个确认只落一次(200+409)", codes == [200, 409], f"实际={codes}")

    # 4. 交接成功：目录/草稿/成员管理权限一起变更
    code, _ = call("GET", "/api/draft?user=乙&lib=lib1&draft=d1")
    check("乙接受后能打开草稿", code == 200)
    code, _ = call("POST", "/api/draft/save", {"user": "乙", "lib_id": "lib1", "draft_id": "d1", "content": "乙修订"})
    check("乙接受后能编辑草稿", code == 200)
    code, _ = call("POST", "/api/members/remove", {"user": "乙", "lib_id": "lib1", "member": "丙"})
    check("乙接受后能管理成员", code == 200)
    code, _ = call("POST", "/api/members/add", {"user": "甲", "lib_id": "lib1", "member": "丙"})
    check("旧负责人甲不能再管理 lib1 成员(403)", code == 403)

    # 5. 甲原来打开的草稿页再保存应被拒绝
    code, _ = call("POST", "/api/draft/save", {"user": "甲", "lib_id": "lib1", "draft_id": "d1", "content": "旧页面的保存"})
    check("甲旧草稿页保存被拒(403)", code == 403)
    code, _ = call("GET", "/api/draft?user=甲&lib=lib1&draft=d1")
    check("甲对 lib1 变为只读(看不了草稿)", code == 403)

    # 6. 其他库照旧：甲仍能管理资料库二
    code, _ = call("POST", "/api/draft/save", {"user": "甲", "lib_id": "lib2", "draft_id": "d3", "content": "lib2 正常"})
    check("甲仍能管理资料库二", code == 200)

    # 7. 取消后旧确认页不能再完成交接
    _, t2 = call("POST", "/api/transfer/initiate", {"user": "甲", "lib_id": "lib2", "to_user": "丙"})
    code, _ = call("POST", "/api/transfer/cancel", {"user": "甲", "transfer_id": t2["id"]})
    check("发起人可取消待接受的交接", code == 200)
    code, _ = call("POST", "/api/transfer/accept", {"user": "丙", "transfer_id": t2["id"]})
    check("取消后旧确认页不能再完成(409)", code == 409)
    _, s = call("GET", "/api/state?user=甲")
    lib2 = next(l for l in s["libraries"] if l["id"] == "lib2")
    check("取消后 lib2 负责人仍是甲", lib2["owner"] == "甲")
finally:
    server.terminate()

print(f"\n{'全部通过' if not FAILURES else f'{len(FAILURES)} 项失败: {FAILURES}'}")
sys.exit(1 if FAILURES else 0)
