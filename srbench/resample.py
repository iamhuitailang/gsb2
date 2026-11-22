"""采样率转换：两条质量路径 + 统一的长度取整规则。

取整规则（两条路径完全一致，保证可对照、片尾规则一致）：
    输出采样点数 n_out = ceil(n_in * up / down)
    即“向上取整，宁可多一个输出采样，也不丢尾部”。
    对应时长 n_out / f_out，与原时长的偏差始终小于一个输出采样间隔。
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
from scipy.signal import firwin, kaiserord, resample_poly

from . import QUALITY_HIGH, QUALITY_LOW
from .audio import AudioData


def ratio_parts(src_rate: int, dst_rate: int) -> tuple[int, int]:
    """把采样率比约分为 (up, down)。"""
    g = math.gcd(int(src_rate), int(dst_rate))
    return int(dst_rate) // g, int(src_rate) // g


def output_length(n_in: int, up: int, down: int) -> int:
    """统一取整规则：ceil(n_in * up / down)。"""
    return math.ceil(n_in * up / down)


def source_index_for_output(k: np.ndarray | int, up: int, down: int) -> np.ndarray:
    """输出采样 k 对应的（分数）源采样位置 k*down/up。"""
    return np.asarray(k, dtype=np.float64) * down / up


@dataclass
class ResampleResult:
    audio: AudioData
    quality: str
    up: int
    down: int
    filter_taps: int          # 低质量路径为 0
    expected_length: int
    group_delay: float       # 以“输出采样”为单位；低质量为 0

    @property
    def length_rule_ok(self) -> bool:
        return self.audio.n_frames == self.expected_length


# Kaiser 窗参数：旁瓣抑制 ~90dB
_KAISER_RIPPLE_DB = 90.0
_TRANS_FRAC = 0.10          # 过渡带宽度占目标 Nyquist 的比例
_MAX_TAPS = 2001


def _design_filter(up: int, down: int) -> np.ndarray:
    """设计多相 FIR 抗混叠滤波器（归一化 Nyquist=1 约定，系数和为 1）。

    关键约定（与 scipy.signal.resample_poly 内部一致）：
    - 滤波器在 up/down 的公共归一化率上设计，目标 Nyquist 对应
      归一化频率 ``1/max(up, down)``；
    - 过渡带以目标 Nyquist 为中心（通带边 = Nyquist - 半过渡带），
      保证超过目标 Nyquist 的频率落入阻带；
    - 用 kaiserord 按纹波/过渡带反算抽头数；
    - 返回的 FIR 系数和为 1；resample_poly 内部会自行乘以 up，
      因此这里**不能**再手动缩放，否则增益会错。
    """
    f_nyq = 1.0 / max(up, down)
    width = _TRANS_FRAC * f_nyq
    f_c = f_nyq - width / 2.0
    n_taps, beta = kaiserord(_KAISER_RIPPLE_DB, width)
    n_taps = int(np.clip(n_taps, 63, _MAX_TAPS))
    if n_taps % 2 == 0:
        n_taps += 1
    h = firwin(n_taps, f_c, window=("kaiser", beta))
    return h


def resample_high(audio: AudioData, dst_rate: int) -> ResampleResult:
    """高质量：Kaiser 窗 FIR 抗混叠 + 多相滤波（scipy.signal.resample_poly）。"""
    up, down = ratio_parts(audio.sample_rate, dst_rate)
    h = _design_filter(up, down)
    n_expect = output_length(audio.n_frames, up, down)

    out = resample_poly(audio.samples, up, down, window=h, axis=0)
    # resample_poly 的长度约定与本模块的 ceil 规则对齐；保险起见按规则裁/补
    out = _fit_length(out, n_expect)
    group_delay = ((len(h) - 1) / 2.0) / up  # 输出采样单位
    return ResampleResult(
        audio=AudioData(out, dst_rate, name=f"{audio.name}@{dst_rate}_high"),
        quality=QUALITY_HIGH,
        up=up,
        down=down,
        filter_taps=len(h),
        expected_length=n_expect,
        group_delay=group_delay,
    )


def resample_low(audio: AudioData, dst_rate: int) -> ResampleResult:
    """低质量：线性插值，无任何抗混叠滤波（混叠会原样暴露，用于对照）。"""
    up, down = ratio_parts(audio.sample_rate, dst_rate)
    n_expect = output_length(audio.n_frames, up, down)
    n_in = audio.n_frames

    # 输出采样 k 对应源位置 k*down/up，线性插值到该位置
    k = np.arange(n_expect, dtype=np.float64)
    src_pos = k * down / up
    i0 = np.floor(src_pos).astype(np.int64)
    frac = src_pos - i0
    i1 = np.minimum(i0 + 1, n_in - 1)
    i0c = np.minimum(i0, n_in - 1)
    x0 = audio.samples[i0c, :]
    x1 = audio.samples[i1, :]
    out = x0 + (x1 - x0) * frac[:, None]

    return ResampleResult(
        audio=AudioData(out, dst_rate, name=f"{audio.name}@{dst_rate}_low"),
        quality=QUALITY_LOW,
        up=up,
        down=down,
        filter_taps=0,
        expected_length=n_expect,
        group_delay=0.0,
    )


def _fit_length(out: np.ndarray, n_expect: int) -> np.ndarray:
    n = out.shape[0]
    if n == n_expect:
        return out
    if n > n_expect:
        return out[:n_expect]
    pad = np.zeros((n_expect - n, out.shape[1]), dtype=out.dtype)
    return np.concatenate([out, pad], axis=0)


def resample(audio: AudioData, dst_rate: int, quality: str) -> ResampleResult:
    if dst_rate == audio.sample_rate:
        up, down = ratio_parts(audio.sample_rate, dst_rate)  # 1, 1
        n = audio.n_frames
        return ResampleResult(
            audio=AudioData(audio.samples.copy(), dst_rate, name=f"{audio.name}@{dst_rate}"),
            quality=quality,
            up=1,
            down=1,
            filter_taps=0,
            expected_length=n,
            group_delay=0.0,
        )
    if quality == QUALITY_HIGH:
        return resample_high(audio, dst_rate)
    if quality == QUALITY_LOW:
        return resample_low(audio, dst_rate)
    raise ValueError(f"未知质量档位: {quality}")
