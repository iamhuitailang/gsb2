"""评审状态：阈值重算保留人工结论、逐图隔离、导出与修订日志。"""

import json
from pathlib import Path

import cv2
import numpy as np

from markfinder.candidates import Match
from markfinder.export import export_results
from markfinder.matching import SearchParams, find_matches
from markfinder.review import ReviewStore, image_identity


def _make_match(idx: int, x: float, y: float, angle: float = 10.0,
                scale: float = 1.0, flipped: bool = False,
                score: float = 0.8) -> Match:
    return Match(
        id=f"m{idx:04d}", x=x, y=y, angle=angle, scale=scale, flipped=flipped,
        score=score, robust_score=score - 0.05,
        bbox=np.zeros((4, 2)), cell_scores=np.full((4, 4), np.nan),
        cell_rows=4, cell_cols=4,
    )


def test_decisions_survive_rerun(tmp_path):
    store = ReviewStore(tmp_path / "state.json")
    state = store.get_state("img-a", "/tmp/a.png")
    first = [_make_match(1, 100, 100, score=0.9), _make_match(2, 300, 200, score=0.7)]
    store.replace_matches(state, first, params={"k": 1}, threshold=0.5, position_tol_px=30)
    store.set_decision(state, "m0001", "confirmed")
    store.set_decision(state, "m0002", "false_positive")

    # 重算：同一物理标记换了候选 id、位置轻微漂移，决策必须认回
    second = [_make_match(3, 102, 101, angle=11.0, score=0.91),
              _make_match(4, 302, 199, angle=12.0, score=0.72),
              _make_match(5, 500, 500, score=0.65)]
    store.replace_matches(state, second, params={"k": 2}, threshold=0.5, position_tol_px=30)
    by_pos = {(round(m.x), round(m.y)): m for m in state.matches}
    assert by_pos[(102, 101)].decision == "confirmed"
    assert by_pos[(302, 199)].decision == "false_positive"
    assert by_pos[(500, 500)].decision == "candidate"

    # 修订日志记录了两次重算与两次人工决策
    actions = [r["action"] for r in state.revisions]
    assert actions.count("rerun") == 2
    assert actions.count("decision") == 2

    # 落盘再加载，决策仍在（候选 id 在重算后会变，按决策内容核对）
    store.save()
    reloaded = ReviewStore(tmp_path / "state.json")
    st2 = reloaded.get_state("img-a", "/tmp/a.png")
    assert any(d["decision"] == "confirmed" for d in st2.decisions.values())
    assert any(d["decision"] == "false_positive" for d in st2.decisions.values())


def test_threshold_filter_keeps_confirmed(tmp_path):
    store = ReviewStore(None)
    state = store.get_state("img", "/tmp/x.png")
    matches = [_make_match(1, 10, 10, score=0.9), _make_match(2, 80, 80, score=0.4)]
    store.replace_matches(state, matches, params={}, threshold=0.3, position_tol_px=30)
    store.set_decision(state, "m0002", "confirmed")
    store.apply_threshold_filter(state, 0.5)
    assert state.matches[0].hidden is False
    assert state.matches[1].hidden is False  # 已确认的低分项不隐藏


def test_image_states_are_isolated(tmp_path):
    # 两张不同的图（不同路径/mtime），决策绝不能串
    p1 = tmp_path / "a.png"
    p2 = tmp_path / "b.png"
    cv2.imwrite(str(p1), np.full((10, 10, 3), 1, np.uint8))
    cv2.imwrite(str(p2), np.full((10, 10, 3), 2, np.uint8))
    key1 = image_identity(p1)
    key2 = image_identity(p2)
    assert key1 != key2

    store = ReviewStore(tmp_path / "state.json")
    s1 = store.get_state(key1, str(p1))
    s2 = store.get_state(key2, str(p2))
    store.replace_matches(s1, [_make_match(1, 5, 5)], {}, 0.5, 30)
    store.set_decision(s1, "m0001", "confirmed")
    store.replace_matches(s2, [_make_match(1, 5, 5)], {}, 0.5, 30)
    assert s2.matches[0].decision == "candidate"
    assert s1.matches[0].decision == "confirmed"


def test_export_files(tmp_path, scene_with_marks, arrow_template):
    scene, _ = scene_with_marks
    params = SearchParams(angle_step=15, min_scale=0.8, max_scale=1.25,
                          num_scales=4, score_threshold=0.5)
    matches = find_matches(arrow_template, scene, params)
    store = ReviewStore(None)
    state = store.get_state("img", str(tmp_path / "scene.png"))
    store.replace_matches(state, matches, {}, 0.5, 30)
    if matches:
        store.set_decision(state, matches[0].id, "confirmed")

    out = tmp_path / "export"
    paths = export_results(state, scene, out)
    for key in ("csv", "json", "revisions", "annotated"):
        assert Path(paths[key]).exists()
    data = json.loads(Path(paths["json"]).read_text(encoding="utf-8"))
    assert data["counts"]["confirmed"] == 1
    assert all("angle" in m and "x" in m and "y" in m for m in data["matches"])
    revisions = json.loads(Path(paths["revisions"]).read_text(encoding="utf-8"))
    assert any(r["action"] == "decision" for r in revisions["revisions"])
