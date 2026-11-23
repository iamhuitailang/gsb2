"""Human-readable views: segment tables, sample-level seam windows, CSV/PNG."""
from __future__ import annotations

import csv
from pathlib import Path

import numpy as np

from .analysis import mono_mix
from .model import Project, build_tracks
from .wavio import read_wav, write_wav

BLOCKS = " ▁▂▃▄▅▆▇█"


def _spark(values: np.ndarray, width: int = 48) -> str:
    x = np.asarray(values, dtype=np.float64)
    if len(x) > width:
        bins = np.array_split(x, width)
        x = np.array([np.max(np.abs(b)) for b in bins])
    peak = np.max(np.abs(x)) if len(x) else 0.0
    if peak < 1e-12:
        return "·" * len(x)
    idxs = np.clip((np.abs(x) / peak * (len(BLOCKS) - 1)).round().astype(int), 0, len(BLOCKS) - 1)
    return "".join(BLOCKS[i] for i in idxs)


def segment_table(proj: Project) -> str:
    lines = [
        f"codec={proj.codec}  sr={proj.sample_rate}  channels={proj.channels}  "
        f"source={proj.source_samples} samples",
        "",
        f"{'seg':>3} {'src_start':>10} {'src_len':>9} {'decoded':>9} "
        f"{'head_pad':>9} {'tail_pad':>9} {'trust':>9}  keep range (src-rel)",
    ]
    for s in proj.segments:
        hp = "?" if s.head_padding is None else s.head_padding
        tp = "?" if s.tail_padding is None else s.tail_padding
        lines.append(
            f"{s.index:>3} {s.source_start:>10} {s.source_length:>9} "
            f"{s.decoded_length:>9} {str(hp):>9} {str(tp):>9} "
            f"{s.padding_trust:>9}  [{s.keep_start}, {s.keep_end})"
        )
    lines.append("")
    notes = [n for s in proj.segments for n in s.padding_notes]
    if notes:
        lines.append("padding notes:")
        lines.extend(f"  - {n}" for n in dict.fromkeys(notes))
    return "\n".join(lines)


def track_summary(analysis: dict) -> str:
    ref_n = analysis["reference"]["samples"]
    lines = [
        f"reference: {ref_n} samples",
        f"{'track':>10} {'length':>9} {'delta':>7}  seams",
    ]
    for name, t in analysis["tracks"].items():
        seams = ", ".join(
            f"#{s['seam_index']}:{s['classification']}"
            f"({s['measured_shift']:+d},{s['padding_trust'][:4]})"
            for s in t["seams"]
        )
        lines.append(
            f"{name:>10} {t['samples']:>9} {t['delta_vs_reference']:>+7}  {seams}"
        )
    if analysis["warnings"]:
        lines.append("")
        lines.append("warnings:")
        lines.extend(f"  ! {w}" for w in dict.fromkeys(analysis["warnings"]))
    return "\n".join(lines)


def seam_window(
    proj: Project, seam_index: int, radius: int = 24
) -> str:
    """Sample-accurate table around one seam for reference + three tracks."""
    ref = read_wav(Path(proj.workdir, "reference.wav")).samples
    naive, trimmed, corrected, _ = build_tracks(proj)
    rj = proj.cuts[seam_index]
    tracks = [
        ("reference", ref, rj),
        ("naive", naive.samples, naive.junctions[seam_index]),
        ("trimmed", trimmed.samples, trimmed.junctions[seam_index]),
        ("corrected", corrected.samples, corrected.junctions[seam_index]),
    ]
    lines = [
        f"seam #{seam_index} (source cut at sample {rj}), ±{radius} samples",
        f"{'track':>10} {'junction':>9}  amplitude window (|amplitude|, "
        "mono mix; '|' marks the join)",
    ]
    for name, x, junction in tracks:
        lo = max(0, junction - radius)
        hi = min(len(x), junction + radius)
        m = mono_mix(x[lo:hi])
        spark = _spark(m, width=2 * radius)
        marker_pos = junction - lo
        spark = spark[:marker_pos] + "│" + spark[marker_pos:]
        lines.append(f"{name:>10} {junction:>9}  {spark}")
    lines.append("")
    lines.append("per-sample values (each track's own indices around its join):")
    header = "       " + "".join(f"{i:>8}" for i in range(-radius, radius))
    lines.append(header)
    for name, x, junction in tracks:
        lo = max(0, junction - radius)
        hi = min(len(x), junction + radius)
        m = mono_mix(x[lo:hi])
        vals = []
        for i in range(-radius, radius):
            idx = junction + i
            vals.append(f"{m[idx-lo]:>8.4f}" if lo <= idx < hi else "     --")
        lines.append(f"{name:>10} " + "".join(vals))
    return "\n".join(lines)


def write_csvs(proj: Project, analysis: dict, outdir: Path) -> list[Path]:
    outdir.mkdir(parents=True, exist_ok=True)
    paths = []
    seg_csv = outdir / "segments.csv"
    with seg_csv.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(
            [
                "segment", "source_start", "source_length", "decoded_length",
                "head_padding", "tail_padding", "padding_trust",
                "keep_start", "keep_end",
            ]
        )
        for s in proj.segments:
            w.writerow(
                [
                    s.index, s.source_start, s.source_length, s.decoded_length,
                    s.head_padding, s.tail_padding, s.padding_trust,
                    s.keep_start, s.keep_end,
                ]
            )
    paths.append(seg_csv)

    seam_csv = outdir / "seams.csv"
    with seam_csv.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(
            [
                "track", "seam", "reference_sample", "build_sample",
                "measured_shift", "confidence", "classification",
                "inserted_silence", "source_was_silent", "padding_trust",
                "detail",
            ]
        )
        for name, t in analysis["tracks"].items():
            for s in t["seams"]:
                w.writerow(
                    [
                        name, s["seam_index"], s["reference_sample"],
                        s["build_sample"], s["measured_shift"],
                        s["shift_confidence"], s["classification"],
                        s["inserted_silence"], s["source_was_silent"],
                        s["padding_trust"], s["detail"],
                    ]
                )
    paths.append(seam_csv)
    return paths


def write_track_wavs(proj: Project, outdir: Path) -> list[Path]:
    """Persist the three comparison tracks as WAV for external inspection."""
    outdir.mkdir(parents=True, exist_ok=True)
    naive, trimmed, corrected, _ = build_tracks(proj)
    paths = []
    for tr in (naive, trimmed, corrected):
        p = outdir / f"{tr.name}.wav"
        write_wav(p, tr.samples, proj.sample_rate)
        paths.append(p)
    return paths


def maybe_plot(proj: Project, seam_index: int, out_png: Path, radius: int = 600) -> bool:
    """Optional matplotlib plot; returns False when matplotlib is missing."""
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except Exception:
        return False
    ref = read_wav(Path(proj.workdir, "reference.wav")).samples
    naive, trimmed, corrected, _ = build_tracks(proj)
    rj = proj.cuts[seam_index]
    fig, axes = plt.subplots(4, 1, figsize=(12, 9), sharex=False)
    for ax, (name, x, junction) in zip(
        axes,
        [
            ("reference", ref, rj),
            ("naive", naive.samples, naive.junctions[seam_index]),
            ("trimmed", trimmed.samples, trimmed.junctions[seam_index]),
            ("corrected", corrected.samples, corrected.junctions[seam_index]),
        ],
    ):
        lo, hi = max(0, junction - radius), min(len(x), junction + radius)
        ax.plot(np.arange(lo, hi), mono_mix(x[lo:hi]), lw=0.8)
        ax.axvline(junction, color="r", ls="--", lw=1)
        ax.set_title(f"{name} — join at sample {junction}")
        ax.set_ylabel("amplitude")
    fig.tight_layout()
    out_png.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out_png, dpi=110)
    plt.close(fig)
    return True
