"""Tests for timecode parsing and detection rules (no ffmpeg needed)."""

from __future__ import annotations

import unittest

from shot_shelf import detect as D
from shot_shelf.timecode import (
    format_duration,
    format_tc_frames,
    frame_to_ms,
    ms_to_frame,
    ms_to_timecode,
    parse_timecode,
    snap_to_frame,
    timecode_to_ms,
)

FPS = 25
STEP = 40  # ms
DURATION = 24_000


def build_rows(segments):
    """Synthesise an evidence series from ``(start_ms, end_ms, luma, sat)``."""

    rows = []
    for t in range(0, DURATION, STEP):
        luma, sat = 90.0, 40.0
        for start, end, seg_luma, seg_sat in segments:
            if start <= t < end:
                luma, sat = seg_luma, seg_sat
                break
        rows.append([t, 0.002, luma, sat])
    return rows


def add_cut(rows, at_ms, score=0.9):
    for row in rows:
        if abs(row[0] - at_ms) <= STEP // 2:
            row[1] = max(row[1], score)


def add_flash(rows, start_ms, end_ms, luma=230.0, score=0.9):
    """Insert a short bright flash: strong cuts on both edges, bright interior."""

    for row in rows:
        if abs(row[0] - start_ms) <= STEP // 2 or abs(row[0] - end_ms) <= STEP // 2:
            row[1] = max(row[1], score)
        if start_ms <= row[0] < end_ms:
            row[2] = luma


def add_noise(rows, start_ms, end_ms, score):
    for row in rows:
        if start_ms <= row[0] < end_ms:
            row[1] = score


def add_ramp(rows, start_ms, end_ms, target_luma, score):
    span = max(1, end_ms - start_ms)
    for row in rows:
        if start_ms <= row[0] <= end_ms:
            ratio = (row[0] - start_ms) / span
            row[1] = score
            row[2] = 90.0 + (target_luma - 90.0) * ratio
        elif row[0] > end_ms:
            row[2] = target_luma


def as_tuples(rows):
    return [(int(t), float(score), float(luma), float(sat)) for t, score, luma, sat in rows]


class TimecodeTests(unittest.TestCase):
    def test_roundtrip(self):
        self.assertEqual(ms_to_timecode(3_723_456), "01:02:03.456")
        self.assertEqual(timecode_to_ms("01:02:03.456"), 3_723_456)

    def test_short_forms(self):
        self.assertEqual(timecode_to_ms("2:03"), 123_000)
        self.assertEqual(timecode_to_ms("12.5"), 12_500)

    def test_frames(self):
        self.assertEqual(parse_timecode("00:00:02:05", fps=25), 2_200)
        self.assertEqual(ms_to_frame(2_200, 25), 55)
        self.assertEqual(frame_to_ms(55, 25), 2_200)
        self.assertEqual(format_tc_frames(2_200, 25), "00:00:02:05")

    def test_snap(self):
        self.assertEqual(snap_to_frame(2_234, 25), 2_240)

    def test_duration(self):
        self.assertEqual(format_duration(7_500), "7.50s")
        self.assertEqual(format_duration(65_000), "1m 05s")

    def test_invalid(self):
        with self.assertRaises(ValueError):
            timecode_to_ms("not a timecode")


class DetectTests(unittest.TestCase):
    def test_hard_cuts(self):
        rows = build_rows([(0, 3_000, 90, 40), (3_000, 10_000, 150, 40), (10_000, DURATION, 60, 60)])
        add_cut(rows, 3_000)
        add_cut(rows, 10_000)
        result = D.detect(as_tuples(rows), fps=FPS, duration_ms=DURATION)
        starts = [shot["start_ms"] for shot in result.shots]
        self.assertIn(3_000, starts)
        self.assertIn(10_000, starts)
        self.assertEqual(len(result.shots), 3)

    def test_static_scene_has_no_cuts(self):
        rows = build_rows([(0, DURATION, 88, 40)])
        result = D.detect(as_tuples(rows), fps=FPS, duration_ms=DURATION)
        self.assertEqual(len(result.shots), 1)
        self.assertEqual(result.shots[0]["start_ms"], 0)
        self.assertEqual(result.shots[0]["end_ms"], DURATION)

    def test_slow_change_does_not_split(self):
        rows = build_rows([(0, 3_000, 90, 40), (3_000, 6_000, 150, 40), (6_000, DURATION, 150, 40)])
        add_cut(rows, 3_000)
        add_noise(rows, 6_000, 9_800, 0.02)  # continuous low-level drift
        result = D.detect(as_tuples(rows), fps=FPS, duration_ms=DURATION)
        starts = [shot["start_ms"] for shot in result.shots]
        self.assertEqual([s for s in starts if 6_000 < s < 9_800], [])

    def test_short_strong_shot_kept(self):
        rows = build_rows([
            (0, 12_000, 60, 40),
            (12_000, 12_600, 235, 30),
            (12_600, DURATION, 120, 45),
        ])
        add_cut(rows, 12_000)
        add_cut(rows, 12_600)
        result = D.detect(as_tuples(rows), fps=FPS, duration_ms=DURATION)
        starts = [shot["start_ms"] for shot in result.shots]
        self.assertIn(12_000, starts)
        self.assertIn(12_600, starts)
        short = next(s for s in result.shots if s["start_ms"] == 12_000)
        self.assertEqual(short["end_ms"] - short["start_ms"], 600)
        self.assertTrue(any(b["decision"] == "short-kept" for b in result.boundaries))

    def test_short_weak_shot_merged(self):
        rows = build_rows([
            (0, 12_000, 60, 40),
            (12_000, 12_300, 120, 40),
            (12_300, DURATION, 120, 40),
        ])
        add_cut(rows, 12_000, score=0.9)
        add_cut(rows, 12_300, score=0.30)  # weak exit cut
        result = D.detect(as_tuples(rows), fps=FPS, duration_ms=DURATION)
        starts = [shot["start_ms"] for shot in result.shots]
        self.assertNotIn(12_300, starts)

    def test_short_strong_shot_merged_when_disabled(self):
        rows = build_rows([
            (0, 12_000, 60, 40),
            (12_000, 12_600, 235, 30),
            (12_600, DURATION, 120, 45),
        ])
        add_cut(rows, 12_000)
        add_cut(rows, 12_600)
        settings = D.DetectSettings(keep_short_strong=False)
        result = D.detect(as_tuples(rows), settings, fps=FPS, duration_ms=DURATION)
        starts = [shot["start_ms"] for shot in result.shots]
        self.assertFalse(12_000 in starts and 12_600 in starts)

    def test_flash_merged(self):
        rows = build_rows([(0, DURATION, 90, 40)])
        add_flash(rows, 12_000, 12_120)
        result = D.detect(as_tuples(rows), fps=FPS, duration_ms=DURATION)
        starts = [shot["start_ms"] for shot in result.shots]
        self.assertNotIn(12_000, starts)
        self.assertNotIn(12_120, starts)
        self.assertGreaterEqual(result.summary["flash_merged"], 1)

    def test_gradual_transition(self):
        rows = build_rows([(0, DURATION, 90, 40)])
        add_ramp(rows, 19_000, 21_200, 220.0, 0.05)
        result = D.detect(as_tuples(rows), fps=FPS, duration_ms=DURATION)
        gradual = [b for b in result.boundaries if b["kind"] == "gradual"]
        self.assertTrue(gradual, "expected a gradual boundary")
        self.assertTrue(any(b["decision"] in {"kept", "short-kept"} for b in gradual))
        cut_times = [boundary["at_ms"] for boundary in result.boundaries if boundary["decision"] != "merged"]
        self.assertEqual(len(cut_times), 1, "a dissolve should be one boundary, not many")

    def test_similar_neighbours_merged(self):
        rows = build_rows([(0, 8_000, 90, 40), (8_000, 16_000, 94, 42), (16_000, DURATION, 60, 60)])
        add_cut(rows, 8_000, score=0.30)  # above sensitivity but weak
        add_cut(rows, 16_000, score=0.9)
        result = D.detect(as_tuples(rows), fps=FPS, duration_ms=DURATION)
        starts = [shot["start_ms"] for shot in result.shots]
        self.assertNotIn(8_000, starts)
        self.assertIn(16_000, starts)

    def test_removed_boundary(self):
        rows = build_rows([(0, 3_000, 90, 40), (3_000, 10_000, 150, 40), (10_000, DURATION, 60, 60)])
        add_cut(rows, 3_000)
        add_cut(rows, 10_000)
        result = D.detect(as_tuples(rows), fps=FPS, duration_ms=DURATION, removed_boundaries=[3_000])
        starts = [shot["start_ms"] for shot in result.shots]
        self.assertNotIn(3_000, starts)
        self.assertIn(10_000, starts)

    def test_manual_boundary_kept(self):
        rows = build_rows([(0, 3_000, 90, 40), (3_000, DURATION, 150, 40)])
        add_cut(rows, 3_000)
        result = D.detect(as_tuples(rows), fps=FPS, duration_ms=DURATION, extra_boundaries=[7_000])
        starts = [shot["start_ms"] for shot in result.shots]
        self.assertIn(7_000, starts)
        manual = [b for b in result.boundaries if b["source"] == "manual"]
        self.assertTrue(manual)
        self.assertEqual(manual[0]["confidence_label"], "手动")

    def test_shots_are_contiguous(self):
        rows = build_rows([(0, 3_000, 90, 40), (3_000, 10_000, 150, 40), (10_000, DURATION, 60, 60)])
        add_cut(rows, 3_000)
        add_cut(rows, 10_000)
        result = D.detect(as_tuples(rows), fps=FPS, duration_ms=DURATION)
        expected = 0
        for shot in result.shots:
            self.assertEqual(shot["start_ms"], expected)
            expected = shot["end_ms"]
        self.assertEqual(expected, DURATION)

    def test_empty_series(self):
        result = D.detect([], fps=FPS, duration_ms=DURATION)
        self.assertEqual(len(result.shots), 1)
        self.assertEqual(result.shots[0]["end_ms"], DURATION)

    def test_settings_are_normalised(self):
        settings = D.DetectSettings(threshold=2.0, strong_threshold=-1, min_shot_ms=1).normalized()
        self.assertLessEqual(settings.threshold, 0.95)
        self.assertGreaterEqual(settings.min_shot_ms, 100)
        self.assertGreaterEqual(settings.strong_threshold, settings.threshold)


if __name__ == "__main__":
    unittest.main()
