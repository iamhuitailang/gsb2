"""验收流程测试（直接跑服务层，不启 HTTP）：

1. 种子数据两个库区：A区 WB-1001 4 件、B区 WB-2001 6 件；
2. 开始导出并完成第一页；
3. 维护操作把剩余运单 6 件改成 9 件（4 件运单不变）；
4. 继续生成 -> 本次导出仍是快照数据，共 10 件；
5. 新起一次任务 -> 看到最新数据，共 13 件；
6. 中断续跑不重复写明细；已完成的任务再推进是空操作。

运行: python3 test_flow.py
"""

import csv
import os
import tempfile
import zipfile

import db
import service
from run import seed


def read_csv(path):
    with open(path, newline="", encoding="utf-8-sig") as f:
        return list(csv.reader(f))


def main():
    tmp = tempfile.mkdtemp(prefix="export_test_")
    db_path = os.path.join(tmp, "test.db")
    workdir = os.path.join(tmp, "exports")

    conn = db.connect(db_path)
    db.init_db(conn)
    seed(conn)

    # 1. 开始导出：锁定范围和数据版本
    today = db.current_waybills(conn)[0]["ship_date"]
    task1 = service.create_task(conn, today, today)
    t1 = service.get_task(conn, task1)
    assert t1["total_pages"] == 2 and t1["total_pieces"] == 10, t1["total_pieces"]

    # 2. 完成第一页（A区 4 件）
    assert service.generate_next_page(conn, task1, workdir) == 1

    # 模拟服务中断：关掉连接重新打开，状态仍在
    conn.close()
    conn = db.connect(db_path)

    # 3. 维护：剩余运单 6 -> 9 件，另一条 4 件不变
    wb2001 = [w for w in db.current_waybills(conn)
              if w["waybill_no"] == "WB-2001"][0]
    db.update_pieces(conn, wb2001["id"], 9)

    # 4. 继续生成：仍使用任务锁定的旧版本
    service.run_remaining(conn, task1, workdir)
    t1 = service.get_task(conn, task1)
    assert t1["status"] == "DONE"
    assert t1["total_pieces"] == 10, f"本次导出应为 10 件，实际 {t1['total_pieces']}"

    # 每个库区一份 csv，内容来自同一快照
    outdir = os.path.join(workdir, "tasks", str(task1))
    a = read_csv(os.path.join(outdir, "A区.csv"))
    b = read_csv(os.path.join(outdir, "B区.csv"))
    assert a == [["运单号", "库区", "件数", "发货日期"],
                 ["WB-1001", "A区", "4", today]], a
    assert b == [["运单号", "库区", "件数", "发货日期"],
                 ["WB-2001", "B区", "6", today]], b  # 快照：仍是 6 件

    # 统计 manifest：每份文件行数 + 总件数
    manifest = read_csv(os.path.join(outdir, "manifest.csv"))
    assert manifest == [["文件名", "行数", "总件数"],
                        ["A区.csv", "1", "4"],
                        ["B区.csv", "1", "6"],
                        ["合计", "2", "10"]], manifest

    # zip 内含两个库区 csv + manifest
    zpath = os.path.join(outdir, f"export_{task1}_v{t1['data_version']}.zip")
    with zipfile.ZipFile(zpath) as z:
        assert sorted(z.namelist()) == ["A区.csv", "B区.csv", "manifest.csv"]

    # 5. 新起一次任务：看到最新数据，13 件
    task2 = service.create_task(conn, today, today)
    service.run_remaining(conn, task2, workdir)
    t2 = service.get_task(conn, task2)
    assert t2["data_version"] > t1["data_version"]
    assert t2["total_pieces"] == 13, f"新任务应为 13 件，实际 {t2['total_pieces']}"

    # 6. 幂等：已完成任务不再生成；续跑不会写第二次明细
    assert service.generate_next_page(conn, task1, workdir) is None
    service.run_remaining(conn, task1, workdir)
    assert len(service.done_pages(conn, task1)) == 2
    a2 = read_csv(os.path.join(outdir, "A区.csv"))
    b2 = read_csv(os.path.join(outdir, "B区.csv"))
    assert len(a2) == 2 and len(b2) == 2, "明细不能写两次"

    # 撤销旧单也不影响已完成的导出
    db.cancel_waybill(conn, wb2001["id"] + 1)  # 更新后的 WB-2001 新行
    t1_after = service.get_task(conn, task1)
    assert t1_after["total_pieces"] == 10

    conn.close()
    print("全部验收断言通过：")
    print(f"  任务#1（版本 v{t1['data_version']}）总件数 = {t1['total_pieces']}（预期 10）")
    print(f"  任务#2（版本 v{t2['data_version']}）总件数 = {t2['total_pieces']}（预期 13）")
    print(f"  临时目录: {tmp}")


if __name__ == "__main__":
    main()
