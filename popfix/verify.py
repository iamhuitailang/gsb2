"""对照干净参考核对修复质量。

三类结论:
  missed     漏修: 真值爆点区间里, 修复后高频损伤仍明显残留
  false      误伤(误删): 在没有爆点的地方动了样本, 且改动超过量化容差
  residual   已修区域的剩余损伤能量(越低越好)

评价口径:
  爆点的物理本质是高频瞬态, 而床信号(低频正弦)在几毫秒窗口内无法从
  外侧样本完美预测, 其低频拟合差异是任何局部修复都消不掉的物理残差。
  因此漏修判定在"高频残差域"进行(与检测器同一套高通), 另附全频带
  残留比作参考。误伤与"区外逐样本一致"仍在原始波形上严格判定。

另外硬性验证"修补区外不应平白改变": 所有修复区域并集之外,
修复声与原声必须在 PCM16 量化级别完全一致。
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from .detect import highpass_residual
from .wavio import pcm16_codes, read_wav

# 判定门限
MISS_RATIO = 0.4         # 高频残留损伤能量超过原始高频损伤的 40% 视为漏修
                         # (完全未修≈1.0; 0.4 是工程线)
TOL_AMP = 1.5 / 32768.0  # 约一个半 PCM16 量化台阶, 容差内视为未改动
FALSE_GUARD_MS = 30.0    # 真值爆点周围该宽度内的改动视为合理修复邻域, 不算误伤
HPF_ALPHA = 0.92         # 与检测器一致的一阶差分高通系数


def _mask(intervals: list[tuple[int, int]], n: int) -> np.ndarray:
    m = np.zeros(n, dtype=bool)
    for s, e in intervals:
        m[max(0, s):min(n, e)] = True
    return m


def _runs_from_mask(mask: np.ndarray) -> list[tuple[int, int]]:
    if not mask.any():
        return []
    padded = np.concatenate(([False], mask, [False]))
    edges = np.flatnonzero(np.diff(padded.astype(np.int8)))
    return [(int(edges[i]), int(edges[i + 1]))
            for i in range(0, len(edges), 2)]


def verify(damaged: np.ndarray, repaired: np.ndarray,
           clean: np.ndarray, sr: int, manifest: dict,
           truth: dict) -> dict:
    """返回核对报告(dict)。输入均为形状 (N, C) 的 float 波形。"""
    n, n_ch = damaged.shape
    damage = damaged - clean                       # 注入的真实损伤
    residual = repaired - clean                    # 修复后相对干净参考的偏差
    edit = np.any(np.abs(damaged - repaired) > TOL_AMP, axis=1)

    # 高频残差域: 与检测器同一套高通, 只评价爆点所在的高频瞬态分量
    hf_damage = np.zeros_like(damage)
    hf_residual = np.zeros_like(residual)
    for ch in range(n_ch):
        hf_damage[:, ch] = highpass_residual(damage[:, ch], HPF_ALPHA)
        hf_residual[:, ch] = highpass_residual(residual[:, ch], HPF_ALPHA)

    truth_intervals = [(p["start_sample"], p["end_sample"])
                       for p in truth["pops"]]
    truth_mask = _mask(truth_intervals, n)
    guard = int(round(FALSE_GUARD_MS / 1000.0 * sr))
    guard_intervals = [(max(0, p["start_sample"] - guard),
                        min(n, p["end_sample"] + guard))
                       for p in truth["pops"]]
    allowed_mask = _mask(guard_intervals, n)

    # 实际修复区间要计入每区域的 padding(与 repair 模块保持同一套规则)
    repair_intervals = []
    for r in manifest["regions"]:
        if not r["enabled"]:
            continue
        p_ms = (r["padding_ms"]
                if r["padding_ms"] is not None
                else manifest["config"].get("padding_ms", 0.0))
        pad = int(round(float(p_ms) / 1000.0 * sr))
        repair_intervals.append((max(0, r["start"] - pad),
                                 min(n, r["end"] + pad)))
    repair_mask = _mask(repair_intervals, n)

    # ---- 1. 逐真值爆点核对漏修与覆盖情况 ----
    missed, covered = [], []
    for p in truth["pops"]:
        s, e = p["start_sample"], p["end_sample"]
        chs = p["channels"]
        d_energy = float(np.sum(damage[s:e, chs] ** 2))
        r_energy = float(np.sum(residual[s:e, chs] ** 2))
        # 漏修判定用高频域; 全频带数字仅作参考
        hf_d = float(np.sum(hf_damage[s:e, chs] ** 2))
        hf_r = float(np.sum(hf_residual[s:e, chs] ** 2))
        hf_ratio = hf_r / hf_d if hf_d > 0 else 0.0
        ratio = r_energy / d_energy if d_energy > 0 else 0.0
        entry = {
            "kind": p["kind"],
            "start_time": round(s / sr, 6),
            "end_time": round(e / sr, 6),
            "channels": chs,
            "damage_energy": round(d_energy, 8),
            "residual_energy": round(r_energy, 8),
            "residual_ratio": round(ratio, 4),
            "hf_damage_energy": round(hf_d, 8),
            "hf_residual_energy": round(hf_r, 8),
            "hf_residual_ratio": round(hf_ratio, 4),
            "covered_by_region": bool(repair_mask[s:e].any()),
        }
        (missed if hf_ratio > MISS_RATIO else covered).append(entry)

    # ---- 2. 误伤: 真值合理邻域之外被改动(邻域内覆盖真值是修复的正常行为) ----
    false_mask = edit & ~allowed_mask
    false_runs = _runs_from_mask(false_mask)
    false_entries = [{
        "start_time": round(s / sr, 6),
        "end_time": round(e / sr, 6),
        "duration_ms": round((e - s) / sr * 1000.0, 3),
        "max_abs_change": float(np.max(
            np.abs(damaged[s:e] - repaired[s:e]))),
    } for s, e in false_runs[:50]]

    # ---- 3. 修补区外必须逐样本一致(PCM16 量化级别) ----
    outside = ~repair_mask
    outside_identical = bool(np.array_equal(
        pcm16_codes(damaged[outside]), pcm16_codes(repaired[outside])))

    # ---- 4. 汇总能量(高频域, 对应爆点瞬态的消除程度) ----
    total_hf_damage = float(np.sum(hf_damage ** 2))
    total_hf_residual = float(np.sum(hf_residual ** 2))
    report = {
        "sample_rate": sr,
        "frames": n,
        "thresholds": {
            "miss_ratio": MISS_RATIO,
            "miss_ratio_domain": "high_frequency",
            "tolerance_amp": TOL_AMP,
            "hpf_alpha": HPF_ALPHA,
        },
        "summary": {
            "truth_pop_count": len(truth["pops"]),
            "region_count": len(manifest["regions"]),
            "missed_count": len(missed),
            "false_edit_segment_count": len(false_runs),
            "outside_repair_identical": outside_identical,
            "hf_damage_energy_removed_pct": round(
                (1.0 - total_hf_residual / total_hf_damage) * 100.0, 2)
            if total_hf_damage > 0 else 100.0,
        },
        "missed": missed,
        "covered": covered,
        "false_edits": false_entries,
    }
    return report


def verify_files(manifest_path: str | Path, truth_path: str | Path,
                 clean_wav: str | Path, report_path: str | Path) -> dict:
    from .manifest import load_manifest, resolve_wav

    manifest = load_manifest(manifest_path)
    truth = json.loads(Path(truth_path).read_text(encoding="utf-8"))
    damaged, sr = read_wav(resolve_wav(manifest, manifest_path))
    repaired_wav = str(Path(manifest_path).with_name("repaired.wav"))
    repaired, _ = read_wav(repaired_wav)
    clean, _ = read_wav(clean_wav)
    report = verify(damaged, repaired, clean, sr, manifest, truth)
    Path(report_path).write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return report
