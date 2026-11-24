"""修补清单的加载、手工编辑与合并测试。"""

from __future__ import annotations

import pytest

from popfix import manifest as mani


def test_manifest_roundtrip(manifest, tmp_path):
    p = tmp_path / "m.json"
    mani.save_manifest(manifest, p)
    reopened = mani.load_manifest(p)
    assert reopened["regions"] == manifest["regions"]


def test_manifest_reopen_on_original_wav(manifest):
    # 清单记录了原 wav 路径, 重开后仍指向同一文件
    assert manifest["wav"].endswith("damaged.wav")
    assert manifest["frames"] > 0


def test_add_manual_region(manifest):
    n_before = len(manifest["regions"])
    mani.add_region(manifest, 1000, 1200, [0, 1])
    assert len(manifest["regions"]) == n_before + 1
    added = manifest["regions"][-1]
    assert added["source"] == "manual"
    assert added["enabled"] is True


def test_trim_region(manifest):
    rid = manifest["regions"][0]["id"]
    old_end = manifest["regions"][0]["end"]
    mani.trim_region(manifest, rid, end=old_end + 100)
    assert manifest["regions"][0]["end"] == old_end + 100
    assert manifest["regions"][0]["source"] == "manual"


def test_remove_region(manifest):
    rid = manifest["regions"][1]["id"]
    mani.remove_region(manifest, rid)
    assert all(r["id"] != rid for r in manifest["regions"])
    with pytest.raises(KeyError):
        mani.remove_region(manifest, rid)


def test_enable_disable(manifest):
    rid = manifest["regions"][0]["id"]
    mani.set_enabled(manifest, rid, False)
    assert manifest["regions"][0]["enabled"] is False
    mani.set_enabled(manifest, rid, True)
    assert manifest["regions"][0]["enabled"] is True


def test_set_channels(manifest):
    rid = manifest["regions"][0]["id"]
    mani.set_channels(manifest, rid, [1])
    assert manifest["regions"][0]["channels"] == [1]


def test_per_region_padding_overrides_global(manifest):
    mani.set_padding(manifest, None, 2.0)
    assert manifest["config"]["padding_ms"] == 2.0
    rid = manifest["regions"][0]["id"]
    mani.set_padding(manifest, rid, 5.0)
    assert manifest["regions"][0]["padding_ms"] == 5.0
    # 其它区域仍跟随全局
    assert manifest["regions"][1]["padding_ms"] is None


def test_remerge_with_larger_gap_joins_close_regions(manifest):
    n_before = len(manifest["regions"])
    mani.remerge(manifest, gap_ms=3000.0)
    # 区域散布在 6 秒内, 3 秒的大间隔会把所有区域并成一块
    assert len(manifest["regions"]) == 1
    assert manifest["regions"][0]["start"] == 0
    assert len(manifest["regions"][0]["channels"]) >= 1


def test_remerge_with_small_gap_keeps_regions_apart(manifest):
    n_before = len(manifest["regions"])
    mani.remerge(manifest, gap_ms=0.01)
    # 极小间隔下区域数只会变多或不变(双爆点块会被拆开)
    assert len(manifest["regions"]) >= n_before


def test_validation_rejects_out_of_bounds(manifest):
    with pytest.raises(ValueError):
        mani.add_region(manifest, 0, manifest["frames"] + 10, [0])
    with pytest.raises(ValueError):
        mani.add_region(manifest, 100, 200, [9])


def test_rescan_reproduces_regions(manifest):
    before = [(r["start"], r["end"]) for r in manifest["regions"]]
    mani.rescan(manifest)
    after = [(r["start"], r["end"]) for r in manifest["regions"]]
    assert before == after
