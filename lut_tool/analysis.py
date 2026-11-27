"""颜色突变与通道串换分析。

两类问题对应剪辑现场的两类典型故障：

* **颜色突变（banding / 阶梯）**：本应平滑的过渡出现不连续跳变，
  用一阶差分的局部异常尖峰定位；
* **通道串换（cross-talk / swap）**：某通道的纯斜坡在另外两个通道
  引起不该有的响应，或两个通道被整体互换，用相关/能量占比判断。
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .cube import CubeLUT
from .patterns import TestClipSpec, region_of_interest, render_frame


@dataclass
class Discontinuity:
    position: int  # 沿扫描方向的列/行索引
    channel: int
    jump: float
    expected: float  # 局部中位步长
    ratio: float  # jump / expected


@dataclass
class RampReport:
    channel: int
    mean_step: float
    max_jump: float
    max_jump_at: int
    spikes: list[Discontinuity] = field(default_factory=list)

    @property
    def smooth(self) -> bool:
        return not self.spikes


def scan_ramp_discontinuities(
    values: np.ndarray,
    channel: int,
    *,
    spike_ratio: float = 3.0,
    min_jump: float = 1e-3,
) -> RampReport:
    """扫描一条一维单调斜坡上的异常跳变。

    ``values`` 为单通道一维数组。正常步长取差分绝对值的中位数；
    超过 ``spike_ratio`` 倍中位步长且大于 ``min_jump`` 的位置记为突变。
    """
    values = np.asarray(values, dtype=np.float64).reshape(-1)
    diffs = np.diff(values)
    if len(diffs) == 0:
        return RampReport(channel, 0.0, 0.0, -1, [])

    abs_diffs = np.abs(diffs)
    median_step = float(np.median(abs_diffs)) or 1e-12
    spikes: list[Discontinuity] = []
    for i, d in enumerate(abs_diffs):
        if d > min_jump and d > spike_ratio * median_step:
            spikes.append(
                Discontinuity(
                    position=i + 1,
                    channel=channel,
                    jump=float(d),
                    expected=median_step,
                    ratio=float(d / median_step),
                )
            )
    max_i = int(np.argmax(abs_diffs))
    return RampReport(
        channel=channel,
        mean_step=float(abs_diffs.mean()),
        max_jump=float(abs_diffs[max_i]),
        max_jump_at=max_i + 1,
        spikes=spikes,
    )


@dataclass
class CrossTalkReport:
    """一条纯通道斜坡经过处理后的串换情况。"""

    driven_channel: int
    leakage: dict[int, float]  # 其它通道的响应能量（均方差）
    swapped_with: int | None  # 疑似整体互换的通道
    correlation: dict[int, float]
    gains: dict[int, float]  # 各通道输出跨度 / 驱动信号跨度

    @property
    def clean(self) -> bool:
        return self.swapped_with is None and all(
            v < 1e-4 for v in self.leakage.values()
        )


def scan_channel_crosstalk(
    src_ramp: np.ndarray,
    out_ramp: np.ndarray,
    driven: int,
    *,
    swap_corr: float = 0.98,
    swap_gain: float = 0.5,
    leak_threshold: float = 1e-4,
) -> CrossTalkReport:
    """对比纯通道斜坡的输入/输出，检查串扰与互换。

    ``src_ramp`` / ``out_ramp`` 形状均为 ``(N, 3)``；``driven`` 是被
    驱动的通道下标（0=R,1=G,2=B）。

    只看相关性会把“与驱动通道轻微联动”误判成互换，因此互换必须同时
    满足：目标通道高相关 **且** 增益接近驱动信号（``swap_gain``），
    而本通道自身输出已经失去信号。轻微联动只算串扰、不算互换。
    """
    src_ramp = np.asarray(src_ramp, dtype=np.float64)
    out_ramp = np.asarray(out_ramp, dtype=np.float64)
    leakage: dict[int, float] = {}
    correlation: dict[int, float] = {}
    gains: dict[int, float] = {}
    swapped: int | None = None

    driven_signal = src_ramp[:, driven]
    driven_span = float(np.ptp(driven_signal)) or 1.0
    own_gain = float(np.ptp(out_ramp[:, driven])) / driven_span

    for c in range(3):
        sig = out_ramp[:, c]
        gains[c] = float(np.ptp(sig)) / driven_span
        if c == driven:
            continue
        leakage[c] = float(np.mean(sig ** 2))
        if driven_span > 0:
            x = driven_signal - driven_signal.mean()
            y = sig - sig.mean()
            denom = np.sqrt(np.mean(x ** 2) * np.mean(y ** 2))
            correlation[c] = float(np.mean(x * y) / denom) if denom > 0 else 0.0
        else:
            correlation[c] = 0.0
        if (
            correlation[c] >= swap_corr
            and gains[c] >= swap_gain
            and own_gain < swap_gain
            and leakage[c] > leak_threshold
        ):
            swapped = c

    return CrossTalkReport(
        driven_channel=driven,
        leakage=leakage,
        swapped_with=swapped,
        correlation=correlation,
        gains=gains,
    )


# ---------------------------------------------------------------- 整帧/整表
def analyze_clip_frame(frame: np.ndarray, spec: TestClipSpec) -> dict:
    """对一帧测试画面同时跑突变与串换检查，返回结构化报告。"""
    x0, y0, x1, y1 = region_of_interest(spec, "smooth_gradient")
    band = frame[y0:y1, x0:x1]
    band_h = band.shape[0] // 3

    ramp_reports: list[RampReport] = []
    cross_reports: list[CrossTalkReport] = []
    for c in range(3):
        row = band[c * band_h + band_h // 2]  # 取每条带的中线
        ramp_reports.append(scan_ramp_discontinuities(row[:, c], c))

    # 串换检查：用原始测试片同位置斜坡作为输入基准。
    src = render_frame(spec, 0)[y0:y1, x0:x1]
    for c in range(3):
        row_in = src[c * band_h + band_h // 2]
        row_out = band[c * band_h + band_h // 2]
        cross_reports.append(scan_channel_crosstalk(row_in, row_out, c))

    return {
        "ramp_reports": ramp_reports,
        "cross_reports": cross_reports,
        "has_discontinuity": any(not r.smooth for r in ramp_reports),
        "has_crosstalk": any(not r.clean for r in cross_reports),
    }


def analyze_lut_shape(lut: CubeLUT, *, samples: int = 256) -> dict:
    """直接对表体做体检：单调性、突变、串换、输出越界。"""
    grid = np.linspace(0.0, 1.0, samples)

    # 延迟导入避免循环依赖。
    from .lut import apply_lut, clipped_mask

    monotonic_violations = []
    spike_channels = []
    cross: list[CrossTalkReport] = []

    for driven in range(3):
        probe = np.zeros((samples, 3), dtype=np.float64)
        probe[:, driven] = grid
        out = apply_lut(lut, probe)

        diffs = np.diff(out[:, driven])
        if np.any(diffs < -1e-6):
            monotonic_violations.append(
                (driven, int(np.argmin(diffs)) + 1, float(diffs.min()))
            )
        rep = scan_ramp_discontinuities(out[:, driven], driven)
        if not rep.smooth:
            spike_channels.append(rep)
        cross.append(scan_channel_crosstalk(probe, out, driven))

    # 全网格在大表上很贵，改成抽样网格。
    sub = 24
    g = np.linspace(0.0, 1.0, sub)
    xx, yy, zz = np.meshgrid(g, g, g, indexing="ij")
    pts = np.stack([xx, yy, zz], axis=-1).reshape(-1, 3)
    outs = apply_lut(lut, pts)
    clip = clipped_mask(outs)

    return {
        "monotonic_violations": monotonic_violations,
        "spike_channels": spike_channels,
        "cross_reports": cross,
        "output_clipped_ratio": float(clip.mean()),
        "output_min": outs.min(axis=0),
        "output_max": outs.max(axis=0),
    }
