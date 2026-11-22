"""转换摘要导出 + 导出文件回读核对。"""

from __future__ import annotations

import json
from dataclasses import asdict
from pathlib import Path

import numpy as np

from . import QUALITY_HIGH, QUALITY_LOW, QUALITY_LABELS
from .analysis import (
    alias_band_energy,
    alias_residual_energy,
    check_lengths,
    check_peak_alignment,
    dominant_frequency,
)
from .audio import AudioData
from .resample import ResampleResult
from .wavio import probe_wav, read_wav


def check_lengths_to_dict(lengths) -> dict:
    """asdict 不含 @property，手动补齐布尔与时长字段。"""
    d = asdict(lengths)
    d["low_ok"] = lengths.low_ok
    d["high_ok"] = lengths.high_ok
    d["duration_error_seconds"] = lengths.duration_error_seconds
    return d


def check_alignment_to_dict(align) -> dict:
    d = asdict(align)
    d["low_aligned"] = align.low_aligned
    d["high_aligned"] = align.high_aligned
    return d


def build_summary(
    src: AudioData,
    low: ResampleResult,
    high: ResampleResult,
    export_info: dict | None = None,
) -> dict:
    """汇总一次转换的全部关键信息，可直接 json.dump。"""
    align = check_peak_alignment(src, low.audio, high.audio)
    lengths = check_lengths(src, low.audio, high.audio)

    def block(rr: ResampleResult) -> dict:
        a = rr.audio
        dom_f, dom_db = dominant_frequency(a.channel(0), a.sample_rate)
        alias_resid_db, _, _ = alias_residual_energy(
            src.channel(0), src.sample_rate, a.channel(0), a.sample_rate
        )
        return {
            "quality": rr.quality,
            "quality_label": QUALITY_LABELS[rr.quality],
            "sample_rate": a.sample_rate,
            "frames": a.n_frames,
            "channels": a.channels,
            "duration_seconds": a.duration,
            "rms": float(np.sqrt(np.mean(a.samples ** 2))),
            "peak_abs": float(np.max(np.abs(a.samples))),
            "dominant_freq_hz": dom_f,
            "dominant_dbfs": dom_db,
            "filter_taps": rr.filter_taps,
            "group_delay_output_samples": rr.group_delay,
            "length_rule_expected": rr.expected_length,
            "length_rule_ok": rr.length_rule_ok,
            "alias_residual_energy_db": alias_resid_db,
        }

    # 用源信号衡量“有多少高频本应被滤掉”，再分别测两条输出在目标带内的折叠残留
    dst_rate = low.audio.sample_rate
    src_alias_db, _, _ = alias_band_energy(src.channel(0), src.sample_rate, dst_rate)

    summary = {
        "source": {
            "name": src.name,
            "sample_rate": src.sample_rate,
            "channels": src.channels,
            "frames": src.n_frames,
            "duration_seconds": src.duration,
            "bit_depth": src.bit_depth,
            "sample_format": src.sample_format,
            "nyquist_hz": src.sample_rate / 2,
            "above_target_nyquist_energy_db": src_alias_db,
        },
        "target_sample_rate": dst_rate,
        "target_nyquist_hz": dst_rate / 2,
        "ratio": {"up": low.up, "down": low.down, "reduced_by_gcd": True},
        "length_rule": lengths.rule,
        "length_check": check_lengths_to_dict(lengths),
        "peak_alignment": check_alignment_to_dict(align),
        "outputs": {
            QUALITY_LOW: block(low),
            QUALITY_HIGH: block(high),
        },
    }
    if export_info is not None:
        summary["export"] = export_info
    return summary


def save_summary(summary: dict, path: str | Path) -> Path:
    path = Path(path)
    if path.suffix.lower() == ".txt":
        path.write_text(format_summary_text(summary), encoding="utf-8")
    else:
        path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def format_summary_text(s: dict) -> str:
    lines = []
    lines.append("采样率转换摘要")
    lines.append("=" * 56)
    src = s["source"]
    lines.append(f"源: {src['name']}  {src['sample_rate']}Hz  {src['channels']}声道  "
                 f"{src['frames']}点  {src['duration_seconds']:.6f}s  "
                 f"{src['sample_format']}/{src['bit_depth']}bit")
    lines.append(f"目标: {s['target_sample_rate']}Hz (Nyquist {s['target_nyquist_hz']:g}Hz)，"
                 f"比值 up/down = {s['ratio']['up']}/{s['ratio']['down']}")
    lines.append(f"片尾取整规则: {s['length_rule']}")
    lc = s["length_check"]
    lines.append(f"  期望输出 {lc['expected_frames']} 点；低质量 {lc['low_frames']} "
                 f"({'OK' if lc['low_frames'] == lc['expected_frames'] else '不一致'})；"
                 f"高质量 {lc['high_frames']} "
                 f"({'OK' if lc['high_frames'] == lc['expected_frames'] else '不一致'})；"
                 f"时长误差 {lc['duration_error_seconds']:.2e}s")
    pa = s["peak_alignment"]
    lines.append(f"峰值对齐: 低质量 {'OK' if pa['low_aligned'] else '错位 ' + str(pa['low_peak_offset_samples'])}；"
                 f"高质量 {'OK' if pa['high_aligned'] else '错位 ' + str(pa['high_peak_offset_samples'])}")
    for ch_info in pa["per_channel"]:
        lines.append(
            f"  声道{ch_info['channel']}: 源峰 i={ch_info['src_peak_index']} "
            f"t={ch_info['src_peak_time']:.6f}s -> 低质量 i={ch_info['low_peak_index']} "
            f"t={ch_info['low_peak_time']:.6f}s；高质量 i={ch_info['high_peak_index']} "
            f"t={ch_info['high_peak_time']:.6f}s"
        )
    lines.append(f"源中超出目标 Nyquist 的能量占比: {src['above_target_nyquist_energy_db']:.2f} dB")
    for key in (QUALITY_LOW, QUALITY_HIGH):
        o = s["outputs"][key]
        lines.append("-" * 56)
        lines.append(f"[{o['quality_label']}]")
        lines.append(f"  输出 {o['frames']} 点 / {o['duration_seconds']:.6f}s，"
                     f"RMS={o['rms']:.4f}，峰值={o['peak_abs']:.4f}")
        lines.append(f"  主峰 {o['dominant_freq_hz']:.2f} Hz ({o['dominant_dbfs']:.2f} dBFS)，"
                     f"滤波抽头 {o['filter_taps']}，群延迟 {o['group_delay_output_samples']:.2f} 输出采样，"
                     f"混叠残留 {o['alias_residual_energy_db']:.2f} dB")
    if "export" in s:
        e = s["export"]
        lines.append("-" * 56)
        lines.append(f"导出文件: {e.get('path')}")
        lines.append(f"  回读核对: {'全部通过' if e.get('verified') else '存在不一致'}")
        for ck in e.get("checks", []):
            lines.append(f"  - {ck['name']}: {ck['detail']} [{'OK' if ck['ok'] else 'FAIL'}]")
    lines.append("=" * 56)
    return "\n".join(lines)


def verify_export(path: str | Path, expected: AudioData, expected_format: str,
                  expected_bits: int) -> dict:
    """重新读入导出的 WAV，核对头部、时长与实际声道数据。"""
    header = probe_wav(path)
    reread = read_wav(path)
    checks = []

    def add(name: str, ok: bool, detail: str) -> None:
        checks.append({"name": name, "ok": bool(ok), "detail": detail})

    add("采样率", header["sample_rate"] == expected.sample_rate,
        f"头部 {header['sample_rate']} / 期望 {expected.sample_rate}")
    add("声道数", header["channels"] == expected.channels,
        f"头部 {header['channels']} / 期望 {expected.channels}")
    add("采样格式", header["sample_format"] == expected_format,
        f"头部 {header['sample_format']} / 期望 {expected_format}")
    add("位深", header["bits_per_sample"] == expected_bits,
        f"头部 {header['bits_per_sample']} / 期望 {expected_bits}")
    add("头部帧数与 data 字节",
        header["frames_by_header"] * header["block_align"] == header["data_bytes"],
        f"{header['frames_by_header']} 帧 × {header['block_align']} B = "
        f"{header['frames_by_header'] * header['block_align']} / data {header['data_bytes']} B")
    add("实际读入帧数", reread.n_frames == expected.n_frames,
        f"读入 {reread.n_frames} / 期望 {expected.n_frames}")
    add("实际读入声道", reread.channels == expected.channels,
        f"读入 {reread.channels} / 期望 {expected.channels}")
    add("时长一致", abs(reread.duration - expected.duration) < 1.5 / expected.sample_rate,
        f"读入 {reread.duration:.6f}s / 期望 {expected.duration:.6f}s")

    # 数据层核对：PCM 量化误差不超过 1 个量化级；float 应近乎无损
    if expected_format == "PCM":
        # 满量程 [-1,1) 切成 2^bits 级，量化级 = 2 / 2^bits
        qstep = 2.0 / (2 ** expected_bits)
        diff = float(np.max(np.abs(reread.samples - expected.samples)))
        add("采样值量化误差", diff <= qstep * 1.01, f"最大偏差 {diff:.3e}，量化级 {qstep:.3e}")
    else:
        diff = float(np.max(np.abs(reread.samples - expected.samples)))
        add("采样值往返误差", diff < 1e-6, f"最大偏差 {diff:.3e}")

    return {
        "path": str(path),
        "verified": all(c["ok"] for c in checks),
        "checks": checks,
        "header": header,
    }
