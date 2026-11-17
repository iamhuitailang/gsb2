"""场景验证：主管批量关闭工单。

流程：
1. 甲组两张开启工单(#1, #2)，乙组一张同名工单(#3)。
2. 甲组主管预览 [#1, #2, #3] → 可关闭 2 张。
3. 预览后把 #2 转到乙组。
4. 提交包含三张编号的批次 → 只关闭仍属甲组的 #1；#2、#3 不变，
   且结果中这两张只显示"无权处理"，不带标题和状态。
5. 同一批次号重复提交 → 不多写关闭记录。

运行：python3 test_scenario.py
"""

import os
import sqlite3
import tempfile

from app import create_app

BATCH_ID = "test-batch-0001"


def main():
    tmpdir = tempfile.mkdtemp()
    db_path = os.path.join(tmpdir, "test.db")
    app = create_app(db_path)
    client = app.test_client()

    # 甲组主管登录
    r = client.post("/api/login", json={"group_id": 1})
    assert r.get_json()["ok"], "登录失败"

    # 1. 预览：#1、#2 属甲组且开启，#3 属乙组 → 可关闭 2 张
    r = client.post("/api/preview", json={"ids": [1, 2, 3]})
    data = r.get_json()
    assert data == {"total": 3, "closable": 2}, f"预览结果不符: {data}"
    print("1. 预览 [#1,#2,#3] → 可关闭 2 张 ✓")

    # 2. 预览后，#2 被转到乙组
    r = client.post("/api/transfer", json={"ticket_id": 2, "to_group_id": 2})
    assert r.get_json()["ok"], "转组失败"
    print("2. #2 已转到乙组 ✓")

    # 3. 提交批次（执行时重新校验所属组与状态）
    r = client.post("/api/batch-close", json={"batch_id": BATCH_ID, "ids": [1, 2, 3]})
    result = r.get_json()

    assert [x["id"] for x in result["closed"]] == [1], f"关闭列表不符: {result}"
    assert result["closed"][0]["title"] == "网络故障报修", "本组工单应显示标题"

    not_processed = {x["id"]: x for x in result["not_processed"]}
    assert set(not_processed) == {2, 3}, f"未处理列表不符: {result}"
    for tid in (2, 3):
        entry = not_processed[tid]
        assert entry["reason"] == "无权处理", f"#{tid} 原因不符: {entry}"
        assert "title" not in entry, f"#{tid} 泄露了组外标题: {entry}"
        assert "status" not in entry, f"#{tid} 泄露了组外状态: {entry}"
    print("3. 批次执行：仅 #1 关闭成功；#2、#3 无权处理且无标题/状态泄露 ✓")

    # 4. 数据库终态：#1 已归档，#2、#3 仍为开启
    conn = sqlite3.connect(db_path)
    status = dict(conn.execute("SELECT id, status FROM tickets").fetchall())
    assert status[1] == "archived" and status[2] == "open" and status[3] == "open", status
    groups = dict(conn.execute("SELECT id, group_id FROM tickets").fetchall())
    assert groups[2] == 2 and groups[3] == 2, groups
    n_records = conn.execute("SELECT COUNT(*) FROM close_records").fetchone()[0]
    assert n_records == 1, f"关闭记录数不符: {n_records}"
    conn.close()
    print("4. 终态：#1 已归档，#2/#3 仍开启且属乙组，关闭记录仅 1 条 ✓")

    # 5. 同一批次号重复提交 → 返回原结果，不多写记录
    r = client.post("/api/batch-close", json={"batch_id": BATCH_ID, "ids": [1, 2, 3]})
    replay = r.get_json()
    assert replay["replayed"] is True, "重复提交应命中幂等回放"
    assert [x["id"] for x in replay["closed"]] == [1]
    conn = sqlite3.connect(db_path)
    n_records = conn.execute("SELECT COUNT(*) FROM close_records").fetchone()[0]
    conn.close()
    assert n_records == 1, f"重复提交多写了记录: {n_records}"
    print("5. 重复提交同批次：命中幂等回放，关闭记录仍为 1 条 ✓")

    # 6. 附加：本组已归档工单(#5)与不存在的编号(#999) → 未处理且不越权
    r = client.post("/api/batch-close", json={"batch_id": "test-batch-0002", "ids": [5, 999]})
    result2 = r.get_json()
    assert result2["closed"] == []
    np2 = {x["id"]: x for x in result2["not_processed"]}
    assert np2[5]["reason"] == "已归档，无需处理" and np2[5]["title"] == "打印机卡纸"
    assert np2[999]["reason"] == "工单不存在"
    print("6. 附加：本组已归档工单与不存在编号均正确归入未处理 ✓")

    print("\n全部断言通过。")


if __name__ == "__main__":
    main()
