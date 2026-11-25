from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


TAG_VALUE_RE = re.compile(r'([A-Za-z0-9_-]+)=(?:"([^"]*)"|([^,]+))')


@dataclass
class SegmentRef:
    uri: str
    duration: float = 0.0
    title: str = ""
    sequence: int | None = None
    epoch_id: str | None = None
    epoch_index: int | None = None
    program_date_time: str | None = None
    sha256: str | None = None
    discontinuity: bool = False
    writing_complete: bool | None = None
    exposed_bytes: int | None = None
    raw_tags: dict[str, str] = field(default_factory=dict)

    def resolved_path(self, playlist_path: Path | str) -> Path:
        playlist_path = Path(playlist_path)
        return (playlist_path.parent / self.uri).resolve()


@dataclass
class Playlist:
    path: Path
    media_sequence: int = 0
    target_duration: int = 2
    epoch_id: str | None = None
    epoch_index: int | None = None
    epoch_reason: str | None = None
    ended: bool = False
    segments: list[SegmentRef] = field(default_factory=list)


def parse_tag_attributes(payload: str) -> dict[str, str]:
    attrs: dict[str, str] = {}
    for match in TAG_VALUE_RE.finditer(payload):
        key = match.group(1)
        attrs[key] = match.group(2) if match.group(2) is not None else match.group(3)
    return attrs


def parse_playlist(path: Path | str) -> Playlist:
    """解析实验用到的 m3u8 标签。

    除标准 #EXTINF / #EXT-X-MEDIA-SEQUENCE / #EXT-X-PROGRAM-DATE-TIME 外，
    剧本还写 #EXT-X-EPOCH、#EXT-X-SEQUENCE、#EXT-X-SHA256，用来明确表达
    “序号归零但属于另一轮内容”和最终完整性校验值。
    """
    path = Path(path)
    text = path.read_text(encoding="utf-8")
    playlist = Playlist(path=path)

    pending_duration = 0.0
    pending_title = ""
    pending_sequence: int | None = None
    pending_sha: str | None = None
    pending_pdt: str | None = None
    pending_discontinuity = False
    pending_writing_complete: bool | None = None
    pending_exposed_bytes: int | None = None
    pending_tags: dict[str, str] = {}

    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue

        if line.startswith("#EXT-X-MEDIA-SEQUENCE:"):
            try:
                playlist.media_sequence = int(line.split(":", 1)[1])
            except ValueError:
                pass
        elif line.startswith("#EXT-X-TARGETDURATION:"):
            try:
                playlist.target_duration = int(line.split(":", 1)[1])
            except ValueError:
                pass
        elif line.startswith("#EXT-X-ENDLIST"):
            playlist.ended = True
        elif line == "#EXT-X-DISCONTINUITY":
            pending_discontinuity = True
        elif line.startswith("#EXT-X-EPOCH:"):
            attrs = parse_tag_attributes(line.split(":", 1)[1])
            playlist.epoch_id = attrs.get("id", playlist.epoch_id)
            if "index" in attrs:
                try:
                    playlist.epoch_index = int(attrs["index"])
                except ValueError:
                    playlist.epoch_index = None
            playlist.epoch_reason = attrs.get("reason", playlist.epoch_reason)
        elif line.startswith("#EXT-X-SEQUENCE:"):
            try:
                pending_sequence = int(line.split(":", 1)[1].strip())
            except ValueError:
                pending_sequence = None
        elif line.startswith("#EXT-X-SHA256:"):
            pending_sha = line.split(":", 1)[1].strip()
        elif line.startswith("#EXT-X-PROGRAM-DATE-TIME:"):
            pending_pdt = line.split(":", 1)[1].strip()
        elif line.startswith("#EXT-X-WRITING:"):
            attrs = parse_tag_attributes(line.split(":", 1)[1])
            complete = attrs.get("complete")
            if complete is not None:
                pending_writing_complete = complete.lower() in ("1", "yes", "true")
            if "exposed-bytes" in attrs:
                try:
                    pending_exposed_bytes = int(attrs["exposed-bytes"])
                except ValueError:
                    pending_exposed_bytes = None
            pending_tags.update(attrs)
        elif line.startswith("#EXTINF:"):
            payload = line[len("#EXTINF:") :]
            duration_text, _, title = payload.partition(",")
            try:
                pending_duration = float(duration_text)
            except ValueError:
                pending_duration = 0.0
            pending_title = title.strip()
        elif line.startswith("#"):
            # 其他标准/未知标签对本实验无影响，忽略即可。
            continue
        else:
            epoch_id = playlist.epoch_id
            epoch_index = playlist.epoch_index
            segment = SegmentRef(
                uri=line,
                duration=pending_duration,
                title=pending_title,
                sequence=pending_sequence,
                epoch_id=epoch_id,
                epoch_index=epoch_index,
                program_date_time=pending_pdt,
                sha256=pending_sha,
                discontinuity=pending_discontinuity,
                writing_complete=pending_writing_complete,
                exposed_bytes=pending_exposed_bytes,
                raw_tags=dict(pending_tags),
            )
            playlist.segments.append(segment)

            pending_duration = 0.0
            pending_title = ""
            pending_sequence = None
            pending_sha = None
            pending_pdt = None
            pending_discontinuity = False
            pending_writing_complete = None
            pending_exposed_bytes = None
            pending_tags = {}

    return playlist


def extinf_duration_sum(lines_or_path: Path | str | list[str]) -> float:
    if isinstance(lines_or_path, (Path, str)):
        text = Path(lines_or_path).read_text(encoding="utf-8")
        lines = text.splitlines()
    else:
        lines = list(lines_or_path)
    total = 0.0
    for line in lines:
        line = line.strip()
        if line.startswith("#EXTINF:"):
            try:
                total += float(line.split(":", 1)[1].split(",", 1)[0])
            except ValueError:
                pass
    return total
