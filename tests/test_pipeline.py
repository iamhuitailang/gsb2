"""端到端：合成样例 -> 估计 -> 区域处理 -> 导出 -> 验证。"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from blurlab import synth
from blurlab.app import AppController
from blurlab.deblur import DeblurParams
from blurlab.export import export_result, format_validation, validate_pair
from blurlab.image_io import load_image, load_meta
from blurlab.pipeline import process_regions, sweep_parameters
from blurlab.regions import RegionSet


def test_sample_suite_files_exist(tmp_samples):
    for key in ("clean", "meta"):
        assert Path(tmp_samples[key]).exists()
    assert len(tmp_samples["variants"]) == 2
    meta = json.loads(Path(tmp_samples["meta"]).read_text(encoding="utf-8"))
    assert len(meta["bar_widths"]) == 5
    assert all(w >= 1 for w in meta["bar_widths"])
    # 真值必须与实际绘制的条宽一致
    assert [float(b["width_px"]) for b in meta["bars"]] == meta["bar_widths"]
    assert len(meta["edges"]) >= 3
    assert meta["no_blur_rect"] is not None


def test_estimated_length_close_to_truth_for_three_edges():
    img, meta = synth.generate_board(640, 460, seed=5)
    blurred = synth.kernel.blur_image(img, 13.0, 40.0, sigma=0.6)
    blurred = synth.add_capture_noise(blurred, 0.006, seed=9)

    ctl = AppController()
    ctl.s.image = blurred
    ctl.s.clean = img
    ctl.s.meta = meta.to_json()
    ctl.s.region_set = RegionSet(width=640, height=460)

    # 三条法向不同的边（0°/90°/135°）才能同时定出长度与方向
    for edge in meta.edges:
        ctl.add_reference_edge(*edge.probe_segment())
    est = ctl.s.estimate
    assert est is not None
    assert est.method == "multi-edge"
    assert est.length_px is not None and est.angle_deg is not None
    assert abs(est.length_px - 13.0) < 3.5
    from blurlab.kernel import angle_difference

    assert angle_difference(est.angle_deg, 40.0) < 12.0


def test_two_region_pipeline_and_export(tmp_path):
    img, meta = synth.generate_board(520, 380, seed=13)
    specs = [
        synth.BlurSpec("A", (260, 140, 420, 250), 9.0, 25.0, feather_px=8),
        synth.BlurSpec("B", (360, 180, 500, 320), 7.0, 115.0, feather_px=8),
    ]
    blurred, _ = synth.blur_regions(img, specs, sensor_sigma=0.5)
    blurred = synth.add_capture_noise(blurred, 0.006, seed=21)

    rs = RegionSet(width=520, height=380)
    rs.add(specs[0].rect, DeblurParams(9.0, 25.0), label="A", feather_px=8, priority=0)
    rs.add(specs[1].rect, DeblurParams(7.0, 115.0), label="B", feather_px=8, priority=1)

    pipe = process_regions(blurred, rs, clean=img,
                           unchanged_rect=meta.no_blur_rect, compute_metrics=True)
    assert pipe.result.shape == blurred.shape
    assert len(pipe.region_runs) == 2
    # 重叠区归属 B
    y = (180 + 250) // 2
    x = (360 + 420) // 2
    assert pipe.coverage_count[y, x] == 2

    paths = export_result(tmp_path / "out", blurred, pipe.result, pipe.residual, rs,
                          pipeline=pipe, meta=meta.to_json())
    assert Path(paths["result"]).exists()
    assert Path(paths["params"]).exists()
    params = json.loads(Path(paths["params"]).read_text(encoding="utf-8"))
    assert len(params["regions"]) == 2
    assert params["overlaps"]
    assert params["pipeline"]["order"] == ["A", "B"]


def test_validation_report_has_width_and_edge_errors():
    img, meta = synth.generate_board(520, 380, seed=17)
    spec = synth.BlurSpec("A", (250, 130, 460, 300), 9.0, 30.0, feather_px=8)
    blurred, _ = synth.blur_regions(img, [spec], sensor_sigma=0.5)
    meta.blur_specs = [spec]
    meta_json = meta.to_json()

    rs = RegionSet(width=520, height=380)
    rs.add(spec.rect, DeblurParams(9.0, 30.0), label="A", feather_px=8)
    pipe = process_regions(blurred, rs, clean=img, compute_metrics=False)
    report = validate_pair(img, blurred, pipe.result, meta_json)
    assert "bar_widths" in report
    assert "edges" in report
    assert np.isfinite(report["gradient_recovery"])
    assert report["residual_result_vs_clean_rms"] < report["residual_blurred_vs_clean_rms"]
    text = format_validation(report)
    assert "字线宽度" in text and "边缘误差" in text


def test_sweep_finds_reasonable_best_length():
    img, _ = synth.generate_board(480, 340, seed=19)
    clean = img
    blurred = synth.kernel.blur_image(img, 11.0, 0.0, sigma=0.5)
    rect = (150, 100, 400, 300)
    rows = sweep_parameters(blurred, rect, 0.0, [5.0, 9.0, 11.0, 13.0, 17.0], [4.0], clean=clean)
    best = max(rows, key=lambda r: r["gradient_recovery"])
    assert abs(best["length_px"] - 11.0) <= 2.0


def test_unchanged_area_barely_moves(tmp_path):
    img, meta = synth.generate_board(520, 380, seed=23)
    spec = synth.BlurSpec("A", (250, 130, 460, 300), 9.0, 30.0, feather_px=8)
    blurred, _ = synth.blur_regions(img, [spec], sensor_sigma=0.5)
    rs = RegionSet(width=520, height=380)
    rs.add(spec.rect, DeblurParams(9.0, 30.0), label="A", feather_px=8)
    pipe = process_regions(blurred, rs, clean=img, unchanged_rect=meta.no_blur_rect)
    from blurlab.metrics import unchanged_stats

    s = unchanged_stats(blurred, pipe.result, meta.no_blur_rect)
    assert s["rms"] < 0.01


def test_controller_roundtrip(tmp_path):
    ctl = AppController()
    paths = ctl.generate_samples(tmp_path / "samples", seed=31)
    ctl.load_blurred_sample(paths["variants"][0]["path"])
    assert ctl.s.image is not None
    assert ctl.s.clean is not None

    est = ctl.set_manual_estimate(9.0, 30.0)
    region = ctl.add_region((200, 120, 420, 300), feather_px=8)
    assert region.params.length_px == 9.0
    pipe = ctl.preview()
    assert pipe.result.shape == ctl.s.image.shape

    ctl.update_region_params(region, noise_gain=3.0, priority=2)
    assert region.params.noise_gain == 3.0
    assert region.priority == 2

    out = ctl.export(tmp_path / "export")
    assert Path(out["params"]).exists()
    assert (tmp_path / "export" / "estimate.json").exists()

    text = ctl.validate()
    assert "梯度恢复率" in text


def test_controller_single_edge_requires_manual_angle():
    img, meta = synth.generate_board(400, 300, seed=37)
    blurred = synth.kernel.blur_image(img, 9.0, 0.0, sigma=0.5)
    ctl = AppController()
    ctl.s.image = blurred
    ctl.s.region_set = RegionSet(width=400, height=300)
    v = next(e for e in meta.edges if e.label == "edge_v")
    est = ctl.add_reference_edge(*v.probe_segment())
    assert est.angle_deg is None
    import pytest

    with pytest.raises(ValueError):
        ctl.add_region((50, 50, 200, 200))
    # 手填方向后可以建区域
    ctl.set_manual_estimate(9.0, 0.0)
    r = ctl.add_region((50, 50, 200, 200))
    assert r.params.angle_deg == 0.0
