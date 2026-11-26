import json
import tempfile
import unittest
from array import array
from pathlib import Path

from wav_tool import core


class CoreContinuityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.source = self.root / "tone.wav"
        self.rate = 22050
        self.frames = 500
        samples = array("h")
        for i in range(self.frames):
            samples.append(i % 300)          # L
            samples.append(1000 + i % 300)   # R
        core.write_wav_from_raw_chunks(
            self.source,
            channels=2,
            sample_rate=self.rate,
            sample_width=2,
            total_frames=self.frames,
            chunks=[samples.tobytes()],
        )
        self.cut_frames = [100, 250, 400]
        self.cuts = [{"frame": f} for f in self.cut_frames]
        self.export_dir = self.root / "split"
        self.manifest = core.split_wav(self.source, self.export_dir, cuts=self.cuts)

    def tearDown(self):
        self.tmp.cleanup()

    def test_cut_rounding_reports_actual_sample(self):
        cuts = core.plan_custom_cuts(1000, 1000, ["0.1234", "0.1236"], "seconds")
        self.assertEqual([c["frame"] for c in cuts], [123, 124])
        self.assertAlmostEqual(cuts[0]["delta_frames"], -0.4)
        self.assertAlmostEqual(cuts[1]["delta_frames"], 0.4)

        with self.assertRaises(core.CutError):
            core.plan_custom_cuts(1000, 1000, ["1000"], "frames")

    def test_segments_are_frame_exact_without_overlap_or_gap(self):
        segs = self.manifest["segments"]
        self.assertEqual([(s["start_frame"], s["end_frame"]) for s in segs], [
            (0, 100), (100, 250), (250, 400), (400, 500)
        ])
        for prev, nxt in zip(segs, segs[1:]):
            self.assertEqual(prev["end_frame"], nxt["start_frame"])

        source_raw = self.source.read_bytes()[44:]  # standard 16-bit stereo header
        concatenated = b"".join((self.export_dir / s["file"]).read_bytes()[44:] for s in segs)
        self.assertEqual(concatenated, source_raw)
        self.assertEqual(len(concatenated), self.frames * 2 * 2)

    def test_manifest_verification_and_restore_exact(self):
        assignments = core.default_assignments_from_manifest_dir(
            self.manifest, self.export_dir / "manifest.json"
        )
        report = core.verify_assignments(self.manifest, assignments)
        self.assertTrue(report["sample_complete"])
        self.assertEqual(report["counts"]["missing"], 0)

        restored = self.root / "restored.wav"
        core.write_assembly(restored, self.manifest, assignments, report, partial=False)
        comparison = core.compare_wavs(self.source, restored)
        self.assertTrue(comparison["identical_sample_data"], comparison)

    def test_missing_segment_locates_exact_range_and_compare_diffs(self):
        assignments = core.default_assignments_from_manifest_dir(
            self.manifest, self.export_dir / "manifest.json"
        )
        assignments[1] = None
        report = core.verify_assignments(self.manifest, assignments, {1: None})
        self.assertFalse(report["complete"])
        self.assertEqual(report["counts"]["missing"], 1)
        problem = report["problems"][0]
        self.assertEqual(problem["index"], 1)
        self.assertEqual((problem["range"]["start_frame"], problem["range"]["end_frame"]), (100, 250))

        partial = self.root / "partial.wav"
        core.write_assembly(partial, self.manifest, assignments, report, partial=True)
        cmp = core.compare_wavs(self.source, partial)
        self.assertFalse(cmp["identical_sample_data"])
        for ch in cmp["channels_report"]:
            self.assertFalse(ch["identical"])
            self.assertEqual(ch["difference_ranges"][0]["start_frame"], 100)
            self.assertEqual(ch["difference_ranges"][0]["end_frame"], 250)

    def test_swapped_segments_are_identified_to_true_ranges(self):
        assignments = core.default_assignments_from_manifest_dir(
            self.manifest, self.export_dir / "manifest.json"
        )
        names = {i: p.name for i, p in assignments.items()}
        assignments[0], assignments[1] = assignments[1], assignments[0]
        names[0], names[1] = names[1], names[0]

        report = core.verify_assignments(self.manifest, assignments, names)
        self.assertFalse(report["sample_complete"])
        r0 = report["segments"][0]
        self.assertEqual(r0["status"], "swapped")
        self.assertEqual(r0["identity_segment_index"], 1)
        self.assertTrue(r0["reciprocal_swap"])
        self.assertTrue(report["corrected_assembly_possible"])

        corrected = self.root / "corrected.wav"
        core.write_assembly(corrected, self.manifest, assignments, report, partial=True)
        cmp = core.compare_wavs(self.source, corrected)
        self.assertTrue(cmp["identical_sample_data"], cmp)

    def test_same_name_replacement_is_flagged(self):
        replacement = self.root / "segment_002.wav"
        core._create_replacement_wav(replacement, 150, sample_rate=self.rate)
        report = core.verify_assignments(
            self.manifest,
            {1: replacement},
            {1: "segment_002.wav"},
        )
        self.assertEqual(report["segments"][1]["status"], "same_name_replaced")
        self.assertFalse(report["complete"])

    def test_original_file_is_never_rewritten(self):
        before = core.sha256_file(self.source)
        restored = self.root / "again.wav"
        assignments = core.default_assignments_from_manifest_dir(
            self.manifest, self.export_dir / "manifest.json"
        )
        report = core.verify_assignments(self.manifest, assignments)
        core.write_assembly(restored, self.manifest, assignments, report)
        core.compare_wavs(self.source, restored)
        after = core.sha256_file(self.source)
        self.assertEqual(before, after)

    def test_compare_reports_exact_channel_sample_position(self):
        reader = core.WavReader(self.source)
        raw = bytearray(reader.read_raw_range())
        target_frame = 300
        channel = 1
        offset = (target_frame * 2 + channel) * 2
        raw[offset] ^= 0x01  # small but real LSB change

        modified = self.root / "modified.wav"
        core.write_wav_from_raw_chunks(
            modified,
            channels=2,
            sample_rate=self.rate,
            sample_width=2,
            total_frames=self.frames,
            chunks=[bytes(raw)],
        )
        cmp = core.compare_wavs(self.source, modified)
        self.assertFalse(cmp["identical_sample_data"])
        lch, rch = cmp["channels_report"]
        self.assertTrue(lch["identical"])
        self.assertFalse(rch["identical"])
        self.assertEqual(rch["difference_count"], 1)
        self.assertEqual(rch["first_difference"]["frame"], target_frame)
        self.assertEqual(rch["difference_ranges"][0]["start_frame"], target_frame)
        self.assertEqual(rch["difference_ranges"][0]["end_frame"], target_frame + 1)


class DemoTests(unittest.TestCase):
    def test_demo_pulses_are_exactly_on_cuts_and_channels_differ(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            wav = root / "demo.wav"
            demo = core.create_demo_wav(wav)
            reader = core.WavReader(wav)
            self.assertEqual(reader.info.channels, 2)
            raw = reader.read_raw_range()
            samples = core.decode_interleaved(raw, reader.info)
            for f in demo["pulse_frames"]:
                self.assertEqual(samples[f * 2], 32767)
                self.assertEqual(samples[f * 2 + 1], -32768)

            result_normal = core.make_demo_workspace(root / "normal", "normal")
            self.assertTrue(result_normal["verification"]["sample_complete"])
            self.assertTrue(result_normal["comparison_partial"]["identical_sample_data"])

            result_missing = core.make_demo_workspace(root / "missing", "missing")
            self.assertFalse(result_missing["verification"]["sample_complete"])
            self.assertEqual(result_missing["verification"]["counts"]["missing"], 1)
            self.assertFalse(result_missing["comparison_partial"]["identical_sample_data"])

            result_swap = core.make_demo_workspace(root / "swap", "swap")
            self.assertGreaterEqual(result_swap["verification"]["counts"]["swapped"], 1)
            self.assertTrue(result_swap["comparison_partial"]["identical_sample_data"])

            result_bad = core.make_demo_workspace(root / "bad", "same_name_replaced")
            self.assertEqual(
                result_bad["verification"]["segments"][1]["status"],
                "same_name_replaced",
            )


if __name__ == "__main__":
    unittest.main()
