"""坏列表保存与跨批次应用。

坏列表 JSON (格式 badcol-badlist-v1):
{
  "format": "badcol-badlist-v1",
  "height": H, "width": W, "n_frames": N,
  "persistent":  [固定坏列...],
  "intermittent": [{"col": c, "frames": [帧号...]}, ...],
  "protected":   [保护列...],
  "notes": "..."
}
跨批次应用时严格校验高宽; 帧数不一致只警告(帧号映射不上的偶发列跳过),
高宽不一致直接拒绝, 绝不乱补。
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np

FORMAT = "badcol-badlist-v1"


class BadListError(ValueError):
    """坏列表格式或尺寸校验失败。"""


@dataclass
class BadList:
    height: int
    width: int
    n_frames: int
    persistent: list[int]
    intermittent: list[dict]          # [{"col": int, "frames": [int]}]
    protected: list[int]

    def all_cols(self) -> list[int]:
        return sorted(set(self.persistent) | {d["col"] for d in self.intermittent})

    def to_dict(self, notes: str = "") -> dict:
        return {
            "format": FORMAT,
            "height": int(self.height),
            "width": int(self.width),
            "n_frames": int(self.n_frames),
            "persistent": [int(c) for c in self.persistent],
            "intermittent": [
                {"col": int(d["col"]), "frames": [int(x) for x in d["frames"]]}
                for d in self.intermittent
            ],
            "protected": [int(c) for c in self.protected],
            "notes": notes,
        }

    # ---- 构造与序列化 ----
    @classmethod
    def from_selection(
        cls,
        selection_map: dict[int, list[int] | None],
        protected: list[int] | set[int],
        height: int,
        width: int,
        n_frames: int,
    ) -> "BadList":
        persistent, intermittent = [], []
        for col, frames in sorted(selection_map.items()):
            if frames is None:
                persistent.append(int(col))
            else:
                intermittent.append({"col": int(col), "frames": [int(f) for f in frames]})
        return cls(
            height=int(height),
            width=int(width),
            n_frames=int(n_frames),
            persistent=persistent,
            intermittent=intermittent,
            protected=sorted(int(c) for c in protected),
        )

    def save(self, path: str | Path, notes: str = "") -> None:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("w", encoding="utf-8") as fh:
            json.dump(self.to_dict(notes), fh, ensure_ascii=False, indent=2)

    @classmethod
    def load(cls, path: str | Path) -> "BadList":
        path = Path(path)
        with path.open("r", encoding="utf-8") as fh:
            data = json.load(fh)
        if data.get("format") != FORMAT:
            raise BadListError(
                f"{path} 格式标识为 {data.get('format')!r}, 期望 {FORMAT!r}"
            )
        try:
            bl = cls(
                height=int(data["height"]),
                width=int(data["width"]),
                n_frames=int(data["n_frames"]),
                persistent=[int(c) for c in data["persistent"]],
                intermittent=[
                    {"col": int(d["col"]), "frames": [int(x) for x in d["frames"]]}
                    for d in data["intermittent"]
                ],
                protected=[int(c) for c in data.get("protected", [])],
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise BadListError(f"{path} 坏列表字段损坏: {exc}") from exc
        bl._validate_cols(path)
        return bl

    def _validate_cols(self, path: str | Path = "<memory>") -> None:
        for c in self.all_cols() + list(self.protected):
            if not 0 <= c < self.width:
                raise BadListError(f"{path} 含越界列号 {c}(宽度 {self.width})")
        for d in self.intermittent:
            bad = [f for f in d["frames"] if not 0 <= f < self.n_frames]
            if bad:
                raise BadListError(
                    f"{path} 列 {d['col']} 含越界帧号 {bad}(帧数 {self.n_frames})"
                )

    # ---- 跨批次应用 ----
    def check_shape(self, frames: np.ndarray, strict: bool = True) -> None:
        """高宽不符始终报错; strict=True 时帧数不一致也报错, 否则只由 apply 给警告。"""
        if frames.ndim not in (3, 4):
            raise BadListError(f"批次维度应为 3D/4D, 实际 {frames.ndim}D")
        n, h, w = frames.shape[:3]
        if (h, w) != (self.height, self.width):
            raise BadListError(
                f"尺寸不符, 拒绝应用: 坏列表基于 {self.height}x{self.width}, "
                f"当前批次为 {h}x{w}。请重新检测或使用同规格批次。"
            )
        if strict and n != self.n_frames:
            raise BadListError(
                f"帧数不符: 坏列表记录 {self.n_frames} 帧, 当前批次 {n} 帧; "
                f"固定坏列仍可应用, 偶发列帧号可能错位, 请用 apply_to_batch(strict=False)"
            )

    def apply_to_batch(
        self, frames: np.ndarray, strict: bool = True
    ) -> tuple[list[list[int]], list[str]]:
        """返回每帧应修补的列与警告信息; 不修改图像本身。"""
        self.check_shape(frames, strict=strict)
        n = frames.shape[0]
        warnings: list[str] = []
        per_frame: list[list[int]] = [[] for _ in range(n)]
        for f in range(n):
            per_frame[f].extend(self.persistent)
        for d in self.intermittent:
            valid = [f for f in d["frames"] if f < n]
            skipped = [f for f in d["frames"] if f >= n]
            if skipped:
                warnings.append(
                    f"列 {d['col']} 的帧号 {skipped} 超出当前批次(共 {n} 帧), 已跳过"
                )
            for f in valid:
                per_frame[f].append(d["col"])
        if not strict and n != self.n_frames:
            warnings.append(
                f"帧数不同({self.n_frames} -> {n}), 偶发列按原帧号映射, 请人工复核"
            )
        per_frame = [sorted(set(cols) - set(self.protected)) for cols in per_frame]
        return per_frame, warnings
