"""端到端集成测试：真实 ffmpeg 转码 + ffprobe 校验时长/帧率/音频。

需要系统 ffmpeg；无 ffmpeg 时自动跳过。
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from framelab.core import pipeline
from framelab.core.ffmpeg_tools import probe
from framelab.core.project_store import new_project, save_project

SAMPLES = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                       "public", "samples")


def _ffprobe_duration(path: str) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "json", path], capture_output=True, text=True, check=True)
    return float(json.loads(out.stdout)["format"]["duration"])


def _ffprobe_fps(path: str) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=avg_frame_rate", "-of", "json", path],
        capture_output=True, text=True, check=True)
    num, den = json.loads(out.stdout)["streams"][0]["avg_frame_rate"].split("/")
    return float(num) / float(den)


@unittest.skipUnless(shutil.which("ffmpeg"), "需要 ffmpeg")
class TestEndToEnd(unittest.TestCase):
    def setUp(self):
        self.ws = tempfile.mkdtemp()
        self.audio_sample = os.path.join(SAMPLES, "sample_audio_30fps.mp4")
        if not os.path.exists(self.audio_sample):
            self.skipTest("样片未生成，请先运行 scripts/generate_samples.py")

    def _make_project(self, **settings):
        p = new_project(self.audio_sample)
        save_project(self.ws, p)
        pipeline.analyze_source(p)
        p["settings"].update(settings)
        pipeline.compute_mapping(p)
        save_project(self.ws, p)
        return p

    def test_speedup_keep_pitch_sync(self):
        p = self._make_project(dst_fps=60, speed=1.5, method="nearest", keep_pitch=True)
        rec = pipeline.export_video(self.ws, p)
        self.assertTrue(rec["ok"])
        out = os.path.join(self.ws, p["id"], "export", rec["output"])
        self.assertAlmostEqual(_ffprobe_duration(out), 4.0 / 1.5, delta=0.05)
        self.assertAlmostEqual(_ffprobe_fps(out), 60.0, delta=0.01)

    def test_slowdown_pitch_shift_sync(self):
        p = self._make_project(dst_fps=24, speed=0.5, method="nearest", keep_pitch=False)
        rec = pipeline.export_video(self.ws, p)
        out = os.path.join(self.ws, p["id"], "export", rec["output"])
        self.assertAlmostEqual(_ffprobe_duration(out), 8.0, delta=0.05)
        self.assertAlmostEqual(_ffprobe_fps(out), 24.0, delta=0.01)

    def test_blend_export(self):
        p = self._make_project(dst_fps=60, speed=1.0, method="blend")
        rec = pipeline.export_video(self.ws, p)
        out = os.path.join(self.ws, p["id"], "export", rec["output"])
        self.assertAlmostEqual(_ffprobe_duration(out), 4.0, delta=0.1)

    def test_manifest_written(self):
        p = self._make_project(dst_fps=30, speed=1.0, method="nearest")
        mapping = p["mapping_cache"][next(iter(p["mapping_cache"]))]
        csv_path, json_path = pipeline.export_manifest(self.ws, p, mapping)
        self.assertTrue(os.path.getsize(csv_path) > 0)
        payload = json.load(open(json_path, encoding="utf-8"))
        self.assertEqual(payload["stats"]["out_frame_count"],
                         len(payload["rows"]))

    def test_probe_reads_all_frames(self):
        info = probe(self.audio_sample)
        self.assertEqual(info["frame_count"], 120)  # 30fps × 4s，首帧 PTS=0 不丢
        self.assertTrue(info["has_audio"])


if __name__ == "__main__":
    unittest.main()
