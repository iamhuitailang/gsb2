"""本地带编号源短片的发现与统一时间线。

编号规则：文件名按自然序（human sort）排列，例如 clip1.mp4, clip2.mp4, clip10.mp4
会排成 clip1, clip2, clip10 而不是字典序的 clip1, clip10, clip2。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

from .ffmpeg_utils import MediaInfo, probe

VIDEO_EXTS = {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"}


def natural_key(name: str) -> list[object]:
    """自然序排序键：数字段按整数比，其余按小写文本比。"""
    return [int(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", name)]


@dataclass
class SourceClip:
    index: int  # 0 基序号
    path: Path
    info: MediaInfo
    offset: float  # 在全局源时间线上的起点（秒）

    @property
    def end(self) -> float:
        return self.offset + self.info.duration

    @property
    def frame_count(self) -> int:
        return self.info.estimated_frames


@dataclass
class Timeline:
    clips: list[SourceClip] = field(default_factory=list)

    @property
    def duration(self) -> float:
        return self.clips[-1].end if self.clips else 0.0

    @property
    def fps(self) -> float:
        return self.clips[0].info.fps if self.clips else 0.0

    def locate(self, t: float) -> tuple[int, int, float]:
        """把全局源时间 t 定位到 (源片序号, 源片内帧号, 该帧在源片内的时间)。

        超出末尾时夹取到最后一帧。所有“实际首帧 / 画面编号”的换算都走这里，
        保证两档之间用的是同一套源帧坐标。
        """
        if not self.clips:
            raise ValueError("时间线为空")
        t = max(0.0, min(t, max(0.0, self.duration - 1e-9)))
        for clip in self.clips:
            if t < clip.end or clip is self.clips[-1]:
                local = t - clip.offset
                frame = int(round(local * clip.info.fps))
                frame = min(frame, max(0, clip.frame_count - 1))
                return clip.index, frame, frame / clip.info.fps
        raise AssertionError("locate 未命中任何源片")  # pragma: no cover

    def frame_label(self, t: float) -> str:
        """形如 'src2/f045' 的画面编号，跨档对齐比对用的就是它。"""
        clip_idx, frame_no, _ = self.locate(t)
        return f"src{clip_idx + 1}/f{frame_no:03d}"

    def global_frame_index(self, t: float) -> int:
        """全局帧号（跨源片连续计数），供 markers 与播放器核对。"""
        total = 0
        clip_idx, frame_no, _ = self.locate(t)
        for clip in self.clips[:clip_idx]:
            total += clip.frame_count
        return total + frame_no


def discover_sources(src_dir: str | Path) -> list[Path]:
    """枚举目录里的视频文件并按自然序返回；空目录报错而不是静默继续。"""
    root = Path(src_dir)
    if not root.is_dir():
        raise FileNotFoundError(f"源目录不存在: {root}")
    files = [p for p in sorted(root.iterdir(), key=lambda p: natural_key(p.name))
             if p.is_file() and p.suffix.lower() in VIDEO_EXTS]
    if not files:
        raise FileNotFoundError(f"{root} 下没有可识别的视频文件 {sorted(VIDEO_EXTS)}")
    return files


def build_timeline(src_dir: str | Path) -> Timeline:
    """实读每个源片并拼出全局时间线。"""
    clips: list[SourceClip] = []
    offset = 0.0
    for i, path in enumerate(discover_sources(src_dir)):
        info = probe(path)
        clips.append(SourceClip(index=i, path=path, info=info, offset=offset))
        offset += info.duration
    if clips and len({round(c.info.fps, 3) for c in clips}) > 1:
        rates = ", ".join(f"{c.path.name}={c.info.fps}" for c in clips)
        raise ValueError(f"源片帧率不一致，无法建立统一时间线: {rates}")
    return Timeline(clips=clips)
