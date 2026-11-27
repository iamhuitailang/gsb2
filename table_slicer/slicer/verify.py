"""对合成图的检测/切格结果与真值做核对（需求 5）。

真值坐标是旋转前的，因此先把真值网格角点用拉正逆变换映射回原图，
再正变换到拉正图坐标系，与检测到的 xs/ys 和裁切矩形比较。
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from .geometry import RotationInfo, original_to_rectified, rectified_to_original
from .grid import GridModel


def _truth_grid_rectified(truth: dict, rot: RotationInfo) -> tuple[list[float], list[float]]:
    """把真值的旋转前网格坐标换算到拉正图坐标系。"""
    xs0 = np.array(truth["xs_pre_rotation"], dtype=np.float64)
    ys0 = np.array(truth["ys_pre_rotation"], dtype=np.float64)
    pts = np.array([(x, y) for y in ys0 for x in xs0])
    # 合成器在原画布中心旋转、不扩展画布；这里必须用原图尺寸
    import cv2
    H0, W0 = rot.original_shape
    m = cv2.getRotationMatrix2D((W0 / 2, H0 / 2), truth["rotation_deg"], 1.0)
    homo = np.hstack([pts, np.ones((len(pts), 1))])
    in_original = homo @ m.T
    # 原图坐标 -> 拉正图坐标（deskew 内部再做反向旋转与裁白边）
    rect = original_to_rectified(in_original, rot)
    rect = rect.reshape(len(ys0), len(xs0), 2)
    xs = rect[0, :, 0].tolist()
    ys = rect[:, 0, 1].tolist()
    return xs, ys


def verify(model: GridModel, rot: RotationInfo, truth_path: str | Path) -> dict:
    truth = json.loads(Path(truth_path).read_text(encoding="utf-8"))
    report: dict = {"ok": True, "checks": [], "errors": []}

    def check(name: str, passed: bool, detail: str) -> None:
        report["checks"].append({"name": name, "passed": bool(passed), "detail": detail})
        if not passed:
            report["ok"] = False
            report["errors"].append(f"{name}: {detail}")

    # 1) 行列数
    check("行列数",
          model.n_rows == truth["n_rows"] and model.n_cols == truth["n_cols"],
          f"检测 {model.n_rows}x{model.n_cols} / 真值 {truth['n_rows']}x{truth['n_cols']}")

    # 2) 格数与合并关系
    truth_cells = {(c["anchor"][0], c["anchor"][1]): tuple(c["span"])
                   for c in truth["cells"]}
    det_cells = {c.anchor: c.span for c in model.cells}
    check("格子数", len(det_cells) == len(truth_cells),
          f"检测 {len(det_cells)} 格 / 真值 {len(truth_cells)} 格")
    merge_issues = []
    for anchor, span in truth_cells.items():
        got = det_cells.get(anchor)
        if got != span:
            merge_issues.append(f"R{anchor[0]+1}C{anchor[1]+1}: 真值{span} 检测{got}")
    check("合并关系", not merge_issues,
          "全部一致" if not merge_issues else "; ".join(merge_issues))

    # 3) 裁切偏差：真值网格线 vs 检测网格线（拉正坐标）
    try:
        t_xs, t_ys = _truth_grid_rectified(truth, rot)
        d_xs, d_ys = model.det.xs, model.det.ys
        if len(d_xs) == len(t_xs) and len(d_ys) == len(t_ys):
            err_x = np.abs(np.array(d_xs) - np.array(t_xs))
            err_y = np.abs(np.array(d_ys) - np.array(t_ys))
            report["line_errors_px"] = {
                "x_max": float(err_x.max()), "x_mean": float(err_x.mean()),
                "y_max": float(err_y.max()), "y_mean": float(err_y.mean()),
            }
            # 裁切矩形四角偏差
            corner_errs = []
            for cell in model.cells:
                r0, c0 = cell.anchor
                truth_rect = (t_xs[c0], t_ys[r0],
                              t_xs[c0 + cell.span[1]], t_ys[r0 + cell.span[0]])
                det_rect = (d_xs[c0], d_ys[r0],
                            d_xs[c0 + cell.span[1]], d_ys[r0 + cell.span[0]])
                corner_errs.append(max(abs(a - b) for a, b in zip(truth_rect, det_rect)))
            report["crop_error_px"] = {
                "max": float(max(corner_errs)), "mean": float(np.mean(corner_errs)),
            }
            tol = 6.0
            check("裁切偏差", max(corner_errs) <= tol,
                  f"最大 {max(corner_errs):.2f}px / 平均 {np.mean(corner_errs):.2f}px"
                  f"（容差 {tol}px）")
        else:
            check("裁切偏差", False,
                  f"网格线数量不一致 x:{len(d_xs)}/{len(t_xs)} y:{len(d_ys)}/{len(t_ys)}")
    except Exception as exc:  # noqa: BLE001 - 自检失败要落报告而非抛栈
        check("裁切偏差", False, f"计算异常: {exc}")

    # 4) 编号稳定性：编号集合应等于真值锚点集合
    det_codes = {c.code for c in model.cells}
    truth_codes = {f"R{a[0]+1}C{a[1]+1}" for a in truth_cells}
    check("编号稳定", det_codes == truth_codes,
          "编号一一对应" if det_codes == truth_codes
          else f"缺失 {sorted(truth_codes - det_codes)} 多出 {sorted(det_codes - truth_codes)}")

    report["n_low_confidence"] = len(model.det.low_confidence)
    return report
