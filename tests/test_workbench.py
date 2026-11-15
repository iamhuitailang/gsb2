"""关键验收场景测试：
1. 样例批次 4 条记录在旧规则（v1, 上限 20kg）下全部通过
2. 用新规则草稿（v2, 上限 15kg + 冷链必填温区）预跑：2 条通过→拒绝
3. 预跑只保存报告，正式发布前原批次仍显示 4 条通过
4. 发布后新批次用新规则，已开始批次仍绑定 v1
5. 回滚后新批次用旧规则，历史批次显示不变
"""
import json
import os
import tempfile
import unittest

import db as dbmod
from app import app
from seed import load_demo_data


class WorkbenchTest(unittest.TestCase):
    def setUp(self):
        fd, self.db_path = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        app.config["DATABASE"] = self.db_path
        app.config["TESTING"] = True
        dbmod.init_db(self.db_path)
        conn = dbmod.connect(self.db_path)
        load_demo_data(conn)
        conn.commit()
        conn.close()
        self.client = app.test_client()

    def tearDown(self):
        os.unlink(self.db_path)

    def db(self):
        conn = dbmod.connect(self.db_path)
        return conn

    def test_seed_batch_all_pass_under_v1(self):
        conn = self.db()
        batch = conn.execute("SELECT * FROM batches WHERE name LIKE '示例批次%'").fetchone()
        self.assertEqual(batch["total_rows"], 4)
        self.assertEqual(batch["pass_count"], 4)
        self.assertEqual(batch["reject_count"], 0)
        v1 = conn.execute("SELECT * FROM rule_versions WHERE version_no = 1").fetchone()
        self.assertEqual(batch["rule_version_id"], v1["id"])
        self.assertEqual(v1["status"], "published")
        conn.close()

    def test_dryrun_two_pass_to_reject_and_batch_untouched(self):
        conn = self.db()
        batch = conn.execute("SELECT * FROM batches").fetchone()
        draft = conn.execute("SELECT * FROM rule_versions WHERE status = 'draft'").fetchone()
        conn.close()

        resp = self.client.post("/dryrun", data={
            "batch_id": batch["id"], "draft_id": draft["id"],
        }, follow_redirects=False)
        self.assertEqual(resp.status_code, 302)

        conn = self.db()
        report = conn.execute("SELECT * FROM dryrun_reports").fetchone()
        self.assertEqual(report["pass_to_reject"], 2)
        self.assertEqual(report["reject_to_pass"], 0)
        self.assertEqual(report["unchanged"], 2)

        changed = conn.execute(
            "SELECT br.parcel_no, rr.draft_reasons_json FROM dryrun_report_rows rr"
            " JOIN batch_rows br ON br.id = rr.batch_row_id"
            " WHERE rr.change_type = 'pass_to_reject' ORDER BY br.row_no").fetchall()
        self.assertEqual([r["parcel_no"] for r in changed], ["PKG001", "PKG002"])
        self.assertIn("超出允许区间 [0, 15] kg", json.loads(changed[0]["draft_reasons_json"])[0])
        self.assertIn("冷链包裹必须填写温区", json.loads(changed[1]["draft_reasons_json"])[0])

        # 预跑只保存报告：正式发布前原批次仍显示 4 条通过
        batch_after = conn.execute("SELECT * FROM batches WHERE id = ?", (batch["id"],)).fetchone()
        self.assertEqual(batch_after["pass_count"], 4)
        self.assertEqual(batch_after["reject_count"], 0)
        n_results = conn.execute("SELECT COUNT(*) AS c FROM validation_results").fetchone()["c"]
        self.assertEqual(n_results, 4)  # 没有新增正式校验结果
        conn.close()

    def test_publish_then_old_batch_keeps_v1_new_batch_uses_v2(self):
        conn = self.db()
        draft = conn.execute("SELECT * FROM rule_versions WHERE status = 'draft'").fetchone()
        old_batch = conn.execute("SELECT * FROM batches").fetchone()
        conn.close()

        resp = self.client.post(f"/rules/{draft['id']}/publish",
                                data={"operator": "运营A"}, follow_redirects=True)
        self.assertEqual(resp.status_code, 200)

        conn = self.db()
        # 已开始批次仍绑定 v1，仍显示 4 条通过
        b = conn.execute("SELECT * FROM batches WHERE id = ?", (old_batch["id"],)).fetchone()
        v1 = conn.execute("SELECT * FROM rule_versions WHERE version_no = 1").fetchone()
        self.assertEqual(b["rule_version_id"], v1["id"])
        self.assertEqual(b["pass_count"], 4)
        self.assertEqual(v1["status"], "archived")
        conn.close()

        # 新批次使用 v2：同样的 4 条数据现在 2 条被拒绝
        csv_text = "PKG001,18,标准,否,\nPKG002,12,特快,是,\nPKG003,10,标准,否,\nPKG004,8,特快,是,2-8°C"
        self.client.post("/batches", data={"name": "BATCH-NEW", "csv_text": csv_text})
        conn = self.db()
        new_batch = conn.execute("SELECT * FROM batches WHERE name = 'BATCH-NEW'").fetchone()
        self.assertEqual(new_batch["rule_version_id"], draft["id"])
        self.assertEqual(new_batch["pass_count"], 2)
        self.assertEqual(new_batch["reject_count"], 2)
        conn.close()

    def test_rollback_restores_v1_and_history_preserved(self):
        conn = self.db()
        draft = conn.execute("SELECT * FROM rule_versions WHERE status = 'draft'").fetchone()
        conn.close()
        self.client.post(f"/rules/{draft['id']}/publish", data={"operator": "运营A"})

        conn = self.db()
        v1 = conn.execute("SELECT * FROM rule_versions WHERE version_no = 1").fetchone()
        conn.close()
        self.client.post(f"/rules/{v1['id']}/publish", data={"operator": "运营B"})

        conn = self.db()
        v1 = conn.execute("SELECT * FROM rule_versions WHERE version_no = 1").fetchone()
        self.assertEqual(v1["status"], "published")
        actions = [r["action"] for r in conn.execute(
            "SELECT action FROM publish_events ORDER BY id").fetchall()]
        self.assertEqual(actions, ["publish", "publish", "rollback"])

        # 回滚后新批次又用 v1（4 条全通过）
        csv_text = "PKG001,18,标准,否,\nPKG002,12,特快,是,\nPKG003,10,标准,否,\nPKG004,8,特快,是,2-8°C"
        self.client.post("/batches", data={"name": "BATCH-AFTER-ROLLBACK", "csv_text": csv_text})
        b = conn.execute("SELECT * FROM batches WHERE name = 'BATCH-AFTER-ROLLBACK'").fetchone()
        self.assertEqual(b["rule_version_id"], v1["id"])
        self.assertEqual(b["pass_count"], 4)
        conn.close()

    def test_batch_detail_page_shows_version_and_rows(self):
        conn = self.db()
        batch = conn.execute("SELECT * FROM batches").fetchone()
        conn.close()
        resp = self.client.get(f"/batches/{batch['id']}")
        html = resp.get_data(as_text=True)
        self.assertIn("v1", html)
        self.assertIn("PKG001", html)
        self.assertIn("通过 4", html)


if __name__ == "__main__":
    unittest.main()
