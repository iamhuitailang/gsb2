"""End-to-end tests for the stitch checker.

Run with:  python3 -m unittest discover -s tests -v
Only the stdlib, numpy and the ffmpeg/ffprobe binaries are required.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import numpy as np

from audio_stitch_check.analysis import (
    SILENCE_FLOOR,
    estimate_priming,
    find_shift,
    find_silence_runs,
)
from audio_stitch_check.export import export_corrected
from audio_stitch_check.model import (
    Project,
    adjust_keep,
    analyze_project,
    build_tracks,
    create_project,
    undo,
)
from audio_stitch_check.padding import (
    TRUST_NONE,
    TRUST_PARTIAL,
    TRUST_RELIABLE,
    inspect_padding,
    parse_lame_tag,
)
from audio_stitch_check.samples import generate_all
from audio_stitch_check.wavio import read_wav, write_wav

SR = 48000


def _tone(n: int, freq: float = 440.0) -> np.ndarray:
    t = np.arange(n) / SR
    return (0.5 * np.sin(2 * np.pi * freq * t)).astype(np.float32)


class WavIOTests(unittest.TestCase):
    def test_roundtrip_depths(self):
        with tempfile.TemporaryDirectory() as td:
            x = _tone(1000)
            for depth in (16, 24, 32):
                p = Path(td) / f"x{depth}.wav"
                write_wav(p, x, SR, bit_depth=depth)
                back = read_wav(p)
                self.assertEqual(back.n_samples, 1000)
                self.assertEqual(back.sample_rate, SR)
                np.testing.assert_allclose(back.samples[:, 0], x, atol=4e-5)

    def test_stereo_roundtrip(self):
        with tempfile.TemporaryDirectory() as td:
            x = np.stack([_tone(500), _tone(500, 660)], axis=1)
            p = Path(td) / "st.wav"
            write_wav(p, x, SR)
            back = read_wav(p)
            self.assertEqual(back.channels, 2)
            self.assertEqual(back.samples.shape, (500, 2))


class PaddingTests(unittest.TestCase):
    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        self.wd = Path(self.td.name)
        self.src = self.wd / "src.wav"
        write_wav(self.src, _tone(SR), SR)

    def tearDown(self):
        self.td.cleanup()

    def _project(self, codec: str) -> Project:
        return create_project(self.src, self.wd / f"p_{codec}", [12000], codec)

    def test_mp3_padding_reliable_and_lame_tag(self):
        proj = self._project("mp3")
        for seg in proj.segments:
            self.assertEqual(seg.padding_trust, TRUST_RELIABLE)
            self.assertIsNotNone(seg.head_padding)
            self.assertIsNotNone(seg.tail_padding)
        enc = self.wd / "p_mp3" / "seg00.mp3"
        lame = parse_lame_tag(enc)
        # libmp3lame writes a real LAME extension with the 576 delay.
        self.assertIsNotNone(lame)
        self.assertEqual(lame[0], 576)
        info = inspect_padding(enc)
        self.assertEqual(info.head_padding, 1105)
        self.assertGreater(info.tail_padding, 0)

    def test_aac_partial_trust(self):
        proj = self._project("aac")
        for seg in proj.segments:
            self.assertEqual(seg.padding_trust, TRUST_PARTIAL)
            self.assertEqual(seg.head_padding, 1024)
            self.assertIsNone(seg.tail_padding)

    def test_adts_no_metadata_but_priming_estimated(self):
        proj = self._project("adts")
        for seg in proj.segments:
            self.assertEqual(seg.padding_trust, TRUST_NONE)
            self.assertIsNone(seg.head_padding)
            # Empirical estimate should land near the AAC priming of 1024.
            self.assertIsNotNone(seg.estimated_head_padding)
            self.assertAlmostEqual(seg.estimated_head_padding, 1024, delta=8)


class AnalysisTests(unittest.TestCase):
    def test_find_shift_basic_and_alias(self):
        ref = _tone(8000)
        shifted = np.concatenate([np.zeros(5), ref])[: len(ref)]
        shift, conf = find_shift(ref, shifted, 200, 4000, 4000)
        self.assertEqual(shift, 5)
        self.assertGreater(conf, 0.9)
        # Zero shift for identical content even on a periodic tone.
        shift0, _ = find_shift(ref, ref, 200, 4000, 4000)
        self.assertEqual(shift0, 0)

    def test_estimate_priming_impulsive(self):
        n = 20000
        x = np.zeros(n, dtype=np.float32)
        for p in (137, 900, 2500, 6100, 12345):
            x[p : p + 2] = 0.9
        priming = 1024
        dec = np.concatenate([np.zeros(priming), x, np.zeros(600)])
        est, conf = estimate_priming(x, dec)
        self.assertEqual(est, priming)
        self.assertGreater(conf, 0.9)

    def test_silence_runs_detect_source_silence(self):
        x = np.ones(1000, dtype=np.float32)
        x[400:500] = 0.0
        runs = find_silence_runs(x, SILENCE_FLOOR)
        self.assertEqual(runs, [(400, 500)])


class EndToEndTests(unittest.TestCase):
    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        self.root = Path(self.td.name)
        self.samples = generate_all(self.root / "samples", SR)

    def tearDown(self):
        self.td.cleanup()

    def _proj(self, sample_idx: int, codec: str) -> Project:
        s = self.samples[sample_idx]
        return create_project(
            s.wav_path,
            self.root / f"proj{sample_idx}_{codec}",
            s.cuts,
            codec,
        )

    def test_mp3_trimmed_is_sample_accurate(self):
        # mixed sample (index 2): tone + pulses + genuine silence block.
        proj = self._proj(2, "mp3")
        analysis = analyze_project(proj)
        trimmed = analysis["tracks"]["trimmed"]
        self.assertEqual(trimmed["delta_vs_reference"], 0)
        for seam in trimmed["seams"]:
            self.assertIn(
                seam["classification"], {"aligned", "source_silence"}
            )
            self.assertEqual(seam["measured_shift"], 0)

    def test_mp3_naive_shows_inserted_gaps(self):
        proj = self._proj(0, "mp3")  # sustained tone, no source silence
        analysis = analyze_project(proj)
        naive = analysis["tracks"]["naive"]
        self.assertGreater(naive["delta_vs_reference"], 0)
        for seam in naive["seams"]:
            self.assertEqual(seam["classification"], "silence_gap")
            self.assertGreaterEqual(seam["inserted_silence"], 1000)
            self.assertFalse(seam["source_was_silent"])

    def test_genuine_silence_not_miscounted_as_padding(self):
        proj = self._proj(2, "mp3")
        s = self.samples[2]
        # The cut at index 2 sits inside/next to the real silence block.
        analysis = analyze_project(proj)
        classes = [
            seam["classification"]
            for seam in analysis["tracks"]["trimmed"]["seams"]
        ]
        self.assertIn("source_silence", classes)
        gap_seams = [
            seam
            for seam in analysis["tracks"]["trimmed"]["seams"]
            if seam["classification"] == "silence_gap"
        ]
        self.assertEqual(gap_seams, [])
        # manifest silence ranges stay inside the reference unchanged
        ref = read_wav(self.root / "proj2_mp3" / "reference.wav")
        for a, b in s.silence_ranges:
            self.assertTrue(
                np.all(np.abs(ref.samples[a:b]) <= 1e-4)
            )

    def test_manual_trim_is_reported_as_drift_not_distortion(self):
        # Removing real samples at a segment end must surface as a timing
        # drift, never as an 'aligned' seam with mere codec distortion.
        proj = self._proj(0, "mp3")  # sustained tone
        seg = proj.segments[1]
        adjust_keep(proj, 1, keep_start=0, keep_end=seg.source_length - 30)
        analysis = analyze_project(proj)
        seam = analysis["tracks"]["corrected"]["seams"][1]
        self.assertNotIn(seam["classification"], {"aligned", "silence_gap"})
        self.assertEqual(analysis["tracks"]["corrected"]["delta_vs_reference"], -30)
        undo(proj)

    def test_adjust_undo_and_length_propagation(self):
        proj = self._proj(2, "mp3")
        _, _, before, _ = build_tracks(proj)
        before_len = before.length
        adjust_keep(proj, 1, keep_start=100, keep_end=5000)
        _, _, after, _ = build_tracks(proj)
        old_len = proj.segments[1].source_length
        self.assertEqual(after.length, before_len - (old_len - 4900))
        self.assertEqual(len(proj.undo_stack), 1)
        self.assertTrue(undo(proj))
        _, _, restored, _ = build_tracks(proj)
        self.assertEqual(restored.length, before_len)
        self.assertEqual(proj.undo_stack, [])
        self.assertFalse(undo(proj))

    def test_invalid_keep_range_rejected(self):
        proj = self._proj(0, "mp3")
        with self.assertRaises(ValueError):
            adjust_keep(proj, 0, keep_start=10, keep_end=5)
        with self.assertRaises(ValueError):
            adjust_keep(proj, 0, keep_start=0, keep_end=10**9)

    def test_export_checklist_readback(self):
        proj = self._proj(2, "mp3")
        adjust_keep(proj, 0, keep_start=20, keep_end=proj.segments[0].source_length - 20)
        out = self.root / "corrected.wav"
        checklist = export_corrected(proj, out)
        rb = checklist["readback_check"]
        self.assertTrue(rb["passed"])
        self.assertTrue(rb["length_match"])
        self.assertTrue(rb["channels_match"])
        # every seam points at a valid sample inside the exported file
        for seam in checklist["seams"]:
            self.assertLess(seam["sample_at_join"], rb["samples_found"])
        # the sidecar file exists and is valid JSON
        sidecar = out.with_suffix(".checklist.json")
        self.assertTrue(json.loads(sidecar.read_text())["readback_check"]["passed"])
        # every segment's first/last sample verified after round-trip
        for c in checklist["readback_check"]["boundary_sample_checks"]:
            self.assertTrue(c["first_sample_match"])
            self.assertTrue(c["last_sample_match"])

    def test_stereo_pipeline(self):
        proj = self._proj(3, "mp3")  # stereo mixed sample
        self.assertEqual(proj.channels, 2)
        analysis = analyze_project(proj)
        self.assertEqual(
            analysis["tracks"]["trimmed"]["delta_vs_reference"], 0
        )
        naive, trimmed, corrected, _ = build_tracks(proj)
        for tr in (naive, trimmed, corrected):
            self.assertEqual(tr.samples.shape[1], 2)

    def test_adts_downtrust_conclusions_are_flagged(self):
        proj = self._proj(0, "adts")
        analysis = analyze_project(proj)
        for track in analysis["tracks"].values():
            for seam in track["seams"]:
                self.assertEqual(seam["padding_trust"], TRUST_NONE)
                self.assertTrue(seam["trust_notes"])
        # warnings explain the fallback
        self.assertTrue(
            any("no padding metadata" in w for w in analysis["warnings"])
        )


if __name__ == "__main__":
    unittest.main()
