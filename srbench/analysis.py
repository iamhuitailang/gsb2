"""频谱 / 混叠 / 峰值对齐 / 时长取整等分析工具。"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .audio import AudioData
from .resample import output_length, ratio_parts, source_index_for_output


# ---------------------------------------------------------------- 频谱

def power_spectrum(x: np.ndarray, sample_rate: int, nfft: int | None = None) -> tuple[np.ndarray, np.ndarray]:
    """单边幅度谱（dBFS）。x 为单声道一维数组，返回 (频率轴, dB)。"""
    x = np.asarray(x, dtype=np.float64)
    n = x.size
    if nfft is None:
        nfft = max(2048, 1 << int(np.ceil(np.log2(max(8, n)))))
    nfft = min(nfft, 1 << 16)
    win = np.hanning(n)
    xw = x * win
    spec = np.fft.rfft(xw, n=nfft)
    freqs = np.fft.rfftfreq(nfft, d=1.0 / sample_rate)
    # 加窗后做幅度归一（窗能量补偿），dBFS 以满量程 1.0 为参考
    win_gain = np.sum(win)
    mag = np.abs(spec) / max(win_gain, 1e-12) * 2.0
    mag[0] /= 2.0
    if nfft % 2 == 0:
        mag[-1] /= 2.0
    db = 20.0 * np.log10(np.maximum(mag, 1e-10))
    return freqs, db


def dominant_frequency(x: np.ndarray, sample_rate: int) -> tuple[float, float]:
    """返回 (主峰频率 Hz, 主峰 dB)。"""
    freqs, db = power_spectrum(x, sample_rate)
    # 跳过直流 bin
    k = int(np.argmax(db[1:]) + 1)
    return float(freqs[k]), float(db[k])


def spectrogram(x: np.ndarray, sample_rate: int, nfft: int = 1024, hop: int | None = None
                ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """简易 STFT，返回 (时间轴, 频率轴, dB 矩阵)。"""
    if hop is None:
        hop = nfft // 4
    x = np.asarray(x, dtype=np.float64)
    win = np.hanning(nfft)
    starts = list(range(0, max(1, x.size - nfft + 1), hop))
    if not starts:
        starts = [0]
    spec = np.empty((nfft // 2 + 1, len(starts)), dtype=np.float64)
    for j, s in enumerate(starts):
        seg = x[s:s + nfft]
        if seg.size < nfft:
            seg = np.pad(seg, (0, nfft - seg.size))
        spec[:, j] = np.abs(np.fft.rfft(seg * win)) / np.sum(win) * 2.0
    times = np.array(starts, dtype=np.float64) / sample_rate
    freqs = np.fft.rfftfreq(nfft, d=1.0 / sample_rate)
    db = 20.0 * np.log10(np.maximum(spec, 1e-10))
    return times, freqs, db


# ---------------------------------------------------------------- 混叠

def fold_frequency(f: float, nyquist: float) -> float:
    """频率 f 越过 Nyquist 后折叠到的“假频率”（镜像折叠）。"""
    if f <= nyquist:
        return f
    # 折叠周期 2*Nyquist，镜像
    phase = f % (2 * nyquist)
    return phase if phase <= nyquist else 2 * nyquist - phase


def alias_band_energy(x: np.ndarray, src_rate: int, dst_rate: int,
                      guard: float = 0.95) -> tuple[float, float, float]:
    """估计混叠能量占比。

    思路：对源信号里超过 dst Nyquist*guard 的高频成分，按折叠规则映射到
    目标带内；再比较输出信号在这些“假频率 bin”上的能量与总能量。
    返回 (混叠带能量占比 dB, 目标带内总能量, 混叠带能量)，均为线性幅度平方和口径。
    """
    dst_nyq = dst_rate / 2.0
    n = x.size
    nfft = max(2048, 1 << int(np.ceil(np.log2(max(8, n)))))
    nfft = min(nfft, 1 << 16)
    spec = np.abs(np.fft.rfft(x * np.hanning(n), n=nfft)) ** 2
    freqs = np.fft.rfftfreq(nfft, d=1.0 / src_rate)

    # 源中超出目标表示范围的能量（本应被抗混叠滤掉的部分）
    high_mask = freqs > dst_nyq * guard
    high_energy = float(np.sum(spec[high_mask]))

    # 这些高频折叠到目标带内的位置
    alias_bins = set()
    for f in freqs[high_mask]:
        fa = fold_frequency(float(f), dst_nyq)
        alias_bins.add(int(round(fa * nfft / src_rate)))
    alias_bins.discard(0)
    total = float(np.sum(spec)) + 1e-20
    return 10.0 * np.log10((high_energy + 1e-20) / total), total, high_energy


# ---------------------------------------------------------------- 峰值对齐

@dataclass
class PeakInfo:
    index: int
    time: float
    value: float


def find_peak(x: np.ndarray, sample_rate: int) -> PeakInfo:
    x = np.asarray(x, dtype=np.float64)
    # 用绝对值峰值，脉冲和稳态正弦都适用
    idx = int(np.argmax(np.abs(x)))
    return PeakInfo(index=idx, time=idx / sample_rate, value=float(x[idx]))


@dataclass
class AlignmentReport:
    src_rate: int
    dst_rate: int
    channels: int
    # 每个声道：源峰、低质量输出峰、高质量输出峰
    per_channel: list[dict] = field(default_factory=list)
    low_peak_offset_samples: list[int] = field(default_factory=list)   # 左右峰位置差（输出采样）
    high_peak_offset_samples: list[int] = field(default_factory=list)

    @property
    def low_aligned(self) -> bool:
        return all(o == 0 for o in self.low_peak_offset_samples)

    @property
    def high_aligned(self) -> bool:
        return all(o == 0 for o in self.high_peak_offset_samples)


def check_peak_alignment(src: AudioData, low: AudioData, high: AudioData) -> AlignmentReport:
    """检查左右声道同一时刻的峰在转换后是否仍在同一输出采样上。"""
    report = AlignmentReport(src.sample_rate, low.sample_rate, src.channels)
    low_peaks, high_peaks = [], []
    for ch in range(src.channels):
        sp = find_peak(src.channel(ch), src.sample_rate)
        lp = find_peak(low.channel(ch), low.sample_rate)
        hp = find_peak(high.channel(ch), high.sample_rate)
        report.per_channel.append({
            "channel": ch,
            "src_peak_index": sp.index, "src_peak_time": sp.time, "src_peak_value": sp.value,
            "low_peak_index": lp.index, "low_peak_time": lp.time, "low_peak_value": lp.value,
            "high_peak_index": hp.index, "high_peak_time": hp.time, "high_peak_value": hp.value,
            # 高质量路径的理论峰位（含 FIR 群延迟）
            "high_expected_index": lp.index,  # 与低质量共用映射，延迟另行报告
        })
        low_peaks.append(lp.index)
        high_peaks.append(hp.index)
    if src.channels >= 2:
        report.low_peak_offset_samples = [low_peaks[c] - low_peaks[0] for c in range(src.channels)]
        report.high_peak_offset_samples = [high_peaks[c] - high_peaks[0] for c in range(src.channels)]
    return report


# ---------------------------------------------------------------- 时长取整

@dataclass
class LengthReport:
    src_frames: int
    src_rate: int
    dst_rate: int
    up: int
    down: int
    expected_frames: int
    low_frames: int
    high_frames: int
    rule: str = "ceil(n_in * up / down)"

    @property
    def low_ok(self) -> bool:
        return self.low_frames == self.expected_frames

    @property
    def high_ok(self) -> bool:
        return self.high_frames == self.expected_frames

    @property
    def duration_error_seconds(self) -> float:
        return abs(self.expected_frames / self.dst_rate - self.src_frames / self.src_rate)


def check_lengths(src: AudioData, low: AudioData, high: AudioData) -> LengthReport:
    up, down = ratio_parts(src.sample_rate, low.sample_rate)
    expect = output_length(src.n_frames, up, down)
    return LengthReport(
        src_frames=src.n_frames,
        src_rate=src.sample_rate,
        dst_rate=low.sample_rate,
        up=up,
        down=down,
        expected_frames=expect,
        low_frames=low.n_frames,
        high_frames=high.n_frames,
    )


def map_selection_to_output(src_i0: int, src_i1: int, src_rate: int, dst_rate: int
                            ) -> tuple[int, int, np.ndarray]:
    """把源上的框选区间映射到输出采样区间。

    返回 (输出起点, 输出终点(不含), 每个输出采样对应的分数源位置)。
    """
    up, down = ratio_parts(src_rate, dst_rate)
    # 源采样 i 对应输出位置 i*up/down；框选边界同样按 ceil 规则
    o0 = int(np.floor(src_i0 * up / down))
    o1 = output_length(src_i1, up, down)
    ks = np.arange(o0, o1)
    src_pos = source_index_for_output(ks, up, down)
    return o0, o1, src_pos


# ---------------------------------------------------------------- 混叠残留测量

def alias_residual_energy(src_x: np.ndarray, src_rate: int,
                          out_x: np.ndarray, dst_rate: int,
                          guard: float = 0.95) -> tuple[float, float, float]:
    """测量输出信号里“由源高频折叠而来”的带内残留，用绝对 dBFS 口径。

    1) 在源频谱里找出超过 dst Nyquist*guard、且确实有能量的频率 bin；
    2) 按镜像折叠规则算出它们落到目标带内的假频率；
    3) 在输出频谱里定位这些假频率 bin，统计其加窗幅度，换算成 dBFS
       （以满量程 1.0 为参考，做窗增益补偿）。

    必须用绝对幅度而非“占总能量比例”：高质量抗混叠会把总能量也压下去，
    占比口径会反过来显得高质量更差。两条路径同口径，可直接比较。
    没有可折叠的高频时返回 -inf。
    """
    dst_nyq = dst_rate / 2.0
    n_src = src_x.size
    nfft_src = min(1 << 16, max(2048, 1 << int(np.ceil(np.log2(max(8, n_src))))))
    src_spec = np.abs(np.fft.rfft(src_x * np.hanning(n_src), n=nfft_src)) ** 2
    src_freqs = np.fft.rfftfreq(nfft_src, d=1.0 / src_rate)
    high_mask = src_freqs > dst_nyq * guard
    if not np.any(high_mask) or np.sum(src_spec[high_mask]) < 1e-12:
        return -np.inf, 0.0, 0.0

    folded_freqs = sorted({
        fold_frequency(float(f), dst_nyq)
        for f, e in zip(src_freqs[high_mask], src_spec[high_mask]) if e > 1e-9
    })
    if not folded_freqs:
        return -np.inf, 0.0, 0.0

    n_out = out_x.size
    nfft_out = min(1 << 16, max(2048, 1 << int(np.ceil(np.log2(max(8, n_out))))))
    win = np.hanning(n_out)
    win_gain = np.sum(win) / 2.0  # 单边幅度谱的窗增益补偿
    out_mag = np.abs(np.fft.rfft(out_x * win, n=nfft_out)) / win_gain
    out_freqs = np.fft.rfftfreq(nfft_out, d=1.0 / dst_rate)
    bins = sorted({int(np.argmin(np.abs(out_freqs - fa))) for fa in folded_freqs})
    bins = [b for b in bins if b > 0]
    alias_amp = float(np.sqrt(np.sum(out_mag[bins] ** 2)))
    total_amp = float(np.sqrt(np.sum(out_mag ** 2)))
    db = 20.0 * np.log10(alias_amp + 1e-12)  # dBFS，参考满量程 1.0
    return db, total_amp, alias_amp
