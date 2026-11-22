"""端到端集成测试：真实生成视频，覆盖登记/标定/剪辑点/播放头/持久化/重挂接/导出。

测试素材只生成 3 秒，保证整套用例跑得快；若环境没有 ffmpeg 则跳过。
"""

import json
import os
import shutil
import tempfile
import unittest

from proxylink.errors import (
    OutOfRangeError,
    SignatureMismatchError,
)
from proxylink.gen_media import generate_all
from proxylink.media import verify_candidate
from proxylink.project import Project

try:
    import subprocess
    subprocess.run(["ffprobe", "-version"], capture_output=True, check=True)
    HAVE_FFMPEG = True
except Exception:
    HAVE_FFMPEG = False


@unittest.skipUnless(HAVE_FFMPEG, "环境缺少 ffmpeg/ffprobe")
class IntegrationTest(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="proxylink_test_")
        self.media_dir = os.path.join(self.tmp, "media")
        self.project_dir = os.path.join(self.tmp, "project")
        os.makedirs(self.project_dir)
        self.paths = generate_all(self.media_dir, duration=3.0, fps=24,
                                  short_duration=2.0, head_shift=1.0)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _project(self):
        return Project(self.project_dir)

    def _setup_normal_link(self, proj=None):
        proj = proj or self._project()
        o = proj.register(self.paths["original"])
        p = proj.register(self.paths["normal"])
        link = proj.create_link(o.id, p.id, label="normal")
        proj.calibrate(link.id, [(0, 0)])
        return proj, o, p, link

    # ---- 需求 1：登记与探针、同名区分 -------------------------------

    def test_register_probe_info(self):
        proj, o, p, link = self._setup_normal_link()
        detail = proj.media_detail(o.id)
        self.assertEqual((detail["width"], detail["height"]), (1280, 720))
        self.assertEqual((p.width, p.height), (640, 360))
        self.assertAlmostEqual(detail["duration"], 3.0, places=2)
        self.assertEqual(detail["fps"], 24.0)
        self.assertTrue(detail["video_streams"])
        self.assertTrue(detail["has_audio"])
        self.assertEqual(len(detail["partial_sha256"]), 64)

    def test_same_filename_different_dirs_distinguished(self):
        other_dir = os.path.join(self.tmp, "other")
        os.makedirs(other_dir)
        dup = os.path.join(other_dir, os.path.basename(self.paths["normal"]))
        shutil.copy(self.paths["normal"], dup)
        proj = self._project()
        m1 = proj.register(self.paths["normal"])
        m2 = proj.register(dup)
        self.assertNotEqual(m1.id, m2.id)
        self.assertEqual(m1.filename, m2.filename)
        # 用纯文件名引用时应报歧义而不是随便选一个
        with self.assertRaises(Exception):
            proj._resolve_media(m1.filename)
        # 用完整路径（含符号链接前缀，如 macOS /tmp）必须精确命中
        resolved = proj._resolve_media(m1.path)
        self.assertEqual(resolved.id, m1.id)
        # media_detail 中标注其他同名记录
        detail = proj.media_detail(m1.id)
        self.assertEqual(detail["same_filename_others"], [m2.id])

    # ---- 需求 2：标定、首尾匹配、不可定位区间 ------------------------

    def test_short_proxy_reports_unreachable_tail(self):
        proj = self._project()
        o = proj.register(self.paths["original"])
        ps = proj.register(self.paths["short"])
        link = proj.create_link(o.id, ps.id)
        proj.calibrate(link.id, [(0, 0)])
        status = proj.link_status(link.id)
        cov = status["coverage"]
        self.assertFalse(cov["tail_match"]["aligned"])
        self.assertAlmostEqual(cov["tail_match"]["original_missing_tail_seconds"],
                               1.0, places=1)
        self.assertGreater(
            sum(u["seconds"] for u in cov["original"]["unreachable"]), 0.9)
        # 原片后段在代理上无法定位
        with self.assertRaises(OutOfRangeError):
            proj.add_cut_point(link.id, "2.5", side="original")

    def test_headshift_proxy_reports_unreachable_head(self):
        proj = self._project()
        o = proj.register(self.paths["original"])
        ph = proj.register(self.paths["headshift"])
        link = proj.create_link(o.id, ph.id)
        proj.calibrate(link.id, [(1.0, 0.0)])
        cov = proj.link_status(link.id)["coverage"]
        self.assertFalse(cov["head_match"]["aligned"])
        self.assertAlmostEqual(cov["head_match"]["original_missing_head_seconds"],
                               1.0, places=1)
        # 原片 0.5s 的画面代理里没有
        loc = proj.locate(link.id, "original", "0.5")
        self.assertFalse(loc["ok"])
        # 代理 0s 应映射回原片 1s
        loc2 = proj.locate(link.id, "proxy", "0.0")
        self.assertTrue(loc2["ok"])
        self.assertAlmostEqual(loc2["mapped"], 1.0, places=2)

    def test_bad_anchor_rate_rejected(self):
        proj, o, p, link = self._setup_normal_link()
        with self.assertRaises(Exception):
            proj.calibrate(link.id, [(0, 0), (2.0, 0.5)])

    def test_two_anchor_scaled_mapping(self):
        # 用 12fps 代理对 24fps 原片做双点标定，rate=2
        from proxylink.gen_media import _generate_clip
        proxy12 = os.path.join(self.tmp, "proxy12.mp4")
        _generate_clip(proxy12, size=(640, 360), fps=12, duration=3.0,
                       label="P12", origin_frame=0)
        proj = self._project()
        o = proj.register(self.paths["original"])
        p = proj.register(proxy12)
        link = proj.create_link(o.id, p.id)
        mapping = proj.calibrate(link.id, [(0, 0), (2.0, 1.0)])
        self.assertAlmostEqual(mapping.rate, 2.0)
        # 代理 0.5s -> 原片 1.0s
        loc = proj.locate(link.id, "proxy", "0.5")
        self.assertTrue(loc["ok"])
        self.assertAlmostEqual(loc["mapped"], 1.0, places=2)

    # ---- 需求 3：剪辑点 + 切换保持画面 + 越界停止 --------------------

    def test_cut_points_and_switch_keeps_frame(self):
        proj, o, p, link = self._setup_normal_link()
        cp = proj.add_cut_point(link.id, "1.5", side="original", label="mark1")
        self.assertAlmostEqual(cp.original_time, 1.5, places=2)
        self.assertAlmostEqual(cp.proxy_time, 1.5, places=2)
        self.assertTrue(cp.reliable)

        view = proj.seek(link.id, "1.5", side="original")
        self.assertAlmostEqual(view["original"]["time"], 1.5, places=2)
        self.assertAlmostEqual(view["proxy"]["time"], 1.5, places=2)
        switched = proj.switch_side()
        self.assertEqual(switched["side"], "proxy")
        # 切换后两端仍指向对应画面
        self.assertAlmostEqual(switched["original"]["time"],
                               switched["proxy"]["time"], places=2)

    def test_switch_out_of_range_stops(self):
        proj = self._project()
        o = proj.register(self.paths["original"])
        ph = proj.register(self.paths["headshift"])
        link = proj.create_link(o.id, ph.id)
        proj.calibrate(link.id, [(1.0, 0.0)])
        # 在原片 0.2s（代理没有的画面）切换 -> 明确停止
        proj.seek(link.id, "0.2", side="original")
        view = proj.switch_side()
        self.assertTrue(view["stopped"])
        self.assertTrue(view["stop_reason"])

    def test_tick_stops_at_proxy_end(self):
        proj = self._project()
        o = proj.register(self.paths["original"])
        ps = proj.register(self.paths["short"])
        link = proj.create_link(o.id, ps.id)
        proj.calibrate(link.id, [(0, 0)])
        proj.seek(link.id, "1.8", side="proxy")
        view = proj.tick(1.0)  # 代理只有 2s
        self.assertTrue(view["stopped"])
        self.assertIn("停止", view["stop_reason"])
        # 停止后继续正向 tick 不会越过边界
        again = proj.tick(1.0)
        self.assertLessEqual(again["proxy"]["time"], ps.duration + 0.05)

    # ---- 需求 4：重启持久化 + 移动重挂接 + 特征不符信号 --------------

    def test_persistence_across_restart(self):
        proj, o, p, link = self._setup_normal_link()
        proj.add_cut_point(link.id, "1.0", label="persisted")
        proj.seek(link.id, "1.0", side="original")

        reopened = Project(self.project_dir)
        self.assertEqual(len(reopened.list_media()), 2)
        self.assertEqual(len(reopened.list_cut_points()), 1)
        self.assertIsNotNone(reopened.state.session)
        self.assertAlmostEqual(reopened.state.session.original_time, 1.0, places=2)
        # 标定也还在，映射可直接使用
        status = reopened.link_status(link.id)
        self.assertTrue(status["calibrated"])

    def test_relink_after_move(self):
        proj, o, p, link = self._setup_normal_link()
        new_dir = os.path.join(self.tmp, "moved")
        os.makedirs(new_dir)
        new_path = os.path.join(new_dir, os.path.basename(p.path))
        shutil.move(p.path, new_path)
        self.assertFalse(proj.state.get_media(p.id).exists)

        candidates = proj.find_relink_candidates(p.id, new_dir)
        self.assertEqual(candidates[0]["verdict"], "match")
        result = proj.relink(p.id, new_path)
        self.assertTrue(proj.state.get_media(p.id).exists)
        self.assertEqual(result["report"]["verdict"], "match")

        # 重挂接后挂接/标定仍然有效
        proj.seek(link.id, "1.0", side="original")
        view = proj.switch_side()
        self.assertFalse(view["stopped"])

    def test_relink_rejects_wrong_file(self):
        proj, o, p, link = self._setup_normal_link()
        # 用原片（分辨率/编码特征不同）冒充代理候选
        report = verify_candidate(o.path, p.to_dict())
        self.assertEqual(report["verdict"], "mismatch")
        failed_fields = {c["field"] for c in report["checks"] if not c["ok"]}
        self.assertIn("width", failed_fields)
        self.assertIn("height", failed_fields)
        with self.assertRaises(SignatureMismatchError) as ctx:
            proj.relink(p.id, o.path)
        self.assertTrue(ctx.exception.details)
        # force 可以绕过，但记录里留下 forced 痕迹
        forced = proj.relink(p.id, o.path, force=True)
        self.assertTrue(forced["forced"])

    # ---- 需求 5：导出与溯源 -----------------------------------------

    def test_export_contains_provenance(self):
        proj, o, p, link = self._setup_normal_link()
        proj.add_cut_point(link.id, "1.25", side="proxy", label="from-proxy")
        data = json.loads(proj.export_cut_points("json"))
        self.assertEqual(data["count"], 1)
        entry = data["cut_points"][0]
        self.assertIn("timecode", entry["original"])
        src = entry["derived_from"]
        self.assertEqual(src["proxy_filename"], os.path.basename(p.path))
        self.assertIn("proxy_time", src)
        self.assertIn("calibration", src)
        self.assertEqual(src["entered_from"], "proxy")

        csv_text = proj.export_cut_points("csv")
        self.assertIn("original_filename", csv_text)
        self.assertIn(os.path.basename(o.filename), csv_text)
        md_text = proj.export_cut_points("md")
        self.assertIn("换算溯源", md_text)

    # ---- 状态文件位置 -----------------------------------------------

    def test_state_file_under_project_dir(self):
        self._setup_normal_link()
        self.assertTrue(os.path.isfile(
            os.path.join(self.project_dir, ".proxylink", "state.json")))


if __name__ == "__main__":
    unittest.main()
