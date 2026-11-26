"""遮挡打分与模板掩膜提取。"""

import cv2
import numpy as np

from markfinder.matching import SearchParams, find_matches, score_pose, warp_pose
from markfinder.template import extract_rect_template, save_template, load_template


def test_occluded_mark_gets_candidate_and_cell_scores(scene_with_marks, arrow_template):
    scene, instances = scene_with_marks
    cx, cy = instances[0][0], instances[0][1]
    # 盖住第一个标记的一角
    damaged = scene.copy()
    cv2.circle(damaged, (int(cx + 18), int(cy - 18)), 16, (232, 232, 232), -1)

    params = SearchParams(angle_step=10, min_scale=0.85, max_scale=1.15,
                          num_scales=3, score_threshold=0.55)
    matches = find_matches(arrow_template, damaged, params)
    hit = min(matches, key=lambda m: np.hypot(m.x - cx, m.y - cy))
    assert np.hypot(hit.x - cx, hit.y - cy) < 30
    # 主分是方向 chamfer，对局部遮挡鲁棒：缺一角仍是高分候选
    assert hit.score >= 0.55
    assert hit.coverage >= 0.3

    # 逐单元灰度 NCC 作为诊断分：至少有有效单元，被挡局部会显式偏低
    cells = hit.cell_scores[~np.isnan(hit.cell_scores)]
    assert cells.size >= 4

    # 局部对照面板数据齐全
    pose = score_pose(damaged, arrow_template, (hit.x, hit.y), hit.angle,
                      hit.scale, hit.flipped)
    assert pose.warped_template.shape[:2] == pose.warped_mask.shape
    assert pose.target_crop.size > 0


def test_rect_and_flood_extraction(tmp_path):
    # 造一块带背景的样例：深色箭头放在浅色背景中央
    img = np.full((200, 200, 3), 230, np.uint8)
    cv2.arrowedLine(img, (100, 150), (100, 60), (20, 20, 160), 12, tipLength=0.4)

    rect_tpl = extract_rect_template(img, (60, 40, 80, 130), mode="rect")
    assert rect_tpl.mask.all()  # rect 模式整块有效

    flood_tpl = extract_rect_template(img, (60, 40, 80, 130), mode="flood", bg_tolerance=30)
    fg_ratio = float((flood_tpl.mask > 0).mean())
    # 背景被灌掉大部分，前景只占矩形的一小部分
    assert 0.05 < fg_ratio < 0.7

    center_tpl = extract_rect_template(img, (60, 40, 80, 130), mode="center", bg_tolerance=30)
    assert (center_tpl.mask > 0).sum() > 50

    # 带 alpha 的模板能往返保存
    path = tmp_path / "tpl.png"
    save_template(flood_tpl, path)
    reloaded = load_template(path)
    assert reloaded.width == flood_tpl.width
    np.testing.assert_array_equal(reloaded.mask, flood_tpl.mask)
