"""导出：位置/角度/缩放/决策 CSV+JSON、修订日志、标注图。"""

from __future__ import annotations

import csv
import json
from pathlib import Path

import cv2
import numpy as np

from .review import ImageState
from .visualization import draw_all


def export_results(
    state: ImageState,
    image: np.ndarray,
    out_dir: str | Path,
    template=None,
    include_hidden: bool = False,
) -> dict:
    """导出单张图的查找结果。

    生成文件：
    - ``<stem>_matches.csv``：每个候选一行（位置、角度、缩放、翻面、分数、决策）；
    - ``<stem>_matches.json``：结构化结果 + 逐单元分数 + 汇总计数；
    - ``<stem>_revisions.json``：完整修订日志（阈值调整、确认/误报、重算）；
    - ``<stem>_annotated.png``：画回原图位置的标注图。
    """
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    stem = Path(state.image_path).stem or state.image_key[:12]
    visible = [m for m in state.matches if include_hidden or not m.hidden]

    csv_path = out / f"{stem}_matches.csv"
    fields = [
        "id", "x", "y", "angle", "scale", "flipped",
        "score", "robust_score", "decision", "note",
    ]
    with open(csv_path, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        for m in visible:
            rec = m.to_record()
            writer.writerow({k: rec[k] for k in fields})

    json_path = out / f"{stem}_matches.json"
    payload = {
        "image_path": state.image_path,
        "image_key": state.image_key,
        "last_threshold": state.last_threshold,
        "counts": state.counts(),
        "matches": [m.to_record() for m in visible],
    }
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

    rev_path = out / f"{stem}_revisions.json"
    with open(rev_path, "w", encoding="utf-8") as f:
        json.dump(
            {"image_path": state.image_path, "revisions": state.revisions},
            f, ensure_ascii=False, indent=2,
        )

    annotated_path = out / f"{stem}_annotated.png"
    cv2.imwrite(str(annotated_path), draw_all(image, visible))

    return {
        "csv": str(csv_path),
        "json": str(json_path),
        "revisions": str(rev_path),
        "annotated": str(annotated_path),
    }
