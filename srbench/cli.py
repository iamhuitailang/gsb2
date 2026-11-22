"""命令行入口：无 GUI 也能完成生成、转换、检查、回读核对、自检。

示例：
  python -m srbench.cli selftest
  python -m srbench.cli generate sine_high -o /tmp/tone.wav
  python -m srbench.cli convert /tmp/tone.wav --to 22050 --outdir /tmp/out
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from . import COMMON_RATES, QUALITY_HIGH, QUALITY_LOW, QUALITY_LABELS
from .analysis import (
    alias_band_energy,
    alias_residual_energy,
    check_lengths,
    check_peak_alignment,
    dominant_frequency,
)
from .resample import resample
from .signals import PRESETS, build_preset
from .summary import build_summary, save_summary, verify_export
from .wavio import read_wav, write_wav


def cmd_generate(args: argparse.Namespace) -> int:
    audio = build_preset(args.preset)
    path = write_wav(args.output, audio, bits=args.bits,
                     sample_format="PCM", extensible=audio.channels > 2)
    print(f"已生成 {path}: {audio.sample_rate}Hz {audio.channels}声道 "
          f"{audio.n_frames}点 {audio.duration:.4f}s")
    return 0


def _convert(src, dst_rate: int):
    low = resample(src, dst_rate, QUALITY_LOW)
    high = resample(src, dst_rate, QUALITY_HIGH)
    return low, high


def cmd_convert(args: argparse.Namespace) -> int:
    src = read_wav(args.input)
    print(f"源文件: {src.name} {src.sample_rate}Hz {src.channels}ch "
          f"{src.n_frames}点 {src.duration:.4f}s {src.sample_format}/{src.bit_depth}bit")
    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    stem = Path(args.input).stem

    for rate in args.to:
        low, high = _convert(src, rate)
        print(f"\n==> 目标 {rate}Hz（比值 up/down = {low.up}/{low.down}）")
        lengths = check_lengths(src, low.audio, high.audio)
        print(f"  取整规则 {lengths.rule}: 期望 {lengths.expected_frames} 点；"
              f"低质量 {lengths.low_frames}({'OK' if lengths.low_ok else 'X'})，"
              f"高质量 {lengths.high_frames}({'OK' if lengths.high_ok else 'X'})，"
              f"时长误差 {lengths.duration_error_seconds:.2e}s")
        align = check_peak_alignment(src, low.audio, high.audio)
        print(f"  峰值对齐: 低质量 {'OK' if align.low_aligned else align.low_peak_offset_samples}，"
              f"高质量 {'OK' if align.high_aligned else align.high_peak_offset_samples}")
        src_alias_db, _, _ = alias_band_energy(src.channel(0), src.sample_rate, rate)
        print(f"  源超目标 Nyquist 能量: {src_alias_db:.2f} dB")
        for rr in (low, high):
            a = rr.audio
            dom_f, dom_db = dominant_frequency(a.channel(0), rate)
            resid, _, _ = alias_residual_energy(src.channel(0), src.sample_rate, a.channel(0), rate)
            print(f"  [{QUALITY_LABELS[rr.quality]}] {a.n_frames}点 {a.duration:.4f}s "
                  f"主峰 {dom_f:.1f}Hz/{dom_db:.1f}dBFS 混叠残留 {resid:.2f}dB "
                  f"群延迟 {rr.group_delay:.2f}")

        # 导出两条路径的 WAV + 摘要
        exports = {}
        for rr, tag in ((low, "low"), (high, "high")):
            wav_path = outdir / f"{stem}_{rate}_{tag}.wav"
            write_wav(wav_path, rr.audio, bits=args.bits, sample_format="PCM",
                      extensible=rr.audio.channels > 2)
            info = verify_export(wav_path, rr.audio, "PCM", args.bits)
            exports[tag] = info
            print(f"  导出 {wav_path.name}，回读核对: {'全部通过' if info['verified'] else '失败'}")
        summary = build_summary(src, low, high, export_info=exports["high"])
        sp = outdir / f"{stem}_{rate}_summary.txt"
        save_summary(summary, sp)
        save_summary(summary, outdir / f"{stem}_{rate}_summary.json")
        print(f"  摘要: {sp.name} (+ .json)")
    return 0


def cmd_check(args: argparse.Namespace) -> int:
    """只做分析不导出：打印混叠/对齐/取整结论。"""
    src = read_wav(args.input)
    rate = args.to
    low, high = _convert(src, rate)
    summary = build_summary(src, low, high)
    from .summary import format_summary_text
    print(format_summary_text(summary))
    return 0


def cmd_verify(args: argparse.Namespace) -> int:
    """核对一个已导出的 WAV 与参考参数是否一致。"""
    # 参考：同目录摘要 json 可选；这里按命令行参数核对
    header_audio = read_wav(args.input)
    info = verify_export(args.input, header_audio, header_audio.sample_format,
                         header_audio.bit_depth or 16)
    for c in info["checks"]:
        print(f"[{'OK' if c['ok'] else 'FAIL'}] {c['name']}: {c['detail']}")
    return 0 if info["verified"] else 1


def cmd_selftest(args: argparse.Namespace) -> int:
    from .selftest import run_all
    ok = run_all(verbose=True)
    return 0 if ok else 1


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="srbench", description="采样率转换试听台（无头 CLI）")
    sub = p.add_subparsers(dest="cmd", required=True)

    g = sub.add_parser("generate", help="生成测试信号 WAV")
    g.add_argument("preset", choices=sorted(PRESETS.keys()))
    g.add_argument("-o", "--output", required=True)
    g.add_argument("--bits", type=int, default=16, choices=[8, 16, 24, 32])
    g.set_defaults(func=cmd_generate)

    c = sub.add_parser("convert", help="转换并导出 WAV + 摘要")
    c.add_argument("input")
    c.add_argument("--to", type=int, nargs="+", required=True, choices=COMMON_RATES)
    c.add_argument("--outdir", default="out")
    c.add_argument("--bits", type=int, default=16, choices=[8, 16, 24, 32])
    c.set_defaults(func=cmd_convert)

    k = sub.add_parser("check", help="只分析不导出")
    k.add_argument("input")
    k.add_argument("--to", type=int, required=True, choices=COMMON_RATES)
    k.set_defaults(func=cmd_check)

    v = sub.add_parser("verify", help="回读核对导出的 WAV")
    v.add_argument("input")
    v.set_defaults(func=cmd_verify)

    s = sub.add_parser("selftest", help="运行确定性自检")
    s.set_defaults(func=cmd_selftest)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
