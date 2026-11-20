"""序列加载与一致性检查。"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

from PIL import Image

SUPPORTED_EXTS = {".png", ".jpg", ".jpeg", ".bmp", ".webp", ".tif", ".tiff"}


def natural_key(path: Path):
    """自然排序：文件名中的数字按数值比较，保证 frame_2 在 frame_10 前。"""
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", path.name)]


def list_sequence(directory: str | Path) -> list[Path]:
    """列出目录下所有受支持的图片，按文件名自然排序。"""
    directory = Path(directory)
    files = [p for p in directory.iterdir() if p.is_file() and p.suffix.lower() in SUPPORTED_EXTS]
    return sorted(files, key=natural_key)


def load_images(paths: list[Path]) -> list[Image.Image]:
    images = []
    for p in paths:
        with Image.open(p) as im:
            images.append(im.copy())
    return images


@dataclass
class ConsistencyReport:
    total: int = 0
    sizes: dict[tuple[int, int], list[str]] = field(default_factory=dict)
    alpha_frames: list[str] = field(default_factory=list)      # 含透明通道的帧
    non_alpha_frames: list[str] = field(default_factory=list)
    majority_size: tuple[int, int] | None = None
    size_mismatches: list[str] = field(default_factory=list)   # 尺寸与多数不一致的帧
    unreadable: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.size_mismatches and not self.unreadable and not (
            self.alpha_frames and self.non_alpha_frames
        )


def check_consistency(paths: list[Path]) -> ConsistencyReport:
    """检查尺寸与透明度是否一致，不加载完整像素，速度快。"""
    report = ConsistencyReport(total=len(paths))
    for p in paths:
        try:
            with Image.open(p) as im:
                size = im.size
                has_alpha = im.mode in ("RGBA", "LA", "PA") or (
                    im.mode == "P" and "transparency" in im.info
                )
        except Exception:
            report.unreadable.append(p.name)
            continue
        report.sizes.setdefault(size, []).append(p.name)
        (report.alpha_frames if has_alpha else report.non_alpha_frames).append(p.name)
    if report.sizes:
        report.majority_size = max(report.sizes, key=lambda s: len(report.sizes[s]))
        for size, names in report.sizes.items():
            if size != report.majority_size:
                report.size_mismatches.extend(names)
    return report


def format_report(report: ConsistencyReport) -> str:
    lines = [f"共 {report.total} 帧"]
    if report.unreadable:
        lines.append(f"\n无法读取 {len(report.unreadable)} 个文件：")
        lines += [f"  {n}" for n in report.unreadable]
    lines.append(f"\n尺寸分布（{len(report.sizes)} 种）：")
    for size, names in sorted(report.sizes.items(), key=lambda kv: -len(kv[1])):
        marker = "（多数）" if size == report.majority_size else ""
        lines.append(f"  {size[0]}x{size[1]}: {len(names)} 帧{marker}")
    if report.size_mismatches:
        lines.append("\n尺寸与多数不一致的帧：")
        lines += [f"  {n}" for n in report.size_mismatches]
    lines.append(f"\n含透明通道: {len(report.alpha_frames)} 帧；不含: {len(report.non_alpha_frames)} 帧")
    if report.alpha_frames and report.non_alpha_frames:
        lines.append("透明度不一致的帧（含透明通道）：")
        lines += [f"  {n}" for n in report.alpha_frames]
    if report.ok:
        lines.append("\n检查通过：尺寸与透明度一致。")
    else:
        lines.append("\n存在不一致项，建议处理前先修正。")
    return "\n".join(lines)
