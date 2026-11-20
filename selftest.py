"""核心引擎自测：透明区域、抗锯齿过渡、保护色、蒙版、批量容错。

运行: python3 -I selftest.py
"""

from __future__ import annotations

import os
import tempfile

import numpy as np

from pixel_recolor import samples
from pixel_recolor.batch import export_batch, run_batch
from pixel_recolor.core import (
    ColorMapping,
    Scheme,
    apply_scheme,
    extract_palette,
    load_rgba,
)
from pixel_recolor.project import ImageItem, Project


def make_test_image() -> np.ndarray:
    """4x4：纯红、半透明红（AA 边缘）、纯蓝、全透明。"""
    arr = np.zeros((4, 4, 4), dtype=np.uint8)
    arr[0, 0] = (255, 0, 0, 255)    # 纯红
    arr[0, 1] = (255, 0, 0, 128)    # 半透明红（边缘）
    arr[0, 2] = (200, 0, 0, 255)    # 暗红（容差内）
    arr[1, 0] = (0, 0, 255, 255)    # 纯蓝
    # 其余像素 alpha=0（全透明）
    return arr


def test_basic_recolor():
    arr = make_test_image()
    scheme = Scheme("t", [ColorMapping("#ff0000", "#00ff00", tolerance=0)])
    out, changed = apply_scheme(arr, scheme)
    assert tuple(out[0, 0]) == (0, 255, 0, 255), "纯红应变纯绿"
    assert tuple(out[0, 1]) == (0, 255, 0, 128), "半透明边缘应变绿且 alpha 不变"
    assert tuple(out[0, 2]) == (200, 0, 0, 255), "容差 0 时暗红不变"
    assert tuple(out[1, 0]) == (0, 0, 255, 255), "蓝色不变"
    assert (out[..., 3] == arr[..., 3]).all(), "alpha 通道必须保持不变"
    assert changed[0, 0] and changed[0, 1] and not changed[1, 0]
    assert not changed[3, 3], "透明像素不参与"


def test_tolerance_gradient():
    arr = make_test_image()
    scheme = Scheme("t", [ColorMapping("#ff0000", "#00ff00", tolerance=100)])
    out, _ = apply_scheme(arr, scheme)
    # 暗红 (200,0,0) 距红 55，权重 0.45：R 应介于 200 与 0 之间，G 介于 0 与 255
    r, g, b, a = (int(v) for v in out[0, 2])
    assert 0 < r < 200 and 0 < g < 255, f"容差内应平滑过渡, 实际 {(r, g, b)}"
    assert a == 255


def test_protected_and_mask():
    arr = make_test_image()
    scheme = Scheme("t", [ColorMapping("#ff0000", "#00ff00", tolerance=100)],
                    protected=["#c80000"])
    out, _ = apply_scheme(arr, scheme)
    assert tuple(out[0, 2]) == (200, 0, 0, 255), "保护色(200,0,0)不应被改动"

    mask = np.zeros((4, 4), dtype=bool)
    mask[0, 0] = True
    out2, _ = apply_scheme(arr, Scheme("t", [ColorMapping("#ff0000", "#00ff00")]),
                           exclude_mask=mask)
    assert tuple(out2[0, 0]) == (255, 0, 0, 255), "蒙版区域不应被改动"
    assert tuple(out2[0, 1]) == (0, 255, 0, 128), "蒙版外正常换色"


def test_batch_fault_tolerance(tmp):
    paths = samples.generate(tmp)
    bad = os.path.join(tmp, "broken.png")
    with open(bad, "wb") as f:
        f.write(b"not a png")
    proj = Project(
        schemes=[Scheme("s1", [ColorMapping("#8a9ba8", "#ff8800", tolerance=30)])],
        images=[ImageItem(p, "s1") for p in paths]
        + [ImageItem(bad, "s1"), ImageItem(paths[0], "不存在的方案")],
        output_dir=os.path.join(tmp, "out"),
    )
    batch = run_batch(proj)
    assert len(batch.succeeded) == 3, f"3 张示例应成功, {len(batch.succeeded)}"
    assert len(batch.failed) == 2, "坏图与缺失方案应失败"

    batch2, mj, mc = export_batch(proj)
    assert os.path.exists(mj) and os.path.exists(mc)
    import json
    manifest = json.load(open(mj, encoding="utf-8"))
    assert manifest["succeeded"] == 3 and manifest["failed"] == 2
    ok_records = [r for r in manifest["images"] if r["ok"]]
    assert all(r["scheme"] == "s1" for r in ok_records), "清单应记录每张图所用方案"
    for r in batch2.succeeded:
        assert os.path.exists(r.output), "导出文件应存在"
        assert r.output != r.path, "原图不被覆盖"


def test_project_roundtrip(tmp):
    proj = Project(
        schemes=[Scheme("s", [ColorMapping("#112233", "#445566", 10)], ["#000000"])],
        images=[ImageItem("/a.png", "s", "/mask.png")],
        output_dir="out",
    )
    p = os.path.join(tmp, "proj.json")
    proj.save(p)
    loaded = Project.load(p)
    assert loaded.to_dict() == proj.to_dict()


def test_samples_have_aa_and_colors(tmp):
    paths = samples.generate(tmp)
    assert len(paths) == 3
    for p in paths:
        arr = load_rgba(p)
        alpha = arr[..., 3]
        partial = ((alpha > 0) & (alpha < 255)).sum()
        assert partial > 50, f"{p} 应有半透明抗锯齿边缘, 实际 {partial}"
        assert (alpha == 0).any(), f"{p} 应有透明背景"
        palette = extract_palette(arr)
        assert len(palette) >= 3, f"{p} 应有多个颜色块"


def main():
    tmp = tempfile.mkdtemp(prefix="recolor_test_")
    test_basic_recolor()
    test_tolerance_gradient()
    test_protected_and_mask()
    test_batch_fault_tolerance(tmp)
    test_project_roundtrip(tmp)
    test_samples_have_aa_and_colors(tmp)
    print("全部自测通过 ✓")


if __name__ == "__main__":
    main()
