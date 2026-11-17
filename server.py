#!/usr/bin/env python3
"""本地访问策略管理页:规则编辑 / 试算对比 / 发布 / 回滚 / 线上演示入口。

仅依赖 Python 标准库。运行: python3 server.py 然后打开 http://127.0.0.1:8000
数据持久化在 data.json(首次启动自动写入种子数据)。
"""
import json
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

BASE = Path(__file__).resolve().parent
DATA_FILE = BASE / "data.json"
STATIC_DIR = BASE / "static"
LOCK = threading.Lock()
ACTIONS = ["查看", "下载"]
HOST, PORT = "127.0.0.1", 8642


def now():
    return time.strftime("%Y-%m-%d %H:%M:%S")


def rid():
    return uuid.uuid4().hex[:8]


def seed_data():
    """种子:运维组/访客组;旧规则只允许运维下载内部报告。"""
    v1 = {
        "id": rid(),
        "n": 1,
        "rules": [
            {
                "id": rid(),
                "effect": "allow",
                "department": "运维组",
                "category": "内部报告",
                "action": "下载",
                "tag": "",
                "note": "运维可下载内部报告",
            }
        ],
        "published_by": "系统初始化",
        "published_at": now(),
        "note": "初始版本",
    }
    return {
        "accounts": [
            {"id": "u1", "name": "张三", "department": "运维组"},
            {"id": "u2", "name": "李四", "department": "访客组"},
        ],
        "resources": [
            {"id": "r1", "name": "季度经营报告", "category": "内部报告", "tags": []},
            {"id": "r2", "name": "历年归档报告", "category": "内部报告", "tags": ["归档"]},
            {"id": "r3", "name": "公司公告", "category": "公告", "tags": []},
        ],
        "versions": [v1],
        "active_version": v1["id"],
        "draft": None,  # {"rules": [...], "revision": int, "base_version": id, "updated_by": str}
    }


def load():
    if not DATA_FILE.exists():
        data = seed_data()
        save(data)
    return json.loads(DATA_FILE.read_text(encoding="utf-8"))


def save(data):
    DATA_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


# ---------- 策略求值 ----------

def rule_matches(rule, account, resource, action):
    return (
        rule["department"] in ("*", account["department"])
        and rule["category"] in ("*", resource["category"])
        and rule["action"] in ("*", action)
        and (not rule.get("tag") or rule["tag"] in resource["tags"])
    )


def evaluate(rules, account, resource, action):
    """命中禁止以禁止为准;没有任何允许则默认拒绝。返回 (decision, matched_rule|None)。"""
    matched = [r for r in rules if rule_matches(r, account, resource, action)]
    for r in matched:
        if r["effect"] == "deny":
            return "deny", r
    for r in matched:
        if r["effect"] == "allow":
            return "allow", r
    return "deny", None


def active_rules(data):
    for v in data["versions"]:
        if v["id"] == data["active_version"]:
            return v["rules"]
    return []


def simulate(data, new_rules):
    """对全部 账号×资料×动作 组合分别用线上版与给定规则求值,返回变更列表。"""
    old_rules = active_rules(data)
    changes, total = [], 0
    for acc in data["accounts"]:
        for res in data["resources"]:
            for action in ACTIONS:
                total += 1
                old_dec, old_rule = evaluate(old_rules, acc, res, action)
                new_dec, new_rule = evaluate(new_rules, acc, res, action)
                if old_dec != new_dec:
                    changes.append(
                        {
                            "account": acc,
                            "resource": res,
                            "action": action,
                            "old": {"decision": old_dec, "rule": old_rule},
                            "new": {"decision": new_dec, "rule": new_rule},
                        }
                    )
    return {"total": total, "changed": len(changes), "changes": changes}


def public_state(data):
    departments = sorted({a["department"] for a in data["accounts"]})
    categories = sorted({r["category"] for r in data["resources"]})
    tags = sorted({t for r in data["resources"] for t in r["tags"]})
    return {
        "accounts": data["accounts"],
        "resources": data["resources"],
        "actions": ACTIONS,
        "departments": departments,
        "categories": categories,
        "tags": tags,
        "versions": sorted(data["versions"], key=lambda v: v["n"], reverse=True),
        "active_version": data["active_version"],
        "draft": data["draft"],
    }


# ---------- HTTP ----------

class Handler(BaseHTTPRequestHandler):
    def _send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, path, content_type):
        body = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def log_message(self, fmt, *args):  # 静默访问日志
        pass

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            self._send_file(STATIC_DIR / "index.html", "text/html; charset=utf-8")
        elif self.path == "/api/state":
            with LOCK:
                self._send_json(public_state(load()))
        else:
            self._send_json({"error": "not found"}, 404)

    def do_PUT(self):
        if self.path == "/api/draft":
            self._save_draft()
        else:
            self._send_json({"error": "not found"}, 404)

    def do_POST(self):
        routes = {
            "/api/draft/begin": self._begin_draft,
            "/api/draft/publish": self._publish,
            "/api/simulate": self._simulate,
            "/api/rollback": self._rollback,
            "/api/evaluate": self._evaluate_live,
        }
        handler = routes.get(self.path)
        if handler:
            handler()
        else:
            self._send_json({"error": "not found"}, 404)

    # ----- 草稿 -----

    def _begin_draft(self):
        body = self._body()
        with LOCK:
            data = load()
            if data["draft"] is None:
                data["draft"] = {
                    "rules": json.loads(json.dumps(active_rules(data))),
                    "revision": 1,
                    "base_version": data["active_version"],
                    "updated_by": body.get("by") or "匿名",
                }
                save(data)
            self._send_json(public_state(data))

    def _save_draft(self):
        body = self._body()
        with LOCK:
            data = load()
            draft = data["draft"]
            if draft is None:
                self._send_json({"error": "草稿不存在(可能已被发布),请刷新后重新编辑"}, 409)
                return
            if body.get("base_revision") != draft["revision"]:
                self._send_json(
                    {"error": "草稿已被其他人修改,为避免覆盖请基于最新草稿重新编辑"}, 409
                )
                return
            rules = body.get("rules")
            if not isinstance(rules, list):
                self._send_json({"error": "rules 格式不正确"}, 400)
                return
            for r in rules:
                r.setdefault("id", rid())
                r.setdefault("tag", "")
                r.setdefault("note", "")
            draft["rules"] = rules
            draft["revision"] += 1
            draft["updated_by"] = body.get("by") or "匿名"
            save(data)
            self._send_json(public_state(data))

    def _publish(self):
        body = self._body()
        with LOCK:
            data = load()
            draft = data["draft"]
            if draft is None:
                self._send_json({"error": "草稿不存在(可能已被发布),请刷新"}, 409)
                return
            if body.get("base_revision") != draft["revision"]:
                self._send_json(
                    {"error": "发布失败:草稿已被其他人修改,请刷新确认最新内容后再发布"}, 409
                )
                return
            n = max(v["n"] for v in data["versions"]) + 1
            version = {
                "id": rid(),
                "n": n,
                "rules": draft["rules"],
                "published_by": body.get("by") or "匿名",
                "published_at": now(),
                "note": body.get("note") or "",
            }
            data["versions"].append(version)
            data["active_version"] = version["id"]
            data["draft"] = None
            save(data)
            self._send_json(public_state(data))

    # ----- 试算 / 回滚 / 演示 -----

    def _simulate(self):
        body = self._body()
        with LOCK:
            data = load()
            self._send_json(simulate(data, body.get("rules") or []))

    def _rollback(self):
        body = self._body()
        with LOCK:
            data = load()
            target = next((v for v in data["versions"] if v["id"] == body.get("version_id")), None)
            if target is None:
                self._send_json({"error": "目标版本不存在"}, 404)
                return
            if target["id"] == data["active_version"]:
                self._send_json({"error": "该版本已在线上生效"}, 400)
                return
            n = max(v["n"] for v in data["versions"]) + 1
            version = {
                "id": rid(),
                "n": n,
                "rules": json.loads(json.dumps(target["rules"])),
                "published_by": body.get("by") or "匿名",
                "published_at": now(),
                "note": f"回滚自 v{target['n']}",
            }
            data["versions"].append(version)
            data["active_version"] = version["id"]
            save(data)
            self._send_json(public_state(data))

    def _evaluate_live(self):
        body = self._body()
        with LOCK:
            data = load()
            acc = next((a for a in data["accounts"] if a["id"] == body.get("account_id")), None)
            res = next((r for r in data["resources"] if r["id"] == body.get("resource_id")), None)
            action = body.get("action")
            if not acc or not res or action not in ACTIONS:
                self._send_json({"error": "参数不正确"}, 400)
                return
            decision, rule = evaluate(active_rules(data), acc, res, action)
            version = next(v for v in data["versions"] if v["id"] == data["active_version"])
            self._send_json(
                {
                    "decision": decision,
                    "rule": rule,
                    "version": {"n": version["n"], "published_by": version["published_by"]},
                }
            )


def main():
    STATIC_DIR.mkdir(exist_ok=True)
    with LOCK:
        load()  # 确保种子数据存在
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"策略管理页已启动: http://{HOST}:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
