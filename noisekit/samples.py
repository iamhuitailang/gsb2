"""合成演示样音 (确定性随机, 可重复生成)。

生成 4 个 44.1 kHz 立体声 WAV:
  01_stationary_noise.wav  稳定底噪 (粉噪 + 50Hz 嗡声) + 模拟语音, 开头有纯噪声段
  02_sudden_noise.wav      同样的底噪, 中间插入一次突发宽带噪声
  03_transients.wav        底噪中混入多个短促敲击声, 检验瞬态保护
  04_voice_in_sample.wav   整段都有语音, 用于演示"噪声样本含语音"的告警

噪声/语音/敲击是独立生成再按电平混合的, 便于人耳分辨处理前后差异。
"""

from __future__ import annotations

import json
import os

import numpy as np

SR = 44100
DUR = 8.0
RNG_SEED = 13924

# 默认样音输出目录 (仓库根/public/samples, 已在 .gitignore 忽略)
SAMPLES_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "public", "samples"
)


def _pink_noise(n: int, rng: np.random.Generator) -> np.ndarray:
    """Voss-McCartney 风格粉噪 (1/f 频谱), 经一阶低通模拟房间底噪。"""
    white = rng.standard_normal(n)
    # 多个累加器在不同尺度上随机刷新
    n_oct = 16
    rows = np.zeros(n_oct)
    out = np.zeros(n)
    for i in range(n):
        rows[0] = white[i]
        out[i] = rows.mean()
        k = (i & -i).bit_length()  # 最低位 1 的位置
        if 0 < k < n_oct:
            rows[k] = rng.standard_normal()
    # 一阶低通, 让高频滚降更接近真实环境噪声
    a = 0.85
    lp = np.empty(n)
    acc = 0.0
    for i, v in enumerate(out):
        acc = a * acc + (1.0 - a) * v
        lp[i] = acc
    lp /= np.max(np.abs(lp)) + 1e-12
    return lp


def _hum(n: int, sr: int) -> np.ndarray:
    t = np.arange(n) / sr
    return 0.05 * np.sin(2 * np.pi * 50 * t) + 0.02 * np.sin(2 * np.pi * 100 * t)


def _voice_like(
    n: int,
    sr: int,
    rng: np.random.Generator,
    level: float = 0.35,
    gap_prob: float = 0.12,
) -> np.ndarray:
    """用基频谐波 + 振幅包络拼出"类语音"信号 (不是真实语音, 仅作演示)。"""
    t = np.arange(n) / sr
    out = np.zeros(n)
    # 三段"说话": (开始, 时长, 基频); 第一段从头开始, 保证没有纯噪声间隙
    syllables = [(0.05, 2.3, 130.0), (3.0, 2.2, 165.0), (5.8, 2.0, 110.0)]
    for start, length, f0 in syllables:
        i0, i1 = int(start * sr), int((start + length) * sr)
        tt = t[i0:i1] - start
        sig = np.zeros_like(tt)
        for h, amp in ((1, 1.0), (2, 0.5), (3, 0.28), (4, 0.14), (6, 0.07)):
            # 基频缓慢抖动, 模拟语调
            f = f0 * h * (1.0 + 0.02 * np.sin(2 * np.pi * 1.4 * tt + h))
            sig += amp * np.sin(2 * np.pi * f * tt)
        # 音节级慢包络 + 音节内小起伏
        env = 0.5 * (1 - np.cos(2 * np.pi * tt / max(length, 1e-6)))
        env *= 0.75 + 0.25 * np.sin(2 * np.pi * 3.2 * tt) ** 2
        # 随机停顿, 模拟说话间隙
        gaps = rng.random(len(tt)) > (1.0 - gap_prob)
        env[gaps] *= 0.15
        out[i0:i1] += sig * env
    out /= np.max(np.abs(out)) + 1e-12
    return level * out


def _continuous_voiced(n: int, sr: int, rng: np.random.Generator, level: float = 0.5) -> np.ndarray:
    """近连续浊音: 基频在三个音高间漂移, 包络只有轻微起伏、无大间隙。

    专供"噪声样本含语音"告警样音: 任意 0.5s 窗口都含足够周期能量。
    """
    t = np.arange(n) / sr
    f0 = np.piecewise(
        t,
        [t < 2.7, (t >= 2.7) & (t < 5.4), t >= 5.4],
        [130.0, 165.0, 110.0],
    )
    f0 = f0 * (1.0 + 0.02 * np.sin(2 * np.pi * 1.4 * t))
    sig = np.zeros(n)
    for h, amp in ((1, 1.0), (2, 0.5), (3, 0.28), (4, 0.14), (6, 0.07)):
        sig += amp * np.sin(2 * np.pi * f0 * h * t)
    # 轻微振幅起伏但不留静音; 起始只做 20ms 短淡入避免爆音
    env = 0.8 + 0.2 * np.sin(2 * np.pi * 2.5 * t) ** 2
    fade = int(0.02 * sr)
    env[:fade] *= np.linspace(0, 1, fade)
    sig *= env
    return level * sig / (np.max(np.abs(sig)) + 1e-12)


def _taps(n: int, sr: int, rng: np.random.Generator, times: list[float]) -> np.ndarray:
    """短促敲击: 宽带脉冲 + 快速指数衰减。"""
    out = np.zeros(n)
    for ts in times:
        i0 = int(ts * sr)
        length = int(0.08 * sr)  # 80 ms
        i1 = min(n, i0 + length)
        decay = np.exp(-np.linspace(0, 9, i1 - i0))
        out[i0:i1] += 0.5 * rng.standard_normal(i1 - i0) * decay
    return out


def _burst(n: int, sr: int, rng: np.random.Generator, start: float, length: float) -> np.ndarray:
    """突发噪声: 带起音/释音包络的一段宽带噪声。"""
    out = np.zeros(n)
    i0, i1 = int(start * sr), int((start + length) * sr)
    env = np.ones(i1 - i0)
    fade = int(0.02 * sr)
    env[:fade] = np.linspace(0, 1, fade)
    env[-fade:] = np.linspace(1, 0, fade)
    out[i0:i1] = 0.4 * rng.standard_normal(i1 - i0) * env
    return out


def _stereo(mono: np.ndarray, rng: np.random.Generator, width: float = 0.15) -> np.ndarray:
    """单声道转轻微立体声展宽。"""
    jitter = 1.0 + width * rng.standard_normal(len(mono))
    return np.stack([mono, mono * jitter], axis=1)


def generate(out_dir: str) -> list[dict]:
    rng = np.random.default_rng(RNG_SEED)
    n = int(SR * DUR)
    t = np.arange(n) / SR
    os.makedirs(out_dir, exist_ok=True)

    pink = 0.12 * _pink_noise(n, rng)
    hum = _hum(n, SR)
    floor = pink + hum  # 稳定底噪
    voice = _voice_like(n, SR, rng)
    # 告警演示样音: 近连续浊音, 保证任意取样窗口都能检出语音
    voice_dense = _continuous_voiced(n, SR, rng, level=0.5)

    specs = [
        {
            "file": "01_stationary_noise.wav",
            "title": "稳定底噪",
            "description": "持续粉噪与 50Hz 嗡声构成的稳定底噪, 叠加模拟语音; 前 0.6 秒为纯噪声, 适合做噪声样本。",
            "suggested_sample": [0.05, 0.55],
            "build": floor + voice,
        },
        {
            "file": "02_sudden_noise.wav",
            "title": "突然噪声",
            "description": "在稳定底噪与语音之外, 3.0 秒处出现一次约 0.4 秒的突发宽带噪声。",
            "suggested_sample": [0.05, 0.55],
            "build": floor + voice + _burst(n, SR, rng, 3.0, 0.4),
        },
        {
            "file": "03_transients.wav",
            "title": "短促敲击音",
            "description": "底噪中混入 5 个短促敲击声, 用于检验瞬态保护是否保留敲击。",
            "suggested_sample": [0.05, 0.55],
            "build": floor
            + _taps(n, SR, rng, [1.2, 2.4, 3.7, 5.1, 6.6])
            + 0.5 * voice,
        },
        {
            "file": "04_voice_in_sample.wav",
            "title": "噪声样本含语音(告警演示)",
            "description": "没有纯噪声段落, 任意取样都会包含语音, 用于触发样本污染告警。",
            "suggested_sample": [1.0, 1.6],
            "build": floor + voice_dense,
        },
    ]

    manifest = []
    import soundfile as sf

    for spec in specs:
        mono = spec.pop("build")
        stereo = _stereo(mono, rng)
        stereo /= max(1.0, np.max(np.abs(stereo)) / 0.95)
        path = os.path.join(out_dir, spec["file"])
        sf.write(path, stereo, SR, subtype="PCM_16")
        manifest.append({**spec, "sr": SR, "duration": DUR, "channels": 2})

    with open(os.path.join(out_dir, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    return manifest
