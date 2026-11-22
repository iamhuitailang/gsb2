"""matplotlib 绘图组件：波形、频谱、声谱图与框选交互。"""

from __future__ import annotations

import numpy as np

from matplotlib.axes import Axes
from matplotlib.figure import Figure
from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg
from matplotlib.widgets import SpanSelector

from ..analysis import power_spectrum, spectrogram
from ..audio import AudioData

# 统一配色（浅色主题，品牌中性）
COLOR_SRC = "#2563eb"      # 源：蓝
COLOR_LOW = "#dc2626"      # 低质量：红
COLOR_HIGH = "#16a34a"     # 高质量：绿
COLOR_SELECT = "#f59e0b"   # 框选：橙
GRID_COLOR = "#e5e7eb"


def _downsample_for_plot(x: np.ndarray, max_points: int = 4000) -> tuple[np.ndarray, np.ndarray]:
    """长信号降采样成包络（每块 min/max），避免画几十万个点卡顿。"""
    n = x.size
    if n <= max_points:
        return np.arange(n), x
    block = int(np.ceil(n / max_points))
    n_blocks = int(np.ceil(n / block))
    trimmed = x[: n_blocks * block].reshape(n_blocks, block)
    lo = trimmed.min(axis=1)
    hi = trimmed.max(axis=1)
    idx = np.arange(n_blocks) * block
    # 交错 min/max 画出包络
    xs = np.repeat(idx, 2) + np.tile([0, block - 1], n_blocks)
    ys = np.empty(2 * n_blocks)
    ys[0::2] = lo
    ys[1::2] = hi
    return xs, ys


class WaveformPlot:
    """单条波形（一个声道），支持 SpanSelector 框选。"""

    def __init__(self, ax: Axes, color: str, on_select=None) -> None:
        self.ax = ax
        self.color = color
        self.on_select = on_select
        self.line = None
        self.audio: AudioData | None = None
        self.selector: SpanSelector | None = None
        self._axvlines = []
        self._configure()

    def _configure(self) -> None:
        self.ax.grid(True, color=GRID_COLOR, linewidth=0.8)
        self.ax.set_ylim(-1.05, 1.05)
        self.ax.set_ylabel("幅度")

    def set_audio(self, audio: AudioData, title: str) -> None:
        self.audio = audio
        self.ax.clear()
        self._configure()
        self.ax.set_title(title, fontsize=10, loc="left")
        xs, ys = _downsample_for_plot(audio.samples[:, 0])
        t = xs / audio.sample_rate
        (self.line,) = self.ax.plot(t, ys, color=self.color, linewidth=0.7)
        self.ax.set_xlim(0, audio.duration)
        if self.on_select is not None:
            self.selector = SpanSelector(
                self.ax,
                self._handle_select,
                direction="horizontal",
                useblit=True,
                props=dict(alpha=0.25, facecolor=COLOR_SELECT, edgecolor=COLOR_SELECT),
                interactive=True,
            )

    def set_channel(self, channel: int) -> None:
        if self.audio is None:
            return
        self.ax.clear()
        self._configure()
        self.ax.set_title(self.ax.get_title(), fontsize=10, loc="left")
        xs, ys = _downsample_for_plot(self.audio.samples[:, channel])
        t = xs / self.audio.sample_rate
        self.ax.plot(t, ys, color=self.color, linewidth=0.7)
        self.ax.set_xlim(0, self.audio.duration)

    def _handle_select(self, xmin: float, xmax: float) -> None:
        if self.on_select is not None and xmax > xmin:
            self.on_select(xmin, xmax)

    def mark_samples(self, times: np.ndarray) -> None:
        """在指定时刻画竖线（框选片段里的采样点位置）。"""
        self.clear_marks()
        for t in times:
            line = self.ax.axvline(t, color="#111827", linewidth=0.6, alpha=0.5)
            self._axvlines.append(line)

    def clear_marks(self) -> None:
        for line in self._axvlines:
            try:
                line.remove()
            except (NotImplementedError, ValueError):
                if line in self.ax.lines:
                    self.ax.lines.remove(line)
        self._axvlines = []


class SpectrumPlot:
    """前后频谱对照（同一张图叠加）。"""

    def __init__(self, ax: Axes) -> None:
        self.ax = ax
        self._configure()

    def _configure(self) -> None:
        self.ax.clear()
        self.ax.grid(True, color=GRID_COLOR, linewidth=0.8)
        self.ax.set_xlabel("频率 (Hz)")
        self.ax.set_ylabel("幅度 (dBFS)")
        self.ax.set_ylim(-120, 5)

    def plot(self, src: AudioData, low: AudioData | None, high: AudioData | None,
             channel: int = 0) -> None:
        self._configure()
        f, db = power_spectrum(src.channel(channel), src.sample_rate)
        self.ax.plot(f, db, color=COLOR_SRC, linewidth=0.9,
                     label=f"源 {src.sample_rate}Hz")
        if low is not None:
            fl, dl = power_spectrum(low.channel(channel), low.sample_rate)
            self.ax.plot(fl, dl, color=COLOR_LOW, linewidth=0.9, alpha=0.85,
                         label=f"低质量 {low.sample_rate}Hz")
        if high is not None:
            fh, dh = power_spectrum(high.channel(channel), high.sample_rate)
            self.ax.plot(fh, dh, color=COLOR_HIGH, linewidth=0.9, alpha=0.85,
                         label=f"高质量 {high.sample_rate}Hz")
        # 目标 Nyquist 参考线
        if low is not None:
            self.ax.axvline(low.sample_rate / 2, color="#6b7280", linestyle="--",
                            linewidth=0.8, alpha=0.7)
            self.ax.text(low.sample_rate / 2, 0, f" Nyquist {low.sample_rate/2:g}Hz",
                         fontsize=8, color="#6b7280", va="top")
        self.ax.legend(fontsize=8, loc="upper right")


class SpectrogramPlot:
    """声谱图（STFT），用于看扫频的折叠镜像。"""

    def __init__(self, ax: Axes) -> None:
        self.ax = ax

    def plot(self, audio: AudioData, channel: int = 0, nfft: int = 1024) -> None:
        self.ax.clear()
        times, freqs, db = spectrogram(audio.channel(channel), audio.sample_rate, nfft)
        mesh = self.ax.pcolormesh(times, freqs, db, cmap="magma",
                                  vmin=-100, vmax=-10, shading="auto")
        self.ax.set_xlabel("时间 (s)")
        self.ax.set_ylabel("频率 (Hz)")
        self.ax.set_title(f"声谱图 {audio.sample_rate}Hz", fontsize=10, loc="left")
        return mesh


def make_figure(parent, figsize=(9, 5)) -> tuple[Figure, FigureCanvasTkAgg]:
    fig = Figure(figsize=figsize, dpi=100, layout="tight")
    canvas = FigureCanvasTkAgg(fig, master=parent)
    canvas.get_tk_widget().pack(fill="both", expand=True)
    return fig, canvas
