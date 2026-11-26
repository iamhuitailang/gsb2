"""核心匹配：位置、角度、缩放、数量、翻面默认排除。"""

import math

import numpy as np

from markfinder.candidates import merge_candidates, Match
from markfinder.geometry import angle_diff
from markfinder.matching import SearchParams, find_matches, warp_pose
from markfinder.synthetic import generate_dataset, validate_dataset


def test_find_all_rotated_scaled_marks(scene_with_marks, arrow_template):
    scene, instances = scene_with_marks
    params = SearchParams(
        min_angle=0, max_angle=360, angle_step=10,
        min_scale=0.75, max_scale=1.3, num_scales=5,
        score_threshold=0.6,
    )
    matches = find_matches(arrow_template, scene, params)

    # 5 个真值标记全部被找到（允许额外低分候选，但每个真值必须有对应命中）
    assert len(matches) >= 5
    found = 0
    for cx, cy, ang, sc, _flip in instances:
        hit = min(matches, key=lambda m: math.hypot(m.x - cx, m.y - cy))
        if math.hypot(hit.x - cx, hit.y - cy) < 0.5 * min(arrow_template.width, arrow_template.height):
            found += 1
            assert abs(angle_diff(hit.angle, ang)) < 12
            assert abs(hit.scale - sc) < 0.18
            assert hit.score >= 0.6
    assert found == 5


def test_distractor_not_matched(scene_with_marks, arrow_template):
    scene, _ = scene_with_marks
    params = SearchParams(angle_step=15, score_threshold=0.6,
                          min_scale=0.8, max_scale=1.25, num_scales=4)
    matches = find_matches(arrow_template, scene, params)
    # 星形干扰位于 (680,110) 附近：任何候选都不该落在那里
    for m in matches:
        assert math.hypot(m.x - 680, m.y - 110) > 40


def test_angle_range_limit(scene_with_marks, arrow_template):
    scene, instances = scene_with_marks
    # 只允许 0~50 度：只有 15° 的标记该留下
    params = SearchParams(min_angle=0, max_angle=50, angle_step=5,
                          min_scale=0.9, max_scale=1.1, num_scales=3,
                          score_threshold=0.55)
    matches = find_matches(arrow_template, scene, params)
    assert len(matches) >= 1
    for m in matches:
        assert 0 <= m.angle <= 50 + 1e-6
    target = min(matches, key=lambda m: math.hypot(m.x - 150, m.y - 140))
    assert math.hypot(target.x - 150, target.y - 140) < 30


def test_flip_excluded_by_default(tmp_path, asym_template):
    # 对称形状（箭头/十字）翻面在物理上不可观测，因此翻面裁决必须用
    # 非对称形状：asym 左右镜像 IoU 很低，非翻面车道不该匹配翻面实例。
    import cv2

    scene = np.full((400, 500, 3), 232, np.uint8)
    warped, wmask, _, s = warp_pose(asym_template, 30.0, 1.0, flip=True)
    top = left = 100
    sub = scene[top:top + s, left:left + s]
    m = wmask[:sub.shape[0], :sub.shape[1]] > 0
    sub[m] = warped[:sub.shape[0], :sub.shape[1]][m]
    cv2.imwrite(str(tmp_path / "flip.png"), scene)

    no_flip = SearchParams(angle_step=10, min_scale=0.9, max_scale=1.1,
                           num_scales=3, score_threshold=0.6, allow_flip=False)
    assert find_matches(asym_template, scene, no_flip) == []

    with_flip = SearchParams(angle_step=10, min_scale=0.9, max_scale=1.1,
                             num_scales=3, score_threshold=0.6, allow_flip=True)
    hits = find_matches(asym_template, scene, with_flip)
    assert len(hits) == 1
    assert hits[0].flipped is True
    assert math.hypot(hits[0].x - (left + s / 2), hits[0].y - (top + s / 2)) < 12


def test_synthetic_dataset_counts_and_metrics(tmp_path):
    # 用非对称形状：翻面在外观上可观测，查准/查全都能干净达标
    data_dir = tmp_path / "synth"
    generate_dataset(data_dir, n_sheets=2, marks_per_sheet=8, seed=11,
                     shape_kind="asym")
    # 合成标记缩放范围 0.75~1.3；最小缩放取 0.7 可从源头排除 0.65 档
    # 小结构的偶然 chamfer 匹配（该档是误报主要来源）
    params = SearchParams(angle_step=10, min_scale=0.7, max_scale=1.4,
                          num_scales=6, score_threshold=0.6)
    summary = validate_dataset(data_dir, params=params)
    totals = summary["totals"]
    # 默认不翻面：普通标记查全 >= 0.9；查准 >= 0.85（剩余误报可在 GUI
    # 里人工标记，复核状态会被保留）
    assert totals["recall_normal"] >= 0.9
    assert totals["precision"] >= 0.85
    # 翻面标记默认不参与匹配
    assert totals["flipped_matched"] == 0
    # 开启翻面后能找回全部标记（含翻面）
    params.allow_flip = True
    summary_flip = validate_dataset(data_dir, params=params)
    assert summary_flip["totals"]["gt_total"] == summary_flip["totals"]["matched"]


def test_close_pair_both_kept(arrow_template):
    """贴得很近但可区分的两个标记，NMS 不能合并掉。"""
    base = Match(
        id="", x=100.0, y=100.0, angle=10.0, scale=1.0, flipped=False,
        score=0.9, robust_score=0.8, bbox=np.zeros((4, 2)),
        cell_scores=np.zeros((2, 2)), cell_rows=2, cell_cols=2,
    )
    near = Match(
        id="", x=100.0 + arrow_template.width * 0.9, y=102.0, angle=12.0,
        scale=1.02, flipped=False, score=0.85, robust_score=0.8,
        bbox=np.zeros((4, 2)), cell_scores=np.zeros((2, 2)),
        cell_rows=2, cell_cols=2,
    )
    radius = 0.35 * min(arrow_template.width, arrow_template.height)
    kept = merge_candidates([base, near], merge_radius_px=radius)
    assert len(kept) == 2

    # 同一位置的重复命中要合并
    dup = Match(
        id="", x=101.5, y=101.0, angle=11.0, scale=1.01, flipped=False,
        score=0.8, robust_score=0.7, bbox=np.zeros((4, 2)),
        cell_scores=np.zeros((2, 2)), cell_rows=2, cell_cols=2,
    )
    kept2 = merge_candidates([base, near, dup], merge_radius_px=radius)
    assert len(kept2) == 2
