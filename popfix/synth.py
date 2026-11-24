"""程序化合成测试素材。

生成的信号里同时包含:
  - 有轻重之分的正常鼓点(低频 kick + 短噪声 snare/hihat), 检测必须能放过它们
  - 连着两次的爆点(双爆点, 间隔小于合并间隔时会被并成一个块)
  - 只出现在单边声道的爆点
  - 贴着文件头 / 文件尾的爆点(修复时不能越界)
另存一份完全干净的参考 wav 和一份记录真实爆点位置的 truth.json。
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from .wavio import write_wav


@dataclass
class Pop:
    """一个注入的爆点(真值)。"""

    start: int          # 起始样本(含)
    end: int            # 结束样本(不含)
    channels: list[int]
    kind: str           # double / single_channel / head / tail / single

    def to_dict(self, sr: int) -> dict:
        return {
            "start_sample": self.start,
            "end_sample": self.end,
            "start_time": round(self.start / sr, 6),
            "end_time": round(self.end / sr, 6),
            "duration_ms": round((self.end - self.start) / sr * 1000.0, 3),
            "channels": self.channels,
            "kind": self.kind,
        }


@dataclass
class SynthConfig:
    sr: int = 44100
    duration: float = 6.0
    seed: int = 16280
    pop_ms: float = 5.0
    double_gap_ms: float = 4.0        # 双爆点之间的间隔(小于默认合并间隔)
    merge_gap_ms: float = 40.0        # 默认检测合并间隔, 双爆点应被并成一块
    subtype: str = "PCM_16"
    events: list[dict] = field(default_factory=list)
    pops: list[Pop] = field(default_factory=list)


def _kick(n: int, sr: int, freq: float = 55.0) -> np.ndarray:
    """低频 kick: 指数衰减正弦, 主要能量集中在低频, 用来考验检测器。"""
    t = np.arange(n) / sr
    env = np.exp(-t * 22.0)
    pitch = freq * np.exp(-t * 30.0) + 38.0
    phase = 2.0 * np.pi * np.cumsum(pitch) / sr
    return env * np.sin(phase)


def _hat(n: int, sr: int, rng: np.random.Generator) -> np.ndarray:
    """短噪声镲片: 有高频但能量低、起音缓, 与爆点的尖峰形态不同。"""
    t = np.arange(n) / sr
    env = np.exp(-t * 120.0)
    return env * rng.standard_normal(n) * 0.25


def _pop_waveform(n: int, rng: np.random.Generator) -> np.ndarray:
    """爆点波形: 极陡尖峰 + 快速衰减的高频振铃。

    能量集中在前 1/3(模拟真实削顶爆点: 一个硬尖峰后跟几圈振铃),
    与鼓点相比瞬态更硬、高频占比高得多。
    """
    t = np.arange(n)
    spike = np.exp(-t / max(n * 0.09, 1.0))
    ring = np.sin(2.0 * np.pi * 3200.0 * t / 44100.0)
    click = rng.standard_normal(n) * np.exp(-t / max(n * 0.07, 1.0))
    return spike * (0.85 * ring + 0.45 * click)


def _add_event(clean: np.ndarray, sr: int, at_sec: float, wave: np.ndarray,
               amp: float, channels: list[int], cfg: SynthConfig,
               kind: str) -> None:
    i = int(round(at_sec * sr))
    n = min(len(wave), clean.shape[0] - i)
    if n <= 0:
        return
    for ch in channels:
        clean[i:i + n, ch] += amp * wave[:n]
    cfg.events.append({
        "time": at_sec, "kind": kind, "amp": amp, "channels": channels,
    })


def _inject_pop(clean: np.ndarray, sr: int, at_sec: float, channels: list[int],
                kind: str, pop_rng: np.random.Generator, cfg: SynthConfig,
                pop_len: int, amp: float = 0.55) -> Pop:
    i0 = int(round(at_sec * sr))
    i0 = max(0, min(i0, clean.shape[0] - 1))
    i1 = min(clean.shape[0], i0 + pop_len)
    n = i1 - i0
    # 爆点用独立 RNG 流, 不消耗主序列 —— 保证干净参考重建时
    # 床信号/镲片噪声的随机数序列与受损文件完全一致
    wave = amp * _pop_waveform(n, pop_rng)
    for ch in channels:
        clean[i0:i1, ch] += wave
    pop = Pop(start=i0, end=i1, channels=sorted(channels), kind=kind)
    cfg.pops.append(pop)
    return pop


def build_dataset(out_dir: str | Path,
                  sr: int = 44100,
                  duration: float = 6.0,
                  seed: int = 16280) -> SynthConfig:
    """生成整套素材并落盘。

    产出:
      clean.wav    干净参考(只有音乐与鼓点, 无爆点)
      damaged.wav  在 clean 基础上注入爆点
      truth.json   爆点真值与合成参数
    """
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(seed)
    pop_rng = np.random.default_rng(seed + 1)
    cfg = SynthConfig(sr=sr, duration=duration, seed=seed)
    n_total = int(round(sr * duration))
    n_ch = 2
    clean = np.zeros((n_total, n_ch), dtype=np.float64)

    # ---- 背景: 轻柔的和弦垫 + 极低本底噪声 ----
    tt = np.arange(n_total) / sr
    bed = (0.05 * np.sin(2 * np.pi * 220 * tt)
           + 0.035 * np.sin(2 * np.pi * 277 * tt)
           + 0.025 * np.sin(2 * np.pi * 330 * tt))
    clean += bed[:, None]
    clean += rng.standard_normal(clean.shape) * 0.002

    # ---- 有轻重之分的正常鼓点(两边声道都有), 检测不得误伤 ----
    for at, amp in [(0.45, 0.20), (1.30, 0.55), (2.95, 0.18),
                    (4.35, 0.55), (5.55, 0.22)]:
        _add_event(clean, sr, at, _kick(int(0.18 * sr), sr), amp,
                   [0, 1], cfg, "kick")
    for at in [0.95, 1.95, 3.65, 5.05]:
        _add_event(clean, sr, at, _hat(int(0.05 * sr), sr, rng), 0.14,
                   [0, 1], cfg, "hat")

    pop_len = int(round(cfg.pop_ms / 1000.0 * sr))

    # ---- 爆点 1: 贴文件头, 两声道 ----
    _inject_pop(clean, sr, 0.0005, [0, 1], "head", pop_rng, cfg, pop_len)

    # ---- 爆点 2: 普通双声道爆点, 落在两个鼓点之间 ----
    _inject_pop(clean, sr, 2.35, [0, 1], "single", pop_rng, cfg, pop_len)

    # ---- 爆点 3+4: 连着两次(双爆点), 应被合并为一个候选块 ----
    first = _inject_pop(clean, sr, 3.30, [0, 1], "double", pop_rng, cfg, pop_len)
    second_at = first.end / sr + cfg.double_gap_ms / 1000.0
    _inject_pop(clean, sr, second_at, [0, 1], "double", pop_rng, cfg, pop_len)
    # ---- 爆点 5: 只在左声道(单边声道问题) ----
    _inject_pop(clean, sr, 4.75, [0], "single_channel", pop_rng, cfg, pop_len)

    # ---- 爆点 6: 贴文件尾 ----
    tail_at = (n_total - pop_len) / sr
    _inject_pop(clean, sr, tail_at, [0, 1], "tail", pop_rng, cfg, pop_len)

    # 峰值留足余量, 保证 PCM16 量化不会硬削波; 不做全局处理,
    # 让受损文件与干净参考在爆点区间之外逐样本一致
    if float(np.max(np.abs(clean))) >= 0.95:
        raise RuntimeError("合成信号峰值过高, 请下调爆点/鼓点幅度")

    # 干净参考: 注入爆点之前的波形(这里重新合成一遍无爆点版本)
    clean_ref = _build_clean_only(sr, n_total, seed, cfg)

    write_wav(out_dir / "clean.wav", clean_ref, sr, subtype=cfg.subtype)
    write_wav(out_dir / "damaged.wav", clean, sr, subtype=cfg.subtype)
    truth = {
        "sample_rate": sr,
        "frames": n_total,
        "channels": n_ch,
        "pop_ms": cfg.pop_ms,
        "double_gap_ms": cfg.double_gap_ms,
        "default_merge_gap_ms": cfg.merge_gap_ms,
        "pops": [p.to_dict(sr) for p in cfg.pops],
        "events": cfg.events,
    }
    (out_dir / "truth.json").write_text(
        json.dumps(truth, ensure_ascii=False, indent=2), encoding="utf-8")
    return cfg


def _build_clean_only(sr: int, n_total: int, seed: int,
                      cfg: SynthConfig) -> np.ndarray:
    """按记录的事件重建无爆点参考, 保证与受损文件除爆点外逐样本一致。"""
    rng = np.random.default_rng(seed)
    clean = np.zeros((n_total, 2), dtype=np.float64)
    tt = np.arange(n_total) / sr
    bed = (0.05 * np.sin(2 * np.pi * 220 * tt)
           + 0.035 * np.sin(2 * np.pi * 277 * tt)
           + 0.025 * np.sin(2 * np.pi * 330 * tt))
    clean += bed[:, None]
    clean += rng.standard_normal(clean.shape) * 0.002
    for ev in cfg.events:
        if ev["kind"] == "kick":
            wave = _kick(int(0.18 * sr), sr)
        else:
            wave = _hat(int(0.05 * sr), sr, rng)
        i = int(round(ev["time"] * sr))
        n = min(len(wave), n_total - i)
        for ch in ev["channels"]:
            clean[i:i + n, ch] += ev["amp"] * wave[:n]
    return clean
