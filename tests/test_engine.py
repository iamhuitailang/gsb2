"""引擎/IO 测试: 批量失败隔离、导出不覆盖原件、样音生成、工程存取。"""

import json
import os
import tempfile
import unittest

import numpy as np
import soundfile as sf

from noisekit.audioio import EXPORT_SUFFIX, file_sha256, load_audio
from noisekit.engine import Engine
from noisekit.project import build_project, load_project, save_project
from noisekit.samples import generate


def make_wav(path, sr=22050, dur=2.0, seed=0):
    rng = np.random.default_rng(seed)
    n = int(sr * dur)
    t = np.arange(n) / sr
    x = 0.08 * rng.standard_normal(n) + 0.2 * np.sin(2 * np.pi * 220 * t)
    sf.write(path, x.astype(np.float32), sr, subtype="PCM_16")
    return x


class TestEngine(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="noisekit_test_")
        self.src = os.path.join(self.tmp, "rec.wav")
        make_wav(self.src)
        self.engine = Engine()

    def _noise_and_params(self):
        info = self.engine.analyze(self.src, 0.05, 0.45)
        params = {
            "n_fft": info["n_fft"],
            "strength": 0.6,
            "smoothing": 0.6,
            "protect_transient": True,
            "protect_voice": True,
            "region_start": 0.05,
            "region_end": 0.45,
        }
        return info, params

    def test_export_never_overwrites_source_or_previous(self):
        info, params = self._noise_and_params()
        out_dir = os.path.join(self.tmp, "out")
        src_hash_before = file_sha256(self.src)

        r1 = self.engine.export_one(self.src, out_dir, info, params)
        r2 = self.engine.export_one(self.src, out_dir, info, params)
        self.assertTrue(r1["outputs"]["wav"].endswith(f"{EXPORT_SUFFIX}.wav"))
        self.assertNotEqual(r1["outputs"]["wav"], r2["outputs"]["wav"])
        self.assertTrue(os.path.exists(r2["outputs"]["record"]))
        # 原件未改动
        self.assertEqual(file_sha256(self.src), src_hash_before)
        # 参数记录内容完整
        with open(r1["outputs"]["record"], encoding="utf-8") as f:
            rec = json.load(f)
        self.assertEqual(rec["source"]["sha256"], src_hash_before)
        self.assertIn("strength", rec["parameters"])

    def test_batch_failure_isolation(self):
        good = os.path.join(self.tmp, "good.wav")
        make_wav(good, seed=1)
        info, params = self._noise_and_params()
        bad_profile = [np.zeros(max(1, info["n_fft"] // 2), dtype=float).tolist()]
        jobs = [
            {"path": good, "noise": info, "params": params},
            {"path": os.path.join(self.tmp, "missing.wav"),
             "noise": info, "params": params},
            {"path": self.src,
             "noise": {"profile": bad_profile, "n_fft": info["n_fft"],
                       "region": {"start": 0, "end": 0.1}},
             "params": params},
        ]
        results = self.engine.batch_export(jobs, os.path.join(self.tmp, "batch"))
        statuses = {r["file"]: r["status"] for r in results}
        self.assertEqual(statuses["good.wav"], "ok")
        self.assertEqual(statuses["rec.wav"], "error")
        self.assertEqual(statuses["missing.wav"], "error")
        # 失败结果带错误信息, 成功的文件确实落盘
        err = next(r for r in results if r["file"] == "rec.wav")
        self.assertIn("频点", err["error"])
        ok = [r for r in results if r["status"] == "ok"]
        self.assertEqual(len(ok), 1)
        self.assertTrue(os.path.exists(ok[0]["outputs"]["wav"]))

    def test_process_cache_hits_same_params(self):
        info, params = self._noise_and_params()
        y1 = self.engine.process(self.src, info, params)
        y2 = self.engine.process(self.src, info, dict(params))
        self.assertIs(y1, y2)  # 同参数命中缓存, 同一对象
        params2 = dict(params, strength=0.9)
        y3 = self.engine.process(self.src, info, params2)
        self.assertFalse(np.array_equal(y1, y3))


class TestProject(unittest.TestCase):
    def test_roundtrip_and_no_overwrite(self):
        tmp = tempfile.mkdtemp(prefix="noisekit_proj_")
        src = os.path.join(tmp, "a.wav")
        make_wav(src)
        af = load_audio(src)
        project = build_project(
            files=[af.to_dict()],
            common_params={"strength": 0.4},
            sample_regions={af.path: {"start": 0.1, "end": 0.4}},
            per_file_params={af.path: {"strength": 0.7}},
        )
        path = save_project(project, os.path.join(tmp, "p.nkproj"))
        path2 = save_project(project, os.path.join(tmp, "p.nkproj"))
        self.assertNotEqual(path, path2)  # 同名自动加序号
        loaded = load_project(path)
        self.assertEqual(loaded["common_params"], {"strength": 0.4})
        self.assertIn(af.path, loaded["sample_regions"])


class TestSamples(unittest.TestCase):
    def test_generate_all_samples(self):
        out = tempfile.mkdtemp(prefix="noisekit_samples_")
        manifest = generate(out)
        self.assertEqual(len(manifest), 4)
        names = [m["file"] for m in manifest]
        self.assertIn("01_stationary_noise.wav", names)
        self.assertIn("02_sudden_noise.wav", names)
        self.assertIn("03_transients.wav", names)
        self.assertIn("04_voice_in_sample.wav", names)
        for m in manifest:
            path = os.path.join(out, m["file"])
            af = load_audio(path)
            self.assertEqual(af.channels, 2)
            self.assertAlmostEqual(af.duration, 8.0, places=2)
            self.assertTrue(np.max(np.abs(af.data)) <= 1.0)
        # 确定性: 再生成一次内容一致
        out2 = tempfile.mkdtemp(prefix="noisekit_samples2_")
        generate(out2)
        p1 = os.path.join(out, "01_stationary_noise.wav")
        p2 = os.path.join(out2, "01_stationary_noise.wav")
        self.assertEqual(file_sha256(p1), file_sha256(p2))


if __name__ == "__main__":
    unittest.main()
