"""由参考边剖面估计拖影长度与方向。

物理模型
--------
抓拍拖影近似为沿某方向的均匀线段。设真实边（含传感器软化 σ0）为
``softstep((u-u0)/σ0)``，沿法向 φ 观察时，它先被宽度 ``w = L·|cos(θ-φ)|``
的盒核抹平，再叠加暗电平 A 与对比度 B：

    m(u) = A + B · T((u-u0)/w, σ0)

T 是"盒核抹平后的软阶跃"，有解析式（见 ``_trapezoid``）。拟合参数
``(A, B, u0, w, σ0)``，其中 ``w`` 就是投影到法向的拖影长度。

单条边只能测到投影 w；要同时得到长度 L 和方向 θ，需要至少两条法向不同的边，
用 ``w_i = L·|cos(θ-φ_i)|`` 做加权最小二乘。单边情形会明确报告"方向未知，
长度随 1/cos 放大"的依赖关系，并给出可用范围，避免给出虚假的确定值。
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

from .kernel import angle_difference, wrap_angle
from .profile import Profile


# ---------------------------------------------------------------------------
# 模型
# ---------------------------------------------------------------------------

SQRT_PI = math.sqrt(math.pi)


def _erf(x: np.ndarray) -> np.ndarray:
    """向量化 erf（Abramowitz-Stegun 7.1.26，最大误差 ~1.5e-7）。

    比 np.vectorize(math.erf) 快两个数量级，且不依赖 SciPy。
    """
    x = np.asarray(x, dtype=np.float64)
    ax = np.abs(x)
    t = 1.0 / (1.0 + 0.3275911 * ax)
    poly = t * (
        0.254829592
        + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))
    )
    y = 1.0 - poly * np.exp(-ax * ax)
    return np.sign(x) * y


def _phi(x: np.ndarray, sigma: float) -> np.ndarray:
    """∫_0^x erf(t/(√2σ)) dt 的闭式解。"""
    a = 1.0 / (math.sqrt(2.0) * max(1e-6, sigma))
    ax = a * x
    return x * _erf(ax) + np.exp(-(ax * ax)) / (a * SQRT_PI)


def _trapezoid(x: np.ndarray, w: float, sigma: float) -> np.ndarray:
    """软阶跃被宽度 w 的盒核抹平后的值，范围 0..1。"""
    w = max(1e-6, float(w))
    lo = _phi(x - 0.5 * w, sigma)
    hi = _phi(x + 0.5 * w, sigma)
    return np.clip(0.5 + 0.5 * (hi - lo) / w, 0.0, 1.0)


def _edge_model(params: np.ndarray, u: np.ndarray) -> np.ndarray:
    a, b, u0, w, sigma = params
    return a + b * _trapezoid(u - u0, w, sigma)


# ---------------------------------------------------------------------------
# 带边界的 Levenberg-Marquardt（NumPy-only，保证环境一致）
# ---------------------------------------------------------------------------


def _numeric_jacobian(fun, params: np.ndarray, *args) -> np.ndarray:
    """中心差分求 fun 对 params 的雅可比 (n_out, n_par)。"""
    p = np.asarray(params, dtype=np.float64)
    base = fun(p, *args)
    jac = np.empty((base.size, p.size), dtype=np.float64)
    for i in range(p.size):
        step = 1e-5 * max(1.0, abs(p[i]))
        pp = p.copy()
        pp[i] += step
        pm = p.copy()
        pm[i] -= step
        jac[:, i] = (fun(pp, *args) - fun(pm, *args)) / (2.0 * step)
    return jac


def lm_fit(
    fun,
    p0: np.ndarray,
    lo: np.ndarray,
    hi: np.ndarray,
    *args,
    max_iter: int = 120,
    tol: float = 1e-10,
) -> tuple[np.ndarray, np.ndarray, float]:
    """最小化 ||fun(p, *args[: -1]) - args[-1]||²（带盒约束），返回 (p, jac, rss)。"""
    y = np.asarray(args[-1], dtype=np.float64)
    model_args = args[:-1]
    p = np.clip(np.asarray(p0, dtype=np.float64), lo, hi)
    lam = 1e-3
    r = fun(p, *model_args) - y
    rss = float(np.sum(r * r))

    for _ in range(max_iter):
        jac = _numeric_jacobian(fun, p, *model_args)
        jtj = jac.T @ jac
        jtr = jac.T @ r
        diag = np.diag(jtj).copy()
        diag[diag <= 0] = 1e-12
        gain = 0.0
        improved = False
        for _ in range(24):
            a = jtj + lam * np.diag(diag)
            try:
                delta = np.linalg.solve(a, -jtr)
            except np.linalg.LinAlgError:
                lam *= 10.0
                continue
            cand = np.clip(p + delta, lo, hi)
            r_c = fun(cand, *model_args) - y
            rss_c = float(np.sum(r_c * r_c))
            if rss_c < rss:
                gain = rss - rss_c
                p = cand
                r = r_c
                rss = rss_c
                lam = max(1e-12, lam * 0.3)
                improved = True
                break
            lam *= 8.0
        if not improved or gain < tol * max(1e-12, rss):
            break

    jac = _numeric_jacobian(fun, p, *model_args)
    return p, jac, rss


# ---------------------------------------------------------------------------
# 单条边拟合
# ---------------------------------------------------------------------------


@dataclass
class EdgeFit:
    label: str
    normal_deg: float
    width_px: float
    width_ci: float
    sigma0: float
    edge_pos: float
    rss: float
    n_samples: int
    u: np.ndarray
    v: np.ndarray
    model: np.ndarray
    u0: float
    window_half: float
    center: tuple[float, float]
    dependence: dict = field(default_factory=dict)

    @property
    def relative_ci(self) -> float:
        return self.width_ci / max(1e-6, self.width_px)

    def to_dict(self) -> dict:
        return {
            "label": self.label,
            "normal_deg": float(self.normal_deg),
            "width_px": float(self.width_px),
            "width_ci95_px": float(self.width_ci),
            "sensor_sigma_px": float(self.sigma0),
            "edge_pos_px": float(self.edge_pos),
            "rss": float(self.rss),
            "samples": int(self.n_samples),
            "fit_window_half_px": float(self.window_half),
            "fit_center": [float(self.center[0]), float(self.center[1])],
            "significant_u_range": _significant_range(self.u, self.model),
            "single_edge_length_curve": self.dependence,
        }


def _significant_range(u: np.ndarray, model: np.ndarray) -> list[float]:
    """模型从 5% 过渡到 95% 的 u 范围——估计实际依赖的像素段。"""
    lo = float(model.min())
    hi = float(model.max())
    span = hi - lo
    if span <= 1e-9:
        return [float(u[0]), float(u[-1])]
    m = (model - lo) / span
    idx = np.where((m >= 0.05) & (m <= 0.95))[0]
    if idx.size == 0:
        return [float(u[0]), float(u[-1])]
    return [float(u[idx[0]]), float(u[idx[-1]])]


def _single_edge_dependence(width: float, ci: float) -> dict:
    """单边时长度对方向的依赖：L = w / cos(Δ)。"""
    curve = []
    for delta in (0, 15, 30, 45, 60, 75, 85):
        c = math.cos(math.radians(delta))
        L = width / c if c > 1e-3 else float("inf")
        curve.append({"angle_offset_deg": delta, "length_px": float(L)})
    return {
        "relation": "L = w / cos(Δ)   (Δ = 拖影方向与法向夹角)",
        "projected_width_px": float(width),
        "width_ci95_px": float(ci),
        "curve": curve,
        "note": "Δ>60° 时 1/cos 迅速放大，单边无法给出可靠长度",
    }


def fit_edge_profile(prof: Profile, label: str = "", window_half: float | None = None) -> EdgeFit:
    """拟合单条边剖面，返回投影宽度 w 与置信区间。"""
    u = np.asarray(prof.u, dtype=np.float64)
    v = np.asarray(prof.v, dtype=np.float64)
    wh = float(prof.window_half if window_half is None else window_half)

    # 用两端平台的中位数定义有向对比度：正=随 u 上升，负=下降。
    # 模型 a + b·T 的 b 允许为负，因此不必翻转剖面，u 坐标保持物理原样。
    k = max(1, min(5, v.size // 10))
    v_start = float(np.median(v[:k]))
    v_end = float(np.median(v[-k:]))
    amp = v_end - v_start
    peak_to_peak = float(np.max(v) - np.min(v))
    if abs(amp) < 1e-6 or peak_to_peak < 1e-6:
        raise ValueError(f"{label or 'edge'}: 剖面没有对比度，无法估计")

    # norm 在 u 方向上从 0 走到 1（除以带符号的 amp 保证单调上升）
    norm = (v - v_start) / amp
    if norm.size >= 9:
        k = np.ones(5, dtype=np.float64) / 5.0
        sm = np.convolve(norm, k, mode="same")
        # 两端保持真实平台，避免卷积把端点拉向中间
        sm[:2] = norm[:2]
        sm[-2:] = norm[-2:]
        norm = sm
    i10 = int(np.argmax(norm > 0.1))
    i90 = int(np.argmax(norm > 0.9))
    if norm[-1] < 0.9:
        i90 = v.size - 1
    u0_init = float(0.5 * (u[i10] + u[i90]))
    w_init = max(1.0, abs(float(u[i90] - u[i10])))

    p0 = np.array([v_start, amp, u0_init, w_init, 0.7], dtype=np.float64)
    lo = np.array([float(np.min(v)) - 0.35, -2.0, u[0], 0.0, 0.2], dtype=np.float64)
    hi = np.array([float(np.max(v)) + 0.35, 2.0, u[-1], max(3.0, 2.0 * wh), 4.0], dtype=np.float64)

    params, jac, rss = lm_fit(_edge_model, p0, lo, hi, u, v)
    n = u.size
    n_par = params.size
    dof = max(1, n - n_par)
    s2 = rss / dof
    try:
        cov = np.linalg.pinv(jac.T @ jac) * s2
        width_ci = 1.96 * math.sqrt(max(0.0, float(cov[3, 3])))
    except np.linalg.LinAlgError:
        width_ci = float("nan")

    model = _edge_model(params, u)
    width = float(params[3])
    fit = EdgeFit(
        label=label or f"edge@{prof.center[0]:.0f},{prof.center[1]:.0f}",
        normal_deg=float(prof.normal_deg),
        width_px=width,
        width_ci=float(width_ci),
        sigma0=float(params[4]),
        edge_pos=float(params[2]),
        rss=float(rss),
        n_samples=int(n),
        u=u,
        v=v,
        model=model,
        u0=float(params[2]),
        window_half=wh,
        center=prof.center,
    )
    fit.dependence = _single_edge_dependence(width, width_ci)
    return fit


# ---------------------------------------------------------------------------
# 多边联合估计
# ---------------------------------------------------------------------------


@dataclass
class BlurEstimate:
    length_px: float | None
    angle_deg: float | None
    length_ci: float
    angle_ci: float
    method: str
    confidence: float
    edge_fits: list[EdgeFit]
    warnings: list[str] = field(default_factory=list)
    dependence: dict = field(default_factory=dict)
    length_curve: list[dict] = field(default_factory=list)

    @property
    def is_manual(self) -> bool:
        return self.method == "manual"

    def to_dict(self) -> dict:
        return {
            "method": self.method,
            "length_px": None if self.length_px is None else float(self.length_px),
            "angle_deg": None if self.angle_deg is None else float(self.angle_deg),
            "length_ci95_px": float(self.length_ci),
            "angle_ci95_deg": float(self.angle_ci),
            "confidence": float(self.confidence),
            "warnings": list(self.warnings),
            "dependence": self.dependence,
            "length_vs_angle": self.length_curve,
            "edges": [f.to_dict() for f in self.edge_fits],
        }


def _fit_length_angle(edge_fits: list[EdgeFit]) -> tuple[float, float, float, float, float, list[dict]]:
    """给定各边投影宽度，网格搜索角度的同时线性解 L。"""
    widths = np.array([f.width_px for f in edge_fits], dtype=np.float64)
    sigmas = np.array(
        [max(1e-3, f.width_ci / 1.96) if math.isfinite(f.width_ci) else 3.0 for f in edge_fits],
        dtype=np.float64,
    )
    # 置信区间不可用（NaN）时退化为等权，而不是让 NaN 污染整个解
    if not np.all(np.isfinite(sigmas)):
        sigmas = np.ones_like(sigmas)
    sigmas = np.clip(sigmas, 0.1, 10.0)
    normals = np.array([f.normal_deg for f in edge_fits], dtype=np.float64)
    wts = 1.0 / (sigmas**2)

    thetas = np.arange(0.0, 180.0, 0.25)
    curve = []
    best = None
    for th in thetas:
        a = np.abs(np.cos(np.radians(th - normals)))
        denom = float(np.sum(a * a * wts))
        if denom < 1e-6:
            continue
        L = float(np.sum(a * widths * wts) / denom)
        if L < 0:
            continue
        rss = float(np.sum(wts * (widths - L * a) ** 2))
        curve.append({"angle_deg": float(th), "length_px": L, "rss": rss})
        if best is None or rss < best[2]:
            best = (th, L, rss)
    if best is None:
        raise ValueError("无法联合求解：所有候选方向都缺少约束")

    th0, L0, rss0 = best
    # 抛物线细化
    idx = int(np.argmin([c["rss"] for c in curve]))
    if 0 < idx < len(curve) - 1:
        y0, y1, y2 = curve[idx - 1]["rss"], curve[idx]["rss"], curve[idx + 1]["rss"]
        denom = y0 - 2 * y1 + y2
        if abs(denom) > 1e-12:
            shift = 0.5 * (y0 - y2) / denom
            th0 = curve[idx]["angle_deg"] + shift * 0.25
            th0 %= 180.0
            a = np.abs(np.cos(np.radians(th0 - normals)))
            denom2 = float(np.sum(a * a * wts))
            L0 = float(np.sum(a * widths * wts) / max(1e-12, denom2))
            rss0 = float(np.sum(wts * (widths - L0 * a) ** 2))

    dof = max(1, len(edge_fits) - 1)
    chi2_red = rss0 / dof
    # 1σ 轮廓区间：RSS <= RSSmin + 1
    near = [c for c in curve if c["rss"] <= rss0 + 1.0]
    if near:
        angles = [c["angle_deg"] for c in near]
        # 处理 0/180 环绕
        ang_spread = max(angles) - min(angles)
        if ang_spread > 90.0:
            angles = [(a + 90.0) % 180.0 for a in angles]
        angle_ci = 0.5 * (max(angles) - min(angles))
        lengths = [c["length_px"] for c in near]
        length_ci = 0.5 * (max(lengths) - min(lengths))
    else:
        angle_ci = float("nan")
        length_ci = max(f.width_ci for f in edge_fits)

    candidates = _angle_candidates(curve, rss0, th0, widths, wts, normals)
    return L0, th0 % 180.0, length_ci, angle_ci, chi2_red, curve, candidates


def _rss_at(angle_deg: float, widths: np.ndarray, wts: np.ndarray,
            normals: np.ndarray) -> tuple[float, float]:
    """给定方向角，线性解 L 并返回 (L, 加权 RSS)。"""
    a = np.abs(np.cos(np.radians(angle_deg - normals)))
    denom = float(np.sum(a * a * wts))
    if denom < 1e-9:
        return float("nan"), float("inf")
    L = float(np.sum(a * widths * wts) / denom)
    L = max(0.0, L)
    return L, float(np.sum(wts * (widths - L * a) ** 2))


def _angle_candidates(
    curve: list[dict],
    rss0: float,
    best_angle: float,
    widths: np.ndarray,
    wts: np.ndarray,
    normals: np.ndarray,
    tol_rel: float = 0.05,
) -> list[dict]:
    """找出与最优解统计上不可区分的**分离**方向。

    两个来源：
    1. 物理镜像角 ``−θ (mod 180)``：线状 PSF 无正负号，若参考边法向关于拖影
       轴成对出现（典型是 0°/90° 正交边），θ 与 −θ 的投影完全相同，数据上
       无法区分；
    2. 网格上的其它局部极小：法向组合更一般时可能出现。

    返回除最优角以外的等价候选（与最优角相差 > 5°）。
    """
    if not curve:
        return []

    def _distinct(angle: float) -> bool:
        return angle_difference(angle, best_angle) > 5.0

    tol = max(1e-6, tol_rel * max(rss0, 1e-9)) + 1.0

    found: list[dict] = []

    # (1) 显式镜像角
    mirror = (-best_angle) % 180.0
    if _distinct(mirror):
        Lm, rssm = _rss_at(mirror, widths, wts, normals)
        if math.isfinite(rssm) and rssm <= rss0 + tol:
            found.append(
                {"angle_deg": float(mirror), "length_px": float(Lm), "rss": float(rssm),
                 "reason": "mirror"}
            )

    # (2) 网格上的其它局部极小
    rss_vals = np.array([c["rss"] for c in curve], dtype=np.float64)
    n = len(curve)
    for i in range(n):
        prev_v = rss_vals[i - 1] if i > 0 else rss_vals[-1]
        next_v = rss_vals[i + 1] if i < n - 1 else rss_vals[0]
        if rss_vals[i] <= prev_v and rss_vals[i] <= next_v and rss_vals[i] <= rss0 + tol:
            ang = float(curve[i]["angle_deg"])
            if _distinct(ang) and not any(
                angle_difference(ang, f["angle_deg"]) < 3.0 for f in found
            ):
                found.append(
                    {"angle_deg": ang, "length_px": float(curve[i]["length_px"]),
                     "rss": float(rss_vals[i]), "reason": "local_min"}
                )

    found.sort(key=lambda f: f["rss"])
    return found


def estimate_blur(
    profiles: list[Profile],
    labels: list[str] | None = None,
) -> BlurEstimate:
    """由一条或多条参考边剖面估计拖影长度与方向。"""
    if not profiles:
        raise ValueError("至少需要一条参考边")
    labels = labels or [f"edge_{i}" for i in range(len(profiles))]

    fits: list[EdgeFit] = []
    warnings: list[str] = []
    for prof, label in zip(profiles, labels):
        try:
            fits.append(fit_edge_profile(prof, label))
        except ValueError as exc:
            warnings.append(str(exc))

    if not fits:
        raise ValueError("所有参考边都拟合失败：" + "；".join(warnings))

    # 去掉明显非线性的边（RSS 过大）
    usable = [f for f in fits if math.isfinite(f.width_px)]
    if not usable:
        raise ValueError("没有可用的边拟合结果")

    if len(usable) == 1:
        f = usable[0]
        rel = f.relative_ci
        conf = float(np.clip(1.0 - 3.0 * rel, 0.05, 0.6))
        warnings.append(
            "只有一条参考边：只能测到投影宽度，方向未知；长度按 L=w/cos(Δ) 依赖方向，"
            "若拖影沿该边法向则 L≈w。加一条法向不同的边可同时定出长度与方向。"
        )
        dependence = dict(f.dependence)
        dependence["method_note"] = "single-edge projection only"
        return BlurEstimate(
            length_px=f.width_px,
            angle_deg=None,
            length_ci=f.width_ci,
            angle_ci=float("nan"),
            method="single-edge",
            confidence=conf,
            edge_fits=fits,
            warnings=warnings,
            dependence=dependence,
            length_curve=f.dependence.get("curve", []),
        )

    # 多边：需要法向有区分度
    normals = [f.normal_deg for f in usable]
    max_sep = max(
        angle_difference(a, b) for i, a in enumerate(normals) for b in normals[i + 1 :]
    ) if len(normals) > 1 else 0.0
    distinguishable = [f for f in usable if f.width_px > 0.6]

    if max_sep < 8.0 or len(distinguishable) < 2:
        f = min(usable, key=lambda x: x.relative_ci)
        warnings.append(
            "参考边法向过于接近：无法分离长度与方向分量，退化为单边投影估计。"
        )
        return BlurEstimate(
            length_px=f.width_px,
            angle_deg=None,
            length_ci=f.width_ci,
            angle_ci=float("nan"),
            method="single-edge",
            confidence=0.25,
            edge_fits=fits,
            warnings=warnings,
            dependence=f.dependence,
            length_curve=f.dependence.get("curve", []),
        )

    L, theta, L_ci, A_ci, chi2_red, curve, candidates = _fit_length_angle(distinguishable)
    if chi2_red > 9.0:
        warnings.append(
            f"各边投影宽度无法用一个 (L,θ) 同时解释（χ²/ν={chi2_red:.1f}）；"
            "检查边是否属于同一拖影，或拖影角度在画面内变化。"
        )

    # 镜像/等价方向：当参考边只覆盖一个轴系时，θ 与它的镜像同样最优
    ambiguous = [c for c in candidates if angle_difference(c["angle_deg"], theta) > 8.0]
    if ambiguous:
        warnings.append(
            "方向存在镜像歧义：当前参考边法向不足以区分 "
            f"{theta:.1f}° 与 "
            + "、".join(f"{c['angle_deg']:.1f}°" for c in ambiguous)
            + "。加一条法向不与现有轴系平行的斜边即可消除。"
        )
    conf = float(np.clip(1.0 / (1.0 + 0.12 * chi2_red + 0.02 * (A_ci if math.isfinite(A_ci) else 20)), 0.05, 0.98))
    if ambiguous:
        conf *= 0.75

    # 长度依赖：沿最终方向的投影与各边的吻合
    dependence = {
        "relation": "w_i = L·|cos(θ-φ_i)|；θ/φ 均为屏幕角",
        "edges": [
            {
                "label": f.label,
                "normal_deg": float(f.normal_deg),
                "projected_width_px": float(f.width_px),
                "predicted_width_px": float(
                    abs(L * math.cos(math.radians(theta - f.normal_deg)))
                ),
                "residual_px": float(
                    f.width_px - abs(L * math.cos(math.radians(theta - f.normal_deg)))
                ),
            }
            for f in distinguishable
        ],
        "chi2_reduced": float(chi2_red),
        "angle_span_between_normals_deg": float(max_sep),
        "alternative_angles": [
            {
                "angle_deg": float(c["angle_deg"]),
                "length_px": float(c["length_px"]),
                "rss": float(c["rss"]),
            }
            for c in ambiguous
        ],
        "note": "θ 与法向越接近，该边对长度最敏感；接近垂直的边只提供方向信息",
    }

    return BlurEstimate(
        length_px=float(L),
        angle_deg=float(theta),
        length_ci=float(L_ci),
        angle_ci=float(A_ci),
        method="multi-edge",
        confidence=conf,
        edge_fits=fits,
        warnings=warnings,
        dependence=dependence,
        length_curve=curve,
    )


def manual_estimate(length_px: float, angle_deg: float, length_ci: float = 0.0) -> BlurEstimate:
    return BlurEstimate(
        length_px=float(length_px),
        angle_deg=float(wrap_angle(angle_deg)),
        length_ci=float(length_ci),
        angle_ci=0.0,
        method="manual",
        confidence=1.0,
        edge_fits=[],
        warnings=["手工填写的参数（未经参考边校核）"],
        dependence={"note": "manual override"},
        length_curve=[],
    )


def angle_uncertainty_from_edges(fits: list[EdgeFit]) -> float:
    """只要方向信息时，法向差异给出的最小可分辨角度（度）。"""
    if len(fits) < 2:
        return float("nan")
    normals = [f.normal_deg for f in fits]
    seps = [angle_difference(a, b) for i, a in enumerate(normals) for b in normals[i + 1 :]]
    return float(max(seps))
