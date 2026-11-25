from __future__ import annotations

import shutil
import tempfile
import unittest
from pathlib import Path

from segment_recorder.exporter import export_library, verify_export, build_analysis
from segment_recorder.recorder import Recorder
from segment_recorder.storage import Store
from segment_recorder.world import advance, init_world


class RecorderExperimentTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(prefix="seg-rec-test-")
        self.root = Path(self.temp_dir.name) / "work"
        init_world(self.root, fake_media=True, force=True)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def _poll(self) -> Recorder:
        recorder = Recorder(self.root, verbose=False, show_repeats=False)
        recorder.poll_once()
        return recorder

    def test_late_half_restart_sequence_reset_and_offline_export(self) -> None:
        # t1-t3：0、1 完整，2 半截。
        advance(self.root)
        r1 = self._poll()
        advance(self.root)
        r1.poll_once()
        advance(self.root)
        r1.poll_once()

        row = self._row("ep-0001", 2)
        self.assertIsNotNone(row)
        self.assertLess(row["archived_size"], row["expected_size"])
        self.assertGreater(row["archived_size"], 0)

        # 多轮看到同一段不应创建重复 DB 行或重复 blob 任务。
        r1.poll_once()
        r1.close()

        # 进程中断期间，源端继续：写完 2、出现 3、跳过 4 出现 5，并轮换 0。
        advance(self.root)
        advance(self.root)
        advance(self.root)

        # 新 Recorder 实例相当于进程重启；应从 .part 续收 2，并补收 3/5。
        r2 = Recorder(self.root, verbose=False, show_repeats=False)
        r2.poll_once()
        self.assertEqual(self._row("ep-0001", 2)["status"], "saved")
        self.assertEqual(self._row("ep-0001", 3)["status"], "saved")
        self.assertEqual(self._row("ep-0001", 5)["status"], "saved")

        # 再轮询一次：所有已保存段仍只有一条身份记录，seen_count 增加。
        before = self._saved_count()
        r2.poll_once()
        after = self._saved_count()
        self.assertEqual(before, after)
        row0 = self._row("ep-0001", 0)
        self.assertGreaterEqual(row0["seen_count"], 2)

        # t7-t13：迟到 seq4、6、跳过 7 的 8、断档、ep2 从 0 开始。
        for _ in range(7):
            advance(self.root)
            r2.poll_once()
        r2.close()

        expected_ep1 = [0, 1, 2, 3, 4, 5, 6, 8]
        for seq in expected_ep1:
            self.assertEqual(self._row("ep-0001", seq)["status"], "saved", seq)
        for seq in [0, 1, 2]:
            self.assertEqual(self._row("ep-0002", seq)["status"], "saved", seq)

        # seq7 是永久中间缺口；连续区间应为 ep1 0-6、ep1 8、ep2 0-2。
        with Store(self.root / "archive" / "recorder.sqlite3") as store:
            analysis = build_analysis(store)
        self.assertEqual(len(analysis["ranges"]), 3)
        self.assertEqual(
            (analysis["ranges"][0]["epoch_id"], analysis["ranges"][0]["start_sequence"], analysis["ranges"][0]["end_sequence"]),
            ("ep-0001", 0, 6),
        )
        self.assertEqual(
            (analysis["ranges"][1]["start_sequence"], analysis["ranges"][1]["end_sequence"]),
            (8, 8),
        )
        self.assertEqual(analysis["ranges"][2]["epoch_id"], "ep-0002")
        gap_types = [gap["type"] for gap in analysis["gaps"]]
        self.assertIn("missing-sequence", gap_types)
        self.assertIn("epoch-restart", gap_types)
        self.assertIn("late-filled", gap_types)
        late_gap = next(gap for gap in analysis["gaps"] if gap["type"] == "late-filled")
        self.assertEqual(late_gap["missing_sequences"], [4])
        self.assertIsNotNone(late_gap["observed_start_iso"])
        self.assertIsNotNone(late_gap["observed_end_iso"])

        # 同序号 0000 在两个 epoch 中内容不同，两个归档 blob 都必须存在。
        old0 = self._row("ep-0001", 0)
        new0 = self._row("ep-0002", 0)
        self.assertNotEqual(old0["sha256"], new0["sha256"])
        self.assertTrue(Path(old0["archive_path"]).exists())
        self.assertTrue(Path(new0["archive_path"]).exists())
        self.assertNotEqual(old0["archive_path"], new0["archive_path"])

        blob_files = list((self.root / "archive" / "blobs").glob("*"))
        blob_files = [p for p in blob_files if p.is_file()]
        self.assertEqual(len(blob_files), 11)

        export_dir = export_library(self.root, make_media=False)
        report = verify_export(export_dir)
        self.assertTrue(report["ok"], report["errors"])

        # 删除原始清单和源短片后，自包含导出仍校验通过。
        shutil.rmtree(self.root / "source")
        report_after_delete = verify_export(export_dir)
        self.assertTrue(report_after_delete["ok"], report_after_delete["errors"])

    def test_source_prefix_rewrite_resets_part(self) -> None:
        for _ in range(3):
            advance(self.root)

        recorder = Recorder(self.root, verbose=False)
        recorder.poll_once()
        row = self._row("ep-0001", 2)
        self.assertEqual(row["status"], "partial")
        part = recorder.tmp_dir / f"{row['sha256']}.part"
        self.assertTrue(part.exists())
        old_part_size = part.stat().st_size
        self.assertGreater(old_part_size, 0)

        # 源路径被另一轮写入复用/重写，且新前缀与旧 .part 不一致。
        source_path = Path(row["source_path"])
        rewritten = b"rewritten-source-prefix-" * 4000
        source_path.write_bytes(rewritten)

        recorder._ingest_segment(row["id"])
        row_after = self._row("ep-0001", 2)
        self.assertEqual(row_after["status"], "partial")
        self.assertEqual(part.stat().st_size, len(rewritten))
        self.assertEqual(row_after["archived_size"], len(rewritten))
        recorder.close()

    def _row(self, epoch_id: str, sequence: int):
        import sqlite3
        from contextlib import closing

        db = self.root / "archive" / "recorder.sqlite3"
        with closing(sqlite3.connect(db)) as conn:
            conn.row_factory = sqlite3.Row
            return conn.execute(
                "SELECT * FROM segments WHERE epoch_id=? AND sequence=? ORDER BY id DESC LIMIT 1",
                (epoch_id, sequence),
            ).fetchone()

    def _saved_count(self) -> int:
        import sqlite3
        from contextlib import closing

        db = self.root / "archive" / "recorder.sqlite3"
        with closing(sqlite3.connect(db)) as conn:
            return int(conn.execute("SELECT COUNT(*) FROM segments WHERE status='saved'").fetchone()[0])


if __name__ == "__main__":
    unittest.main()
