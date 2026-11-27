"""变更统计与干净参考对比。

两个层面的指标:
1. 修补前后变更统计: 每帧改了多少格、各状态列数、最大/平均差值;
2. 与干净参考对比(合成数据或另存的无缺陷参考):
   - recovery_mae:  选中列上 |修补后 - 干净参考|, 越小说明真恢复;
   - damage_mae:    未选位置上 |修补后 - 干净参考|, 正常应为 0
     (若修补波及或选错列, 这里会体现"误删线条/误伤正常内容")。
"""

from __future__ import annotations

import csv
from pathlib import Path

import numpy as np

from .repair import PROTECTED, RepairResult


def write_change_stats(
    path: str | Path, frame_names: list[str], result: RepairResult
) -> None:
    rows = result.stats_rows(frame_names)
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8-sig") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def compare_with_clean(
    original: np.ndarray,
    repaired: np.ndarray,
    clean: np.ndarray,
    selected_per_frame: list[list[int]],
    protected: list[int] | set[int] | None = None,
) -> dict:
    """对比修补结果与干净参考, 区分真恢复与误伤。"""
    if original.shape != clean.shape:
        raise ValueError(
            f"参考图尺寸 {clean.shape} 与输入 {original.shape} 不一致, 无法对比"
        )
    prot = set(protected or [])
    width = original.shape[2]
    per_frame = []
    all_sel, all_damage, all_defect = [], [], []
    for f in range(original.shape[0]):
        touched = sorted(set(selected_per_frame[f]) - prot)
        untouched = [c for c in range(width) if c not in touched]
        rec = np.abs(repaired[f][:, touched] - clean[f][:, touched]) if touched \
            else np.array([0.0])
        # 误伤: 未选位置上修补结果相对【原图】的改动。正确修补只动选中列,
        # 这里必须为 0(被保护的真实缺陷列不动, 也不会计入)。
        # 注意不能拿未选位置直接对干净参考比: 保护列本身就是缺陷, 与参考天然不同。
        if untouched:
            dmg = np.abs(
                repaired[f][:, untouched] - original[f][:, untouched]
            )
        else:
            dmg = np.array([0.0])
        # 原始缺陷强度: 参考与输入在选中列上的差距
        defect = np.abs(original[f][:, touched] - clean[f][:, touched]) if touched \
            else np.array([0.0])
        row = {
            "frame": f,
            "recovery_mae": float(rec.mean()),
            "damage_mae": float(dmg.mean()),
            "defect_mae_before": float(defect.mean()),
            "max_recovery_error": float(rec.max()),
            "max_damage": float(dmg.max()),
        }
        per_frame.append(row)
        all_sel.append(rec.ravel())
        all_damage.append(dmg.ravel())
        all_defect.append(defect.ravel())

    rec_all = np.concatenate(all_sel)
    dmg_all = np.concatenate(all_damage)
    defect_all = np.concatenate(all_defect)
    no_improvement = rec_all.mean() >= defect_all.mean()
    if np.isclose(dmg_all, 0.0).all() and not no_improvement:
        verdict = "OK: 未选位置零改动, 选中列已向参考收敛"
    elif no_improvement:
        verdict = (
            "WARNING: 选中列修补后并未比原图更接近干净参考, "
            "可能把正常竖线当坏列误删, 请核对选区"
        )
    else:
        verdict = "WARNING: 未选位置出现改动, 可能误伤正常竖线, 请核对选区"
    return {
        "per_frame": per_frame,
        "recovery_mae": float(rec_all.mean()),
        "damage_mae": float(dmg_all.mean()),
        "max_damage": float(dmg_all.max()),
        "defect_mae_before": float(defect_all.mean()),
        "verdict": verdict,
    }


def write_comparison_report(path: str | Path, comparison: dict) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8-sig") as fh:
        writer = csv.DictWriter(
            fh,
            fieldnames=[
                "frame", "defect_mae_before", "recovery_mae",
                "max_recovery_error", "damage_mae", "max_damage",
            ],
        )
        writer.writeheader()
        for row in comparison["per_frame"]:
            writer.writerow(row)
        writer.writerow({})
        writer.writerow({"frame": "OVERALL"})
        writer.writerow({"frame": "recovery_mae", "recovery_mae": comparison["recovery_mae"]})
        writer.writerow({"frame": "damage_mae", "damage_mae": comparison["damage_mae"]})
        writer.writerow({"frame": "verdict", "defect_mae_before": comparison["verdict"]})


def export_repaired(
    out_dir: str | Path,
    frame_names: list[str],
    result: RepairResult,
) -> list[str]:
    """导出修补后的图片, 文件名沿用原帧名。"""
    from .io_utils import save_image

    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    paths = []
    for f, name in enumerate(frame_names):
        p = out_dir / name
        save_image(p, result.repaired[f])
        paths.append(str(p))
    return paths
