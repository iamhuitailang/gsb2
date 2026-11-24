"""局部修复。

原则:
  - 只改清单里 enabled 区域、且只改它声明的声道; 其余样本逐样本不动
  - 每个区域可单独调处理宽度 padding_ms(区域级覆盖全局)
  - 两步法: 先用区间外侧样本估计低频背景, 再用余弦锥形窗只移除叠加在
    背景上的高频爆点分量, 床信号的缓变走势被保留, 不制造次生波形
  - 贴文件头/尾时外侧参考不足, 背景估计退化为单侧拟合, 不越界
  - 同一块里有多个爆点时, 整块只做一次连续修复
  - 带收敛保护: 已无明显爆点的区域重复执行不会漂移(幂等)
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np

# 中央修复区损伤 RMS 低于该值视为"已无爆点", 整块跳过(约 4 个 PCM16 台阶)
IDLE_RMS = 4.0 / 32768.0

from .wavio import read_wav, write_wav


@dataclass
class RepairResult:
    repaired: np.ndarray          # 修复后的完整波形
    removed: np.ndarray           # 被移除的内容 = 原声 - 修复声(非修复区为 0)
    sr: int
    applied: list[dict]           # 每个区域实际生效的修复区间(含 padding)


def _background_estimate(x: np.ndarray, s: int, e: int) -> np.ndarray:
    """估计 [s, e) 内的低频背景。

    爆点是叠加在背景上的高频瞬态。取区间左右两个外侧"短邻域"(约一个
    窗长)的样本, 稳健拟合一条线性趋势作为背景: 床信号(低频正弦)在几毫秒
    的局部内近似线性, 而爆点的高频起伏被一阶趋势平均掉。贴文件头/尾时
    某一侧缺失, 用可用一侧拟合; 两侧都没有时退化为零。
    """
    n = len(x)
    span = e - s
    ref = span
    l_lo, l_hi = max(0, s - ref), s
    r_lo, r_hi = e, min(n, e + ref)
    xs = np.concatenate([np.arange(l_lo, l_hi), np.arange(r_lo, r_hi)])
    ys = np.concatenate([x[l_lo:l_hi], x[r_lo:r_hi]])
    if len(xs) >= 2:
        slope, intercept = np.polyfit(xs, ys, 1)
        return slope * np.arange(s, e, dtype=np.float64) + intercept
    if len(ys):
        return np.full(span, float(np.mean(ys)))
    return np.zeros(span)


def _repair_channel(x: np.ndarray, s: int, e: int) -> np.ndarray:
    """返回与 x 等长的数组, 仅 [s, e) 被替换, 其余原样。

    两步法(保留背景、只移除爆点):
      1. 用区间两侧外侧信号估计区间内的低频背景 bg;
      2. 损伤分量 = 原声 - bg, 对它加余弦锥形窗: 两端短过渡段 taper=0
         (原信号原样保留, 接缝连续), 中央段 taper=1 (损伤完全移除,
         输出就是估计背景)。
    这样修掉的是叠加的爆点, 背景的缓变走势被保留, 不会制造次生波形。
    贴文件头/尾时外侧样本不足, 背景估计自动退化为可用一侧的均值。
    """
    n = len(x)
    out = x.copy()
    if s >= e or s >= n or e <= 0:
        return out
    s = max(0, s)
    e = min(n, e)
    span = e - s

    if span == 1:
        out[s] = x[max(0, s - 1)] if s > 0 else x[min(n - 1, e)]
        return out

    bg = _background_estimate(x, s, e)

    # 修复窗: 两端短过渡(约 0.5ms)保证接缝连续, 中央完全移除损伤
    fade = min(span // 2, 24)
    taper = np.zeros(span)
    t = np.arange(fade) / fade
    taper[:fade] = (1.0 - np.cos(t * np.pi)) / 2.0
    taper[fade:span - fade] = 1.0
    taper[-fade:] = ((1.0 - np.cos(t[::-1] * np.pi)) / 2.0)[::-1]

    damage = x[s:e] - bg
    # 收敛保护(幂等): 中央完全移除区里若已没有明显爆点 —— 损伤 RMS
    # 低于几个 PCM16 量化台阶 —— 整块跳过。否则对已修复信号再跑一次时,
    # 背景拟合的微小变化会被当成新损伤反复修正而持续漂移。
    core = slice(fade, span - fade) if span > 2 * fade else slice(0, span)
    core_rms = float(np.sqrt(np.mean(damage[core] ** 2)))
    if core_rms < IDLE_RMS:
        return out

    out[s:e] = x[s:e] - taper * damage
    return out


def _effective_padding(region: dict, config: dict, sr: int) -> int:
    p_ms = region["padding_ms"]
    if p_ms is None:
        p_ms = config.get("padding_ms", 0.0)
    return int(round(float(p_ms) / 1000.0 * sr))


def repair_manifest(data: np.ndarray, sr: int,
                    manifest: dict) -> RepairResult:
    """按清单修复。data 不被原地修改。"""
    n, n_ch = data.shape
    repaired = data.copy()
    applied: list[dict] = []

    for region in manifest["regions"]:
        if not region["enabled"]:
            continue
        pad = _effective_padding(region, manifest["config"], sr)
        s = max(0, region["start"] - pad)
        e = min(n, region["end"] + pad)
        before = repaired.copy()
        for ch in region["channels"]:
            repaired[:, ch] = _repair_channel(repaired[:, ch], s, e)
        changed = np.any(repaired != before, axis=1)
        applied.append({
            "id": region["id"],
            "start": int(s),
            "end": int(e),
            "channels": list(region["channels"]),
            "padding_ms": (region["padding_ms"]
                           if region["padding_ms"] is not None
                           else manifest["config"].get("padding_ms", 0.0)),
            "changed_samples": int(np.count_nonzero(changed)),
        })

    removed = data - repaired
    return RepairResult(repaired=repaired, removed=removed, sr=sr,
                        applied=applied)


def repair_file(manifest: dict, out_wav: str | Path,
                subtype: str = "PCM_16") -> RepairResult:
    from .manifest import resolve_wav

    data, sr = read_wav(resolve_wav(manifest))
    if sr != manifest["sample_rate"] or data.shape[0] != manifest["frames"]:
        raise ValueError("wav 与清单记录的采样率/长度不一致, 拒绝修复")
    result = repair_manifest(data, sr, manifest)
    write_wav(out_wav, result.repaired, sr, subtype=subtype)
    return result


# ---------------------------------------------------------------- 对齐切片

def export_slices(data: np.ndarray, repaired: np.ndarray,
                  removed: np.ndarray, sr: int, region: dict,
                  out_dir: str | Path, context_ms: float = 150.0,
                  subtype: str = "PCM_16") -> dict:
    """对同一时间位置切原声/修补声/被移除内容, 写三段对齐 wav。

    切片范围 = 区域(含 padding) 外扩 context_ms 的上下文, 三段长度完全一致,
    可直接逐样本对齐试听。
    """
    n = data.shape[0]
    ctx = int(round(context_ms / 1000.0 * sr))
    s = max(0, region["start"] - ctx)
    e = min(n, region["end"] + ctx)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    rid = region["id"]
    paths = {}
    for tag, arr in (("original", data), ("repaired", repaired),
                     ("removed", removed)):
        p = out_dir / f"region{rid:02d}_{tag}.wav"
        write_wav(p, arr[s:e], sr, subtype=subtype)
        paths[tag] = str(p)
    return {
        "id": rid,
        "slice_start_sample": int(s),
        "slice_end_sample": int(e),
        "slice_start_time": round(s / sr, 6),
        "slice_end_time": round(e / sr, 6),
        "context_ms": context_ms,
        "paths": paths,
    }
