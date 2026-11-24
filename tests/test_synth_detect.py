"""素材生成与检测的测试。"""

from __future__ import annotations

import json

import numpy as np

from popfix.detect import detect_file
from popfix.wavio import pcm16_codes, read_wav


def test_dataset_files_exist(dataset):
    for name in ("clean.wav", "damaged.wav", "truth.json"):
        assert (dataset / name).exists()


def test_truth_contains_required_kinds(dataset):
    truth = json.loads((dataset / "truth.json").read_text(encoding="utf-8"))
    kinds = {p["kind"] for p in truth["pops"]}
    # 双爆点 / 单边声道 / 贴头 / 贴尾 都必须有
    assert {"double", "single_channel", "head", "tail"} <= kinds
    # double 必须真的是连着两次
    doubles = [p for p in truth["pops"] if p["kind"] == "double"]
    assert len(doubles) == 2


def test_clean_and_damaged_differ_only_at_pops(dataset):
    clean, sr = read_wav(dataset / "clean.wav")
    damaged, _ = read_wav(dataset / "damaged.wav")
    truth = json.loads((dataset / "truth.json").read_text(encoding="utf-8"))
    # PCM16 写盘后重读有量化误差, 比较统一在 int16 编码级别进行
    diff = np.any(pcm16_codes(damaged) != pcm16_codes(clean), axis=1)
    truth_mask = np.zeros(len(clean), dtype=bool)
    for p in truth["pops"]:
        truth_mask[p["start_sample"]:p["end_sample"]] = True
    # 除真值区间外, 受损文件与干净参考逐样本一致
    assert not np.any(diff & ~truth_mask)
    # 真值区间内确实有损伤
    assert np.any(diff & truth_mask)


def test_single_channel_pop_only_affects_one_channel(dataset):
    clean, _ = read_wav(dataset / "clean.wav")
    damaged, _ = read_wav(dataset / "damaged.wav")
    truth = json.loads((dataset / "truth.json").read_text(encoding="utf-8"))
    pop = next(p for p in truth["pops"] if p["kind"] == "single_channel")
    s, e = pop["start_sample"], pop["end_sample"]
    assert pop["channels"] == [0]
    # 右声道在该区间完全不动(int16 编码级别)
    assert np.array_equal(pcm16_codes(damaged[s:e, 1]),
                          pcm16_codes(clean[s:e, 1]))
    assert not np.array_equal(pcm16_codes(damaged[s:e, 0]),
                              pcm16_codes(clean[s:e, 0]))


def test_detect_finds_all_pops_without_drum_false_alarms(dataset):
    regions = detect_file(dataset / "damaged.wav")
    truth = json.loads((dataset / "truth.json").read_text(encoding="utf-8"))
    # 5 个候选块覆盖 6 个真值爆点(双爆点合并成一块)
    assert len(regions) == 5
    repair_mask = np.zeros(truth["frames"], dtype=bool)
    for r in regions:
        repair_mask[r["start"]:r["end"]] = True
    for p in truth["pops"]:
        # 每个真值爆点至少与某个候选区域重叠
        assert repair_mask[p["start_sample"]:p["end_sample"]].any(), p["kind"]
    # 所有候选都落在真值 30ms 邻域内 —— 鼓点/镲片不得产生候选
    guard = int(round(0.03 * truth["sample_rate"]))
    allowed = np.zeros(truth["frames"], dtype=bool)
    for p in truth["pops"]:
        allowed[max(0, p["start_sample"] - guard):
                min(truth["frames"], p["end_sample"] + guard)] = True
    for r in regions:
        assert allowed[r["start"]:r["end"]].all()


def test_double_pops_merged_into_single_region(dataset):
    regions = detect_file(dataset / "damaged.wav")
    truth = json.loads((dataset / "truth.json").read_text(encoding="utf-8"))
    doubles = sorted(p["start_sample"] for p in truth["pops"]
                     if p["kind"] == "double")
    covering = [r for r in regions
                if r["start"] <= doubles[0] and r["end"] >= doubles[1]]
    assert len(covering) == 1


def test_detect_records_duration_and_channels(dataset):
    regions = detect_file(dataset / "damaged.wav")
    for r in regions:
        assert r["end"] > r["start"]
        assert r["channels"]
        assert all(c in (0, 1) for c in r["channels"])
    mono = next(r for r in regions if r["channels"] == [0])
    assert mono is not None
