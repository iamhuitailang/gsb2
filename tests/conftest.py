"""测试用夹具: 每个测试独立生成一套小素材, 互不干扰。"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from popfix import manifest as mani
from popfix.detect import detect_file
from popfix.synth import build_dataset
from popfix.wavio import read_wav


@pytest.fixture()
def dataset(tmp_path: Path) -> Path:
    out = tmp_path / "sample"
    build_dataset(out, sr=44100, duration=6.0, seed=16280)
    return out


@pytest.fixture()
def manifest(dataset: Path, tmp_path: Path) -> dict:
    wav = dataset / "damaged.wav"
    data, sr = read_wav(wav)
    m = mani.new_manifest(wav, sr, data.shape[1], data.shape[0])
    m["regions"] = detect_file(wav, m["config"])
    return m
