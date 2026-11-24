"""修复与对齐切片的测试。"""

from __future__ import annotations

import numpy as np

from popfix import manifest as mani
from popfix.repair import export_slices, repair_manifest
from popfix.wavio import pcm16_codes, read_wav


def _repair(manifest):
    data, sr = read_wav(manifest["wav"])
    return data, sr, repair_manifest(data, sr, manifest)


def test_outside_regions_identical_sample_by_sample(manifest):
    data, sr, result = _repair(manifest)
    n = data.shape[0]
    touched = np.zeros(n, dtype=bool)
    for a in result.applied:
        touched[a["start"]:a["end"]] = True
    # 修复区外在 PCM16 量化级别逐样本一致(浮点误差不应产生可闻差异)
    assert np.array_equal(pcm16_codes(data[~touched]),
                          pcm16_codes(result.repaired[~touched]))


def test_only_listed_channels_modified(manifest):
    data, _, result = _repair(manifest)
    # 单边区域只改左声道, 右声道必须原样
    mono = next(r for r in manifest["regions"] if r["channels"] == [0])
    s, e = mono["start"], mono["end"]
    assert np.array_equal(data[s:e, 1], result.repaired[s:e, 1])
    assert not np.array_equal(data[s:e, 0], result.repaired[s:e, 0])


def test_disabled_region_not_repaired(manifest):
    rid = manifest["regions"][0]["id"]
    mani.set_enabled(manifest, rid, False)
    data, _, result = _repair(manifest)
    assert all(a["id"] != rid for a in result.applied)
    assert np.array_equal(data, result.repaired) is False  # 其它区域仍修了
    disabled = next(r for r in manifest["regions"] if r["id"] == rid)
    s, e = disabled["start"], disabled["end"]
    assert np.array_equal(data[s:e], result.repaired[s:e])


def test_per_region_padding_widens_repair(manifest):
    rid = manifest["regions"][1]["id"]
    _, _, base = _repair(manifest)
    base_applied = next(a for a in base.applied if a["id"] == rid)

    mani.set_padding(manifest, rid, 3.0)
    _, _, wide = _repair(manifest)
    wide_applied = next(a for a in wide.applied if a["id"] == rid)
    assert wide_applied["start"] < base_applied["start"]
    assert wide_applied["end"] > base_applied["end"]


def test_head_and_tail_regions_do_not_go_out_of_bounds(manifest):
    _, sr, result = _repair(manifest)
    n = manifest["frames"]
    for a in result.applied:
        assert 0 <= a["start"] < a["end"] <= n
    # 第一个区域贴头、最后一个贴尾时修复正常完成且没有 nan
    assert not np.any(np.isnan(result.repaired))


def test_multi_pop_block_repaired_in_one_pass(manifest):
    # 双爆点合并块是一个区域, 一次修复覆盖整块
    data, sr, result = _repair(manifest)
    block = max(result.applied, key=lambda a: a["end"] - a["start"])
    assert (block["end"] - block["start"]) / sr > 0.01  # 宽于单爆点
    # 整块内都有实际改动
    assert block["changed_samples"] > 0


def test_removed_signal_is_zero_outside_repair(manifest):
    data, _, result = _repair(manifest)
    touched = np.zeros(data.shape[0], dtype=bool)
    for a in result.applied:
        touched[a["start"]:a["end"]] = True
    assert np.all(result.removed[~touched] == 0.0)
    assert np.allclose(data - result.repaired, result.removed)


def test_slices_are_aligned_and_same_length(manifest, tmp_path):
    data, sr, result = _repair(manifest)
    region = manifest["regions"][0]
    info = export_slices(data, result.repaired, result.removed, sr,
                         region, tmp_path / "slices")
    orig, _ = read_wav(info["paths"]["original"])
    rep, _ = read_wav(info["paths"]["repaired"])
    rem, _ = read_wav(info["paths"]["removed"])
    assert orig.shape == rep.shape == rem.shape
    # 同一切片位置: 原声 = 修补声 + 移除内容
    assert np.allclose(orig, rep + rem, atol=2 / 32768)
    # 切片范围比修复区域宽(带上下文)
    span = info["slice_end_sample"] - info["slice_start_sample"]
    assert span > region["end"] - region["start"]


def test_repair_is_idempotent(manifest):
    data, sr, first = _repair(manifest)
    second = repair_manifest(first.repaired, sr, manifest)
    # 对已修复信号再修一次, 结果不再变化
    assert np.allclose(first.repaired, second.repaired, atol=2 / 32768)


def test_manual_region_is_repaired(manifest):
    data, sr = read_wav(manifest["wav"])
    mani.add_region(manifest, 5000, 5200, [0])
    result = repair_manifest(data, sr, manifest)
    applied_ids = {a["id"] for a in result.applied}
    assert manifest["regions"][-1]["id"] in applied_ids
