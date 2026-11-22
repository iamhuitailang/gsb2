"""读取视频的存储宽高、显示宽高、SAR、显示矩阵(旋转/翻转)与时长。

只依赖 ffprobe 的 JSON 输出, 不做任何解码。
"""

from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass, field
from fractions import Fraction

from .geometry import DisplayTransform, build_display_transform


class ProbeError(RuntimeError):
    pass


def _ffprobe() -> str:
    exe = shutil.which("ffprobe")
    if not exe:
        raise ProbeError("未找到 ffprobe, 请先安装 ffmpeg 并加入 PATH")
    return exe


@dataclass
class VideoInfo:
    path: str
    codec: str
    stored_width: int
    stored_height: int
    sar: Fraction
    dar: Fraction
    rotation_ccw: float | None          # ffprobe 原始逆时针角度
    matrix3x3: tuple[float, ...] | None
    display: DisplayTransform
    duration_sec: float
    nb_frames: int | None
    frame_rate: Fraction
    has_audio: bool
    audio_duration_sec: float | None
    ambiguous: bool
    ambiguity_reasons: list[str] = field(default_factory=list)

    @property
    def display_width(self) -> int:
        return self.display.dw

    @property
    def display_height(self) -> int:
        return self.display.dh

    def summary(self) -> str:
        d = self.display
        lines = [
            f"文件: {self.path}",
            f"编码: {self.codec}  帧率: {float(self.frame_rate):.3f} fps  "
            f"时长: {self.duration_sec:.3f}s"
            + (f"  帧数: {self.nb_frames}" if self.nb_frames is not None else ""),
            f"存储帧: {self.stored_width}x{self.stored_height}  "
            f"SAR={_frac_str(self.sar)}  DAR={_frac_str(self.dar)}",
            f"显示帧: {self.display_width}x{self.display_height} (方形像素)  "
            f"旋转: 顺时针 {d.cw_deg}°"
            + (" + 水平镜像" if d.flip else "")
            + (f"  [ffprobe 原始逆时针 {self.rotation_ccw:g}°]"
               if self.rotation_ccw else ""),
            f"非方形像素: {'是' if self.sar != 1 else '否'}",
        ]
        if self.ambiguous:
            lines.append("⚠ 方向无法确定, 需要用户确认:")
            for r in self.ambiguity_reasons:
                lines.append(f"   - {r}")
        return "\n".join(lines)


def _frac_str(f: Fraction) -> str:
    return f"{f.numerator}:{f.denominator}"


def _parse_fraction(text: str | None, default: Fraction) -> Fraction:
    if not text or text in ("0:0", "N/A"):
        return default
    if ":" in text:
        n, d = text.split(":", 1)
        d = d or "1"
        return Fraction(int(n), int(d))
    if "/" in text:
        n, d = text.split("/", 1)
        return Fraction(int(n), int(d))
    return Fraction(text)


def probe(path: str) -> VideoInfo:
    """同步运行 ffprobe 并解析为 VideoInfo。"""
    cmd = [
        _ffprobe(), "-v", "error",
        "-show_format", "-show_streams",
        "-select_streams", "v:0",
        "-of", "json", path,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise ProbeError(f"ffprobe 失败: {proc.stderr.strip()}")
    data = json.loads(proc.stdout)
    streams = data.get("streams", [])
    if not streams:
        raise ProbeError(f"{path} 中没有视频流")
    st = streams[0]

    sw = int(st["width"])
    sh = int(st["height"])
    sar = _parse_fraction(st.get("sample_aspect_ratio"), Fraction(1))
    dar = _parse_fraction(st.get("display_aspect_ratio"), Fraction(sw) * sar / sh)

    rotation, matrix = _extract_rotation(st)
    dt = build_display_transform(sw, sh, sar, rotation, matrix)

    # 完整流信息再探一次音频 (上面 select_streams 只选了视频)
    has_audio, audio_dur = _probe_audio(path)

    fr = _parse_fraction(st.get("r_frame_rate"), Fraction(25, 1))
    dur = _parse_duration(st, data.get("format", {}))
    nb = st.get("nb_frames")
    nb_frames = int(nb) if nb and nb != "N/A" else None

    ambiguous, reasons = _assess_ambiguity(st, dt, rotation, matrix)

    return VideoInfo(
        path=path,
        codec=st.get("codec_name", "?"),
        stored_width=sw, stored_height=sh,
        sar=sar, dar=dar,
        rotation_ccw=rotation, matrix3x3=matrix,
        display=dt,
        duration_sec=dur,
        nb_frames=nb_frames,
        frame_rate=fr,
        has_audio=has_audio,
        audio_duration_sec=audio_dur,
        ambiguous=ambiguous,
        ambiguity_reasons=reasons,
    )


def _extract_rotation(st: dict) -> tuple[float | None, tuple[float, ...] | None]:
    """从 side_data_list 提取 Display Matrix 的 rotation 与 3x3 矩阵。"""
    rotation: float | None = None
    matrix: tuple[float, ...] | None = None
    for sd in st.get("side_data_list", []) or []:
        if sd.get("side_data_type") in ("Display Matrix", "Display Matrix Side Data"):
            if "rotation" in sd:
                rotation = float(sd["rotation"])
            dm = sd.get("displaymatrix")
            if dm:
                matrix = _parse_display_matrix(dm)
    # 某些容器把 rotation 放在 stream tags (旧版 rotate 元数据)
    tags = st.get("tags", {}) or {}
    if rotation is None and "rotate" in tags:
        try:
            rotation = float(tags["rotate"])
        except ValueError:
            pass
    return rotation, matrix


def _parse_display_matrix(text: str) -> tuple[float, ...] | None:
    """解析 ffprobe 的 displaymatrix 十六进制转储为 9 个 float。"""
    nums: list[float] = []
    for line in text.splitlines():
        line = line.strip()
        if not line or ":" not in line:
            continue
        _, _, rest = line.partition(":")
        for tok in rest.split():
            try:
                nums.append(int(tok, 16) / 65536.0)
            except ValueError:
                continue
    if len(nums) >= 9:
        return tuple(nums[:9])
    return None


def _probe_audio(path: str) -> tuple[bool, float | None]:
    cmd = [_ffprobe(), "-v", "error", "-select_streams", "a:0",
           "-show_entries", "stream=duration", "-of", "json", path]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        return False, None
    try:
        streams = json.loads(proc.stdout).get("streams", [])
    except json.JSONDecodeError:
        return False, None
    if not streams:
        return False, None
    dur = streams[0].get("duration")
    return True, float(dur) if dur and dur != "N/A" else None


def _parse_duration(st: dict, fmt: dict) -> float:
    for src in (st.get("duration"), fmt.get("duration")):
        if src and src != "N/A":
            try:
                return float(src)
            except ValueError:
                continue
    return 0.0


def _assess_ambiguity(
    st: dict, dt: DisplayTransform,
    rotation: float | None, matrix: tuple[float, ...] | None,
) -> tuple[bool, list[str]]:
    """判断旋转信息是否无法确定, 需要用户确认。

    只有"方向本身不可信"才标记为歧义 (任意角、矩阵损坏);
    SAR/旋转并存属于可正常处理的组合, 仅在几何模块的 notes 中提示。
    """
    reasons = list(dt.notes)

    # 1) 任意角度 (非 90 倍数) —— geometry 已记录时不重复添加
    if rotation is not None and abs(rotation) > 1e-6:
        mod = abs(rotation) % 90
        if mod > 1e-3 and abs(mod - 90) > 1e-3:
            msg = f"旋转角 {rotation:g}° 不是 90° 的整数倍"
            if not any(msg in r for r in reasons):
                reasons.append(msg)

    # 2) 有矩阵但左上 2x2 全 0 / 损坏
    if matrix is not None and all(abs(v) < 1e-9 for v in matrix[:4]):
        reasons.append("显示矩阵存在但左上 2x2 全为 0, 矩阵可能损坏")

    # 去重并保持顺序
    seen: set[str] = set()
    uniq = [r for r in reasons if not (r in seen or seen.add(r))]
    return (len(uniq) > 0), uniq
