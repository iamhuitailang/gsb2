"""End-to-end smoke test: sample video -> analysis -> shots -> export.

Requires ffmpeg + libx264; skipped automatically when they are unavailable so
the unit suite still runs on machines without media tooling.
"""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

from shot_shelf import export, media, samples, store


def _ffmpeg_ready() -> bool:
    report = media.doctor()
    return bool(report.get("ffmpeg") and report.get("ffprobe") and report.get("libx264"))


@unittest.skipUnless(_ffmpeg_ready(), "needs ffmpeg with libx264")
class EndToEndTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        os.environ["SHOT_SHELF_HOME"] = cls.tmp.name
        sample = samples.ensure_sample(regenerate=True)
        cls.video = Path(sample["video_path"])
        cls.info = media.probe(cls.video)

    @classmethod
    def tearDownClass(cls):
        os.environ.pop("SHOT_SHELF_HOME", None)
        cls.tmp.cleanup()

    def test_pipeline(self):
        project = store.create_project(str(self.video), name="smoke")
        analysis = store.save_analysis(
            project["media"]["fingerprint"],
            str(self.video),
            store.ensure_media(project),
            media.analyze_scene(str(self.video))["points"],
        )
        store.rebuild(project, analysis=analysis, save_project=True)

        # The designed hard cuts at 3s and 10s should be detected.
        starts = [shot["start_ms"] for shot in project["shots"]]
        self.assertTrue(project["shots"], "expected at least one shot")
        self.assertTrue(any(abs(s - 3_000) <= 120 for s in starts), starts)
        self.assertTrue(any(abs(s - 10_000) <= 120 for s in starts), starts)

        # Shots must tile the whole timeline.
        expected = 0
        for shot in project["shots"]:
            self.assertEqual(shot["start_ms"], expected)
            expected = shot["end_ms"]
        self.assertEqual(expected, project["media"]["info"]["duration_ms"])

        # Annotate + export.
        first = project["shots"][0]
        store.update_shot(project, first["id"], {"tags": ["demo"], "note": "冒烟测试"})
        result = export.export_project(project, name="smoke-export")
        self.assertTrue(Path(result["index"]).is_file())
        self.assertTrue(Path(result["csv"]).is_file())
        self.assertTrue(Path(result["manifest"]).is_file())
        self.assertGreater(result["shots"], 0)
        manifest = Path(result["manifest"]).read_text(encoding="utf-8")
        self.assertIn("demo", manifest)

    def test_thumbnail_alignment(self):
        from shot_shelf import thumbnails

        project = store.create_project(str(self.video), name="thumb")
        shot = project["shots"][0]
        meta = thumbnails.thumb_for(
            project_id=project["id"],
            fingerprint=project["media"]["fingerprint"],
            media_path=project["media"]["path"],
            start_ms=shot["start_ms"],
            end_ms=min(shot["end_ms"], 3_000),
            position=0.35,
            width=320,
        )
        self.assertIsNotNone(meta)
        self.assertIsNotNone(meta.get("actual_ms"))
        # Accurate seek should land within one frame (40ms at 25fps).
        self.assertLessEqual(abs(meta["drift_ms"]), 60)


if __name__ == "__main__":
    unittest.main()
