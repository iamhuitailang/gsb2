"""选择性地去拖影。

核心是频域约束最小二乘（Tikhonov / Wiener 形式）：

    X(ω) = conj(H)·Y / (|H|² + λ·D̂(ω))

- H 是拖影 PSF 的传递函数；D̂ 是归一化拉普拉斯高通谱，只用来压制拖影
  零陷附近的噪声放大；
- ``noise_gain`` 是"最多把某个频点放大多少倍"的硬上限：求解后取整个频谱
  的增益峰值 |conj(H)/(|H|²+λD̂)|，超过上限就加大 λ 重解，直到峰值达标。
  因此面板上的旋钮直接对应噪点放大倍数，而不是抽象的 λ。

暗边/过冲控制（``shadow_limit`` / ``overshoot``）：
- 先求参考图（模糊输入）在约 PSF 尺度邻域内的局部包络 [env_lo, env_hi]；
- 允许结果落到 ``[env_lo - s·c, env_hi + o·c]``，其中 ``c = env_hi - env_lo``
  是局部对比度，s/o 就是两个参数（按局部对比度的比例）；
- 超出部分用窄 tanh 软限幅，避免硬截断产生二次振铃。
这样"暗边被放大多少"是按局部对比度归一化的，平坦噪声区几乎不允许额外变暗，
强对比边缘附近则允许充分的恢复。
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from .image_io import clip01, luma, with_luma
from .kernel import motion_psf, next_fast_len, psf_radius


@dataclass
class DeblurParams:
    length_px: float
    angle_deg: float
    noise_gain: float = 4.0
    regularization: float = 2.5
    shadow_limit: float = 0.5
    overshoot: float = 0.5

    def to_dict(self) -> dict:
        return {
            "length_px": float(self.length_px),
            "angle_deg": float(self.angle_deg),
            "noise_gain": float(self.noise_gain),
            "regularization": float(self.regularization),
            "shadow_limit": float(self.shadow_limit),
            "overshoot": float(self.overshoot),
        }


@dataclass
class DeblurStats:
    effective_noise_gain: float
    mean_noise_gain: float
    lambda_used: float
    highlight_clipped_fraction: float = 0.0
    shadow_clipped_fraction: float = 0.0

    def to_dict(self) -> dict:
        return {
            "effective_noise_gain": float(self.effective_noise_gain),
            "mean_noise_gain": float(self.mean_noise_gain),
            "lambda_used": float(self.lambda_used),
            "highlight_clipped_fraction": float(self.highlight_clipped_fraction),
            "shadow_clipped_fraction": float(self.shadow_clipped_fraction),
        }


# ---------------------------------------------------------------------------
# 频域准备
# ---------------------------------------------------------------------------


def _laplacian_spectrum(shape: tuple[int, int]) -> np.ndarray:
    h, w = shape
    fy = np.fft.fftfreq(h)[:, None]
    fx = np.fft.rfftfreq(w)[None, :]
    return (2.0 * np.cos(2.0 * np.pi * fx) - 2.0) + (2.0 * np.cos(2.0 * np.pi * fy) - 2.0)


def _psf_spectrum(psf: np.ndarray, shape: tuple[int, int]) -> np.ndarray:
    """把 PSF 放到 FFT 网格上，并把核中心滚到原点以去掉相位斜坡。"""
    h, w = shape
    kh, kw = psf.shape
    if kh > h or kw > w:
        raise ValueError("PSF 比 FFT 网格大")
    pad = np.zeros((h, w), dtype=np.float64)
    pad[:kh, :kw] = psf
    pad = np.roll(pad, (-(kh // 2), -(kw // 2)), axis=(0, 1))
    return np.fft.rfft2(pad)


@dataclass
class _Prepared:
    y_spec: np.ndarray
    h_spec: np.ndarray
    dn2: np.ndarray
    shape: tuple[int, int]
    pad: tuple[int, int] = (0, 0)  # 实际使用的 (pad_y, pad_x)


def prepare(lum: np.ndarray, psf: np.ndarray, pad: int) -> _Prepared:
    """对亮度块做镜像填充 + FFT。"""
    a = np.asarray(lum, dtype=np.float64)
    pad = max(0, int(pad))
    # 对称延拓要求 pad 小于对应维度，小图时按需收缩
    pad_y = min(pad, max(0, a.shape[0] - 1))
    pad_x = min(pad, max(0, a.shape[1] - 1))
    padded = np.pad(a, ((pad_y, pad_y), (pad_x, pad_x)), mode="symmetric") if pad else a.copy()
    kh, kw = psf.shape
    nh = next_fast_len(max(padded.shape[0], kh) + 2)
    nw = next_fast_len(max(padded.shape[1], kw) + 2)
    grid = np.zeros((nh, nw), dtype=np.float64)
    grid[: padded.shape[0], : padded.shape[1]] = padded

    h_spec = _psf_spectrum(psf, (nh, nw))
    d2 = np.abs(_laplacian_spectrum((nh, nw))) ** 2
    d2_max = float(np.max(d2)) if np.any(d2 > 0) else 1.0
    dn2 = d2 / max(1e-12, d2_max)
    return _Prepared(
        y_spec=np.fft.rfft2(grid),
        h_spec=h_spec,
        dn2=dn2,
        shape=(nh, nw),
        pad=(pad_y, pad_x),
    )


def _gain(h_spec: np.ndarray, dn2: np.ndarray, lam: float) -> np.ndarray:
    denom = np.abs(h_spec) ** 2 + lam * dn2 + 1e-15
    return np.abs(np.conj(h_spec)) / denom


def _tune_lambda(
    h_spec: np.ndarray, dn2: np.ndarray, params: DeblurParams
) -> tuple[float, np.ndarray, float]:
    """选 λ 使全频带增益峰值|conj(H)/(|H|²+λD̂)|不超过 ``noise_gain``。

    逐频点闭式解：要求 |H|/(|H|²+λD̂) ≤ g
        => λ ≥ (|H|/g − |H|²) / D̂        （当右端 > 0）
    取所有频点的最大值即可得到满足上限的最小 λ（再加 2% 余量）。
    这比迭代逼近更可靠——上限是硬保证，而不是"大概收敛"。
    """
    h2 = np.abs(h_spec) ** 2
    abs_h = np.abs(h_spec)
    lam0 = max(1e-12, params.regularization * 1e-3 * float(h2.max() or 1.0))

    cap = max(1.0, float(params.noise_gain))
    with np.errstate(divide="ignore", invalid="ignore"):
        need = (abs_h / cap - h2) / np.maximum(dn2, 1e-12)
    need = np.where((dn2 > 0) & np.isfinite(need) & (need > 0), need, 0.0)
    lam_req = float(need.max()) if need.size else 0.0

    lam = max(lam0, lam_req * 1.02)
    gain = _gain(h_spec, dn2, lam)
    peak = float(np.max(gain))
    return lam, gain, peak


def solve(prep: _Prepared, params: DeblurParams) -> tuple[np.ndarray, DeblurStats]:
    lam, gain, peak = _tune_lambda(prep.h_spec, prep.dn2, params)
    x_spec = (
        np.conj(prep.h_spec) * prep.y_spec
        / (np.abs(prep.h_spec) ** 2 + lam * prep.dn2 + 1e-15)
    )
    out = np.fft.irfft2(x_spec, s=prep.shape)
    stats = DeblurStats(
        effective_noise_gain=float(peak),
        mean_noise_gain=float(np.mean(gain)),
        lambda_used=float(lam),
    )
    return out.astype(np.float32), stats


# ---------------------------------------------------------------------------
# 局部包络与过冲限制
# ---------------------------------------------------------------------------


def _minmax_axis(a: np.ndarray, r: int, axis: int) -> tuple[np.ndarray, np.ndarray]:
    """只沿 axis 做窗口 min/max，其它轴保持原长。

    注意只能 pad 目标轴；若对两个轴都 pad，第二个轴算完会多出 2r 行/列，
    和原图对不齐。
    """
    from numpy.lib.stride_tricks import sliding_window_view

    pad_width = [(0, 0)] * a.ndim
    pad_width[axis] = (r, r)
    p = np.pad(a, pad_width, mode="edge")
    win = sliding_window_view(p, 2 * r + 1, axis=axis)
    return win.min(axis=-1), win.max(axis=-1)


def local_envelope(lum: np.ndarray, radius: int) -> tuple[np.ndarray, np.ndarray]:
    """参考图在邻域内的局部最小/最大值（可分离的 min/max 滤波）。"""
    a = np.asarray(lum, dtype=np.float32)
    r = int(np.clip(radius, 1, 48))
    lo, hi = _minmax_axis(a, r, 0)
    lo, hi = _minmax_axis(lo, r, 1)[0], _minmax_axis(hi, r, 1)[1]
    return lo, hi


def limit_excursions(
    est: np.ndarray,
    env_lo: np.ndarray,
    env_hi: np.ndarray,
    shadow_limit: float,
    overshoot: float,
    knee: float = 0.02,
) -> tuple[np.ndarray, float, float]:
    """把结果限制在局部包络外的允许范围内，超出部分用窄 tanh 软限幅。

    shadow_limit / overshoot 是局部对比度的比例。
    """
    est = np.asarray(est, dtype=np.float32)
    contrast = np.maximum(env_hi - env_lo, 1e-3)
    lower = env_lo - float(shadow_limit) * contrast
    upper = env_hi + float(overshoot) * contrast

    out = est.copy()
    hi_excess = est > upper
    lo_excess = est < lower
    if np.any(hi_excess):
        ex = est[hi_excess] - upper[hi_excess]
        out[hi_excess] = upper[hi_excess] + knee * np.tanh(ex / knee)
    if np.any(lo_excess):
        ex = lower[lo_excess] - est[lo_excess]
        out[lo_excess] = lower[lo_excess] - knee * np.tanh(ex / knee)

    hi_frac = float(np.mean(hi_excess)) if est.size else 0.0
    lo_frac = float(np.mean(lo_excess)) if est.size else 0.0
    return out, hi_frac, lo_frac


# ---------------------------------------------------------------------------
# 单块处理
# ---------------------------------------------------------------------------


def suggested_padding(length_px: float, extra: int = 16) -> int:
    """处理块的余量：覆盖 PSF 半径再留一点，减少边界拼接痕迹。"""
    return int(psf_radius(motion_psf(length_px, 0.0)) + extra)


def suggested_envelope_radius(length_px: float) -> int:
    return int(np.clip(np.ceil(length_px) + 2, 2, 48))


def deblur_luma_region(
    lum: np.ndarray,
    params: DeblurParams,
    pad: int | None = None,
    psf: np.ndarray | None = None,
) -> tuple[np.ndarray, DeblurStats]:
    """对亮度块去模糊，返回同尺寸结果与统计。"""
    a = np.asarray(lum, dtype=np.float32)
    if params.length_px < 0.75:
        # 没有拖影：保持像素不变，避免无谓的高通衰减
        return a.copy(), DeblurStats(1.0, 1.0, 0.0)

    if psf is None:
        psf = motion_psf(params.length_px, params.angle_deg)
    pad = suggested_padding(params.length_px) if pad is None else int(pad)

    prep = prepare(a, psf, pad)
    est, stats = solve(prep, params)
    py, px = prep.pad
    cropped = est[py : py + a.shape[0], px : px + a.shape[1]]
    if cropped.shape != a.shape:
        # 小图极端情况下网格不足，退化为不处理而不是错位裁剪
        return a.copy(), DeblurStats(1.0, 1.0, 0.0)

    r = suggested_envelope_radius(params.length_px)
    env_lo, env_hi = local_envelope(a, r)
    limited, hi, lo = limit_excursions(
        cropped, env_lo, env_hi, params.shadow_limit, params.overshoot
    )
    stats.highlight_clipped_fraction = hi
    stats.shadow_clipped_fraction = lo
    return clip01(limited), stats


def deblur_image_region(
    img: np.ndarray,
    params: DeblurParams,
    pad: int | None = None,
    psf: np.ndarray | None = None,
) -> tuple[np.ndarray, DeblurStats]:
    """对 RGB 块去模糊：只改亮度，保留色度。"""
    a = np.asarray(img, dtype=np.float32)
    if a.ndim == 2 or a.shape[2] == 1:
        lum = a if a.ndim == 2 else a[..., 0]
        out, stats = deblur_luma_region(lum, params, pad=pad, psf=psf)
        return (out if a.ndim == 2 else out[..., None]), stats

    lum = luma(a)
    out_lum, stats = deblur_luma_region(lum, params, pad=pad, psf=psf)
    rgb = with_luma(a, out_lum)
    return clip01(rgb).astype(np.float32), stats


# ---------------------------------------------------------------------------
# 频响（给 UI 展示"能恢复多少"）
# ---------------------------------------------------------------------------


def frequency_response_1d(
    params: DeblurParams, n: int = 256, psf: np.ndarray | None = None
) -> dict:
    """沿拖影方向的一维响应：OTF、恢复增益与拖影第一零点。

    在 2D 频谱里沿拖影方向取一条射线（频率半径 0..0.5），得到该方向上的
    H 与正则项；增益曲线与 ``freq`` 同长，可直接画图。
    """
    psf = motion_psf(params.length_px, params.angle_deg) if psf is None else psf
    h_spec = _psf_spectrum(psf, (n, n))
    d2 = np.abs(_laplacian_spectrum((n, n))) ** 2
    dn2 = d2 / max(1e-12, float(np.max(d2)))

    radii = np.fft.rfftfreq(n)  # 0 .. 0.5
    ang = math.radians(params.angle_deg)
    ca, sa = abs(math.cos(ang)), math.sin(ang)
    ix = np.clip(np.rint(ca * radii * n).astype(int), 0, n // 2)
    iy = np.rint(sa * radii * n).astype(int) % n
    h_line = h_spec[iy, ix]
    d_line = dn2[iy, ix]

    lam, gain, peak = _tune_lambda(h_line, d_line, params)
    # OTF 沿该方向的幅度：DC 为 1，第一零点在 1/L 周/像素
    otf = np.abs(h_line)
    return {
        "freq": radii,
        "gain": np.asarray(gain, dtype=np.float64),
        "otf": otf,
        "lambda": float(lam),
        "noise_gain": float(peak),
        "first_zero_cycles_per_px": (1.0 / params.length_px) if params.length_px > 1e-6 else None,
    }
