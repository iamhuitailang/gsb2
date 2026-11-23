"""端到端测试：真实 ffmpeg 生成源片、构建两档、比对、核验、预览 API。

素材刻意保持很小（2 个源片、10fps、320x180），整套测试在本机数秒内完成。
若本机没有 ffmpeg 则跳过。
"""

import json
import shutil
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from sebalign.build import TierConfig, build_workspace, load_manifest
from sebalign.compare import compare_tiers
from sebalign.samples import generate_source_clips
from sebalign.server import serve
from sebalign.verify import verify_workspace


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"),
                     "本机缺少 ffmpeg/ffprobe")
class EndToEndTest(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.tmp = Path(tempfile.mkdtemp(prefix="sebalign-e2e-"))
        self.src = self.tmp / "src"
        # 两个短片：2s + 3s，10fps，共 50 帧
        self.markers = generate_source_clips(self.src, clip_seconds=(2.0, 3.0), fps=10)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_full_pipeline_good_case(self):
        ws = self.tmp / "good"
        tiers = [
            TierConfig("low", 160, 90, [1.0, 2.0, 3.0, 4.0]),
            TierConfig("high", 320, 180, [1.0, 2.0, 3.0, 4.0]),
        ]
        manifest = build_workspace(self.src, ws, tiers, markers=self.markers)

        # 切分点 1/2/3/4 加上端点 0、5s => 5 段
        for tier in manifest.tiers:
            self.assertEqual(len(tier.segments), 5)
            for s in tier.segments:
                self.assertTrue(s.openable)
                self.assertTrue((ws / s.file).is_file())
                self.assertTrue(s.actual_duration > 0)
                self.assertTrue(s.frame_label.startswith("src"))
                self.assertIsNotNone(s.first_frame_hash)
                self.assertTrue((ws / s.thumb).is_file())

        # 连续音轨存在且可读
        self.assertIsNotNone(manifest.audio_track)
        self.assertTrue((ws / manifest.audio_track).is_file())

        # 比对无问题，核验无异常
        cmp_report = compare_tiers(ws, load_manifest(ws))
        self.assertEqual(cmp_report.issues, [])
        verify_report = verify_workspace(ws, load_manifest(ws))
        self.assertFalse(verify_report.has_errors, verify_report.summary())

        # 切分点吸附：2.0 正好是源片边界，两段分别落在两个源片上
        labels = [s.frame_label for s in manifest.tiers[0].segments]
        self.assertTrue(any(l.startswith("src1/") for l in labels))
        self.assertTrue(any(l.startswith("src2/") for l in labels))

    def test_bad_case_detects_misalignment_and_missing_file(self):
        ws = self.tmp / "bad"
        tiers = [
            TierConfig("low", 160, 90, [1.0, 2.0, 3.0, 4.0]),
            TierConfig("high", 320, 180, [1.5, 2.5, 3.5]),  # 系统性错位
        ]
        manifest = build_workspace(self.src, ws, tiers, markers=self.markers)
        victim = ws / manifest.tiers[1].segments[1].file
        victim.unlink()

        cmp_report = compare_tiers(ws, load_manifest(ws))
        kinds = {i.kind for i in cmp_report.issues}
        self.assertIn("boundary_mismatch", kinds)
        self.assertIn("unreadable", kinds)

        verify_report = verify_workspace(ws, load_manifest(ws))
        self.assertTrue(verify_report.has_errors)
        files_bad = {c.file for c in verify_report.checks if c.status in {"missing", "unreadable"}}
        self.assertIn(manifest.tiers[1].segments[1].file, files_bad)

    def test_duration_drift_detected_after_tamper(self):
        ws = self.tmp / "tamper"
        tiers = [TierConfig("low", 160, 90, [2.0]), TierConfig("high", 320, 180, [2.0])]
        build_workspace(self.src, ws, tiers, markers=self.markers)
        manifest_path = ws / "manifest.json"
        data = json.loads(manifest_path.read_text(encoding="utf-8"))
        data["tiers"][0]["segments"][0]["actual_duration"] = 99.0  # 篡改估计时长
        manifest_path.write_text(json.dumps(data), encoding="utf-8")

        report = verify_workspace(ws, data)
        self.assertTrue(any(c.status == "duration_drift" for c in report.checks))

    def test_preview_server_switch_api_and_path_guard(self):
        ws = self.tmp / "serve"
        tiers = [
            TierConfig("low", 160, 90, [1.0, 2.0, 3.0, 4.0]),
            TierConfig("high", 320, 180, [1.0, 2.0, 3.0, 4.0]),
        ]
        build_workspace(self.src, ws, tiers, markers=self.markers)
        httpd = serve(ws, port=0)
        port = httpd.server_address[1]
        # serve_forever 必须在独立线程里，否则主线程随后调用 shutdown 会自锁
        import threading
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/manifest") as r:
                self.assertEqual(r.status, 200)
                payload = json.loads(r.read())
                self.assertIn("tiers", payload)

            # 边界上立即切换；分段中间要求等待
            with urllib.request.urlopen(
                f"http://127.0.0.1:{port}/api/switch?from=low&to=high&t=2.0"
            ) as r:
                d = json.loads(r.read())
                self.assertEqual(d["verdict"], "switch_now")
            with urllib.request.urlopen(
                f"http://127.0.0.1:{port}/api/switch?from=low&to=high&t=2.3"
            ) as r:
                d = json.loads(r.read())
                self.assertEqual(d["verdict"], "wait")

            # 切换尝试被持久化
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/switch-log") as r:
                log = json.loads(r.read())
                self.assertEqual(len(log["attempts"]), 2)

            # 路径穿越被拒
            with self.assertRaises(urllib.error.HTTPError):
                urllib.request.urlopen(
                    f"http://127.0.0.1:{port}/media/..%2f..%2f..%2fetc%2fpasswd"
                )
        finally:
            httpd.shutdown()
            httpd.server_close()


if __name__ == "__main__":
    unittest.main()
