"""命令行入口。

用法:
  python -m noisekit.cli serve [--port 8765]            启动本地 Web 工具
  python -m noisekit.cli generate-samples [--out DIR]   生成演示样音
  python -m noisekit.cli process A.wav --sample 0.1 0.6 \
      --strength 0.6 --out-dir ./out [--params.json]    无界面单文件处理
"""

from __future__ import annotations

import argparse
import json
import os
import sys

# 允许 `python3 -I noisekit/cli.py ...` 直接运行 (隔离模式无 PYTHONPATH)
if __package__ in (None, ""):
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from noisekit.audioio import SUPPORTED_READ_EXTS
    from noisekit.dsp import choose_n_fft
    from noisekit.engine import Engine
    from noisekit.samples import SAMPLES_DIR, generate
else:
    from .audioio import SUPPORTED_READ_EXTS
    from .dsp import choose_n_fft
    from .engine import Engine
    from .samples import SAMPLES_DIR, generate


def _cmd_serve(args: argparse.Namespace) -> int:
    from .server import run

    run(port=args.port)
    return 0


def _cmd_samples(args: argparse.Namespace) -> int:
    out = args.out or SAMPLES_DIR
    manifest = generate(out)
    print(f"已生成 {len(manifest)} 个样音到 {out}:")
    for item in manifest:
        print(f"  - {item['file']}  {item['title']}")
    return 0


def _cmd_process(args: argparse.Namespace) -> int:
    engine = Engine()
    af = engine.load(args.audio)
    n_fft = choose_n_fft(af.sr)
    noise = engine.analyze(args.audio, args.sample[0], args.sample[1])
    if noise["speech_suspected"]:
        print("警告: 噪声样本疑似包含语音/瞬态, 处理可能削弱目标声音:", file=sys.stderr)
        for w in noise["warnings"]:
            print(f"  - {w}", file=sys.stderr)
    params = {
        "n_fft": n_fft,
        "strength": args.strength,
        "smoothing": args.smoothing,
        "protect_transient": not args.no_protect_transient,
        "protect_voice": not args.no_protect_voice,
        "region_start": args.sample[0],
        "region_end": args.sample[1],
    }
    result = engine.export_one(args.audio, args.out_dir, noise, params)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="noisekit", description="本地录音底噪降噪预览工具")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("serve", help="启动本地 Web 服务")
    s.add_argument("--port", type=int, default=8765)
    s.set_defaults(func=_cmd_serve)

    g = sub.add_parser("generate-samples", help="生成演示样音")
    g.add_argument("--out", default=None)
    g.set_defaults(func=_cmd_samples)

    pr = sub.add_parser("process", help="命令行单文件降噪")
    pr.add_argument("audio", help=f"源录音 (支持 {sorted(SUPPORTED_READ_EXTS)})")
    pr.add_argument("--sample", nargs=2, type=float, required=True, metavar=("START", "END"),
                    help="噪声样本区间(秒)")
    pr.add_argument("--strength", type=float, default=0.5, help="处理强度 0~1")
    pr.add_argument("--smoothing", type=float, default=0.6, help="增益平滑 0~1")
    pr.add_argument("--no-protect-transient", action="store_true", help="关闭瞬态保护")
    pr.add_argument("--no-protect-voice", action="store_true", help="关闭语音保护")
    pr.add_argument("--out-dir", default="./noisekit_exports")
    pr.set_defaults(func=_cmd_process)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
