"""Automated checks for the flat-field inspector.

Run with ``python3 -m unittest discover -s tests -v`` from the repository root.
These tests are deliberately numeric: they compare the corrected output with
the synthetic scene the generator actually used, rather than just checking that
code runs.
"""

from __future__ import annotations

import json
import math
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from flatfield import core, tiffio  # noqa: E402


class SyntheticCorrectionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.spec = core.SampleSpec(width=200, height=150, channels=3, seed=11)
        cls.sample = core.make_synthetic_set(cls.spec)
        cls.group = cls.sample.group("测试组")
        cls.result = core.correct_image(
            cls.sample.science.array,
            cls.group,
            sensor_max=255.0,
            bit_depth=8,
        )

    def test_corner_gradient_is_reduced(self) -> None:
        corners = core.corner_gradient(self.sample.science.array, self.result.corrected)
        self.assertGreater(abs(corners["before_delta"]), 5.0)
        self.assertLess(abs(corners["after_delta"]), abs(corners["before_delta"]) * 0.25)

    def test_uniform_patch_variance_drops(self) -> None:
        stats = core.uniform_region_stats(
            self.sample.science.array, self.result.corrected, self.sample.uniform_rect
        )
        self.assertGreater(stats["std_reduction"], 0.7)
        self.assertGreater(stats["span_reduction"], 0.5)

    def test_gain_map_is_close_to_truth(self) -> None:
        diag = self.result.diagnostics
        self.assertIsNotNone(diag)
        mask = ~diag.invalid_mask
        expected = self.sample.truth_gain
        expected = expected / expected[mask].mean()
        actual = self.result.gain
        actual = actual / actual[mask].mean()
        error = np.abs(actual[mask] - expected[mask])
        self.assertLess(float(np.mean(error)), 0.05)

    def test_reference_defects_are_flagged(self) -> None:
        diag = self.result.diagnostics
        self.assertIsNotNone(diag)
        # Two hard-zero dead pixels and a saturated patch were planted per frame.
        self.assertGreaterEqual(int(diag.dead_mask.any(axis=2).sum() if diag.dead_mask.ndim == 3 else diag.dead_mask.sum()), 2)
        self.assertGreater(int(diag.saturated_mask.sum()), 0)

    def test_gain_has_no_nans_and_is_bounded(self) -> None:
        self.assertTrue(np.all(np.isfinite(self.result.gain)))
        self.assertGreaterEqual(float(self.result.gain.min()), 0.05)
        self.assertLessEqual(float(self.result.gain.max()), 10.0)


class PointSampleTests(unittest.TestCase):
    def test_sample_reports_every_stage(self) -> None:
        sample = core.make_synthetic_set(core.SampleSpec(width=120, height=90, seed=3))
        result = core.correct_image(
            sample.science.array, sample.group(), sensor_max=255.0, bit_depth=8
        )
        point = core.sample_point(result, 10, 10, channel_names=("R", "G", "B"))
        self.assertEqual(len(point.original), 3)
        self.assertEqual(len(point.dark), 3)
        self.assertEqual(len(point.flat), 3)
        self.assertEqual(len(point.gain), 3)
        # Model identity: result ≈ (raw - dark) / gain where not guarded.
        if not point.guarded:
            for raw, dark, gain, corrected in zip(
                point.original, point.dark, point.gain, point.corrected
            ):
                self.assertAlmostEqual((raw - dark) / gain, corrected, places=4)

    def test_channel_names_come_from_meta(self) -> None:
        sample = core.make_synthetic_set(core.SampleSpec(width=40, height=30, seed=1))
        result = core.correct_image(
            sample.science.array, sample.group(), sensor_max=255.0, bit_depth=8
        )
        point = core.sample_point(result, 1, 1, channel_names=sample.science.meta.channel_names)
        self.assertEqual(point.channel_names, ("R", "G", "B"))


class ReferenceMatchingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.sample = core.make_synthetic_set(core.SampleSpec(width=64, height=48, seed=5))
        self.library = core.ReferenceLibrary()
        self.library.create_group("匹配组", self.sample.darks, self.sample.flats)

    def test_mismatched_exposure_is_refused_with_reason(self) -> None:
        other = core.make_synthetic_set(
            core.SampleSpec(width=64, height=48, exposure_ev=-1.0, seed=6)
        )
        reasons = self.library.groups["匹配组"].key.mismatch(
            core.ReferenceKey.from_meta(other.science.meta)
        )
        self.assertTrue(any("曝光档" in r for r in reasons))
        with self.assertRaises(core.ReferenceError) as ctx:
            self.library.resolve(other.science.meta, "匹配组")
        self.assertTrue(ctx.exception.reasons)

    def test_mismatched_size_and_channels_are_refused(self) -> None:
        other = core.make_synthetic_set(
            core.SampleSpec(width=80, height=48, channels=1, seed=6)
        )
        rows = self.library.availability(other.science.meta)
        self.assertTrue(rows)
        row = rows[0]
        self.assertFalse(row.usable)
        joined = " ".join(row.reasons)
        self.assertIn("尺寸", joined)
        self.assertIn("通道", joined)

    def test_auto_resolve_refuses_ambiguity(self) -> None:
        self.library.create_group("重复组", self.sample.darks, self.sample.flats)
        group, reasons = self.library.auto_resolve(self.sample.science.meta)
        self.assertIsNone(group)
        self.assertTrue(any("多个" in r for r in reasons))

    def test_group_creation_rejects_mixed_configs(self) -> None:
        other = core.make_synthetic_set(
            core.SampleSpec(width=64, height=48, exposure_ev=2.0, seed=9)
        )
        with self.assertRaises(core.ReferenceError):
            core.ReferenceLibrary().create_group(
                "混合", self.sample.darks, other.flats
            )

    def test_single_frame_references_are_supported(self) -> None:
        library = core.ReferenceLibrary()
        group = library.create_group(
            "单帧", self.sample.darks[:1], self.sample.flats[:1]
        )
        result = core.correct_image(
            self.sample.science.array, group, sensor_max=255.0, bit_depth=8
        )
        self.assertTrue(np.all(np.isfinite(result.corrected)))
        self.assertLess(
            abs(core.corner_gradient(self.sample.science.array, result.corrected)["after_delta"]),
            abs(core.corner_gradient(self.sample.science.array, result.corrected)["before_delta"]),
        )


class GuardAndNearZeroTests(unittest.TestCase):
    def test_near_zero_flat_does_not_clip_whole_image(self) -> None:
        sample = core.make_synthetic_set(core.SampleSpec(width=60, height=40, seed=2))
        group = sample.group()
        # Replace flats with a near-zero reference.
        zero_flat = core._synthetic_loaded(
            np.full((40, 60, 3), 0.2), "zero_flat.png", core.SampleSpec(channels=3), 3
        )
        group.flats = [zero_flat]
        result = core.correct_image(sample.science.array, group, sensor_max=255.0, bit_depth=8)
        self.assertTrue(np.all(np.isfinite(result.corrected)))
        # No giant amplification and no frame-wide clipping to white.
        self.assertLessEqual(float(np.max(result.corrected)), float(np.max(sample.science.array)) + 1e-6)
        self.assertLess(float(np.mean(result.corrected >= 254.0)), 0.02)

    def test_bright_scene_is_not_forced_to_white(self) -> None:
        spec = core.SampleSpec(
            width=64, height=48, scene_level=235.0, bright_level=248.0, seed=4
        )
        sample = core.make_synthetic_set(spec)
        result = core.correct_image(
            sample.science.array, sample.group(), sensor_max=255.0, bit_depth=8
        )
        # The correction must not turn the frame into a white plate, and it
        # must never produce values beyond the sensor's own maximum.
        self.assertLessEqual(float(np.max(result.corrected)), 255.0 + 1e-6)
        self.assertLess(float(np.mean(result.corrected >= 255.0)), 0.5)
        self.assertTrue(np.all(np.isfinite(result.corrected)))

    def test_overflow_guard_flags_pixels(self) -> None:
        spec = core.SampleSpec(width=64, height=48, seed=12)
        sample = core.make_synthetic_set(spec)
        # A strongly tilted flat: gain falls to ~0.15 on the right, so dividing
        # there would push the scene well past the sensor range.
        ramp = np.linspace(255.0, 25.0, spec.width)[None, :, None]
        flat = np.broadcast_to(ramp, sample.flats[0].array.shape).copy()
        flat_img = core._synthetic_loaded(flat, "tilted_flat.png", spec, 3)
        group = sample.group()
        group.flats = [flat_img]
        result = core.correct_image(
            sample.science.array, group, sensor_max=255.0, bit_depth=8
        )
        self.assertTrue(result.guard_mask.any())
        self.assertLessEqual(float(np.max(result.corrected)), 255.0 + 1e-6)
        # Guarded pixels keep the dark-subtracted value rather than pure white.
        guarded = result.guard_mask
        self.assertTrue(np.allclose(result.corrected[guarded], result.after_dark[guarded]))

    def test_dark_only_and_flat_only_partial_groups(self) -> None:
        sample = core.make_synthetic_set(core.SampleSpec(width=48, height=36, seed=8))
        dark_only = core.ReferenceGroup(
            "only-dark", core.ReferenceKey.from_meta(sample.darks[0].meta),
            darks=[sample.darks[0]],
        )
        result = core.correct_image(sample.science.array, dark_only, sensor_max=255.0)
        self.assertIsNotNone(result.dark_used)
        self.assertIsNone(result.flat_used)
        self.assertTrue(np.allclose(result.corrected, result.after_dark))


class TiffRoundTripTests(unittest.TestCase):
    def test_write_read_16bit_rgb(self) -> None:
        arr = np.arange(3 * 4 * 3, dtype=np.uint16).reshape(3, 4, 3) * 100
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "test.tif"
            tiffio.write_tiff(path, arr, bits=16)
            back, bits = tiffio.read_tiff(path)
            self.assertEqual(bits, 16)
            np.testing.assert_array_equal(back, arr)

    def test_write_read_16bit_gray(self) -> None:
        arr = np.arange(20, dtype=np.uint16).reshape(4, 5) * 1000
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "gray.tif"
            tiffio.write_tiff(path, arr, bits=16)
            back, bits = tiffio.read_tiff(path)
            np.testing.assert_array_equal(back, arr)

    def test_load_image_preserves_16bit_values(self) -> None:
        arr = np.array([[[0, 1000, 60000]]], dtype=np.uint16)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "deep.tif"
            tiffio.write_tiff(path, arr, bits=16)
            loaded = core.load_image(path)
            np.testing.assert_array_equal(loaded.array, arr.astype(np.float64))
            self.assertEqual(loaded.meta.bit_depth, 16)


class ExportTests(unittest.TestCase):
    def test_batch_export_and_readback(self) -> None:
        sample = core.make_synthetic_set(core.SampleSpec(width=80, height=60, seed=10))
        library = core.ReferenceLibrary()
        library.create_group("导出组", sample.darks, sample.flats)
        job = core.ExportJob(image=sample.science)
        with tempfile.TemporaryDirectory() as tmp:
            manifest = core.export_batch([job], library, tmp)
            self.assertEqual(len(manifest.records), 1)
            self.assertEqual(manifest.errors, [])
            record = manifest.records[0]
            self.assertTrue(record.verified)
            self.assertLess(
                record.readback_max_abs_error, 0.5 / record.store_scale + 1e-9
            )
            self.assertTrue(Path(record.output_path).exists())
            self.assertTrue((Path(tmp) / "flatfield_manifest.json").exists())
            self.assertLess(
                abs(record.corner_after_delta), abs(record.corner_before_delta)
            )
            payload = json.loads((Path(tmp) / "flatfield_manifest.json").read_text())
            self.assertEqual(payload["records"][0]["reference_group"], "导出组")

    def test_export_skips_unmatched_image_with_reason(self) -> None:
        sample = core.make_synthetic_set(core.SampleSpec(width=80, height=60, seed=10))
        library = core.ReferenceLibrary()
        library.create_group("原始组", sample.darks, sample.flats)
        other = core.make_synthetic_set(
            core.SampleSpec(width=80, height=60, exposure_ev=-2.0, seed=13)
        )
        with tempfile.TemporaryDirectory() as tmp:
            manifest = core.export_batch([core.ExportJob(image=other.science)], library, tmp)
            self.assertEqual(manifest.records, [])
            self.assertTrue(manifest.errors)
            self.assertIn("曝光档", manifest.errors[0])

    def test_export_respects_explicit_group_choice(self) -> None:
        sample = core.make_synthetic_set(core.SampleSpec(width=80, height=60, seed=10))
        library = core.ReferenceLibrary()
        library.create_group("A组", sample.darks, sample.flats)
        library.create_group("B组", sample.darks, sample.flats)
        with tempfile.TemporaryDirectory() as tmp:
            manifest = core.export_batch(
                [core.ExportJob(image=sample.science, group_name="B组")], library, tmp
            )
            self.assertEqual(len(manifest.records), 1)
            self.assertEqual(manifest.records[0].group_name, "B组")


class ExposureMetadataTests(unittest.TestCase):
    def test_filename_ev_parsing(self) -> None:
        self.assertEqual(core.parse_exposure_from_name("flat_ev-1.5.png"), -1.5)
        self.assertEqual(core.parse_exposure_from_name("science_EV+2.png"), 2.0)
        self.assertIsNone(core.parse_exposure_from_name("science.png"))
        self.assertIsNone(core.parse_exposure_from_name("never.png"))

    def test_png_ev_text_chunk(self) -> None:
        from PIL import PngImagePlugin

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "frame.png"
            info = PngImagePlugin.PngInfo()
            info.add_text("exposure_ev", "-0.7")
            Image.fromarray(np.zeros((4, 4), dtype=np.uint8)).save(path, pnginfo=info)
            self.assertEqual(core.infer_exposure(path), -0.7)


class SyntheticValidationTests(unittest.TestCase):
    def test_report_quantifies_improvement(self) -> None:
        report = core.synthetic_validation(core.SampleSpec(width=120, height=90, seed=21))
        self.assertGreater(report["uniform_std_reduction"], 0.7)
        self.assertGreater(report["corner_delta_reduction"], 1.0)
        self.assertLess(
            report["mean_abs_error_to_truth_after"],
            report["mean_abs_error_to_truth_before"],
        )
        self.assertGreater(report["flat_dead_pixels"], 0)
        self.assertGreater(report["flat_saturated_pixels"], 0)


if __name__ == "__main__":
    unittest.main()
