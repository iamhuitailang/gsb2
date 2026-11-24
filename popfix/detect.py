"""爆点检测。

思路: 爆点是极陡的瞬态, 能量集中在高频; 而鼓点(kick)主要是低频。
先做一阶高通取高频残差, 在短帧上算能量, 再用滑动中位数估计"当前信号
自己的高频本底", 用比值打分 —— 这样重鼓点抬高本底时阈值会跟着抬高,
不会把鼓点误判成爆点, 而真正的尖峰仍会显著高出本底。

检测按声道独立进行, 再把时间上重叠/相邻的候选合并, 记录受影响声道。
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

from .wavio import read_wav

# 检测默认参数(可在清单 config 中覆盖)
DEFAULTS = {
    "hop_ms": 0.75,         # 帧移(短帧移保证毫秒级爆点能跨多帧)
    "win_ms": 1.5,          # 帧长
    "baseline_ms": 120.0,   # 拖尾中位数窗(只看瞬态发生之前的本底)
    "threshold": 200.0,     # 触发门限: 能量 / 本底 的倍数(实测鼓点 <100, 爆点 >300)
    "energy_cover": 0.97,   # 区域边界外扩到覆盖触发点周围该比例的高频能量
    "max_grow_ms": 3.5,     # 能量覆盖外扩的单侧上限, 防止拖进相邻事件/噪声
    "abs_floor": 1e-5,      # 静音段绝对能量门限, 防止除零式误报
    "min_run_frames": 2,    # 候选至少持续的帧数, 滤掉单帧随机尖峰
    "merge_gap_ms": 40.0,   # 相邻候选合并间隔
    "min_region_ms": 7.0,   # 检测区域最短持续时长(=爆点长度 1.4 倍, 包住振铃拖尾)
    "padding_ms": 0.75,     # 修复时每个区域两侧外扩的处理宽度
    "hpf_alpha": 0.92,      # 一阶差分高通系数, 44.1k 下截止约 1.3kHz
}


def highpass_residual(x: np.ndarray, alpha: float) -> np.ndarray:
    """高频残差: 一阶差分 y[n] = x[n] - alpha*x[n-1]。

    这是一个向量化的 FIR 高通(alpha≈0.9 时截止约 1~2kHz): 低频缓变被
    相消, 爆点的陡沿几乎原样保留, 而鼓点的低频能量进不到残差里。
    """
    y = np.empty_like(x, dtype=np.float64)
    y[0] = x[0]
    y[1:] = x[1:] - alpha * x[:-1]
    return y


def _frame_energies(res: np.ndarray, hop: int, win: int) -> np.ndarray:
    """滑窗帧能量(残差平方均值), 返回每帧一个值。"""
    n = len(res)
    if n < win:
        return np.array([float(np.mean(res ** 2))]) if n else np.zeros(0)
    n_frames = 1 + (n - win) // hop
    energies = np.empty(n_frames)
    for f in range(n_frames):
        seg = res[f * hop:f * hop + win]
        energies[f] = float(np.mean(seg ** 2))
    return energies


def _trailing_median(values: np.ndarray, window: int) -> np.ndarray:
    """左向拖尾中位数: 每帧的基线只来自它之前 window 帧(不含当前帧)。

    这样估计的是"瞬态发生前的高频本底"; 居中或含当前帧的中位数会把
    爆点自己算进基线里。文件开头没有历史时用全曲中位数填充, 防止贴头
    爆点把基线整体抬高。
    """
    window = max(3, window)
    n = len(values)
    fill = float(np.median(values))
    out = np.empty(n)
    for i in range(n):
        lo = max(0, i - window)
        if i == 0:
            # 首帧若是贴头爆点, 不能拿它自己当基线
            out[i] = min(fill, float(values[0]))
        else:
            out[i] = float(np.median(values[lo:i]))
    return out


def _runs(mask: np.ndarray) -> list[tuple[int, int]]:
    """布尔数组里 True 的连续段, 返回 [(起, 止(不含)), ...]。"""
    if not mask.any():
        return []
    padded = np.concatenate(([False], mask, [False]))
    edges = np.flatnonzero(np.diff(padded.astype(np.int8)))
    return [(int(edges[i]), int(edges[i + 1])) for i in range(0, len(edges), 2)]


def _expand_by_energy(residual: np.ndarray, s: int, e: int,
                      cover: float, max_grow: int,
                      n_total: int) -> tuple[int, int]:
    """以 [s, e) 为种子, 按高频残差能量把边界外扩到覆盖 cover 比例。

    爆点的高能尖峰很短但带低幅振铃拖尾, 仅靠帧门限会截短区域。
    在种子两侧的受限邻域内累计残差绝对值, 向外扩边直到纳入的能量
    达到邻域总能量的 cover; 用绝对值而非平方, 是为了不让背景噪声的
    零散大值把边界无限往外拉。单侧外扩不超过 max_grow 个样本。
    """
    lo = max(0, s - max_grow)
    hi = min(n_total, e + max_grow)
    weight = np.abs(residual[lo:hi])
    total = float(np.sum(weight))
    if total <= 0.0:
        return s, e
    target = total * cover
    seed_lo, seed_hi = s - lo, e - lo
    c_lo, c_hi = seed_lo, seed_hi
    acc = float(np.sum(weight[c_lo:c_hi]))
    while acc < target and (c_lo > 0 or c_hi < len(weight)):
        left_e = float(weight[c_lo - 1]) if c_lo > 0 else -1.0
        right_e = float(weight[c_hi]) if c_hi < len(weight) else -1.0
        if left_e < 0.0 and right_e < 0.0:
            break
        if left_e >= right_e:
            c_lo -= 1
            acc += left_e
        else:
            acc += right_e
            c_hi += 1
    return lo + c_lo, lo + c_hi


def _merge_intervals(intervals: list[tuple[int, int, dict]],
                     gap: int) -> list[tuple[int, int, dict]]:
    """按间隔合并 [start, end) 区间; info 会被合并(声道取并集、分数取最大)。"""
    if not intervals:
        return []
    intervals = sorted(intervals, key=lambda t: (t[0], t[1]))
    merged: list[tuple[int, int, dict]] = []
    for s, e, info in intervals:
        if merged and s - merged[-1][1] <= gap:
            ps, pe, pinfo = merged[-1]
            pinfo["channels"] = sorted(set(pinfo["channels"]) | set(info["channels"]))
            pinfo["sources"] = sorted(set(pinfo["sources"]) | set(info["sources"]))
            pinfo["peak_score"] = max(pinfo["peak_score"], info["peak_score"])
            merged[-1] = (ps, max(pe, e), pinfo)
        else:
            merged.append((s, e, dict(info)))
    return merged


def detect_channels(data: np.ndarray, sr: int,
                    params: dict | None = None) -> list[dict]:
    """对形状 (N, C) 的波形做检测, 返回候选区域列表。

    每个区域: {start, end, channels, sources, peak_score}
    起止为样本号, 区间左闭右开。
    """
    p = {**DEFAULTS, **(params or {})}
    n_frames_total, n_ch = data.shape
    hop = max(1, int(round(p["hop_ms"] / 1000.0 * sr)))
    win = max(hop, int(round(p["win_ms"] / 1000.0 * sr)))
    base_win = max(3, int(round(p["baseline_ms"] / p["hop_ms"])))
    gap = int(round(p["merge_gap_ms"] / 1000.0 * sr))

    raw: list[tuple[int, int, dict]] = []
    for ch in range(n_ch):
        res = highpass_residual(data[:, ch], p["hpf_alpha"])
        energies = _frame_energies(res, hop, win)
        if len(energies) == 0:
            continue
        # 本底用纯拖尾中位数: 只含历史帧, 瞬态自己进不了基线
        baseline = _trailing_median(energies, base_win)
        score = energies / (baseline + 1e-12)
        mask = (score >= p["threshold"]) & (energies >= p["abs_floor"])
        runs = _runs(mask)
        if p["min_run_frames"] > 1:
            # 贴文件头/尾的爆点可能只占一帧, 边缘单帧候选予以保留
            runs = [r for r in runs
                    if (r[1] - r[0] >= int(p["min_run_frames"])
                        or r[0] == 0 or r[1] >= len(mask))]
        max_grow = int(round(p["max_grow_ms"] / 1000.0 * sr))
        for f0, f1 in runs:
            s = f0 * hop
            e = min(n_frames_total, f1 * hop + (win - hop))
            # 帧门限只负责定位触发, 区域真实边界按高频能量覆盖来定,
            # 把爆点的振铃拖尾完整包进来, 修复窗口不再短于真实损伤
            s, e = _expand_by_energy(
                res, s, e, p["energy_cover"], max_grow, n_frames_total)
            peak = float(np.max(score[f0:f1]))
            raw.append((s, e, {
                "channels": [ch], "sources": [ch], "peak_score": peak,
            }))

    merged = _merge_intervals(raw, gap)
    min_len = int(round(p["min_region_ms"] / 1000.0 * sr))
    regions = []
    for idx, (s, e, info) in enumerate(merged):
        # 扩到最短时长: 爆点尖峰在前、振铃拖尾在后, 优先向后扩;
        # 顶到文件尾再把余量挪到前面
        if e - s < min_len:
            grow = min_len - (e - s)
            take_right = min(grow, n_frames_total - e)
            e += take_right
            take_left = grow - take_right
            s = max(0, s - take_left)
        regions.append({
            "id": idx + 1,
            "start": int(s),
            "end": int(e),
            "channels": info["channels"],
            "sources": info["sources"],
            "peak_score": round(info["peak_score"], 2),
            "source": "auto",
            "enabled": True,
            "padding_ms": None,
        })
    return regions


def detect_file(wav_path: str | Path, params: dict | None = None) -> list[dict]:
    data, sr = read_wav(wav_path)
    return detect_channels(data, sr, params)
