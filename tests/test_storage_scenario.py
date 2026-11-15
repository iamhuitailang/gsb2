"""端到端测试：乱序导入、去重、跨午夜配对、车牌更正后重算、轨迹、每日统计。

完整复现题面样例：
  1) 先导第二次停车的完整记录 + 第一次停车的出场；
  2) 再补第一晚 23:50 的入场 → 00:20 出场应配成 30 分钟，
     而不是和当天 09:10 的第二次进场配对；
  3) 把 00:20 出场车牌更正到另一辆车 → 原车只剩第二次完整记录，
     两个车牌各有一条未配对事件。
"""

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.importer import parse_csv
from app.storage import Storage

FIRST_FILE = """停车场,闸机号,流水号,车牌,事件类型,事件时间
P1,入口闸机A,1001,京A12345,进场,2026-11-15 09:10:00
P1,出口闸机B,2001,京A12345,出场,2026-11-15 11:40:00
P1,出口闸机B,2002,京A12345,出场,2026-11-15 00:20:00
"""

LATE_ENTRY_FILE = """停车场,闸机号,流水号,车牌,事件类型,事件时间
P1,入口闸机A,1000,京A12345,进场,2026-11-14 23:50:00
"""


class StorageScenarioTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
        self.tmp.close()
        self.db = Storage(self.tmp.name)

    def tearDown(self):
        self.db.close()
        os.unlink(self.tmp.name)

    def _pair_index(self):
        return {(p["entry_id"], p["exit_id"]): p for p in self.db.list_pairs()}

    def test_full_scenario(self):
        # ---- 第一步：先导第二次停车 + 第一条出场（缺第一晚入场）----
        r1 = self.db.import_rows("first.csv", parse_csv(FIRST_FILE))
        self.assertEqual((r1.inserted, r1.duplicates), (3, 0))

        pairs = self.db.list_pairs()
        self.assertEqual(len(pairs), 1)  # 09:10 进 / 11:40 出
        unpaired = {u["id"]: u for u in self.db.list_unpaired()}
        self.assertEqual(len(unpaired), 1)
        lone_exit = next(iter(unpaired.values()))
        self.assertEqual(lone_exit["event_type"], "exit")
        self.assertEqual(lone_exit["event_time"], "2026-11-15 00:20:00")
        # 未配对事件此时从未参与过配对
        self.assertEqual(lone_exit["trail"], [])

        # ---- 第二步：重复导入完全相同的文件，全部跳过且不产生新批次配对影响 ----
        r_dup = self.db.import_rows("dup.csv", parse_csv(FIRST_FILE))
        self.assertEqual((r_dup.inserted, r_dup.duplicates), (0, 3))
        self.assertEqual(len(self.db.list_pairs()), 1)

        # ---- 第三步：补第一晚 23:50 的入场（跨午夜）----
        self.db.import_rows("late.csv", parse_csv(LATE_ENTRY_FILE))
        pairs = self.db.list_pairs()
        self.assertEqual(len(pairs), 2)

        night = next(p for p in pairs if p["exit_time"] == "2026-11-15 00:20:00")
        self.assertEqual(night["entry_time"], "2026-11-14 23:50:00")
        self.assertEqual(night["duration_seconds"], 1800)  # 30 分钟

        morning = next(p for p in pairs if p["entry_time"] == "2026-11-15 09:10:00")
        self.assertEqual(morning["exit_time"], "2026-11-15 11:40:00")
        self.assertEqual(morning["duration_seconds"], 9000)  # 150 分钟

        self.assertEqual(self.db.list_unpaired(), [])

        # 00:20 出场现在能在配对轨迹里看到它曾"未配对→已配对"的历史
        exit_event = self.db.get_event(night["exit_id"])
        self.assertTrue(any(t["partner"]["id"] == night["entry_id"]
                            for t in exit_event["trail"]))

        # ---- 第四步：把 00:20 出场更正到另一辆车 ----
        exit_id = night["exit_id"]
        entry_id = night["entry_id"]
        updated = self.db.correct_plate(exit_id, "京B99999", "车牌识别错误")
        self.assertEqual(updated["raw_plate"], "京A12345")       # 原始导入保留
        self.assertEqual(updated["effective_plate"], "京B99999")
        self.assertEqual(len(updated["corrections"]), 1)

        pairs = self.db.list_pairs()
        self.assertEqual(len(pairs), 1)  # 原车只剩第二次完整记录
        remaining = pairs[0]
        self.assertEqual(remaining["plate"], "京A12345")
        self.assertEqual(remaining["entry_time"], "2026-11-15 09:10:00")

        unpaired = self.db.list_unpaired()
        self.assertEqual(len(unpaired), 2)  # 两个车牌各一条
        by_plate = {}
        for u in unpaired:
            by_plate.setdefault(u["effective_plate"], []).append(u)
        self.assertEqual(set(by_plate), {"京A12345", "京B99999"})
        self.assertEqual(by_plate["京A12345"][0]["id"], entry_id)  # 第一晚入场
        self.assertEqual(by_plate["京A12345"][0]["event_type"], "entry")
        self.assertEqual(by_plate["京B99999"][0]["id"], exit_id)
        self.assertEqual(by_plate["京B99999"][0]["event_type"], "exit")

        # 被挪走的出场仍能在轨迹里看到它曾经与第一晚入场配过对
        moved = self.db.get_event(exit_id)
        self.assertTrue(any(t["partner"]["id"] == entry_id for t in moved["trail"]))
        # 被留在原车的入场同样保留配对轨迹
        left = self.db.get_event(entry_id)
        self.assertTrue(any(t["partner"]["id"] == exit_id for t in left["trail"]))

        # ---- 每日统计：按出场日期，时长用实际时间差 ----
        stats = self.db.daily_stats()
        self.assertEqual(len(stats), 1)
        self.assertEqual(stats[0]["exit_date"], "2026-11-15")
        self.assertEqual(stats[0]["exit_count"], 1)
        self.assertEqual(stats[0]["avg_duration_minutes"], 150.0)

        # ---- 再次更正：把车牌改回去，应恢复两条完整记录 ----
        self.db.correct_plate(exit_id, "京A12345", "误更正，恢复")
        self.assertEqual(len(self.db.list_pairs()), 2)
        self.assertEqual(self.db.list_unpaired(), [])

    def test_dedup_key_includes_gate_and_seq(self):
        # 不同闸机的相同流水号是不同事件
        content = (
            "停车场,闸机号,流水号,车牌,事件类型,事件时间\n"
            "P1,G1,1,京A12345,进场,2026-11-15 08:00:00\n"
            "P1,G2,1,京A12345,进场,2026-11-15 08:05:00\n"
        )
        r = self.db.import_rows("gates.csv", parse_csv(content))
        self.assertEqual(r.inserted, 2)
        r2 = self.db.import_rows("gates.csv", parse_csv(content))
        self.assertEqual((r2.inserted, r2.duplicates), (0, 2))

    def test_invalid_rows_raise(self):
        with self.assertRaises(ValueError):
            parse_csv("停车场,闸机号,流水号,车牌,事件类型,事件时间\n"
                      "P1,G1,1,京A12345,未知类型,2026-11-15 08:00:00\n")


if __name__ == "__main__":
    unittest.main()
