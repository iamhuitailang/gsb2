"""Command line interface for the seamless-audio stitch checker."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .export import export_corrected
from .model import (
    STATE_NAME,
    Project,
    adjust_keep,
    analyze_project,
    create_project,
    undo,
)
from .samples import generate_all
from .view import (
    maybe_plot,
    seam_window,
    segment_table,
    track_summary,
    write_csvs,
    write_track_wavs,
)
from .wavio import read_wav


def _load(workdir: Path) -> Project:
    state = Path(workdir) / STATE_NAME
    if not state.exists():
        raise SystemExit(f"no project found in {workdir} (run 'create' first)")
    return Project.from_json(state)


def cmd_create(args: argparse.Namespace) -> None:
    cuts = [int(x) for x in args.cuts.split(",") if x]
    proj = create_project(
        Path(args.wav), Path(args.workdir), cuts, codec=args.codec
    )
    print(f"project created in {args.workdir} ({len(proj.segments)} segments)")
    print(segment_table(proj))


def cmd_info(args: argparse.Namespace) -> None:
    proj = _load(args.workdir)
    print(segment_table(proj))
    analysis = analyze_project(proj)
    print()
    print(track_summary(analysis))


def cmd_seam(args: argparse.Namespace) -> None:
    proj = _load(args.workdir)
    if not 0 <= args.seam < len(proj.cuts):
        raise SystemExit(f"seam must be in 0..{len(proj.cuts) - 1}")
    print(seam_window(proj, args.seam, radius=args.radius))
    if args.png:
        ok = maybe_plot(proj, args.seam, Path(args.png), radius=args.radius * 25)
        if not ok:
            print(
                "\n[matplotlib not installed - PNG skipped; CSV/WAV outputs "
                "still available]",
                file=sys.stderr,
            )


def cmd_analyze(args: argparse.Namespace) -> None:
    proj = _load(args.workdir)
    analysis = analyze_project(proj)
    print(track_summary(analysis))
    out = Path(args.workdir) / "reports"
    paths = write_csvs(proj, analysis, out)
    paths += write_track_wavs(proj, out)
    (out / "analysis.json").write_text(json.dumps(analysis, indent=2))
    print(f"\nwrote: {', '.join(str(p) for p in paths)}, {out / 'analysis.json'}")


def cmd_adjust(args: argparse.Namespace) -> None:
    proj = _load(args.workdir)
    adjust_keep(proj, args.segment, args.keep_start, args.keep_end)
    analysis = analyze_project(proj)
    print(
        f"segment {args.segment} keep range -> "
        f"[{proj.segments[args.segment].keep_start}, "
        f"{proj.segments[args.segment].keep_end}) "
        "(undo available)"
    )
    print(track_summary(analysis))


def cmd_undo(args: argparse.Namespace) -> None:
    proj = _load(args.workdir)
    if not undo(proj):
        print("nothing to undo")
        return
    print("last adjustment reverted")
    print(track_summary(analyze_project(proj)))


def cmd_export(args: argparse.Namespace) -> None:
    proj = _load(args.workdir)
    checklist = export_corrected(proj, Path(args.out))
    print(json.dumps(checklist, indent=2, ensure_ascii=False))
    print(f"\nchecklist written to {Path(args.out).with_suffix('.checklist.json')}")
    if not checklist["readback_check"]["passed"]:
        raise SystemExit(1)


def cmd_samples(args: argparse.Namespace) -> None:
    samples = generate_all(Path(args.outdir))
    for s in samples:
        w = read_wav(s.wav_path)
        print(
            f"{s.wav_path.name}: {w.n_samples} samples, {w.channels} ch, "
            f"cuts={s.cuts}, silence={s.silence_ranges}"
        )
    print(f"\nmanifest: {Path(args.outdir) / 'manifest.json'}")


def cmd_compare(args: argparse.Namespace) -> None:
    """Quick raw waveform diff of two WAVs (for ad-hoc verification)."""
    import numpy as np

    a, b = read_wav(args.a), read_wav(args.b)
    n = min(a.n_samples, b.n_samples)
    d = (a.samples[:n] - b.samples[:n]).mean(axis=1)
    rms = float(np.sqrt(np.mean(d * d)))
    print(
        f"lengths: {a.n_samples} vs {b.n_samples} "
        f"(delta {a.n_samples - b.n_samples})"
    )
    print(f"overlap {n} samples: max|diff|={abs(d).max():.5f} rms={rms:.5f}")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="stitch-check",
        description="Local seamless audio concatenation verifier (Python + ffmpeg)",
    )
    sub = p.add_subparsers(dest="command", required=True)

    c = sub.add_parser("create", help="split a WAV, encode parts, probe padding")
    c.add_argument("wav")
    c.add_argument("workdir")
    c.add_argument("--cuts", required=True, help="comma-separated cut sample indices")
    c.add_argument("--codec", default="mp3", choices=["mp3", "aac", "adts"])
    c.set_defaults(func=cmd_create)

    c = sub.add_parser("info", help="segment/padding table and track summary")
    c.add_argument("workdir")
    c.set_defaults(func=cmd_info)

    c = sub.add_parser("seam", help="sample-level view around one seam")
    c.add_argument("workdir")
    c.add_argument("seam", type=int)
    c.add_argument("--radius", type=int, default=24)
    c.add_argument("--png", help="optional matplotlib PNG output path")
    c.set_defaults(func=cmd_seam)

    c = sub.add_parser("analyze", help="measure all seams, write CSV/JSON/WAV report")
    c.add_argument("workdir")
    c.set_defaults(func=cmd_analyze)

    c = sub.add_parser("adjust", help="change one segment's kept source range")
    c.add_argument("workdir")
    c.add_argument("segment", type=int)
    c.add_argument("--keep-start", type=int, default=None)
    c.add_argument("--keep-end", type=int, default=None)
    c.set_defaults(func=cmd_adjust)

    c = sub.add_parser("undo", help="revert the last keep-range adjustment")
    c.add_argument("workdir")
    c.set_defaults(func=cmd_undo)

    c = sub.add_parser("export", help="export corrected WAV + checklist with read-back")
    c.add_argument("workdir")
    c.add_argument("out")
    c.set_defaults(func=cmd_export)

    c = sub.add_parser("samples", help="generate deterministic program-made WAVs")
    c.add_argument("outdir")
    c.set_defaults(func=cmd_samples)

    c = sub.add_parser("compare", help="raw diff of two WAV files")
    c.add_argument("a")
    c.add_argument("b")
    c.set_defaults(func=cmd_compare)
    return p


def main(argv: list[str] | None = None) -> None:
    args = build_parser().parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
