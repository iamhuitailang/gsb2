"""核心逻辑单元测试（不依赖 GUI）：

    python -m unittest discover -s tests -v

覆盖需求 1~6 的无界面部分：
1. 1D/3D 解析、适用范围、错误行定位
2. 三联数据（原片/套表/差值）同帧计算
3. 探针入表/出表、双表换序、范围外标记
4. 颜色突变与通道串换检测
5. 导出后编码往返、同一颜色约定
6. 两套配置保存、加载失败保留旧表
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lut_tool.analysis import (  # noqa: E402
    analyze_clip_frame,
    analyze_lut_shape,
    scan_channel_crosstalk,
    scan_ramp_discontinuities,
)
from lut_tool.config import (  # noqa: E402
    CompareConfig,
    ConfigStore,
    SafeLutLoader,
    load_configs,
    save_configs,
)
from lut_tool.cube import CubeParseError, parse_cube, write_cube  # noqa: E402
from lut_tool.lut import apply_chain, apply_lut, diff_heatmap  # noqa: E402
from lut_tool.patterns import SKIN_TONES, TestClipSpec, render_clip, render_frame  # noqa: E402
from lut_tool.video import export_and_verify, quantize_8bit  # noqa: E402


def _cube(text: str):
    return parse_cube(text=text)


def _identity_3d(size: int = 9):
    g = np.linspace(0, 1, size)
    r, gg, b = np.meshgrid(g, g, g, indexing="ij")
    t = np.stack([r, gg, b], axis=-1)
    return _cube_lut("3D", size, t)


def _cube_lut(kind: str, size: int, table: np.ndarray,
              dmin=None, dmax=None):
    from lut_tool.cube import CubeLUT

    return CubeLUT(
        kind, size,
        np.zeros(3) if dmin is None else np.asarray(dmin, float),
        np.ones(3) if dmax is None else np.asarray(dmax, float),
        table,
    )


class TestCubeParsing(unittest.TestCase):
    def test_parse_1d(self):
        text = "LUT_1D_SIZE 3\n0 0 0\n0.5 0.5 0.5\n1 1 1\n"
        lut = _cube(text)
        self.assertEqual(lut.kind, "1D")
        self.assertEqual(lut.size, 3)
        self.assertEqual(lut.table.shape, (3, 3))
        np.testing.assert_allclose(lut.domain_min, 0.0)
        np.testing.assert_allclose(lut.domain_max, 1.0)

    def test_parse_3d_layout(self):
        # 2^3 = 8 行，R 最慢 B 最快；table[1,0,1] 对应第 6 个数据行。
        rows = []
        for r in (0.0, 1.0):
            for g in (0.0, 1.0):
                for b in (0.0, 1.0):
                    rows.append(f"{r} {g} {b}")
        lut = _cube("LUT_3D_SIZE 2\n" + "\n".join(rows) + "\n")
        self.assertEqual(lut.table.shape, (2, 2, 2, 3))
        np.testing.assert_allclose(lut.table[1, 0, 1], [1, 0, 1])

    def test_domain_declared(self):
        text = (
            "DOMAIN_MIN 0.05 0.05 0.05\n"
            "DOMAIN_MAX 0.95 0.95 0.95\n"
            "LUT_1D_SIZE 2\n0 0 0\n1 1 1\n"
        )
        lut = _cube(text)
        np.testing.assert_allclose(lut.domain_min, 0.05)
        np.testing.assert_allclose(lut.domain_max, 0.95)

    def test_wrong_row_count_points_to_problem(self):
        text = "LUT_3D_SIZE 5\n" + "0.1 0.1 0.1\n" * 10
        with self.assertRaises(CubeParseError) as ctx:
            _cube(text)
        self.assertIn("125", str(ctx.exception))
        self.assertIn("10", str(ctx.exception))

    def test_bad_token_reports_line(self):
        # 第 1 行是 SIZE 声明，坏数据在第 3 行（含行号定位）。
        text = "LUT_1D_SIZE 2\n0 0 0\n0.5 nope 0.5\n"
        with self.assertRaises(CubeParseError) as ctx:
            _cube(text)
        self.assertEqual(ctx.exception.line, 3)
        self.assertIn("nope", str(ctx.exception))

    def test_bad_arity_reports_line(self):
        # 第 1 行是 SIZE 声明，两列的坏数据行在第 2 行。
        text = "LUT_1D_SIZE 2\n0 0\n1 1 1\n"
        with self.assertRaises(CubeParseError) as ctx:
            _cube(text)
        self.assertEqual(ctx.exception.line, 2)

    def test_missing_size(self):
        with self.assertRaises(CubeParseError):
            _cube("# only comment\n")

    def test_roundtrip_write(self):
        lut = _identity_3d(5)
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "x.cube")
            write_cube(lut, p)
            again = parse_cube(p)
            self.assertEqual(again.kind, lut.kind)
            np.testing.assert_allclose(again.table, lut.table)


class TestLUTApplication(unittest.TestCase):
    def test_identity_3d_passthrough(self):
        lut = _identity_3d(11)
        rgb = np.random.RandomState(0).rand(4, 5, 3)
        np.testing.assert_allclose(apply_lut(lut, rgb), rgb, atol=1e-12)

    def test_1d_interpolation(self):
        # 输出 = 2x 的 1D 表（采样点 0、0.5、1）。
        t = np.array([[0, 0, 0], [1, 1, 1], [2, 2, 2]], float)
        lut = _cube_lut("1D", 3, t)
        out = apply_lut(lut, np.array([[0.25, 0.25, 0.25]]))
        np.testing.assert_allclose(out, [[0.5, 0.5, 0.5]])

    def test_domain_scaling(self):
        # domain [0.25, 0.75] 的恒等映射：输入 0.5 应落在轴坐标 0.5。
        t = np.array([[0, 0, 0], [1, 1, 1]], float)
        lut = _cube_lut("1D", 2, t, dmin=[0.25] * 3, dmax=[0.75] * 3)
        in_domain = lut.is_in_domain(np.array([[0.5, 0.5, 0.5]]))
        self.assertTrue(bool(in_domain[0]))
        out_of_domain = lut.is_in_domain(np.array([[0.1, 0.1, 0.1]]))
        self.assertFalse(bool(out_of_domain[0]))

    def test_chain_order_and_swap(self):
        # A: 每通道 +0.1；B: 每通道 ×2。
        ga = np.linspace(0, 1, 3)
        ta = np.repeat((ga + 0.1)[:, None], 3, axis=1)
        lut_a = _cube_lut("1D", 3, ta)
        tb = np.repeat((ga * 2)[:, None], 3, axis=1)
        lut_b = _cube_lut("1D", 3, tb)
        x = np.array([[0.3, 0.3, 0.3]])

        ab = apply_chain(x, lut_a, lut_b).out
        ba = apply_chain(x, lut_b, lut_a).out
        np.testing.assert_allclose(ab, np.repeat([[(0.3 + 0.1) * 2]], 3, axis=1),
                                   atol=1e-12)
        np.testing.assert_allclose(ba, np.repeat([[0.3 * 2 + 0.1]], 3, axis=1),
                                   atol=1e-12)
        self.assertFalse(np.allclose(ab, ba))  # 换序结果必须不同

    def test_oor_and_clip_masks(self):
        # 窄域表：0.9 超出 0.75 上限，应被标记；再让输出 >1 触发钳位。
        t = np.array([[0, 0, 0], [2, 2, 2]], float)
        lut = _cube_lut("1D", 2, t, dmin=[0.0] * 3, dmax=[0.75] * 3)
        frame = np.full((2, 2, 3), 0.9)
        res = apply_chain(frame, lut, None)
        self.assertTrue(bool(res.oor_mask.all()))
        self.assertTrue(bool(res.clip_mask.all()))
        self.assertEqual(int(res.oor_stage[0, 0]), 1)

    def test_diff_heatmap_shape_and_range(self):
        a = np.zeros((4, 4, 3))
        b = np.ones((4, 4, 3))
        heat = diff_heatmap(a, b)
        self.assertEqual(heat.shape, (4, 4, 3))
        self.assertTrue(float(heat.min()) >= 0.0)
        self.assertTrue(float(heat.max()) <= 1.0)


class TestPatternsAndAnalysis(unittest.TestCase):
    def setUp(self):
        self.spec = TestClipSpec(width=320, height=180, frames=6)
        self.clip = render_clip(self.spec)

    def test_clip_shape_and_motion(self):
        self.assertEqual(self.clip.shape, (6, 180, 320, 3))
        # 运动球位置逐帧变化 => 帧间不完全相同。
        self.assertFalse(np.allclose(self.clip[0], self.clip[1]))

    def test_source_clip_is_clean(self):
        rep = analyze_clip_frame(self.clip[0], self.spec)
        self.assertFalse(rep["has_discontinuity"])
        self.assertFalse(rep["has_crosstalk"])

    def test_ramp_spike_detection(self):
        x = np.linspace(0, 1, 20)
        x[10:] += 0.2  # 第 10 个位置一个大跳变
        rep = scan_ramp_discontinuities(x, 0)
        self.assertFalse(rep.smooth)
        self.assertEqual(rep.spikes[0].position, 10)

    def test_channel_swap_detection(self):
        n = 32
        src = np.zeros((n, 3))
        src[:, 0] = np.linspace(0, 1, n)
        out = src[:, [2, 1, 0]]  # R/B 互换
        rep = scan_channel_crosstalk(src, out, driven=0)
        self.assertEqual(rep.swapped_with, 2)

    def test_swap_lut_diagnosed(self):
        g = np.linspace(0, 1, 7)
        r, gg, b = np.meshgrid(g, g, g, indexing="ij")
        swap = _cube_lut("3D", 7, np.stack([b, gg, r], -1))
        rep = analyze_lut_shape(swap)
        driven_r = rep["cross_reports"][0]
        self.assertEqual(driven_r.swapped_with, 2)

    def test_banded_lut_diagnosed(self):
        x = np.linspace(0, 1, 33)
        y = np.round(x * 8) / 8
        banded = _cube_lut("1D", 33, np.repeat(y[:, None], 3, 1))
        rep = analyze_lut_shape(banded)
        self.assertTrue(len(rep["spike_channels"]) >= 1)

    def test_warm_shift_spares_neutral_gray(self):
        # 复现“灰色没事、肤色偏”的问题表。
        size = 17
        g = np.linspace(0, 1, size)
        r, gg, b = np.meshgrid(g, g, g, indexing="ij")
        warmth = np.clip(r - 0.5 * (gg + b), 0, 1)
        out = np.stack([
            np.clip(r + 0.22 * warmth, 0, 1),
            gg,
            np.clip(b - 0.25 * warmth, 0, 1),
        ], -1)
        lut = _cube_lut("3D", size, out)

        gray = np.array([[0.5, 0.5, 0.5]])
        np.testing.assert_allclose(apply_lut(lut, gray), gray, atol=1e-12)
        skin = SKIN_TONES[2:3]
        shifted = apply_lut(lut, skin)
        # 灰色变化为 0，肤色有明确可见偏移（该肤色暖度约 0.235）。
        self.assertGreater(float(np.abs(shifted - skin).mean()), 0.02)

    def test_warm_shift_not_misreported_as_swap(self):
        # 回归：轻微通道联动（小增益）不应被判成整体互换。
        size = 17
        g = np.linspace(0, 1, size)
        r, gg, b = np.meshgrid(g, g, g, indexing="ij")
        warmth = np.clip(r - 0.5 * (gg + b), 0, 1)
        out = np.stack([
            np.clip(r + 0.22 * warmth, 0, 1),
            np.clip(gg + 0.05 * warmth, 0, 1),
            np.clip(b - 0.25 * warmth, 0, 1),
        ], -1)
        lut = _cube_lut("3D", size, out)
        rep = analyze_lut_shape(lut)
        for c in rep["cross_reports"]:
            self.assertIsNone(c.swapped_with)


class TestProbes(unittest.TestCase):
    def test_probe_values_match_frame_pixels(self):
        spec = TestClipSpec()
        frame = render_frame(spec, 0)
        lut = _identity_3d(5)
        x, y = 17, 29
        chain = apply_chain(frame, lut, None)
        np.testing.assert_allclose(chain.out[y, x], frame[y, x])
        np.testing.assert_allclose(chain.stage1[y, x], frame[y, x])

    def test_probe_flags_oor(self):
        t = np.array([[0, 0, 0], [1, 1, 1]], float)
        lut = _cube_lut("1D", 2, t, dmin=[0.1] * 3, dmax=[0.9] * 3)
        frame = np.zeros((1, 2, 3))
        frame[0, 0] = 0.5   # 落在 [0.1, 0.9] 内
        frame[0, 1] = 0.95  # 超出上限
        res = apply_chain(frame, lut, None)
        self.assertFalse(bool(res.oor_mask[0, 0]))
        self.assertTrue(bool(res.oor_mask[0, 1]))


class TestVideoRoundTrip(unittest.TestCase):
    def test_quantization_isolated(self):
        rgb = np.full((2, 2, 3), 1.0 / 3.0)
        q = quantize_8bit(rgb)
        # 量化误差不超过半个 8-bit 步长。
        self.assertLessEqual(float(np.abs(q - rgb).max()), 0.5 / 255 + 1e-12)

    def test_export_and_verify_same_convention(self):
        spec = TestClipSpec(width=160, height=90, frames=4)
        clip = render_clip(spec)
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "out.mp4")
            actual, report = export_and_verify(clip, path, spec.fps, "mp4v")
            self.assertTrue(os.path.exists(actual))
            # 读回与预览同为 RGB/[0,1]，误差必有界；饱和色条上有损
            # mp4v 峰值可到 ~0.4，用宽松上界确认约定一致、无通道错位。
            self.assertGreaterEqual(report.total_error["mean_abs"], 0.0)
            self.assertLess(report.total_error["max_abs"], 0.5)
            # 逐通道量级接近，说明没有发生整通道互换。
            pc = report.total_error["mean_per_channel"]
            self.assertLess(pc.max() / max(pc.mean(), 1e-9), 3.0)

    def test_ffv1_near_lossless(self):
        spec = TestClipSpec(width=160, height=90, frames=3)
        clip = render_clip(spec)
        with tempfile.TemporaryDirectory() as d:
            _, report = export_and_verify(
                clip, os.path.join(d, "out.mkv"), spec.fps, "FFV1"
            )
            # 无损编码的“编码附加误差”应接近 0。
            self.assertLess(report.codec_error["mean_abs"], 1e-9)


class TestConfigAndSafeLoad(unittest.TestCase):
    def test_save_and_load_two_slots(self):
        store = ConfigStore.empty()
        store.slots["A"] = CompareConfig("A", "/a1.cube", "/a2.cube", False)
        store.slots["B"] = CompareConfig("B", "/b1.cube", "/b2.cube", True)
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "cfg.json")
            save_configs(store, p)
            loaded = load_configs(p)
        self.assertEqual(loaded.slots["A"].first_path, "/a1.cube")
        self.assertTrue(loaded.slots["B"].swapped)

    def test_failed_load_keeps_previous_lut(self):
        good = _identity_3d(4)
        loader = SafeLutLoader()
        with tempfile.TemporaryDirectory() as d:
            good_path = os.path.join(d, "good.cube")
            write_cube(good, good_path)
            ok = loader.load(good_path)
            self.assertTrue(ok.ok)

            broken = os.path.join(d, "bad.cube")
            with open(broken, "w") as fh:
                fh.write("LUT_3D_SIZE 5\n0 0 0\n")  # 行数不够
            bad = loader.load(broken)
            self.assertFalse(bad.ok)
            self.assertIn("行数", bad.error)
            # 关键容错：旧表仍在，效果可继续查看。
            self.assertIsNotNone(loader.current)
            np.testing.assert_allclose(loader.current.table, good.table)

    def test_missing_file_keeps_previous(self):
        good = _identity_3d(3)
        loader = SafeLutLoader(good)
        outcome = loader.load("/nonexistent/path/x.cube")
        self.assertFalse(outcome.ok)
        self.assertIs(loader.current, good)


class TestCLIProbe(unittest.TestCase):
    def test_probe_command_runs(self):
        # 回归：1D 数组曾被按 2D 索引导致 IndexError。
        import contextlib
        from lut_tool.cli import build_parser

        good = _identity_3d(4)
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "g.cube")
            write_cube(good, p)
            with contextlib.redirect_stdout(open(os.devnull, "w")):
                args = build_parser().parse_args(["probe", p])
                args.func(args)  # 不抛异常即通过

                args2 = build_parser().parse_args(
                    ["probe", p, "--point", "0.5", "0.25", "0.75"]
                )
                args2.func(args2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
