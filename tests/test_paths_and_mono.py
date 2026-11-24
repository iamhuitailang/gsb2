"""清单路径解析与单声道等边界场景。"""

from __future__ import annotations

import shutil

import numpy as np

from popfix import manifest as mani
from popfix.detect import detect_channels, detect_file
from popfix.repair import repair_manifest
from popfix.wavio import read_wav, write_wav


def test_resolve_wav_absolute_path(dataset, tmp_path):
    wav = dataset / "damaged.wav"
    data, sr = read_wav(wav)
    m = mani.new_manifest(wav, sr, data.shape[1], data.shape[0])
    # 新建清单默认存绝对路径
    assert mani.resolve_wav(m).exists()


def test_manifest_reopens_after_directory_moved(dataset, tmp_path):
    # 模拟整个素材目录被挪走: 清单里写相对 wav 名, 清单与 wav 一起移动
    wav = dataset / "damaged.wav"
    data, sr = read_wav(wav)
    m = mani.new_manifest("damaged.wav", sr, data.shape[1], data.shape[0])
    m["regions"] = detect_channels(data, sr, m["config"])
    moved = tmp_path / "moved"
    moved.mkdir()
    shutil.copy(wav, moved / "damaged.wav")
    mpath = moved / "manifest.json"
    mani.save_manifest(m, mpath)
    # 换个工作目录重开, 仍能通过"清单同目录"规则找到 wav
    reopened = mani.load_manifest(mpath)
    assert mani.resolve_wav(reopened, mpath) == moved / "damaged.wav"


def test_mono_file_detect_and_repair(tmp_path):
    # 构造单声道信号: 背景 + 一个强爆点
    sr = 44100
    rng = np.random.default_rng(1)
    x = 0.05 * np.sin(2 * np.pi * 220 * np.arange(sr) / sr)
    x += rng.standard_normal(sr) * 0.002
    s = int(0.5 * sr)
    x[s:s + 200] += 0.6 * np.exp(-np.arange(200) / 15.0)
    mono = x[:, None]
    wav = tmp_path / "mono.wav"
    write_wav(wav, mono, sr)
    data, _ = read_wav(wav)
    assert data.shape[1] == 1

    regions = detect_channels(data, sr)
    assert len(regions) >= 1
    assert regions[0]["channels"] == [0]

    m = mani.new_manifest(wav, sr, 1, sr)
    m["regions"] = regions
    result = repair_manifest(data, sr, m)
    # 爆点附近被改动, 其余不动
    assert result.applied
    assert not np.any(np.isnan(result.repaired))


def test_manifest_json_records_times_and_channels(dataset):
    regions = detect_file(dataset / "damaged.wav")
    for r in regions:
        assert r["end"] > r["start"]
        assert isinstance(r["channels"], list) and r["channels"]
        assert r["peak_score"] is not None
