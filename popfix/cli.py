"""popfix 命令行入口。

工作流:
  python -m popfix generate  out/                 生成测试素材与真值
  python -m popfix detect    out/damaged.wav -m out/manifest.json
  python -m popfix list      -m out/manifest.json
  python -m popfix add/trim/remove/enable/padding/remerge ...   手工改选区
  python -m popfix repair    -m out/manifest.json -o out/repaired.wav --slices
  python -m popfix verify    -m out/manifest.json --truth out/truth.json \
                             --clean out/clean.wav --report out/report.json
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import manifest as mani
from .detect import DEFAULTS, detect_file
from .repair import export_slices, repair_manifest
from .synth import build_dataset
from .verify import verify
from .wavio import read_wav, write_wav


# ---------------------------------------------------------------- 参数解析

def _time_to_sample(value: str, sr: int, in_samples: bool) -> int:
    if in_samples:
        return int(float(value))
    return int(round(float(value) * sr))


def _parse_channels(text: str, n_ch: int) -> list[int]:
    if text.lower() in ("all", "*"):
        return list(range(n_ch))
    chs = []
    for tok in text.split(","):
        tok = tok.strip().lower()
        if tok.startswith("ch"):
            tok = tok[2:]
        ch = int(tok)
        if not 0 <= ch < n_ch:
            raise argparse.ArgumentTypeError(
                f"声道 {ch} 越界, 文件只有 {n_ch} 个声道(0 起编)")
        chs.append(ch)
    if not chs:
        raise argparse.ArgumentTypeError("声道列表为空")
    return sorted(set(chs))


def _load(path: str) -> dict:
    return mani.load_manifest(path)


def _print_regions(m: dict) -> None:
    sr = m["sample_rate"]
    print(f"#  起点(s)   终点(s)   时长(ms)  声道    来源    启用  分数")
    for r in m["regions"]:
        print(
            f"{r['id']:>2} "
            f"{r['start'] / sr:8.4f} "
            f"{r['end'] / sr:9.4f} "
            f"{(r['end'] - r['start']) / sr * 1000:8.2f} "
            f"{','.join('L' if c == 0 else 'R' if c == 1 else str(c) for c in r['channels']):<7} "
            f"{r['source']:<7} "
            f"{'是' if r['enabled'] else '否':<4} "
            f"{r['peak_score'] if r['peak_score'] is not None else '-'}")
    if not m["regions"]:
        print("(无区域)")


# ---------------------------------------------------------------- 子命令

def cmd_generate(args: argparse.Namespace) -> None:
    cfg = build_dataset(args.out_dir, sr=args.sr,
                        duration=args.duration, seed=args.seed)
    out = Path(args.out_dir)
    print(f"已生成素材到 {out}/")
    print(f"  clean.wav   干净参考")
    print(f"  damaged.wav 含 {len(cfg.pops)} 处爆点的受损文件")
    print(f"  truth.json  真值(默认合并间隔 {cfg.merge_gap_ms} ms)")
    for p in cfg.pops:
        ch = ",".join("L" if c == 0 else "R" for c in p.channels)
        print(f"    - {p.kind:<14} {p.start / cfg.sr:7.4f}s "
              f"时长 {(p.end - p.start) / cfg.sr * 1000:5.2f}ms 声道 {ch}")


def cmd_detect(args: argparse.Namespace) -> None:
    data, sr = read_wav(args.wav)
    n, n_ch = data.shape
    params = dict(DEFAULTS)
    if args.merge_gap_ms is not None:
        params["merge_gap_ms"] = args.merge_gap_ms
    if args.threshold is not None:
        params["threshold"] = args.threshold
    if Path(args.manifest).exists() and not args.rescan:
        raise SystemExit(
            f"{args.manifest} 已存在; 加 --rescan 覆盖重扫, 或用编辑子命令调整")
    # wav 与清单同目录(或在其子树)时存相对路径, 便于整体移动; 否则存绝对路径
    wav_abs = Path(args.wav).resolve()
    mdir = Path(args.manifest).resolve().parent
    try:
        stored_wav = str(wav_abs.relative_to(mdir))
    except ValueError:
        stored_wav = str(wav_abs)
    m = mani.new_manifest(stored_wav, sr, n_ch, n, params)
    m["regions"] = detect_file(wav_abs, params)
    mani.save_manifest(m, args.manifest)
    print(f"检测到 {len(m['regions'])} 个候选区域 -> {args.manifest}")
    _print_regions(m)


def cmd_list(args: argparse.Namespace) -> None:
    _print_regions(_load(args.manifest))


def cmd_add(args: argparse.Namespace) -> None:
    m = _load(args.manifest)
    sr = m["sample_rate"]
    s = _time_to_sample(args.start, sr, args.in_samples)
    e = _time_to_sample(args.end, sr, args.in_samples)
    chs = _parse_channels(args.channels, m["channels"])
    mani.add_region(m, s, e, chs)
    mani.save_manifest(m, args.manifest)
    print(f"已新增手工选区 [{s}, {e})")
    _print_regions(m)


def cmd_trim(args: argparse.Namespace) -> None:
    m = _load(args.manifest)
    sr = m["sample_rate"]
    s = (_time_to_sample(args.start, sr, args.in_samples)
         if args.start is not None else None)
    e = (_time_to_sample(args.end, sr, args.in_samples)
         if args.end is not None else None)
    mani.trim_region(m, args.id, s, e)
    mani.save_manifest(m, args.manifest)
    print(f"区域 {args.id} 边界已更新")
    _print_regions(m)


def cmd_remove(args: argparse.Namespace) -> None:
    m = _load(args.manifest)
    mani.remove_region(m, args.id)
    mani.save_manifest(m, args.manifest)
    print(f"已删除区域 {args.id}")
    _print_regions(m)


def cmd_enable(args: argparse.Namespace) -> None:
    m = _load(args.manifest)
    mani.set_enabled(m, args.id, args.on)
    mani.save_manifest(m, args.manifest)
    print(f"区域 {args.id} {'启用' if args.on else '停用'}")


def cmd_channels(args: argparse.Namespace) -> None:
    m = _load(args.manifest)
    chs = _parse_channels(args.channels, m["channels"])
    mani.set_channels(m, args.id, chs)
    mani.save_manifest(m, args.manifest)
    print(f"区域 {args.id} 声道改为 {chs}")
    _print_regions(m)


def cmd_padding(args: argparse.Namespace) -> None:
    m = _load(args.manifest)
    rid = args.id if args.id is not None else None
    mani.set_padding(m, rid, args.ms)
    mani.save_manifest(m, args.manifest)
    target = "全局默认" if rid is None else f"区域 {rid}"
    print(f"{target}处理宽度 padding = {args.ms} ms")


def cmd_remerge(args: argparse.Namespace) -> None:
    m = _load(args.manifest)
    mani.remerge(m, args.gap_ms)
    mani.save_manifest(m, args.manifest)
    print(f"已按间隔 {m['config']['merge_gap_ms']} ms 重新合并")
    _print_regions(m)


def cmd_repair(args: argparse.Namespace) -> None:
    m = _load(args.manifest)
    wav_path = mani.resolve_wav(m, args.manifest)
    data, sr = read_wav(wav_path)
    if sr != m["sample_rate"] or data.shape[0] != m["frames"]:
        raise SystemExit("wav 与清单记录的采样率/长度不一致, 拒绝修复")
    result = repair_manifest(data, sr, m)
    write_wav(args.out, result.repaired, sr, subtype=args.subtype)
    print(f"修复完成 -> {args.out} (实际修复 {len(result.applied)} 块)")
    for a in result.applied:
        print(f"  区域 {a['id']:>2}: {a['start'] / sr:.4f}s - "
              f"{a['end'] / sr:.4f}s 声道 {a['channels']} "
              f"padding={a['padding_ms']}ms 改动 {a['changed_samples']} 样本")

    slice_records = []
    if args.slices:
        slice_dir = Path(args.out).with_name("slices")
        for r in m["regions"]:
            if not r["enabled"]:
                continue
            slice_records.append(export_slices(
                data, result.repaired, result.removed, sr, r,
                slice_dir, context_ms=args.context_ms, subtype=args.subtype))
        print(f"对齐切片(原声/修补/移除) -> {slice_dir}/")

    m["repair_output"] = {
        "repaired_wav": str(args.out),
        "applied": result.applied,
        "slices": slice_records,
    }
    mani.save_manifest(m, args.manifest)


def cmd_verify(args: argparse.Namespace) -> None:
    m = _load(args.manifest)
    truth = json.loads(Path(args.truth).read_text(encoding="utf-8"))
    damaged, sr = read_wav(mani.resolve_wav(m, args.manifest))
    repaired, _ = read_wav(args.repaired)
    clean, _ = read_wav(args.clean)
    report = verify(damaged, repaired, clean, sr, m, truth)
    Path(args.report).write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    s = report["summary"]
    print(f"核对报告 -> {args.report}")
    print(f"  真值爆点 {s['truth_pop_count']} 处, "
          f"漏修 {s['missed_count']} 处, "
          f"误伤段 {s['false_edit_segment_count']} 个")
    print(f"  修补区外逐样本一致: {s['outside_repair_identical']}")
    print(f"  高频损伤能量移除率: {s['hf_damage_energy_removed_pct']}%")
    for item in report["missed"]:
        print(f"  [漏修] {item['kind']} @ {item['start_time']}s "
              f"高频残留比 {item['hf_residual_ratio']}")
    for item in report["false_edits"][:10]:
        print(f"  [误伤] {item['start_time']}s - {item['end_time']}s "
              f"({item['duration_ms']}ms)")


# ---------------------------------------------------------------- 总入口

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="popfix",
                                description="录音爆点定位与局部修复工具")
    sub = p.add_subparsers(dest="cmd", required=True)

    g = sub.add_parser("generate", help="生成测试素材(干净参考+爆点+真值)")
    g.add_argument("out_dir")
    g.add_argument("--sr", type=int, default=44100)
    g.add_argument("--duration", type=float, default=6.0)
    g.add_argument("--seed", type=int, default=16280)
    g.set_defaults(func=cmd_generate)

    d = sub.add_parser("detect", help="检测爆点候选并写清单")
    d.add_argument("wav")
    d.add_argument("-m", "--manifest", required=True)
    d.add_argument("--merge-gap-ms", type=float, default=None)
    d.add_argument("--threshold", type=float, default=None)
    d.add_argument("--rescan", action="store_true", help="覆盖已有清单重扫")
    d.set_defaults(func=cmd_detect)

    def add_manifest(sp: argparse.ArgumentParser) -> None:
        sp.add_argument("-m", "--manifest", required=True)

    l = sub.add_parser("list", help="列出清单中的区域")
    add_manifest(l)
    l.set_defaults(func=cmd_list)

    a = sub.add_parser("add", help="手工新增选区(时间默认秒, 加 --in-samples)")
    add_manifest(a)
    a.add_argument("start")
    a.add_argument("end")
    a.add_argument("-c", "--channels", default="all")
    a.add_argument("--in-samples", action="store_true")
    a.set_defaults(func=cmd_add)

    t = sub.add_parser("trim", help="修改区域边界")
    add_manifest(t)
    t.add_argument("id", type=int)
    t.add_argument("-s", "--start", default=None)
    t.add_argument("-e", "--end", default=None)
    t.add_argument("--in-samples", action="store_true")
    t.set_defaults(func=cmd_trim)

    r = sub.add_parser("remove", help="删除区域")
    add_manifest(r)
    r.add_argument("id", type=int)
    r.set_defaults(func=cmd_remove)

    en = sub.add_parser("enable", help="启用/停用区域(停用则不修复)")
    add_manifest(en)
    en.add_argument("id", type=int)
    en.add_argument("--off", dest="on", action="store_false", default=True)
    en.set_defaults(func=cmd_enable)

    ch = sub.add_parser("channels", help="修改区域受影响声道, 如 0 / 1 / all")
    add_manifest(ch)
    ch.add_argument("id", type=int)
    ch.add_argument("channels")
    ch.set_defaults(func=cmd_channels)

    pad = sub.add_parser("padding", help="调处理宽度; 不给 id 改全局默认")
    add_manifest(pad)
    pad.add_argument("ms", type=float)
    pad.add_argument("--id", type=int, default=None)
    pad.set_defaults(func=cmd_padding)

    rm = sub.add_parser("remerge", help="按新间隔重新合并区域")
    add_manifest(rm)
    rm.add_argument("gap_ms", type=float)
    rm.set_defaults(func=cmd_remerge)

    rp = sub.add_parser("repair", help="按清单修复并导出 wav/切片")
    add_manifest(rp)
    rp.add_argument("-o", "--out", required=True)
    rp.add_argument("--slices", action="store_true",
                    help="导出每块的原声/修补/移除对齐切片")
    rp.add_argument("--context-ms", type=float, default=150.0)
    rp.add_argument("--subtype", default="PCM_16")
    rp.set_defaults(func=cmd_repair)

    v = sub.add_parser("verify", help="对照干净参考核对漏修/误伤")
    add_manifest(v)
    v.add_argument("--truth", required=True)
    v.add_argument("--clean", required=True)
    v.add_argument("--repaired", required=True)
    v.add_argument("--report", required=True)
    v.set_defaults(func=cmd_verify)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    args.func(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
