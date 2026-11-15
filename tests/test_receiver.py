"""接收台核心行为的自动化验证。运行：python3 -m unittest discover -s tests -v"""
import json
import os
import shutil
import tempfile
import unittest

from app import source
from app.receiver import Receiver


def push_batch(rc, batch_no, which="all", order="normal"):
    items = source.deliveries(batch_no)
    if which == "manifest":
        items = [d for d in items if d.kind == "manifest"]
    elif which == "shards":
        items = [d for d in items if d.kind == "shard"]
    if order == "reverse":
        items = list(reversed(items))
    return [rc.ingest(d.batch_no, d.kind, d.filename, d.body) for d in items]


class ReceiverTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="rc-test-")
        self.rc = Receiver(self.tmp)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_shards_before_manifest_then_verified(self):
        push_batch(self.rc, 1, which="shards")
        st = self.rc.status()["batches"][0]
        self.assertEqual(st["state"], "awaiting_manifest")
        self.assertEqual(len(st["received_files"]), 2, "分片本身应先落盘保存")
        self.assertFalse(st["published"])
        push_batch(self.rc, 1, which="manifest")
        st = self.rc.status()["batches"][0]
        self.assertEqual(st["state"], "published")
        self.assertEqual(self.rc.status()["effective_batch"], 1)

    def test_out_of_order_batch_is_staged_until_previous_publishes(self):
        push_batch(self.rc, 3)
        st = self.rc.status()
        self.assertEqual(st["effective_batch"], 0, "无初始批时第 3 批不得生效")
        self.assertEqual(st["batches"][0]["state"], "staged")
        self.assertEqual(self.rc.list_tickets(), [])

        push_batch(self.rc, 1)
        self.assertEqual(self.rc.status()["effective_batch"], 1)
        # 第 2 批还没来，第 3 批仍然不能越过它
        self.assertEqual(self.rc.status()["batches"][1]["state"], "staged")

        push_batch(self.rc, 2, order="reverse")
        st = self.rc.status()
        self.assertEqual(st["effective_batch"], 3, "上一批齐了之后应顺序生效到第 3 批")
        self.assertEqual(st["published_batches"], [1, 2, 3])

    def test_duplicate_delivery_makes_no_second_publish(self):
        push_batch(self.rc, 1)
        results = push_batch(self.rc, 1)
        after = self.rc.status()
        self.assertEqual(len(after["published_batches"]), 1)
        self.assertTrue(all(r["duplicate"] for r in results))
        # 历史也不重复
        self.assertEqual(len(self.rc.history_list()), 6)

    def test_duplicate_of_last_file_after_publish_is_ignored(self):
        push_batch(self.rc, 1, which="manifest")
        d = [x for x in source.deliveries(1) if x.kind == "shard"][0]
        self.rc.ingest(d.batch_no, d.kind, d.filename, d.body)
        self.assertEqual(self.rc.status()["effective_batch"], 0)
        # 在收到最后一个文件后、发布前重送同一文件，仍能正常发布
        self.rc.ingest(d.batch_no, d.kind, d.filename, d.body)
        push_batch(self.rc, 1, which="shards")
        self.assertEqual(self.rc.status()["effective_batch"], 1)
        self.assertEqual(len(self.rc.status()["published_batches"]), 1)

    def test_checksum_mismatch_is_rejected_and_not_published(self):
        items = source.deliveries(1)
        manifest = next(d for d in items if d.kind == "manifest")
        shards = [d for d in items if d.kind == "shard"]
        self.rc.ingest(manifest.batch_no, manifest.kind, manifest.filename, manifest.body)
        bad = json.loads(shards[0].body.decode("utf-8"))
        bad[0]["ticket"]["title"] = "被篡改"
        self.rc.ingest(shards[0].batch_no, shards[0].kind, shards[0].filename, json.dumps(bad, ensure_ascii=False).encode("utf-8"))
        self.rc.ingest(shards[1].batch_no, shards[1].kind, shards[1].filename, shards[1].body)
        st = self.rc.status()
        self.assertEqual(st["effective_batch"], 0)
        self.assertEqual(st["batches"][0]["state"], "problem")
        self.assertEqual(st["batches"][0]["file_status"][shards[0].filename], "bad")
        self.assertEqual(st["batches"][0]["file_status"][shards[1].filename], "verified")
        # 修正后重送可正常生效
        self.rc.ingest(shards[0].batch_no, shards[0].kind, shards[0].filename, shards[0].body)
        self.assertEqual(self.rc.status()["effective_batch"], 1)

    def test_restart_keeps_verified_files_and_resumes(self):
        push_batch(self.rc, 1, which="manifest")
        first_shard = [d for d in source.deliveries(1) if d.kind == "shard"][0]
        self.rc.ingest(first_shard.batch_no, first_shard.kind, first_shard.filename, first_shard.body)
        self.assertEqual(self.rc.status()["effective_batch"], 0)

        # 模拟进程重启：新实例读同一目录
        rc2 = Receiver(self.tmp)
        st = rc2.status()
        self.assertEqual(st["batches"][0]["received_files"], [first_shard.filename])
        self.assertEqual(st["batches"][0]["received_manifest"], True)
        self.assertEqual(st["batches"][0]["state"], "partial")
        # 补齐清单与剩余文件后照常生效，历史不重复
        push_batch(rc2, 1)
        self.assertEqual(rc2.status()["effective_batch"], 1)
        self.assertEqual(len(rc2.history_list()), 6)
        self.assertIn("TK-1001", [t["id"] for t in rc2.list_tickets()])

    def test_restart_between_last_file_and_publish_still_completes(self):
        # 先送齐全但模拟「落盘后、发布前」崩溃：直接构造目录
        for d in source.deliveries(1):
            target = os.path.join(self.rc._batch_dir(1), d.filename)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target, "wb") as fh:
                fh.write(d.body)
        self.assertEqual(self.rc.status()["effective_batch"], 0)
        rc2 = Receiver(self.tmp)
        self.assertEqual(rc2.status()["effective_batch"], 1, "重启后应补做发布")

    def test_update_then_delete_removed_from_query_but_history_kept(self):
        for b in (1, 2, 3):
            push_batch(self.rc, b)
        self.assertNotIn("TK-1001", [t["id"] for t in self.rc.list_tickets()])
        detail = self.rc.ticket_detail("TK-1001")
        self.assertFalse(detail["exists"])
        self.assertEqual([h["action"] for h in detail["history"]], ["create", "update", "delete"])
        self.assertEqual(detail["history"][1]["before"]["status"], "待处理")
        self.assertEqual(detail["history"][1]["after"]["status"], "处理中")
        self.assertEqual(detail["history"][2]["before"]["status"], "处理中")
        self.assertIsNone(detail["history"][2]["after"])

    def test_current_tickets_after_three_batches(self):
        for b in (1, 2, 3):
            push_batch(self.rc, b)
        ids = sorted(t["id"] for t in self.rc.list_tickets())
        # 初始 6 条；+TK-1007 +TK-1008 = 8；删除 TK-1005、TK-1001、TK-1004 = 5
        self.assertEqual(ids, ["TK-1002", "TK-1003", "TK-1006", "TK-1007", "TK-1008"])
        detail = self.rc.ticket_detail("TK-1008")
        self.assertTrue(detail["exists"])

    def test_manifest_before_shards_shows_expected_files(self):
        push_batch(self.rc, 2, which="manifest")
        st = self.rc.status()["batches"][0]
        self.assertEqual(st["state"], "partial")
        self.assertEqual(len(st["expected_files"]), 2)
        self.assertEqual(st["received_files"], [])
        self.assertTrue(all(v == "missing" for v in st["file_status"].values()))


if __name__ == "__main__":
    unittest.main()
