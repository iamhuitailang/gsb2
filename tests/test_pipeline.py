import cv2
import numpy as np
import pytest

from focus_stack.pipeline import (
    load_images,
    point_info,
    refusion_only,
    run_pipeline,
)
from focus_stack.project import load_project, save_outputs
from focus_stack.registration import STATUS_FAIL
from focus_stack.samples import SAMPLE_SETS, generate_focus_stack
from focus_stack.selection import Pin, PinSet


@pytest.fixture(scope="module")
def scene_paths(tmp_path_factory):
    d = tmp_path_factory.mktemp("scene")
    return generate_focus_stack(d, n=4)


@pytest.fixture(scope="module")
def fail_paths(tmp_path_factory):
    d = tmp_path_factory.mktemp("failure")
    return generate_focus_stack(d, n=4, failure=True)


def test_sample_stack_properties(scene_paths):
    imgs = load_images(scene_paths)
    assert len(imgs) == 4
    assert all(im.shape == imgs[0].shape for im in imgs)
    # 文件名顺序即焦点顺序
    assert scene_paths == sorted(scene_paths)


def test_pipeline_end_to_end(scene_paths):
    imgs = load_images(scene_paths)
    result = run_pipeline(imgs)
    assert result.fusion.composite.shape == imgs[0].shape
    # 全部源参与（样例呼吸量在阈值内）
    assert sorted(result.usable) == [0, 1, 2, 3]
    # 标签只包含可用源与无效标记
    uniq = set(np.unique(result.labels).tolist())
    assert uniq.issubset({-1, 0, 1, 2, 3})
    # 软权重在有效区归一
    valid = result.valid_mask > 0
    assert np.allclose(result.weights[:, valid].sum(axis=0), 1.0, atol=1e-4)


def test_flat_color_area_stable_label(scene_paths):
    """需求：大面积没细节的位置应有稳定的选取结果。"""
    imgs = load_images(scene_paths)
    r1 = run_pipeline([im.copy() for im in imgs])
    r2 = run_pipeline([im.copy() for im in imgs])
    # 纯色块位于画面右下（samples.build_scene_prims 中 0.60~0.93 区域），
    # 取严格内部以避开色块边缘的虚化过渡带
    h, w = r1.labels.shape
    sl = (slice(int(h * 0.70), int(h * 0.85)), slice(int(w * 0.68), int(w * 0.88)))
    block1 = r1.labels[sl]
    block2 = r2.labels[sl]
    vals, counts = np.unique(block1, return_counts=True)
    dominant = vals[np.argmax(counts)]
    assert counts.max() / block1.size > 0.9
    # 两次运行主标签一致
    vals2, counts2 = np.unique(block2, return_counts=True)
    assert vals2[np.argmax(counts2)] == dominant


def test_failure_set_flags_last_source(fail_paths):
    imgs = load_images(fail_paths)
    result = run_pipeline(imgs)
    assert result.registration.items[-1].status == STATUS_FAIL
    assert 3 not in result.usable
    # 失败源不出现在标签里
    assert 3 not in np.unique(result.labels)


def test_pin_preserved_across_refusion(scene_paths):
    imgs = load_images(scene_paths)
    result = run_pipeline(imgs)
    h, w = result.labels.shape
    pin = Pin.create(1, "rect", [30, 30, 90, 90], "test-pin")
    result.pins.add(pin)
    refusion_only(result)
    # 留出滤波核边界，pin 内部稳定为源 1
    assert (result.labels[34:86, 34:86] == 1).all()

    # 再加第二个 pin（矩形，切片与栅格严格对齐），第一个 pin 内部不动
    pin2 = Pin.create(2, "rect", [200, 200, 260, 260], "second")
    result.pins.add(pin2)
    refusion_only(result)
    assert (result.labels[34:86, 34:86] == 1).all()
    assert (result.labels[204:256, 204:256] == 2).all()
    assert len(result.pins.pins) == 2


def test_point_info_after_crop(scene_paths):
    imgs = load_images(scene_paths)
    result = run_pipeline(imgs, coverage_mode="crop")
    assert result.fusion.bbox is not None
    # 裁剪后点击 (5,5)，内部应换算回全帧坐标且不越界
    info = point_info(result, 5, 5)
    x, y = info["point"]
    assert 0 <= x < result.labels.shape[1] and 0 <= y < result.labels.shape[0]


def test_project_save_reload_roundtrip(scene_paths, tmp_path):
    imgs = load_images(scene_paths)
    result = run_pipeline(imgs)
    result.pins.add(Pin.create(2, "rect", [10, 10, 60, 60], "saved-pin"))
    refusion_only(result)

    root = tmp_path / "project"
    save_outputs(root, result.fusion.composite, result.fusion.source_map)
    from focus_stack.project import save_project
    from focus_stack.selection import SelectionConfig
    from focus_stack.sharpness import SharpnessConfig
    save_project(root, scene_paths, result.registration, result.pins,
                 SharpnessConfig(), SelectionConfig(),
                 result.temperature, "soft", "keep",
                 cache={"scores": result.scores, "labels": result.labels,
                        "weights": result.weights,
                        "valid_mask": result.valid_mask})

    assert (root / "project.json").exists()
    assert (root / "composite.png").exists()
    assert (root / "source_map.png").exists()
    assert len(list((root / "sources").iterdir())) == 4

    data = load_project(root)
    assert len(data["source_paths"]) == 4
    assert len(data["pins"].pins) == 1
    assert data["pins"].pins[0].source_index == 2
    assert data["cache"] is not None and "scores" in data["cache"]
    # 复用保存的配准重跑，结果一致
    reloaded = run_pipeline(load_images(data["source_paths"]),
                            pins=data["pins"], existing_reg=data["registration"])
    assert reloaded.registration is data["registration"]
    assert reloaded.labels.shape == result.labels.shape
    assert (reloaded.labels[14:56, 14:56] == 2).all()


def test_hard_mode_output(scene_paths):
    imgs = load_images(scene_paths)
    result = run_pipeline(imgs, fusion_mode="hard")
    assert result.fusion.mode == "hard"
    # 硬合成每个像素严格等于某张源
    h, w = result.labels.shape
    sample = np.random.default_rng(0).integers(0, (h, w), size=(20, 2))
    for y, x in sample:
        lab = result.labels[y, x]
        if lab >= 0:
            assert tuple(result.fusion.composite[y, x]) == tuple(result.aligned[lab][y, x])
