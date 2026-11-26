"""导出结果与参数，以及用干净样例做配对验证。"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

import numpy as np

from .image_io import json_safe, save_image, save_npy, write_json
from .metrics import (
    bar_width_report,
    edge_error_report,
    gradient_recovery,
    residual_stats,
    unchanged_stats,
)
from .pipeline import PipelineResult
from .regions import RegionSet


def export_result(
    outdir: str | Path,
    original: np.ndarray,
    result: np.ndarray,
    residual: np.ndarray,
    region_set: RegionSet,
    pipeline: PipelineResult | None = None,
    meta: dict | None = None,
    source: str | None = None,
    save_float: bool = True,
) -> dict:
    """保存 result/residual/覆盖图 + 参数 JSON，返回路径字典。"""
    outdir = Path(outdir)
    outdir.mkdir(parents=True, exist_ok=True)

    paths = {
        "result": str(outdir / "result.png"),
        "residual": str(outdir / "residual.png"),
        "coverage": str(outdir / "coverage.png"),
        "params": str(outdir / "params.json"),
    }
    save_image(outdir / "result.png", result)
    save_image(outdir / "residual.png", _residual_to_view(residual))

    from .regions import coverage_overlay

    save_image(outdir / "coverage.png", coverage_overlay(original, region_set, mode="owner"))

    if save_float:
        save_npy(outdir / "result_float.npy", result)
        save_npy(outdir / "residual_float.npy", residual)
        paths["result_float"] = str(outdir / "result_float.npy")
        paths["residual_float"] = str(outdir / "residual_float.npy")

    params = {
        "created": datetime.now().isoformat(timespec="seconds"),
        "source": source,
        "image_size": [int(original.shape[1]), int(original.shape[0])],
        "angle_convention": "0=+x, 逆时针为正, 180° 取模",
        "regions": [r.to_dict() for r in region_set.ordered()],
        "overlaps": region_set.overlap_report(),
        "pipeline": pipeline.metrics_dict() if pipeline is not None else None,
        "sample_meta": meta,
    }
    (outdir / "params.json").write_text(
        json.dumps(json_safe(params), ensure_ascii=False, indent=2, allow_nan=False),
        encoding="utf-8",
    )
    return paths


def _residual_to_view(residual: np.ndarray, gain: float = 8.0) -> np.ndarray:
    """残差 ±gain 映射到 0..1 灰度，0 为 0.5 灰。"""
    r = np.asarray(residual, dtype=np.float32)
    if r.ndim == 3:
        r = r.mean(axis=2)
    return np.clip(0.5 + gain * r, 0.0, 1.0)


def validate_pair(
    clean: np.ndarray,
    blurred: np.ndarray,
    result: np.ndarray,
    meta: dict | None = None,
    rect: tuple[int, int, int, int] | None = None,
) -> dict:
    """用干净样例核对：字线宽度、边缘误差、梯度恢复、无拖影区变化。"""
    bars = (meta or {}).get("bars", [])
    edges = (meta or {}).get("edges", [])
    unchanged_rect = (meta or {}).get("no_blur_rect")

    report: dict = {
        "gradient_recovery": gradient_recovery(blurred, result, clean),
        "residual_blurred_vs_clean_rms": float(np.sqrt(np.mean((blurred - clean) ** 2))),
        "residual_result_vs_clean_rms": float(np.sqrt(np.mean((result - clean) ** 2))),
        "residual_stats": residual_stats(blurred, result, rect).to_dict(),
    }
    if bars:
        bw = bar_width_report(blurred, result, clean, bars)
        report["bar_widths"] = [b.to_dict() for b in bw]
        errs = [abs(b.error_px) for b in bw if np.isfinite(b.error_px)]
        report["bar_width_mean_abs_error_px"] = float(np.mean(errs)) if errs else float("nan")
        blurred_errs = [
            abs(b.measured_blurred_px - b.true_width_px)
            for b in bw
            if np.isfinite(b.measured_blurred_px)
        ]
        report["bar_width_mean_abs_error_blurred_px"] = (
            float(np.mean(blurred_errs)) if blurred_errs else float("nan")
        )
    if edges:
        e_report = [e.to_dict() for e in edge_error_report(blurred, result, clean, edges)]
        report["edges"] = e_report
        pos_errs = [abs(e["position_error_px"]) for e in e_report if np.isfinite(e["position_error_px"])]
        report["edge_mean_abs_position_error_px"] = (
            float(np.mean(pos_errs)) if pos_errs else float("nan")
        )
        widths = [e["result_transition_10_90_px"] for e in e_report if np.isfinite(e["result_transition_10_90_px"])]
        clean_widths = [e["clean_transition_10_90_px"] for e in e_report if np.isfinite(e["clean_transition_10_90_px"])]
        report["edge_mean_transition_10_90_px"] = float(np.mean(widths)) if widths else float("nan")
        report["edge_mean_transition_clean_10_90_px"] = (
            float(np.mean(clean_widths)) if clean_widths else float("nan")
        )
    if unchanged_rect:
        report["unchanged_region"] = unchanged_stats(blurred, result, tuple(unchanged_rect))
        report["unchanged_region_vs_clean"] = unchanged_stats(clean, result, tuple(unchanged_rect))
    return report


def save_validation(path: str | Path, report: dict, params: dict | None = None) -> Path:
    payload = {
        "created": datetime.now().isoformat(timespec="seconds"),
        "params": params,
        "report": report,
    }
    return write_json(path, payload)


def format_validation(report: dict) -> str:
    lines = []
    gr = report.get("gradient_recovery")
    if gr is not None and np.isfinite(gr):
        lines.append(f"梯度恢复率      : {gr:6.3f}  (1.0=恢复到干净图, >1=过锐)")
    rb = report.get("residual_blurred_vs_clean_rms")
    rr = report.get("residual_result_vs_clean_rms")
    if rb is not None:
        lines.append(f"对干净图 RMS    : 模糊 {rb:.4f} -> 结果 {rr:.4f}")
    if "bar_widths" in report:
        lines.append("字线宽度核对:")
        for b in report["bar_widths"]:
            if np.isfinite(b["measured_result_px"]):
                lines.append(
                    f"  {b['label']:<10} 真值 {b['true_width_px']:.1f}  "
                    f"模糊 {b['measured_blurred_px']:.2f}  结果 {b['measured_result_px']:.2f}  "
                    f"误差 {b['error_px']:+.2f} px"
                )
        ma = report.get("bar_width_mean_abs_error_px")
        mb = report.get("bar_width_mean_abs_error_blurred_px")
        if ma is not None and np.isfinite(ma):
            lines.append(f"  平均绝对误差: 模糊 {mb:.2f} px -> 结果 {ma:.2f} px")
    if "edges" in report:
        lines.append("边缘误差核对:")
        for e in report["edges"]:
            if np.isfinite(e["position_error_px"]):
                lines.append(
                    f"  {e['label']:<10} 位置误差 {e['position_error_px']:+.2f} px  "
                    f"过渡宽(10-90%) 模糊 {e['blurred_transition_10_90_px']:.2f} -> "
                    f"结果 {e['result_transition_10_90_px']:.2f} / 干净 {e['clean_transition_10_90_px']:.2f}"
                )
        me = report.get("edge_mean_abs_position_error_px")
        if me is not None and np.isfinite(me):
            lines.append(f"  平均位置误差: {me:.2f} px")
    if "unchanged_region" in report:
        u = report["unchanged_region"]
        lines.append(
            f"无拖影区变化    : RMS {u['rms']:.4f}, 超容差(>{u['tol']}) {u['frac_over_tol']:.2%}"
        )
    if "unchanged_region_vs_clean" in report:
        u = report["unchanged_region_vs_clean"]
        lines.append(f"无拖影区对干净图: RMS {u['rms']:.4f}")
    return "\n".join(lines)
