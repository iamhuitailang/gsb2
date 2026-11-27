"""Store-level tests: edit operations, manual overrides, cache layout.

These do not need ffmpeg: a project is assembled by hand from a synthetic
analysis cache, which is exactly the data the detector consumes.
"""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path

from shot_shelf import store
from shot_shelf.detect import DetectSettings

FPS = 25
STEP = 40
DURATION = 10_000


def analysis_points(cuts=(3_000, 7_000)):
    points = []
    for t in range(0, DURATION, STEP):
        score = 0.002
        for cut in cuts:
            if abs(t - cut) <= STEP // 2:
                score = 0.9
        luma = 90.0
        if t >= 3_000:
            luma = 150.0
        if t >= 7_000:
            luma = 60.0
        points.append([t, score, luma, 40.0])
    return points


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.environ["SHOT_SHELF_HOME"] = self.tmp.name
        self.video = Path(self.tmp.name) / "clip.mp4"
        # Contents are irrelevant: rebuild only stats the file.
        self.video.write_bytes(b"not really a video")
        self.project = {
            "version": store.VERSION,
            "id": "p-test000001",
            "name": "test",
            "created_at": "2026-01-01T00:00:00",
            "updated_at": "2026-01-01T00:00:00",
            "media": {
                "path": str(self.video),
                "name": self.video.name,
                "fingerprint": store.media_fingerprint(self.video),
                "info": {
                    "duration_ms": DURATION,
                    "fps": FPS,
                    "width": 640,
                    "height": 360,
                    "codec": "h264",
                    "has_audio": False,
                    "rotation": 0,
                    "bit_rate": None,
                },
            },
            "settings": DetectSettings().__dict__.copy(),
            "manual": {"add": [], "remove": []},
            "shots": [],
            "detection": {},
            "analysis": {},
        }
        store.save_analysis(
            self.project["media"]["fingerprint"],
            str(self.video),
            store.ensure_media(self.project),
            analysis_points(),
        )
        store.rebuild(self.project, save_project=True)

    def tearDown(self):
        os.environ.pop("SHOT_SHELF_HOME", None)
        self.tmp.cleanup()

    def starts(self):
        return [shot["start_ms"] for shot in self.project["shots"]]

    def test_initial_shots(self):
        self.assertEqual(self.starts(), [0, 3_000, 7_000])
        self.assertEqual(self.project["shots"][-1]["end_ms"], DURATION)

    def test_split_and_annotate(self):
        target = self.project["shots"][1]
        store.update_shot(self.project, target["id"], {"tags": ["B-roll"], "note": "海边"})
        result = store.split_shot(self.project, target["id"], 5_000)
        self.assertIn(5_000, self.starts())
        # The left half keeps the annotations; the new right half starts clean.
        left = next(s for s in self.project["shots"] if s["start_ms"] == 3_000)
        right = next(s for s in self.project["shots"] if s["start_ms"] == 5_000)
        self.assertEqual(left["tags"], ["B-roll"])
        self.assertEqual(left["note"], "海边")
        self.assertEqual(right["tags"], [])
        self.assertEqual(right["note"], "")

    def test_split_is_manual_override(self):
        target = self.project["shots"][0]
        store.split_shot(self.project, target["id"], 1_000)
        self.assertIn(1_000, self.project["manual"]["add"])
        # Re-detecting without manual overrides would drop it again.
        clone = json.loads(json.dumps(self.project))
        clone["manual"] = {"add": [], "remove": []}
        store.rebuild(clone)
        self.assertNotIn(1_000, [s["start_ms"] for s in clone["shots"]])

    def test_merge_removes_cut_and_unions_annotations(self):
        first, second = self.project["shots"][0], self.project["shots"][1]
        store.update_shot(self.project, first["id"], {"tags": ["A"], "note": "one"})
        store.update_shot(self.project, second["id"], {"tags": ["B"], "note": "two"})
        store.merge_shots(self.project, [first["id"], second["id"]])
        self.assertEqual(self.starts(), [0, 7_000])
        merged = self.project["shots"][0]
        self.assertEqual(merged["tags"], ["A", "B"])
        self.assertIn("one", merged["note"])
        self.assertIn("two", merged["note"])
        self.assertIn(3_000, self.project["manual"]["remove"])

    def test_merge_requires_adjacent(self):
        first = self.project["shots"][0]
        last = self.project["shots"][2]
        with self.assertRaises(store.StoreError):
            store.merge_shots(self.project, [first["id"], last["id"]])

    def test_move_boundary_updates_neighbour(self):
        first = self.project["shots"][0]
        store.update_shot(self.project, first["id"], {"end_ms": 4_000})
        self.assertEqual(self.starts(), [0, 4_000, 7_000])
        self.assertEqual(self.project["shots"][1]["start_ms"], 4_000)

    def test_move_boundary_keeps_annotations_in_place(self):
        first, second = self.project["shots"][0], self.project["shots"][1]
        store.update_shot(self.project, first["id"], {"tags": ["A"], "note": "left"})
        store.update_shot(self.project, second["id"], {"tags": ["B"], "note": "right"})
        store.update_shot(self.project, first["id"], {"end_ms": 4_000})
        self.assertEqual(self.project["shots"][0]["tags"], ["A"])
        self.assertEqual(self.project["shots"][0]["note"], "left")
        self.assertEqual(self.project["shots"][1]["tags"], ["B"])
        self.assertEqual(self.project["shots"][1]["note"], "right")

    def test_boundaries_cannot_cross(self):
        first = self.project["shots"][0]
        store.update_shot(self.project, first["id"], {"end_ms": 9_000})
        starts = self.starts()
        self.assertEqual(len(starts), 3)
        self.assertLess(starts[0], starts[1])
        self.assertLess(starts[1], starts[2])

    def test_remove_cut(self):
        cut = self.project["shots"][1]["end_ms"]
        store.remove_cut(self.project, cut)
        self.assertNotIn(7_000, self.starts())
        self.assertEqual(len(self.project["shots"]), 2)

    def test_remove_cut_keeps_annotations(self):
        first, second = self.project["shots"][0], self.project["shots"][1]
        store.update_shot(self.project, first["id"], {"tags": ["A"], "note": "one"})
        store.update_shot(self.project, second["id"], {"tags": ["B"]})
        store.remove_cut(self.project, 3_000)
        merged = self.project["shots"][0]
        self.assertEqual(sorted(merged["tags"]), ["A", "B"])
        self.assertIn("one", merged["note"])

    def test_reset_manual(self):
        store.split_shot(self.project, self.project["shots"][0]["id"], 1_000)
        store.reset_manual(self.project)
        self.assertEqual(self.starts(), [0, 3_000, 7_000])
        self.assertEqual(self.project["manual"], {"add": [], "remove": []})

    def test_tags_survive_sensitivity_change(self):
        shot = self.project["shots"][1]
        store.update_shot(self.project, shot["id"], {"tags": ["interview"]})
        store.rebuild(self.project, settings=DetectSettings(threshold=0.95))
        self.assertEqual(len(self.project["shots"]), 1)
        self.assertEqual(self.project["shots"][0]["tags"], ["interview"])

    def test_merge_on_redetect_unions_annotations(self):
        first, second = self.project["shots"][0], self.project["shots"][1]
        store.update_shot(self.project, first["id"], {"tags": ["A"], "note": "one"})
        store.update_shot(self.project, second["id"], {"tags": ["B"], "note": "two"})
        # Loosening the threshold below both cuts merges 0-3000 and 3000-7000.
        store.rebuild(self.project, settings=DetectSettings(threshold=0.95))
        merged = self.project["shots"][0]
        self.assertEqual(sorted(merged["tags"]), ["A", "B"])
        self.assertIn("one", merged["note"])
        self.assertIn("two", merged["note"])

    def test_split_on_redetect_keeps_single_copy(self):
        shot = self.project["shots"][1]
        store.update_shot(self.project, shot["id"], {"tags": ["keep"]})
        # Raising sensitivity should not duplicate the tag onto a neighbour.
        store.rebuild(self.project, settings=DetectSettings(threshold=0.05))
        tagged = [s for s in self.project["shots"] if s["tags"]]
        self.assertEqual(len(tagged), 1)
        self.assertEqual(tagged[0]["tags"], ["keep"])

    def test_split_tags_do_not_duplicate(self):
        shot = self.project["shots"][1]
        store.update_shot(self.project, shot["id"], {"tags": ["keep"], "note": "only once"})
        store.split_shot(self.project, shot["id"], 5_000)
        tagged = [s for s in self.project["shots"] if s["tags"]]
        self.assertEqual(len(tagged), 1)
        self.assertEqual(tagged[0]["tags"], ["keep"])
        self.assertEqual(tagged[0]["note"], "only once")

    def test_manual_boundary_evidence_is_retimed(self):
        shot = self.project["shots"][0]
        store.update_shot(self.project, shot["id"], {"end_ms": 4_000})
        boundaries = self.project["detection"]["boundaries"]
        self.assertTrue(any(abs(b["at_ms"] - 4_000) <= 2 for b in boundaries))
        self.assertFalse(any(abs(b["at_ms"] - 3_000) <= 2 and b.get("decision") != "merged" for b in boundaries))

    def test_cache_clear_keeps_projects(self):
        thumb_dir = store.thumbs_dir() / self.project["id"]
        thumb_dir.mkdir(parents=True, exist_ok=True)
        (thumb_dir / "x.jpg").write_bytes(b"jpg")
        store.clear_cache("all")
        self.assertFalse(thumb_dir.exists())
        self.assertTrue(store.project_path(self.project["id"]).exists())

    def test_list_projects(self):
        items = store.list_projects()
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["id"], self.project["id"])
        self.assertTrue(items[0]["media_exists"])

    def test_fingerprint_changes_with_file(self):
        before = store.media_fingerprint(self.video)
        self.video.write_bytes(b"different bytes")
        os.utime(self.video, None)
        self.assertNotEqual(before, store.media_fingerprint(self.video))

    def test_ensure_media_rejects_changed_source(self):
        self.video.write_bytes(b"a much longer replacement payload")
        os.utime(self.video, None)
        with self.assertRaises(store.StoreError):
            store.ensure_media(self.project)


if __name__ == "__main__":
    unittest.main()
