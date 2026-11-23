"""比对与核验逻辑测试：用临时目录里的假分段文件模拟缺失/损坏/漂移。"""

import json
import unittest
from pathlib import Path

from sebalign.compare import compare_tiers
from sebalign.verify import verify_workspace

FPS = 10.0


def seg_dict(tier, seq, start, end, openable=True):
    return {
        "seq": seq,
        "file": f"{tier}/seg_{seq:03d}.mp4",
        "source_start": float(start),
        "source_end": float(end),
        "planned_duration": end - start,
        "actual_duration": end - start,
        "start_clip_index": 0,
        "start_frame_index": int(start * FPS),
        "frame_label": f"src1/f{int(start * FPS):03d}",
        "global_frame": int(start * FPS),
        "first_frame_hash": "deadbeef",
        "thumb": None,
        "openable": openable,
        "error": None,
    }


def manifest(tmp: Path, low_cuts, high_cuts, high_closed_index=None):
    tiers = []
    for name, cuts in (("low", low_cuts), ("high", high_cuts)):
        segs = [seg_dict(name, i, a, b) for i, (a, b) in enumerate(zip(cuts, cuts[1:]))]
        tiers.append({"name": name, "width": 1, "height": 1, "fps": FPS,
                      "cutpoints_effective": cuts, "segments": segs})
    m = {
        "schema_version": "sebalign-manifest-v1",
        "source_fps": FPS,
        "source_duration": float(low_cuts[-1]),
        "tiers": tiers,
        "audio_track": None,
        "markers": {},
    }
    (tmp / "manifest.json").write_text(json.dumps(m), encoding="utf-8")
    for tier in tiers:
        d = tmp / tier["name"]
        d.mkdir(parents=True, exist_ok=True)
        for s in tier["segments"]:
            (tmp / s["file"]).write_bytes(b"not-a-real-video")
    if high_closed_index is not None:
        (tmp / tiers[1]["segments"][high_closed_index]["file"]).unlink()
    return m


class CompareTest(unittest.TestCase):
    def setUp(self):
        # 假文件无法被 ffprobe 打开，所以 compare 的可读性检查会全部标 unreadable；
        # 为隔离“边界比对”逻辑，这里直接构造后把 openable 检查绕过：
        # 用 monkeypatch 替换 _readable。
        import sebalign.compare as cmp_mod
        self._orig = cmp_mod._readable
        cmp_mod._readable = lambda root, rel: (Path(root) / rel).exists()

    def tearDown(self):
        import sebalign.compare as cmp_mod
        cmp_mod._readable = self._orig

    def test_aligned_tiers_no_boundary_issue(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            m = manifest(tmp, [0, 2, 4, 6], [0, 2, 4, 6])
            report = compare_tiers(tmp, m)
            kinds = {i.kind for i in report.issues}
            self.assertNotIn("boundary_mismatch", kinds)
            self.assertTrue(all(b.aligned for b in report.boundaries))

    def test_misaligned_cutpoints_flagged(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            m = manifest(tmp, [0, 3, 6, 9], [0, 2.5, 5, 7.5, 9])
            report = compare_tiers(tmp, m)
            self.assertTrue(any(i.kind == "boundary_mismatch" for i in report.issues))

    def test_missing_file_flagged_unreadable(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            m = manifest(tmp, [0, 3, 6, 9], [0, 3, 6, 9], high_closed_index=1)
            report = compare_tiers(tmp, m)
            self.assertTrue(any(i.kind == "unreadable" for i in report.issues))

    def test_coverage_gap_detected(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            # low 故意缺 3-6 的覆盖
            m = manifest(tmp, [0, 3, 6, 9], [0, 3, 6, 9])
            m["tiers"][0]["segments"] = [
                s for s in m["tiers"][0]["segments"] if s["seq"] != 1
            ]
            import sebalign.compare as cmp_mod
            report = cmp_mod.compare_tiers(tmp, m)
            self.assertTrue(any(i.kind == "missing_segment" for i in report.issues))


class VerifyTest(unittest.TestCase):
    def test_missing_file_reported_as_missing(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            m = manifest(tmp, [0, 2, 4], [0, 2, 4])
            (tmp / m["tiers"][0]["segments"][0]["file"]).unlink()
            report = verify_workspace(tmp, m)
            statuses = {c.file: c.status for c in report.checks}
            self.assertEqual(statuses[m["tiers"][0]["segments"][0]["file"]], "missing")
            self.assertTrue(report.has_errors)


if __name__ == "__main__":
    unittest.main()
