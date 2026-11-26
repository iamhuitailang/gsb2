"""DSP 单元测试: STFT 完美重构、降噪有效性、瞬态/语音保护、样本语音检出。"""

import unittest

import numpy as np

from noisekit.dsp import (
    analyze_noise_segment,
    choose_n_fft,
    denoise,
    istft,
    rms,
    stft,
)

SR = 44100


def pinkish_noise(n, rng, level=0.1):
    """简易宽带稳态噪声 (白噪过一阶低通)。"""
    x = rng.standard_normal(n)
    a = 0.9
    y = np.zeros(n)
    acc = 0.0
    for i, v in enumerate(x):
        acc = a * acc + (1 - a) * v
        y[i] = acc
    return level * y / (np.max(np.abs(y)) + 1e-12)


def tone(n, sr, freq, level=0.3):
    t = np.arange(n) / sr
    return level * np.sin(2 * np.pi * freq * t)


def speech_like(n, sr, rng, level=0.35):
    """谐波 + 基频抖动 + 音节包络与随机间隙, 贴近浊音的统计特征。"""
    t = np.arange(n) / sr
    f0 = 150 * (1 + 0.03 * np.sin(2 * np.pi * 1.3 * t))
    sig = np.zeros(n)
    for h, a in ((1, 1.0), (2, 0.5), (3, 0.28), (4, 0.14)):
        sig += a * np.sin(2 * np.pi * f0 * h * t)
    env = 0.5 + 0.5 * np.sin(2 * np.pi * 2.2 * t) ** 2
    gaps = rng.random(n) > 0.9
    env[gaps] *= 0.1
    return level * sig * env / (np.max(np.abs(sig)) + 1e-12)


class TestSTFT(unittest.TestCase):
    def test_perfect_reconstruction(self):
        rng = np.random.default_rng(0)
        x = rng.standard_normal(SR * 2)
        scale = np.sqrt(np.mean(x**2))
        for n_fft in (1024, 2048, 4096):
            hop = n_fft // 2
            spec = stft(x, n_fft, hop)
            y = istft(spec, n_fft, hop, len(x))
            # 内部帧窗平方和恒定可完美重构
            inner = slice(n_fft, len(x) - n_fft)
            self.assertLess(np.max(np.abs(x[inner] - y[inner])), 1e-10)
            # 边界区(末尾一窗)反射填充只做部分重叠相加, 相对误差控制在小量级
            rel = np.max(np.abs(x - y)) / scale
            self.assertLess(rel, 0.2, f"n_fft={n_fft} 边界相对误差过大: {rel}")
            # 排除首尾窗后应接近完美
            core = slice(n_fft, len(x) - n_fft)
            self.assertLess(np.max(np.abs(x[core] - y[core])) / scale, 1e-9)

    def test_short_signal(self):
        # 不足一窗: 单帧零填充, 不崩溃
        x = np.zeros(100)
        spec = stft(x, 2048, 1024)
        self.assertEqual(spec.shape[0], 1)
        y = istft(spec, 2048, 1024, 100)
        self.assertEqual(len(y), 100)
        # 完全短于一窗的信号也能走通 denoise 流程
        from noisekit.dsp import denoise

        profile = [np.zeros(1025).tolist()]
        out = denoise(x, SR, profile, 2048, strength=0.5)
        self.assertEqual(len(out), 100)

    def test_choose_n_fft(self):
        self.assertEqual(choose_n_fft(44100), 2048)  # ~46ms
        self.assertEqual(choose_n_fft(16000), 1024)  # 64ms 被夹到下限
        self.assertEqual(choose_n_fft(192000), 4096)  # 被夹到上限


class TestDenoise(unittest.TestCase):
    def setUp(self):
        self.rng = np.random.default_rng(42)
        n = SR * 4
        self.n = n
        self.noise = pinkish_noise(n, self.rng)
        # 语音从 0.7s 开始, 前 0.6s 留作纯噪声样本
        self.voice = np.zeros(n)
        i0 = int(0.7 * SR)
        self.voice[i0:] = speech_like(n - i0, SR, self.rng)
        self.x = self.noise + self.voice

    def _profile(self):
        res = analyze_noise_segment(self.x, SR, 0.05, 0.55)
        return res

    def test_noise_segment_clean(self):
        res = self._profile()
        self.assertFalse(res["speech_suspected"])
        self.assertEqual(len(res["profile"]), 1)
        self.assertEqual(len(res["profile"][0]), res["n_fft"] // 2 + 1)

    def test_denoise_reduces_noise_floor(self):
        info = self._profile()
        y = denoise(self.x, SR, info["profile"], info["n_fft"], strength=0.7)
        # 在中段纯噪声窗口比较 (避开首尾 STFT 边界帧)
        s = slice(int(0.1 * SR), int(0.5 * SR))
        self.assertLess(rms(y[s]), rms(self.x[s]) * 0.6)
        # 强度越高, 噪声段衰减越多
        y_strong = denoise(self.x, SR, info["profile"], info["n_fft"], strength=0.95)
        y_weak = denoise(self.x, SR, info["profile"], info["n_fft"], strength=0.15)
        self.assertLess(rms(y_strong[s]), rms(y_weak[s]))

    def test_voice_better_preserved_with_protection(self):
        info = self._profile()
        y_prot = denoise(self.x, SR, info["profile"], info["n_fft"],
                         strength=0.8, protect_voice=True)
        y_plain = denoise(self.x, SR, info["profile"], info["n_fft"],
                          strength=0.8, protect_voice=False)
        # 语音集中在中后段, 保护开启时该段保留能量更多
        s = slice(int(1.5 * SR), int(3.5 * SR))
        self.assertGreater(rms(y_prot[s]), rms(y_plain[s]))

    def test_strength_zero_is_identity(self):
        info = self._profile()
        y = denoise(self.x, SR, info["profile"], info["n_fft"], strength=0.0)
        np.testing.assert_array_equal(y, self.x)

    def test_transient_protection_keeps_taps(self):
        # 用较弱、较短的敲击: 其能量泄漏到上升沿前一分析窗, 该帧会被谱减重衰减,
        # 正是瞬态保护应当托底的场景
        n = self.n
        x = self.noise.copy()
        tap_positions = (1.0, 2.0, 3.0)
        for ts in tap_positions:
            i0 = int(ts * SR)
            L = int(0.03 * SR)
            x[i0 : i0 + L] += 0.3 * self.rng.standard_normal(L) * np.exp(
                -np.linspace(0, 6, L)
            )
        info = analyze_noise_segment(x, SR, 0.05, 0.55)
        n_fft = info["n_fft"]
        hop = n_fft // 2
        y_on = denoise(x, SR, info["profile"], n_fft, strength=0.95,
                       protect_transient=True)
        y_off = denoise(x, SR, info["profile"], n_fft, strength=0.95,
                        protect_transient=False)

        # 每个敲击上升沿的前一分析窗 (敲击能量泄漏帧): 未保护时被谱减重衰减,
        # 保护开启时增益被托底, 该帧能量应高出数倍
        ratios = []
        for ts in tap_positions:
            rise_frame = int(ts * SR / hop)
            prev = rise_frame - 1
            s = slice(prev * hop, (prev + 1) * hop)
            ratios.append(rms(y_on[s]) / (rms(y_off[s]) + 1e-12))
        self.assertGreater(np.mean(ratios), 1.8)

        # 无敲击的纯噪声段两种模式应接近, 说明保护只在瞬态处生效
        q = slice(int(0.1 * SR), int(0.5 * SR))
        self.assertLess(abs(rms(y_on[q]) - rms(y_off[q])) / (rms(y_off[q]) + 1e-12), 0.25)

    def test_stereo_channel_count_preserved(self):
        info = self._profile()
        stereo = np.stack([self.x, self.x * 0.9], axis=1)
        profile_stereo = [info["profile"][0], info["profile"][0]]
        y = denoise(stereo, SR, profile_stereo, info["n_fft"], strength=0.5)
        self.assertEqual(y.ndim, 2)
        self.assertEqual(y.shape, stereo.shape)


class TestSpeechDetection(unittest.TestCase):
    def test_voice_in_sample_flags_warning(self):
        rng = np.random.default_rng(7)
        n = SR * 4
        # 整段都是强谐波 + 慢包络, 没有纯噪声区
        t = np.arange(n) / SR
        f0 = 150 * (1 + 0.03 * np.sin(2 * np.pi * 1.3 * t))
        voice = np.zeros(n)
        for h, a in ((1, 1), (2, 0.5), (3, 0.25)):
            voice += a * np.sin(2 * np.pi * f0 * h * t)
        env = 0.5 + 0.5 * np.sin(2 * np.pi * 2.0 * t) ** 2
        x = 0.3 * voice * env + 0.02 * rng.standard_normal(n)
        res = analyze_noise_segment(x, SR, 1.0, 1.8)
        self.assertTrue(res["speech_suspected"])
        self.assertTrue(any("语音" in w for w in res["warnings"]))

    def test_too_short_segment_raises(self):
        rng = np.random.default_rng(1)
        x = rng.standard_normal(SR)
        with self.assertRaises(ValueError):
            analyze_noise_segment(x, SR, 0.0, 0.05)


if __name__ == "__main__":
    unittest.main()
