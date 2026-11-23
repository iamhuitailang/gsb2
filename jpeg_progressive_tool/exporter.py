"""Export scan manifests and decodable-stage PNGs.

Output is deterministic: re-analyzing the same file produces the same
scan order, stage numbering and file names (all derived from byte
offsets in file order).
"""

from __future__ import annotations

import json
import os

from . import analyzer, parser


def export(data: bytes, outdir: str, source_name: str = "input.jpg") -> dict:
    """Write manifest.json plus one PNG per decodable scan-boundary
    stage. Returns the manifest dict."""
    os.makedirs(outdir, exist_ok=True)
    struct = parser.parse(data)
    results = analyzer.probe_scan_boundaries(data)

    stages = []
    for i, res in enumerate(results):
        stage = {
            "stage": i,
            "byte_range": [0, res.offset],
            "coverage": round(res.coverage, 6),
            "state": res.state,
            "state_label": res.state_label,
            "scans_included": res.scans_included,
            "scan_indices": list(res.scan_indices),
            "mid_scan": res.mid_scan,
            "png": None,
            "error": res.error,
        }
        if res.image is not None:
            png = f"stage_{i:03d}_bytes_0-{res.offset}.png"
            res.image.save(os.path.join(outdir, png))
            stage["png"] = png
        stages.append(stage)

    manifest = {
        "source": source_name,
        "file_size": len(data),
        "progressive": struct.progressive,
        "width": struct.width,
        "height": struct.height,
        "scan_count": len(struct.scans),
        "segments": [s.to_dict() for s in struct.segments],
        "stages": stages,
    }
    with open(os.path.join(outdir, "manifest.json"), "w",
              encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    return manifest
