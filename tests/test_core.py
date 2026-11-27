import unittest

from masktool.core import box_at, build_issues, review_state
from masktool.render import render_frame


def target_with_keys():
    return {
        "id": "t1",
        "name": "测试牌",
        "shape": "rect",
        "color": "#fff",
        "keyframes": [
            {"id": "k1", "t": 0.0, "x": 0.1, "y": 0.1, "w": 0.2, "h": 0.1},
            {"id": "k2", "t": 1.0, "x": 0.3, "y": 0.2, "w": 0.3, "h": 0.2},
        ],
        "gaps": [],
    }


class CoreTests(unittest.TestCase):
    def test_linear_interpolation_between_two_keys(self):
        box = box_at(target_with_keys(), 0.5)
        self.assertAlmostEqual(box["x"], 0.2)
        self.assertAlmostEqual(box["y"], 0.15)
        self.assertAlmostEqual(box["w"], 0.25)
        self.assertAlmostEqual(box["h"], 0.15)
        self.assertEqual(box["mode"], "interpolate")

    def test_no_extrapolation_before_first_or_after_last_key(self):
        t = target_with_keys()
        self.assertIsNone(box_at(t, -0.5))
        self.assertIsNone(box_at(t, 1.5))

    def test_gap_forces_no_mask(self):
        t = target_with_keys()
        t["gaps"] = [{"id": "g", "start": 0.4, "end": 0.6}]
        self.assertIsNone(box_at(t, 0.5))

    def test_cross_gap_does_not_sweep(self):
        t = target_with_keys()
        t["keyframes"][1]["t"] = 2.0
        t["gaps"] = [{"id": "g", "start": 0.8, "end": 1.4}]
        before = box_at(t, 0.7)
        self.assertEqual(before["mode"], "hold-before-gap")
        self.assertAlmostEqual(before["x"], 0.1)
        after = box_at(t, 1.6)
        self.assertEqual(after["mode"], "hold-after-gap")
        self.assertAlmostEqual(after["x"], 0.3)
        self.assertIsNone(box_at(t, 1.0))

    def test_issues_cover_missing_edges_outside_and_gap(self):
        project = {
            "video": {"duration": 5},
            "settings": {"keyInterval": 1},
            "targets": [
                {
                    "id": "t",
                    "name": "越界牌",
                    "keyframes": [
                        {"id": "a", "t": 0.5, "x": -0.2, "y": 0, "w": 0.3, "h": 0.1},
                        {"id": "b", "t": 4.0, "x": 0.2, "y": 0.2, "w": 0.3, "h": 0.1},
                    ],
                    "gaps": [{"id": "g", "start": 1, "end": 1.4}],
                }
            ],
            "reviews": {},
        }
        issues = build_issues(project)
        kinds = " ".join(i["id"] for i in issues)
        self.assertIn("missing-prefix", kinds)
        self.assertIn("missing-suffix", kinds)
        self.assertIn("outside-key", kinds)
        self.assertIn("gap:", kinds)

    def test_review_becomes_stale_after_signature_changes(self):
        project = {"video": {"duration": 2}, "settings": {"keyInterval": 0.5}, "targets": [target_with_keys()], "reviews": {}}
        issue = next(i for i in build_issues(project) if i["id"].startswith("sparse-pair"))
        project["reviews"][issue["reviewId"]] = {"checked": True, "signature": issue["signature"]}
        self.assertFalse(review_state(project, issue)["stale"])
        project["targets"][0]["keyframes"][0]["x"] = 0.11
        changed = next(i for i in build_issues(project) if i["reviewId"] == issue["reviewId"])
        self.assertTrue(review_state(project, changed)["stale"])

    def test_render_frame_draws_only_active_mask(self):
        project = {"targets": [target_with_keys()]}
        active = render_frame(project, 0.5, 100, 100)
        self.assertTrue(any(active))
        project["targets"][0]["gaps"] = [{"start": 0.4, "end": 0.6}]
        inactive = render_frame(project, 0.5, 100, 100)
        self.assertFalse(any(inactive))


if __name__ == "__main__":
    unittest.main()
