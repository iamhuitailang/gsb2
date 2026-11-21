"""批量处理：逐张容错，失败不影响其余图片，参数随结果一起落盘。"""

from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass, field
from typing import Callable

import cv2

from .params import ProcessParams
from .pipeline import process_file

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff", ".webp", ".jp2"}


@dataclass
class BatchReport:
    succeeded: list[dict] = field(default_factory=list)
    failed: list[dict] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


def iter_images(paths: list[str]) -> list[str]:
    """展开目录、过滤受支持扩展名。"""
    files: list[str] = []
    for p in paths:
        if os.path.isdir(p):
            for name in sorted(os.listdir(p)):
                if os.path.splitext(name)[1].lower() in IMAGE_EXTS:
                    files.append(os.path.join(p, name))
        elif os.path.isfile(p):
            files.append(p)
        else:
            raise FileNotFoundError(p)
    return files


def run_batch(inputs: list[str], outdir: str, params: ProcessParams,
              progress: Callable[[str, int, int], None] | None = None
              ) -> BatchReport:
    """处理一批图片。

    每张图独立 try/except：无法读取或处理失败的进入 failed 列表，
    已成功的图片照常导出。输出：
      <outdir>/<stem>.cleaned.png  —— 清理图
      <outdir>/<stem>.params.json  —— 当张使用的完整参数
      <outdir>/batch_report.json   —— 汇总（成功/失败清单）
    """
    os.makedirs(outdir, exist_ok=True)
    files = iter_images(inputs)
    report = BatchReport()

    for i, path in enumerate(files, 1):
        stem = os.path.splitext(os.path.basename(path))[0]
        if progress:
            progress(path, i, len(files))
        try:
            result, _ = process_file(path, params)  # 原尺寸导出
            out_img = os.path.join(outdir, f"{stem}.cleaned.png")
            out_par = os.path.join(outdir, f"{stem}.params.json")
            if not cv2.imwrite(out_img, result.cleaned):
                raise OSError(f"写出失败: {out_img}")
            with open(out_par, "w", encoding="utf-8") as f:
                json.dump(params.to_dict(), f, ensure_ascii=False, indent=2)
            report.succeeded.append({
                "input": os.path.abspath(path),
                "output": os.path.abspath(out_img),
                "params": os.path.abspath(out_par),
                "size": [int(v) for v in reversed(result.cleaned.shape)],
                "dots_flagged": len(result.meta.get("dots", [])),
            })
        except Exception as exc:  # 单张失败隔离
            report.failed.append({
                "input": os.path.abspath(path),
                "error": f"{type(exc).__name__}: {exc}",
            })

    with open(os.path.join(outdir, "batch_report.json"), "w", encoding="utf-8") as f:
        json.dump(report.to_dict(), f, ensure_ascii=False, indent=2)
    return report
