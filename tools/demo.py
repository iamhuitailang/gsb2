#!/usr/bin/env python3
"""命令行演示：按需求描述的步骤，把清单/分片分别送到接收台并打印结果。

先启动服务：python3 -m app.server --port 8765
再运行：      python3 tools/demo.py --base http://127.0.0.1:8765

脚本对接收台是「外部客户端」，只通过 HTTP 交互，不直接改数据目录。
"""
import argparse
import json
import sys
import urllib.error
import urllib.request


def call(base, path, payload=None):
    url = base.rstrip("/") + path
    data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"}, method="POST" if payload is not None else "GET")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise SystemExit(f"{path} -> HTTP {exc.code}: {exc.read().decode('utf-8', 'replace')}")


def push(base, batch_no, **kw):
    return call(base, "/api/source/push", dict(batch_no=batch_no, **kw))


def show(base, title):
    st = call(base, "/api/receiver/state")
    print(f"\n== {title} ==")
    print(f"   生效批次: {st['effective_batch']}   下一待生效: {st['next_batch']}   已发布: {st['published_batches']}")
    for b in st["batches"]:
        recv = "清单✓" if b["received_manifest"] else "清单✗"
        print(f"   第 {b['batch_no']} 批: {b['state']:<18} {recv} 分片 {len(b['received_files'])}/{len(b['expected_files']) or '?'}")
    return st


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:8765")
    args = ap.parse_args()
    base = args.base

    show(base, "初始状态")

    # 1. 初始批：先清单，再分片
    push(base, 1, which="manifest")
    show(base, "第 1 批只送了清单（此时应缺 2 个分片）")
    push(base, 1, which="shards")
    st = show(base, "第 1 批分片补齐（应已发布，生效批次=1）")
    assert st["effective_batch"] == 1, st
    assert st["ticket_count"] == 6, st

    # 2. 先送最后一批
    push(base, 3, which="all")
    st = show(base, "第 3 批先到（页面应仍停留在第 1 批）")
    assert st["effective_batch"] == 1, "第 3 批不得越过第 2 批生效"
    assert st["published_batches"] == [1], st

    # 3. 再送第 2 批，第 3 批应自动顺序生效
    push(base, 2, order="reverse")
    st = show(base, "第 2 批补齐后（第 3 批应自动生效）")
    assert st["effective_batch"] == 3, st
    assert st["published_batches"] == [1, 2, 3], st

    # 4. 查询与历史
    ids = [t["id"] for t in call(base, "/api/tickets")["tickets"]]
    print("\n   当前工单:", ", ".join(ids))
    assert "TK-1001" not in ids, "TK-1001 应已从当前查询移除"
    detail = call(base, "/api/tickets/TK-1001")
    print("   TK-1001 当前可查:", detail["exists"])
    for h in detail["history"]:
        before = (h.get("before") or {}).get("status", "-")
        after = (h.get("after") or {}).get("status", "-")
        print(f"     第 {h['batch_no']} 批 {h['action']:<7} {before} -> {after}")
    assert [h["action"] for h in detail["history"]] == ["create", "update", "delete"], detail["history"]

    # 5. 重复送达不产生第二条发布记录
    for b in (1, 2, 3):
        push(base, b, which="all")
    st = show(base, "三批全部重复送达后（发布记录仍应各 1 条）")
    assert st["published_batches"] == [1, 2, 3], st
    assert len(st["batches"]) == 3, st

    print("\n全部步骤通过。")


if __name__ == "__main__":
    sys.exit(main())
