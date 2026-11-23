"""Export the corrected WAV plus a verification checklist, then verify it."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from .model import Project, build_tracks
from .wavio import read_wav, write_wav


def export_corrected(proj: Project, out_wav: Path) -> dict:
    """Write corrected.wav and a checklist; re-read the file to verify it."""
    out_wav = Path(out_wav)
    naive, trimmed, corrected, warnings = build_tracks(proj)
    write_wav(out_wav, corrected.samples, proj.sample_rate, bit_depth=16)

    used_ranges, seams = [], []
    pos = 0
    for i, seg in enumerate(proj.segments):
        length = seg.keep_end - seg.keep_start
        used_ranges.append(
            {
                "segment": i,
                "source_absolute_range": [
                    seg.source_start + seg.keep_start,
                    seg.source_start + seg.keep_end,
                ],
                "segment_relative_keep": [seg.keep_start, seg.keep_end],
                "samples_used": length,
                "position_in_export": [pos, pos + length],
            }
        )
        if i < len(proj.segments) - 1:
            pos += length
            seams.append({"seam": i, "sample_before_join": pos - 1, "sample_at_join": pos})

    readback = read_wav(out_wav)
    in_memory = corrected.samples
    # Sample-level boundary check: first/last sample of every used range must
    # match the built track after the WAV round-trip (16-bit tolerance).
    boundary_checks = []
    for r in used_ranges:
        p0, p1 = r["position_in_export"]
        boundary_checks.append(
            {
                "segment": r["segment"],
                "first_sample_match": bool(
                    np.allclose(readback.samples[p0], in_memory[p0], atol=4e-5)
                ),
                "last_sample_match": bool(
                    np.allclose(readback.samples[p1 - 1], in_memory[p1 - 1], atol=4e-5)
                ),
            }
        )
    checklist = {
        "export_file": str(out_wav.resolve()),
        "codec_workflow": proj.codec,
        "sample_rate": proj.sample_rate,
        "channels_expected": proj.channels,
        "segments_used": used_ranges,
        "seams": seams,
        "total_samples_expected": corrected.length,
        "warnings": warnings,
        "readback_check": {
            "samples_found": readback.n_samples,
            "channels_found": readback.channels,
            "sample_rate_found": readback.sample_rate,
            "length_match": readback.n_samples == corrected.length,
            "channels_match": readback.channels == proj.channels,
            "range_starts_nonnegative": all(
                r["position_in_export"][0] >= 0 for r in used_ranges
            ),
            "range_ends_inside_file": all(
                r["position_in_export"][1] <= readback.n_samples for r in used_ranges
            ),
            "boundary_sample_checks": boundary_checks,
        },
    }
    rb = checklist["readback_check"]
    ok = (
        rb["length_match"]
        and rb["channels_match"]
        and rb["range_starts_nonnegative"]
        and rb["range_ends_inside_file"]
        and all(
            c["first_sample_match"] and c["last_sample_match"]
            for c in boundary_checks
        )
    )
    rb["passed"] = ok

    sidecar = out_wav.with_suffix(".checklist.json")
    sidecar.write_text(json.dumps(checklist, indent=2, ensure_ascii=False))
    return checklist
