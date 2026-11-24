"""对照干净参考的核对测试。"""

from __future__ import annotations

import json

import numpy as np

from popfix import manifest as mani
from popfix.repair import repair_manifest
from popfix.verify import verify
from popfix.wavio import read_wav


def _run_verify(manifest, dataset):
    data, sr = read_wav(manifest["wav"])
    clean, _ = read_wav(dataset / "clean.wav")
    truth = json.loads((dataset / "truth.json").read_text(encoding="utf-8"))
    result = repair_manifest(data, sr, manifest)
    report = verify(data, result.repaired, clean, sr, manifest, truth)
    return report


def test_clean_report_has_no_missed_or_false(dataset, manifest):
    report = _run_verify(manifest, dataset)
    assert report["summary"]["missed_count"] == 0
    assert report["summary"]["false_edit_segment_count"] == 0
    assert report["summary"]["outside_repair_identical"] is True
    assert report["summary"]["hf_damage_energy_removed_pct"] > 50.0


def test_every_truth_pop_covered(dataset, manifest):
    report = _run_verify(manifest, dataset)
    assert len(report["covered"]) == 6  # 6 个真值爆点全部覆盖


def test_unrepaired_file_is_all_missed(dataset, manifest):
    # 停用全部区域 => 等同未修, 每个真值爆点都应判漏修
    for r in manifest["regions"]:
        mani.set_enabled(manifest, r["id"], False)
    report = _run_verify(manifest, dataset)
    assert report["summary"]["missed_count"] == 6
    # 没有任何改动, 也不存在误伤
    assert report["summary"]["false_edit_segment_count"] == 0


def test_false_edit_detected_when_repairing_clean_area(dataset, manifest):
    # 在没有爆点的位置手工加一个修复区, 应被判为误伤
    mani.add_region(manifest, int(1.0 * manifest["sample_rate"]),
                    int(1.005 * manifest["sample_rate"]), [0, 1])
    report = _run_verify(manifest, dataset)
    assert report["summary"]["false_edit_segment_count"] >= 1


def test_report_is_json_serializable(dataset, manifest):
    report = _run_verify(manifest, dataset)
    encoded = json.dumps(report, ensure_ascii=False)
    decoded = json.loads(encoded)
    assert decoded["summary"] == report["summary"]
