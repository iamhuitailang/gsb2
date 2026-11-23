"""重新打开工作区时的实读核验。

不相信 manifest 里生成时记下的时间，而是对每个分段文件重新 ffprobe、
重抽首帧哈希，并检查：
1. 索引写了但文件打不开 / 不存在；
2. 实测时长与索引时长的漂移（超出帧时长即异常）；
3. 首帧像素哈希变化（文件被换过 / 开头被改动）；
4. 档内分段首尾衔接是否连续；
5. 连续音轨是否仍可读。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from .ffmpeg_utils import FFprobeError, ffprobe_json, first_frame_hash, probe


def _probe_audio_duration(path: Path) -> float:
    """纯音频文件不能用 probe()（它要求视频流），单独读音频时长。"""
    data = ffprobe_json(path)
    audio = next((s for s in data.get("streams", []) if s.get("codec_type") == "audio"), None)
    if audio is None:
        raise FFprobeError(f"{path} 中没有音频流")
    return float(data.get("format", {}).get("duration") or audio.get("duration") or 0.0)


@dataclass
class SegmentCheck:
    tier: str
    seq: int
    file: str
    status: str  # ok | missing | unreadable | duration_drift | first_frame_changed | gap
    detail: str
    indexed_duration: float
    actual_duration: float | None = None
    indexed_frame_label: str = ""
    duration_delta: float | None = None


@dataclass
class VerifyReport:
    workspace: str
    checks: list[SegmentCheck] = field(default_factory=list)
    audio_status: str = "absent"
    audio_detail: str = ""

    @property
    def has_errors(self) -> bool:
        # 音轨 absent 表示源片本来就没有音频，不是错误；只有 error 才算
        return any(c.status != "ok" for c in self.checks) or self.audio_status == "error"

    def to_dict(self) -> dict:
        return {
            "workspace": self.workspace,
            "has_errors": self.has_errors,
            "audio_status": self.audio_status,
            "audio_detail": self.audio_detail,
            "checks": [c.__dict__ for c in self.checks],
        }

    def summary(self) -> dict[str, int]:
        out: dict[str, int] = {}
        for c in self.checks:
            out[c.status] = out.get(c.status, 0) + 1
        return out


def verify_workspace(workspace: str | Path, manifest: dict) -> VerifyReport:
    root = Path(workspace)
    report = VerifyReport(workspace=str(root))
    frame_tol = 1.5 / float(manifest.get("source_fps", 30))

    for tier in manifest.get("tiers", []):
        prev_end: float | None = None
        for seg in tier.get("segments", []):
            rel = seg["file"]
            path = root / rel
            check = SegmentCheck(
                tier=tier["name"],
                seq=seg["seq"],
                file=rel,
                status="ok",
                detail="",
                indexed_duration=seg["actual_duration"],
                indexed_frame_label=seg.get("frame_label", ""),
            )
            if not path.is_file():
                check.status = "missing"
                check.detail = "索引引用的文件不存在"
                report.checks.append(check)
                prev_end = None
                continue
            try:
                info = probe(path)
            except FFprobeError as exc:
                check.status = "unreadable"
                check.detail = f"ffprobe 无法打开: {exc}"
                report.checks.append(check)
                prev_end = None
                continue

            check.actual_duration = info.duration
            delta = info.duration - float(seg["actual_duration"])
            check.duration_delta = delta
            if abs(delta) > frame_tol:
                check.status = "duration_drift"
                check.detail = (
                    f"实测 {info.duration:.3f}s 与索引 {seg['actual_duration']:.3f}s "
                    f"相差 {delta:+.3f}s（超过一帧 {frame_tol:.3f}s）"
                )

            # 首帧像素哈希：同档同文件，开头被换过立刻能发现
            if seg.get("first_frame_hash"):
                try:
                    actual_hash = first_frame_hash(path)
                    if actual_hash != seg["first_frame_hash"]:
                        check.status = "first_frame_changed"
                        check.detail = "首帧像素哈希与索引不一致，文件开头已被替换或改动"
                except FFprobeError as exc:
                    check.status = "unreadable"
                    check.detail = f"首帧解码失败: {exc}"

            # 档内衔接：上一段的源终点应等于本段源起点
            if prev_end is not None and abs(seg["source_start"] - prev_end) > frame_tol:
                check.status = "gap" if check.status == "ok" else check.status
                check.detail = (
                    f"档内衔接断裂：上段源终点 {prev_end:.3f}s，"
                    f"本段源起点 {seg['source_start']:.3f}s"
                )
            prev_end = seg["source_end"]
            report.checks.append(check)

    audio_rel = manifest.get("audio_track")
    if audio_rel:
        audio_path = root / audio_rel
        if not audio_path.is_file():
            report.audio_status = "error"
            report.audio_detail = "连续音轨文件缺失"
        else:
            try:
                duration = _probe_audio_duration(audio_path)
                report.audio_status = "ok"
                report.audio_detail = f"连续音轨 {duration:.3f}s"
            except FFprobeError as exc:
                report.audio_status = "error"
                report.audio_detail = str(exc)
    return report
