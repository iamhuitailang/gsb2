"""File IO: WAV export, marker CSV, ground-truth CSV and verification report."""

from __future__ import annotations

import csv
from pathlib import Path
from typing import List

import numpy as np
import soundfile as sf

from .synthesis import SAMPLE_RATE, Event
from .replacement import VerificationReport, RenderResult

MARKER_FIELDS = ["time_sec", "sample_index", "drum", "velocity", "kind"]


def export_wav(path: str | Path, audio: np.ndarray,
               sr: int = SAMPLE_RATE) -> Path:
    """Write 16-bit PCM WAV, guarding against inter-sample clipping."""
    path = Path(path)
    peak = float(np.max(np.abs(audio)))
    out = audio
    if peak > 0.999:
        out = audio * (0.999 / peak)
    sf.write(path, out.astype(np.float32), sr, subtype="PCM_16")
    return path


def export_markers(path: str | Path, events: List[Event]) -> Path:
    """Write one marker per row: time, sample, class, velocity, kind."""
    path = Path(path)
    with path.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=MARKER_FIELDS)
        writer.writeheader()
        for ev in sorted(events, key=lambda e: e.time):
            writer.writerow({
                "time_sec": f"{ev.time:.6f}",
                "sample_index": int(round(ev.time * SAMPLE_RATE)),
                "drum": ev.drum,
                "velocity": ev.velocity,
                "kind": ev.kind,
            })
    return path


def import_markers(path: str | Path) -> List[Event]:
    events = []
    with Path(path).open(newline="") as f:
        for row in csv.DictReader(f):
            events.append(Event(
                time=float(row["time_sec"]),
                drum=row["drum"],
                velocity=row["velocity"],
                kind=row.get("kind", "hit"),
            ))
    return events


def export_report(path: str | Path, report: VerificationReport,
                  render: RenderResult) -> Path:
    """Human-readable verification report plus the boundary rule accounting."""
    path = Path(path)
    text = report.summary() + "\n" + "\n".join([
        "",
        "boundary rules",
        f"  head-clipped samples : {render.clipped_head_samples}",
        f"  tail samples past end: {render.dropped_tail_samples} "
        "(kept via buffer extension; a fixed-length export would lose them)",
    ])
    path.write_text(text + "\n")
    return path
