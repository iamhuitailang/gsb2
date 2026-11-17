#!/usr/bin/env python3
"""知识库负责人交接 demo（本地内存态，零依赖）。

规则：
- 交接由当前负责人发起，三种终态：待接受(pending) / 取消(cancelled) / 完成(completed)。
- 待接受期间仍由原负责人管理；取消后旧确认请求一律拒绝。
- 接受成功的一瞬间，目录、草稿、成员管理权限随 owner 一起原子切换；
  并发的两个确认请求只有一个能落库（全局锁内 check-and-set）。
- 草稿仅负责人可读可写；普通成员只读目录。交接完成后旧负责人降级为只读成员。
- 其他资料库的责任人和权限不受影响。
"""
import json
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

LOCK = threading.Lock()  # 交接状态变更与权限切换的互斥锁
USERS = ["甲", "乙", "丙"]
INDEX_HTML = Path(__file__).with_name("index.html")


def fresh_state():
    return {
        "libraries": {
            "lib1": {
                "id": "lib1", "name": "资料库一", "owner": "甲",
                "members": ["甲", "乙", "丙"],
                "catalog": ["01-部门制度", "02-操作手册", "03-培训材料"],
                "drafts": [
                    {"id": "d1", "title": "交接清单（草稿）", "content": "待补充：权限回收列表", "published": False},
                    {"id": "d2", "title": "新版操作手册（草稿）", "content": "未发布内容，仅负责人可见", "published": False},
                ],
            },
            "lib2": {
                "id": "lib2", "name": "资料库二", "owner": "甲",
                "members": ["甲", "丙"],
                "catalog": ["01-周报模板", "02-会议纪要"],
                "drafts": [
                    {"id": "d3", "title": "季度总结（草稿）", "content": "未发布内容，仅负责人可见", "published": False},
                ],
            },
        },
        "transfers": {},  # tid -> {id, lib_id, from_user, to_user, status}
    }


STATE = fresh_state()


class ApiError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message


def get_lib(lib_id):
    lib = STATE["libraries"].get(lib_id)
    if lib is None:
        raise ApiError(404, "资料库不存在")
    return lib


def require_owner(user, lib):
    if user != lib["owner"]:
        raise ApiError(403, "只有负责人才能执行此操作")


def view_for(user):
    """按当前用户裁剪的可见状态。"""
    libs = []
    for lib in STATE["libraries"].values():
        if user not in lib["members"] and user != lib["owner"]:
            continue
        is_owner = user == lib["owner"]
        entry = {
            "id": lib["id"], "name": lib["name"], "owner": lib["owner"],
            "members": list(lib["members"]), "catalog": list(lib["catalog"]),
            "my_role": "owner" if is_owner else "readonly",
            # 非负责人只能看到草稿标题（锁定），正文需单独请求且会被拒
            "drafts": [
                {"id": d["id"], "title": d["title"], "locked": not is_owner,
                 **({"content": d["content"]} if is_owner else {})}
                for d in lib["drafts"]
            ],
        }
        pending = [t for t in STATE["transfers"].values()
                   if t["lib_id"] == lib["id"] and t["status"] == "pending"]
        entry["pending_transfer"] = pending[0] if pending else None
        libs.append(entry)
    transfers = [t for t in STATE["transfers"].values()
                 if user in (t["from_user"], t["to_user"])]
    return {"user": user, "users": USERS, "libraries": libs, "transfers": transfers}


# ---------------- 交接动作 ----------------

def initiate_transfer(user, lib_id, to_user):
    with LOCK:
        lib = get_lib(lib_id)
        require_owner(user, lib)
        if to_user not in USERS or to_user == user:
            raise ApiError(400, "接任人无效")
        if any(t["lib_id"] == lib_id and t["status"] == "pending"
               for t in STATE["transfers"].values()):
            raise ApiError(409, "该资料库已有待接受的交接")
        tid = uuid.uuid4().hex[:8]
        STATE["transfers"][tid] = {
            "id": tid, "lib_id": lib_id, "from_user": user,
            "to_user": to_user, "status": "pending",
        }
        return STATE["transfers"][tid]


def accept_transfer(user, tid):
    with LOCK:  # check-and-set 原子化：并发确认只落一次
        t = STATE["transfers"].get(tid)
        if t is None:
            raise ApiError(404, "交接单不存在")
        if t["to_user"] != user:
            raise ApiError(403, "只有接任人才能确认")
        if t["status"] != "pending":
            raise ApiError(409, f"交接已{t['status'] == 'completed' and '完成' or '取消'}，无法重复确认")
        lib = get_lib(t["lib_id"])
        # 目录、草稿、成员管理权限都派生自 owner，一次切换同时生效
        lib["owner"] = t["to_user"]
        for u in (t["to_user"], t["from_user"]):  # 旧负责人降级为只读成员
            if u not in lib["members"]:
                lib["members"].append(u)
        t["status"] = "completed"
        return t


def cancel_transfer(user, tid):
    with LOCK:
        t = STATE["transfers"].get(tid)
        if t is None:
            raise ApiError(404, "交接单不存在")
        if t["from_user"] != user:
            raise ApiError(403, "只有发起人才能取消")
        if t["status"] != "pending":
            raise ApiError(409, "交接已结束，无法取消")
        t["status"] = "cancelled"
        return t


# ---------------- 资料库操作 ----------------

def read_draft(user, lib_id, draft_id):
    lib = get_lib(lib_id)
    require_owner(user, lib)  # 草稿仅负责人可见
    for d in lib["drafts"]:
        if d["id"] == draft_id:
            return d
    raise ApiError(404, "草稿不存在")


def save_draft(user, lib_id, draft_id, content):
    with LOCK:
        lib = get_lib(lib_id)
        require_owner(user, lib)  # 以服务端当前权限为准，旧页面保存会被拒
        for d in lib["drafts"]:
            if d["id"] == draft_id:
                d["content"] = content
                return d
        raise ApiError(404, "草稿不存在")


def manage_member(user, lib_id, member, add):
    with LOCK:
        lib = get_lib(lib_id)
        require_owner(user, lib)
        if member not in USERS:
            raise ApiError(400, "成员无效")
        if add:
            if member not in lib["members"]:
                lib["members"].append(member)
        else:
            if member == lib["owner"]:
                raise ApiError(400, "不能移除负责人")
            if member in lib["members"]:
                lib["members"].remove(member)
        return {"members": lib["members"]}


# ---------------- HTTP 层 ----------------

class Handler(BaseHTTPRequestHandler):
    def _send(self, status, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        return json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")

    def _dispatch(self, fn):
        try:
            self._send(200, fn())
        except ApiError as e:
            self._send(e.status, {"error": e.message})
        except (KeyError, ValueError) as e:
            self._send(400, {"error": f"参数错误: {e}"})

    def do_GET(self):
        url = urlparse(self.path)
        q = parse_qs(url.query)
        user = q.get("user", [""])[0]
        if url.path == "/":
            body = INDEX_HTML.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif url.path == "/api/state":
            self._dispatch(lambda: view_for(user))
        elif url.path == "/api/draft":
            self._dispatch(lambda: read_draft(user, q["lib"][0], q["draft"][0]))
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        routes = {
            "/api/transfer/initiate": lambda b: initiate_transfer(b["user"], b["lib_id"], b["to_user"]),
            "/api/transfer/accept": lambda b: accept_transfer(b["user"], b["transfer_id"]),
            "/api/transfer/cancel": lambda b: cancel_transfer(b["user"], b["transfer_id"]),
            "/api/draft/save": lambda b: save_draft(b["user"], b["lib_id"], b["draft_id"], b["content"]),
            "/api/members/add": lambda b: manage_member(b["user"], b["lib_id"], b["member"], True),
            "/api/members/remove": lambda b: manage_member(b["user"], b["lib_id"], b["member"], False),
            "/api/reset": lambda b: STATE.update(fresh_state()) or {"ok": True},
        }
        fn = routes.get(urlparse(self.path).path)
        if fn is None:
            self._send(404, {"error": "not found"})
            return
        self._dispatch(lambda: fn(self._body()))

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    import sys
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    print(f"交接页已启动: http://localhost:{port}")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
