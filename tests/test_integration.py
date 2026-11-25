"""端到端: 样例生成 -> 规划 -> 预览/对照/导出 -> 逐帧一致性校验。

需要系统 ffmpeg; 无 ffmpeg 时整体 skip。
"""
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from reframer.ffmpegutil import probe
from reframer.cli import main as cli_main
from reframer.tracks import load_tracks
from reframer.tracks import rect_at
from reframer.planner import plan
from reframer.expr import sample_kf


@unittest.skipIf(shutil.which("ffmpeg") is None, "ffmpeg 未安装")
class TestEndToEnd(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_full_pipeline(self):
        # 1. 样例
        cli_main(["sample", str(self.dir)])
        video = self.dir / "sample.mp4"
        tracks = self.dir / "sample_tracks.json"
        self.assertTrue(video.exists())
        info = probe(video)
        self.assertEqual((info["width"], info["height"]), (1280, 720))
        self.assertTrue(info["has_audio"])
        self.assertAlmostEqual(info["duration"], 12.0, delta=0.2)

        # 2. 规划
        schedule_path = self.dir / "schedule.json"
        rc = cli_main(["plan", str(tracks), "-o", str(schedule_path)])
        self.assertEqual(rc, 0)
        sched = json.loads(schedule_path.read_text())
        self.assertEqual(sched["crop"]["width_px"] % 2, 0)
        self.assertEqual(sched["crop"]["height_px"], 720)
        # 两个镜头都有策略摘要
        self.assertEqual(len(sched["segments"]), 2)
        # 切点事件存在
        self.assertTrue(any(e["type"] == "cut" for e in sched["events"]))

        # 3. 预览 + 对照
        preview = self.dir / "preview.mp4"
        cli_main(["preview", str(schedule_path), "-o", str(preview)])
        self.assertTrue(preview.exists())
        compare = self.dir / "compare.mp4"
        cli_main(["compare", str(schedule_path), "-o", str(compare),
                  "--workdir", str(self.dir / "work")])
        p_info = probe(compare)
        self.assertEqual(p_info["height"], 720)

        # 4. 导出竖版
        vertical = self.dir / "vertical.mp4"
        rc = cli_main(["export", str(schedule_path), "-o", str(vertical),
                       "--workdir", str(self.dir / "work")])
        self.assertEqual(rc, 0)
        v_info = probe(vertical)
        self.assertEqual((v_info["width"], v_info["height"]),
                         (sched["crop"]["width_px"], 720))
        self.assertTrue(v_info["has_audio"])
        self.assertAlmostEqual(v_info["duration"], info["duration"], delta=0.15)

        # 5. 逐帧一致性 (含切点前后帧)
        rc = cli_main(["verify", str(schedule_path), str(vertical),
                       "--workdir", str(self.dir / "work"),
                       "--json", str(self.dir / "verify.json")])
        self.assertEqual(rc, 0)
        vdata = json.loads((self.dir / "verify.json").read_text())
        self.assertTrue(vdata["ok"])
        self.assertTrue(all(r["identical"] for r in vdata["frame_check"]["rows"]))
        # 切点确实是硬跳
        self.assertTrue(all(r["jump_px"] > 100 for r in vdata["cut_frames"]))

        # 6. 编辑: 加人工取景后重算, 原片不动。0.80 落在必留对象+安全区的可行交集内
        cli_main(["edit", str(schedule_path),
                  "--add-override", "5.0", "7.0", "0.80", "--name", "fix1"])
        sched2 = json.loads(schedule_path.read_text())
        c = sample_kf(sched2, 6.0)
        self.assertAlmostEqual(c["x"] + c["w"] / 2, 0.80, delta=0.02)
        vertical2 = self.dir / "vertical2.mp4"
        cli_main(["export", str(schedule_path), "-o", str(vertical2),
                  "--workdir", str(self.dir / "work")])
        self.assertTrue(vertical2.exists())

        # 7. 报告
        report = self.dir / "report.html"
        cli_main(["report", str(schedule_path), "-o", str(report),
                  "--vertical", str(vertical2), "--sheet-video", str(vertical2),
                  "--workdir", str(self.dir / "work")])
        html = report.read_text(encoding="utf-8")
        self.assertIn("取景轨迹", html)
        self.assertIn("data:image/jpeg;base64", html)

    def test_missing_box_interval_in_sample(self):
        # 样例里 p2 在 3.0~4.2s 出画: 该区间只剩 p1, 规划不崩溃且能正常跟随
        cli_main(["sample", str(self.dir), "--prefix", "s2"])
        tracks = load_tracks(self.dir / "s2_tracks.json")
        self.assertIsNone(rect_at(tracks.track("p2"), 3.5))
        self.assertIsNotNone(rect_at(tracks.track("p1"), 3.5))
        sched = plan(tracks)
        self.assertGreaterEqual(len(sched["keyframes"]), 2)
        self.assertNotIn("fallback", sched["segments"][0]["strategies"])


if __name__ == "__main__":
    unittest.main()
