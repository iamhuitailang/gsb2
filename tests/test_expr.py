import unittest

from reframer.expr import crop_x_expr, sample_kf, build_crop_filter
from reframer.ffmpegutil import fmt_float


def sched_with_kfs(kfs, width=1000, crop_w=280):
    return {
        "width": width, "height": 500, "fps": 10.0, "duration": 4.0,
        "frames": 40, "crop": {"width_px": crop_w, "height_px": 500},
        "keyframes": [{"t": t, "crop": {"x": x, "y": 0.0, "w": crop_w / width, "h": 1.0}}
                      for t, x in kfs],
    }


class TestExpr(unittest.TestCase):
    def test_sample_interpolation(self):
        s = sched_with_kfs([(0.0, 0.0), (1.0, 0.5), (2.0, 0.5)])
        self.assertAlmostEqual(sample_kf(s, 0.5)["x"], 0.25)
        self.assertAlmostEqual(sample_kf(s, 1.5)["x"], 0.5)
        self.assertAlmostEqual(sample_kf(s, 9.0)["x"], 0.5)     # 末端外推

    def test_expr_uses_piecewise_linear(self):
        s = sched_with_kfs([(0.0, 0.0), (2.0, 0.4)])
        expr = crop_x_expr(s)
        # 表达式按帧号 n 分段 (fps=10, t=2s -> n=20)
        self.assertIn("if(lt(n,20)", expr)
        self.assertIn("(n-0)", expr)

    def test_crop_filter_expression_mode(self, tmp=False):
        import tempfile
        s = sched_with_kfs([(0.0, 0.0), (1.0, 0.2), (2.0, 0.4)])
        with tempfile.TemporaryDirectory() as d:
            filt, cmd_file = build_crop_filter(s, d)
        self.assertIn("crop=w=280", filt)
        self.assertIsNone(cmd_file)

    def test_sendcmd_fallback(self):
        import tempfile
        import reframer.expr as exprmod
        old = exprmod.EXPR_MAX_CHARS
        exprmod.EXPR_MAX_CHARS = 100          # 强制走回退分支
        try:
            kfs = [(i * 0.1, 0.001 * i) for i in range(50)]
            s = sched_with_kfs(kfs)
            with tempfile.TemporaryDirectory() as d:
                filt, cmd_file = build_crop_filter(s, d)
                self.assertIn("sendcmd", filt)
                self.assertTrue(cmd_file.exists())
                text = cmd_file.read_text()
        finally:
            exprmod.EXPR_MAX_CHARS = old
        self.assertIn("crop x", text)

    def test_fmt_float(self):
        self.assertEqual(fmt_float(0.0), "0")
        self.assertEqual(fmt_float(1.5), "1.5")
        self.assertEqual(fmt_float(1 / 3).startswith("0.333"), True)


if __name__ == "__main__":
    unittest.main()
