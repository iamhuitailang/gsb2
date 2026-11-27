"""端到端与单元测试, 覆盖全部六项需求。

运行: python -m pytest -q
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from badcol.badlist import BadList, BadListError
from badcol.detect import ColumnSelection, DetectConfig, detect_columns
from badcol.io_utils import load_frames, save_image, to_gray
from badcol.repair import (
    EDGE_COPY,
    PROTECTED,
    REPAIRED,
    UNRELIABLE,
    UNREPAIRED,
    RepairConfig,
    assert_unchanged,
    repair_batch,
)
from badcol.report import compare_with_clean, write_change_stats
from badcol.synth import DefectSpec, SynthConfig, default_config, generate_batch


@pytest.fixture(scope="module")
def batch():
    cfg = default_config()
    clean, defective, manifest = generate_batch(cfg)
    return cfg, clean, defective, manifest


# ---- 需求 1: 合成数据 ----
def test_synth_shapes_and_variation(batch):
    cfg, clean, defective, manifest = batch
    assert clean.shape == (cfg.n_frames, cfg.height, cfg.width)
    assert defective.shape == clean.shape
    # 每张背景/图案不同
    assert not np.allclose(clean[0], clean[1])
    # 注入后与干净参考不同, 且差异只发生在缺陷列
    diff_cols = np.where(np.abs(defective - clean).max(axis=(0, 1)) > 0)[0]
    injected = {s.col for s in cfg.defects}
    assert set(diff_cols) == injected
    # 固定坏列每帧都有, 偶发列只在指定帧
    for s in cfg.defects:
        for f in range(cfg.n_frames):
            changed = np.abs(defective[f, :, s.col] - clean[f, :, s.col]).max() > 0
            assert changed == s.active_in(f)


def test_defect_kinds():
    cfg = SynthConfig(
        n_frames=3, defects=[
            DefectSpec(col=10, kind="dead", value=0.0),
            DefectSpec(col=20, kind="noisy", value=50.0),
        ]
    )
    clean, defective, _ = generate_batch(cfg)
    assert np.all(defective[:, :, 10] == 0.0)
    sd = defective[:, :, 20].std(axis=1)
    assert sd.mean() > 20.0  # 噪声列列内波动显著


# ---- 需求 2: 检测、证据、手动选区 ----
def test_detect_finds_injected_columns(batch):
    cfg, clean, defective, _ = batch
    det = detect_columns(defective)
    found = {e.col for e in det.evidences}
    injected = {s.col for s in cfg.defects}
    assert injected <= found
    groups = det.columns_by_label()
    persistent_cols = {s.col for s in cfg.defects if s.frames is None}
    intermittent_cols = {s.col for s in cfg.defects if s.frames is not None}
    assert persistent_cols <= set(groups["persistent"])
    assert intermittent_cols <= set(groups["intermittent"])
    # 证据完整
    ev = det.evidence_map()[37]
    assert ev.hits == cfg.n_frames and ev.direction == "bright"
    ev2 = det.evidence_map()[210]
    assert ev2.frames == [2] and ev2.label(0.8) == "intermittent"


def test_detect_does_not_flag_random_normal_lines():
    # 没有注入缺陷时: 随机正常竖线最多产生单帧弱候选(confidence=weak),
    # 不允许出现多帧复现的强候选, 更不能出现固定坏列
    cfg = SynthConfig(
        n_frames=6, n_lines=20, n_bands=20, defects=[]
    )
    _, defective, _ = generate_batch(cfg)
    det = detect_columns(defective)
    assert all(e.confidence == "weak" for e in det.evidences)
    assert det.columns_by_label()["persistent"] == []


def test_manual_selection(batch):
    _, _, defective, _ = batch
    det = detect_columns(defective)
    sel = ColumnSelection()
    # 手动补选一个未被自动检测的列(仅当前帧)
    sel.toggle_include(100, [0])
    # 排除一个自动候选
    target = det.evidences[0].col
    sel.toggle_exclude(target)
    eff = sel.effective(det)
    assert 100 in eff and eff[100] == [0]
    assert target not in eff
    # 保护列
    sel.toggle_protect(37)
    per_frame = [
        [c for c in sel.columns_for_frame(det, f) if c not in sel.protected]
        for f in range(det.n_frames)
    ]
    assert all(37 not in cols for cols in per_frame)


# ---- 需求 3: 相邻坏列、边沿、保护、连续坏列 ----
def test_repair_basic_and_unchanged_guarantee(batch):
    _, clean, defective, _ = batch
    det = detect_columns(defective)
    sel = ColumnSelection()
    eff = sel.effective(det)
    per_frame = [
        [c for c, fr in eff.items() if fr is None or f in fr]
        for f in range(det.n_frames)
    ]
    res = repair_batch(defective, per_frame)
    assert_unchanged(defective, res.repaired, per_frame)
    # 固定偏置列修补后更接近干净参考
    err_before = np.abs(defective[:, :, 37] - clean[:, :, 37]).mean()
    err_after = np.abs(res.repaired[:, :, 37] - clean[:, :, 37]).mean()
    assert err_after < err_before * 0.4


def test_edge_columns_marked_edge_copy():
    frames = np.random.default_rng(1).normal(128, 5, (2, 40, 30))
    frames[:, :, 0] = 0.0
    frames[:, :, -1] = 255.0
    res = repair_batch(frames, [[0, 29], [0, 29]])
    assert res.states[0][0] == EDGE_COPY
    assert res.states[0][29] == EDGE_COPY


def test_wide_contiguous_bad_columns_unreliable():
    frames = np.random.default_rng(2).normal(128, 4, (1, 50, 20))
    bad = [[10, 11, 12, 13, 14]]  # 连续 5 列 > max_span=3
    res = repair_batch(frames, bad, config=RepairConfig(max_span=3))
    assert all(res.states[0][c] == UNRELIABLE for c in bad[0])
    # 2 列连续在阈值内应可靠
    res2 = repair_batch(frames, [[10, 11]], config=RepairConfig(max_span=3))
    assert res2.states[0][10] == REPAIRED


def test_all_columns_bad_is_unrepaired():
    frames = np.ones((1, 10, 4)) * 100
    res = repair_batch(frames, [[0, 1, 2, 3]])
    assert all(s == UNREPAIRED for s in res.states[0].values())
    assert np.array_equal(res.repaired, frames)


def test_protected_columns_untouched(batch):
    _, _, defective, _ = batch
    per_frame = [[37, 38] for _ in range(defective.shape[0])]
    res = repair_batch(defective, per_frame, protected=[37])
    assert res.states[0][37] == PROTECTED
    assert np.array_equal(res.repaired[:, :, 37], defective[:, :, 37])
    assert_unchanged(defective, res.repaired, per_frame, protected=[37])


# ---- 需求 4: 剖面数据与逐字节核对 ----
def test_profile_evidence_arrays(batch):
    _, clean, defective, _ = batch
    det = detect_columns(defective)
    assert det.frame_median_resid.shape == (det.n_frames, det.width)
    # 坏列在命中帧的残差显著高于普通列
    normal_cols = [c for c in range(det.width) if c not in det.evidence_map()]
    normal_abs = np.abs(det.frame_median_resid[:, normal_cols]).mean()
    bad_abs = np.abs(det.frame_median_resid[:, 37]).mean()
    assert bad_abs > normal_abs * 5


# ---- 需求 5: 坏列表保存/应用/尺寸校验 ----
def test_badlist_roundtrip_and_apply(batch, tmp_path):
    cfg, _, defective, _ = batch
    det = detect_columns(defective)
    sel = ColumnSelection()
    bl = BadList.from_selection(
        sel.effective(det), [37], det.height, det.width, det.n_frames
    )
    p = tmp_path / "bl.json"
    bl.save(p)
    loaded = BadList.load(p)
    assert loaded.persistent == bl.persistent
    assert loaded.protected == [37]
    per_frame, warnings = loaded.apply_to_batch(defective)
    assert all(37 not in cols for cols in per_frame)  # 保护列不修补
    assert 38 in per_frame[0]
    # 偶发坏列的帧映射
    assert 210 in per_frame[2] and 210 not in per_frame[0]


def test_badlist_shape_mismatch_rejected(batch, tmp_path):
    cfg, _, defective, _ = batch
    det = detect_columns(defective)
    bl = BadList.from_selection(
        {}, [], det.height, det.width, det.n_frames
    )
    p = tmp_path / "bl.json"
    bl.save(p)
    other = np.zeros((cfg.n_frames, cfg.height, cfg.width + 5))
    with pytest.raises(BadListError, match="尺寸不符"):
        BadList.load(p).apply_to_batch(other)


def test_badlist_frame_count_warning(batch, tmp_path):
    cfg, _, defective, _ = batch
    det = detect_columns(defective)
    sel = ColumnSelection()
    sel.toggle_include(50, [0, cfg.n_frames - 1])
    bl = BadList.from_selection(
        sel.effective(det), [], det.height, det.width, det.n_frames
    )
    smaller = defective[: cfg.n_frames // 2]
    _per, warnings = bl.apply_to_batch(smaller, strict=False)
    assert any("超出当前批次" in w for w in warnings)
    with pytest.raises(BadListError, match="帧数不符"):
        bl.apply_to_batch(smaller, strict=True)


# ---- 需求 6: 导出、统计、干净参考区分恢复与误伤 ----
def test_export_stats_and_clean_comparison(batch, tmp_path):
    _, clean, defective, _ = batch
    det = detect_columns(defective)
    sel = ColumnSelection()
    eff = sel.effective(det)
    per_frame = [
        [c for c, fr in eff.items() if fr is None or f in fr]
        for f in range(det.n_frames)
    ]
    res = repair_batch(defective, per_frame)
    names = [f"f{f}.png" for f in range(det.n_frames)]
    paths = []
    for f, name in enumerate(names):
        p = tmp_path / name
        save_image(p, res.repaired[f])
        paths.append(p)
    write_change_stats(tmp_path / "stats.csv", names, res)
    assert (tmp_path / "stats.csv").exists()

    cmp_ = compare_with_clean(defective, res.repaired, clean, per_frame)
    assert cmp_["damage_mae"] == 0.0          # 未选位置零误伤
    assert cmp_["recovery_mae"] < cmp_["per_frame"][0]["defect_mae_before"]
    assert "OK" in cmp_["verdict"]


def test_comparison_detects_false_repair():
    # 无缺陷批次: 干净参考 == 输入。此时把一个正常列选进去修,
    # 未选位置虽不变, 但被修列会偏离参考, recovery/damage 指标应暴露问题
    from badcol.synth import SynthConfig, generate_batch

    cfg = SynthConfig(n_frames=4, n_lines=10, defects=[])
    clean, frames, _ = generate_batch(cfg)
    good_col = 100
    per_frame = [[good_col] for _ in range(frames.shape[0])]
    res = repair_batch(frames, per_frame)
    cmp_ = compare_with_clean(frames, res.repaired, clean, per_frame)
    # 被"修"的正常列相对干净参考出现明显偏差
    assert cmp_["recovery_mae"] > 5.0
    assert cmp_["verdict"].startswith("WARNING")


# ---- IO 与 CLI ----
def test_load_frames_shape_guard(tmp_path):
    save_image(tmp_path / "a.png", np.zeros((10, 10)))
    save_image(tmp_path / "b.png", np.zeros((10, 12)))
    with pytest.raises(ValueError, match="尺寸不一致"):
        load_frames(tmp_path)


def test_cli_synth_detect_repair(tmp_path):
    from badcol.cli import main

    gen = tmp_path / "gen"
    rc = main(["synth", "--out", str(gen), "--frames", "6", "--seed", "7"])
    assert rc == 0
    det_dir = tmp_path / "analysis"
    rc = main(["detect", "--input", str(gen / "defective"), "--out", str(det_dir)])
    assert rc == 0
    bl_path = det_dir / "badlist.json"
    data = json.loads(bl_path.read_text(encoding="utf-8"))
    assert data["format"] == "badcol-badlist-v1"
    # 默认坏列表只收强候选(>=3 帧复现): 即 5 个固定坏列
    assert set(data["persistent"]) == {2, 37, 38, 120, 299}
    assert data["intermittent"] == []
    ev = json.loads((det_dir / "evidence.json").read_text(encoding="utf-8"))
    # 偶发注入列(210 单帧、255 两帧)作为弱候选保留在证据报告里供手动补选
    assert {c["col"] for c in ev["columns"]} >= {37, 38, 2, 299, 120, 210, 255}
    weak = {c["col"] for c in ev["columns"] if c["confidence"] == "weak"}
    assert {210, 255} <= weak

    out = tmp_path / "fixed"
    rc = main([
        "repair",
        "--input", str(gen / "defective"),
        "--badlist", str(bl_path),
        "--out", str(out),
        "--clean", str(gen / "clean"),
    ])
    assert rc == 0
    assert (out / "change_stats.csv").exists()
    assert (out / "clean_comparison.csv").exists()
    assert len(list((out / "repaired").iterdir())) == 6

    # 坏列表应用到尺寸不符的批次必须被拒
    other = tmp_path / "other"
    other.mkdir()
    save_image(other / "x.png", np.zeros((10, 10)))
    rc = main([
        "repair", "--input", str(other),
        "--badlist", str(bl_path), "--out", str(tmp_path / "nope"),
    ])
    assert rc == 2
