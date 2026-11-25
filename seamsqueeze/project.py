"""项目文件：让一次缩减可以从源图完整复现，且永不覆盖源图。

项目 JSON 只保存「源图路径 + 源图 SHA-256 + 蒙版 + 每一步方向」，
不内嵌任何结果像素。回放时重新打开源图、核对哈希、按相同顺序抽缝；
算法为确定性动态规划，同一份输入得到逐像素一致的结果。
"""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass

import numpy as np
from PIL import Image

from .engine import (
    HORIZONTAL,
    VERTICAL,
    SeamEngine,
    StepRecord,
)
from .masks import MaskSet

SCHEMA_VERSION = 1


class ProjectError(RuntimeError):
    pass


def sha256_file(path: str, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(chunk), b""):
            h.update(block)
    return h.hexdigest()


def load_rgb(path: str) -> np.ndarray:
    return np.asarray(Image.open(path).convert("RGB"))


@dataclass
class Project:
    source_path: str
    source_size: tuple[int, int]          # (w, h)
    source_sha256: str
    masks: MaskSet
    directions: list[str]
    target_size: tuple[int, int]
    order: str
    schema_version: int = SCHEMA_VERSION

    def to_dict(self) -> dict:
        return {
            "schema_version": self.schema_version,
            "source_path": os.path.abspath(self.source_path),
            "source_size": list(self.source_size),
            "source_sha256": self.source_sha256,
            "masks": self.masks.to_dict(),
            "directions": list(self.directions),
            "target_size": list(self.target_size),
            "order": self.order,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "Project":
        if int(d.get("schema_version", 0)) != SCHEMA_VERSION:
            raise ProjectError(
                f"项目 schema 版本 {d.get('schema_version')} 与当前 "
                f"{SCHEMA_VERSION} 不兼容"
            )
        return cls(
            source_path=d["source_path"],
            source_size=tuple(d["source_size"]),
            source_sha256=d["source_sha256"],
            masks=MaskSet.from_dict(d["masks"]),
            directions=list(d["directions"]),
            target_size=tuple(d["target_size"]),
            order=d.get("order", "alternate"),
        )

    # ------------------------------------------------------------------
    def save(self, project_path: str) -> None:
        os.makedirs(os.path.dirname(os.path.abspath(project_path)) or ".",
                    exist_ok=True)
        with open(project_path, "w", encoding="utf-8") as f:
            json.dump(self.to_dict(), f, ensure_ascii=False, indent=2)

    @classmethod
    def load(cls, project_path: str) -> "Project":
        with open(project_path, "r", encoding="utf-8") as f:
            return cls.from_dict(json.load(f))

    # ------------------------------------------------------------------
    def replay(self, source_root: str | None = None) -> tuple[SeamEngine, np.ndarray]:
        """从源图复现，返回（引擎, 结果图）。源图哈希不一致直接报错。"""
        src_path = self._resolve_source(source_root)
        actual_hash = sha256_file(src_path)
        if actual_hash != self.source_sha256:
            raise ProjectError(
                f"源图哈希不一致，拒绝复现：\n  项目记录 {self.source_sha256}\n"
                f"  当前文件 {actual_hash}\n请确认源图未被修改"
            )
        image = load_rgb(src_path)
        h, w = image.shape[:2]
        if (w, h) != tuple(self.source_size):
            raise ProjectError(
                f"源图尺寸 {w}x{h} 与项目记录 {self.source_size} 不符"
            )
        engine = SeamEngine(image, self.masks)
        engine.apply_directions(self.directions)
        if engine.size != tuple(self.target_size):
            raise ProjectError(
                f"回放结果尺寸 {engine.size} 与项目记录 {self.target_size} 不符"
            )
        return engine, engine.image

    def _resolve_source(self, source_root: str | None) -> str:
        if os.path.exists(self.source_path):
            return self.source_path
        if source_root:
            alt = os.path.join(source_root, os.path.basename(self.source_path))
            if os.path.exists(alt):
                return alt
        raise ProjectError(f"找不到源图：{self.source_path}")


# ----------------------------------------------------------------------
# 构建与导出
# ----------------------------------------------------------------------
def build_project(
    source_path: str,
    masks: MaskSet,
    engine: SeamEngine,
    order: str,
) -> Project:
    return Project(
        source_path=os.path.abspath(source_path),
        source_size=engine.source_size,
        source_sha256=sha256_file(source_path),
        masks=masks,
        directions=[s.direction for s in engine.steps],
        target_size=engine.size,
        order=order,
    )


def write_report(
    report_path: str,
    project: Project,
    engine: SeamEngine,
) -> None:
    """导出被缩减位置的文字说明（Markdown）。"""
    steps = engine.steps
    n_v = sum(1 for s in steps if s.direction == VERTICAL)
    n_h = sum(1 for s in steps if s.direction == HORIZONTAL)
    removed = engine.removed_source_pixels()
    cols = sorted({x for _, x in removed})
    rows = sorted({y for y, _ in removed})

    lines = [
        "# SeamSqueeze 缩减位置说明",
        "",
        f"- 源图：`{project.source_path}`（SHA-256 `{project.source_sha256[:12]}…`）",
        f"- 源尺寸：{project.source_size[0]}x{project.source_size[1]}",
        f"- 目标尺寸：{project.target_size[0]}x{project.target_size[1]}",
        f"- 抽缝顺序策略：{project.order}",
        f"- 总步数：{len(steps)}（竖直缝 {n_v} 条 / 水平缝 {n_h} 条）",
        f"- 被抽走的源像素数：{len(removed)}",
        f"- 涉及源列（x）：{_fmt_runs(cols)}",
        f"- 涉及源行（y）：{_fmt_runs(rows)}",
        "",
        "## 逐步记录",
        "",
        "| # | 方向 | 抽缝前帧尺寸 | 路径代价 | 是否触碰保护 |",
        "|---|------|--------------|----------|--------------|",
    ]
    for i, rec in enumerate(steps, start=1):
        frame_w, frame_h = _frame_size_before(engine, rec)
        lines.append(
            f"| {i} | {'竖直(宽-1)' if rec.direction == VERTICAL else '水平(高-1)'} "
            f"| {frame_w}x{frame_h} | {rec.cost:,.0f} "
            f"| {'是（异常）' if rec.hits_protection else '否'} |"
        )
    lines += [
        "",
        "## 保护区域（源图坐标，闭区间）",
        "",
    ]
    for r in project.masks.protect:
        lines.append(
            f"- {r.name or '保护区'}: x[{r.x0},{r.x1}] y[{r.y0},{r.y1}] "
            f"= {r.width}x{r.height}px"
        )
    if not project.masks.protect:
        lines.append("- （无）")
    lines += ["", "## 优先缩减留白（源图坐标，闭区间）", ""]
    for r in project.masks.shrink:
        lines.append(
            f"- {r.name or '留白'}: x[{r.x0},{r.x1}] y[{r.y0},{r.y1}]"
        )
    if not project.masks.shrink:
        lines.append("- （无）")
    lines.append("")

    os.makedirs(os.path.dirname(os.path.abspath(report_path)) or ".",
                exist_ok=True)
    with open(report_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))


def _fmt_runs(values: list[int]) -> str:
    """[1,2,3,7,8] -> '1-3, 7-8'；空列表 -> '无'。"""
    if not values:
        return "无"
    runs: list[str] = []
    start = prev = values[0]
    for v in values[1:]:
        if v == prev + 1:
            prev = v
            continue
        runs.append(str(start) if start == prev else f"{start}-{prev}")
        start = prev = v
    runs.append(str(start) if start == prev else f"{start}-{prev}")
    return ", ".join(runs)


def _frame_size_before(engine: SeamEngine, rec: StepRecord) -> tuple[int, int]:
    """根据步骤序号反推抽缝前帧尺寸。"""
    sw, sh = engine.source_size
    prior = rec.index  # 该步之前已抽的缝数
    prior_v = sum(
        1 for s in engine.steps[:prior] if s.direction == VERTICAL
    )
    prior_h = prior - prior_v
    return sw - prior_v, sh - prior_h
