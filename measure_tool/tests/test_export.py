"""工程文件导出、读回与描边测试。"""
import cv2
import numpy as np

from core.export_project import (
    build_export, draw_annotation, load_project,
    save_project, validate_project_against_image,
)
from core.geometry import Calibration, Ruler
from core.measurements import measure_all
from core.segmentation import SegmentParams, segment


def _pipeline(tmp_path):
    img = np.full((400, 500), 240, dtype=np.uint8)
    cv2.rectangle(img, (100, 100), (300, 300), 20, cv2.FILLED)
    cv2.circle(img, (200, 200), 20, 240, cv2.FILLED)

    h = Ruler((50, 350), (450, 350), 40.0)
    v = Ruler((50, 350), (50, 50), 30.0)
    calib = Calibration(h, v, img.shape[:2])
    seg_res = segment(img, SegmentParams())
    measurements = measure_all(seg_res, calib)

    project = build_export(
        image_path="scan.png", image_shape=img.shape[:2],
        calibration=calib, segmentation=seg_res,
        measurements=measurements,
    )
    fpath = save_project(project, tmp_path / "project.json")
    return img, calib, seg_res, measurements, project, fpath


def test_export_roundtrip(tmp_path):
    img, calib, seg_res, measurements, project, fpath = _pipeline(tmp_path)
    loaded = load_project(fpath)
    assert loaded["schema_version"] == project["schema_version"]
    problems = validate_project_against_image(loaded, img.shape[:2])
    assert problems == []
    restored = __import__(
        "core.export_project", fromlist=["restore_calibration"]
    ).restore_calibration(loaded)
    uv = np.array([[5.0, -5.0]])
    assert np.allclose(restored.to_pixel(uv), calib.to_pixel(uv), atol=1e-9)


def test_validate_detects_size_mismatch(tmp_path):
    _, _, _, _, project, fpath = _pipeline(tmp_path)
    loaded = load_project(fpath)
    problems = validate_project_against_image(loaded, (500, 600))
    assert any("尺寸不一致" in p for p in problems)


def test_annotation_draws_without_error(tmp_path):
    img, calib, seg_res, measurements, project, _ = _pipeline(tmp_path)
    annotated = draw_annotation(img, calib, project, measurements,
                                selected_id=next(iter(measurements)))
    assert annotated.shape[:2] == img.shape[:2]
    # 描边图上应出现彩色像素（轮廓线/测量线）
    gray_back = cv2.cvtColor(annotated, cv2.COLOR_BGR2GRAY)
    assert gray_back.std() > 5


def test_pending_readings_persist(tmp_path):
    img, calib, seg_res, measurements, project, fpath = _pipeline(tmp_path)
    cid = next(iter(measurements))
    project["pending_readings"] = {str(cid): {"status": "pending",
                                               "note": "孔边缘发虚"}}
    save_project(project, fpath)
    loaded = load_project(fpath)
    assert loaded["pending_readings"][str(cid)]["status"] == "pending"
