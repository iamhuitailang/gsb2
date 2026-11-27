"""帧率转换与时间映射核心计算（纯 Python 标准库，无 ffmpeg 依赖）。

时间轴约定
----------
- 源素材时间轴 t_src：原始素材自身的播放时间，帧 i 位于 t = i / src_fps。
- 输出时间轴 t_out：成片时间轴，输出帧 n 位于 t = n / dst_fps。
- 播放速度 speed：t_src = t_out * speed。speed=2 表示 2 倍速，输出时长 = 源时长 / speed。

转换方式
--------
- nearest（重复/丢帧）：输出帧取时间上最近的源帧，帧率不足时重复、过高时丢弃。
- blend（混合）：输出帧由相邻两源帧按时间距离加权混合，运动平滑但有拖影。
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field, asdict
from fractions import Fraction
from typing import Sequence

METHODS = ("nearest", "blend")

# 判定“精确对齐”的时间容差（秒），仅用于 VFR 浮点时间戳场景
_EPS = 1e-6


@dataclass(frozen=True)
class FrameRow:
    """单行映射：第 out_index 个输出帧 ← 源素材的哪个/哪两个帧。"""

    out_index: int
    out_time: float          # 输出时间轴上的时间（秒）
    out_timecode: str        # 输出时间码 HH:MM:SS:FF（按输出帧率）
    src_time: float          # 对应到源素材时间轴的时间（秒）
    src_timecode: str        # 源时间码（按源帧率）
    src_index: int           # 主源帧序号（blend 时为较早的帧）
    src_index_2: int | None  # blend 时的第二个源帧
    blend_weight: float      # src_index_2 的权重，0~1；nearest 恒为 0
    kind: str                # exact | duplicate | drop | blend

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class MappingStats:
    src_fps: float
    dst_fps: float
    speed: float
    method: str
    src_frame_count: int
    out_frame_count: int
    src_duration: float
    out_duration: float
    exact_frames: int
    duplicate_frames: int          # 重复上一输出帧的行数（卡顿来源）
    max_duplicate_run: int         # 最长连续重复段
    drop_frames: int               # 输出侧跨帧跳跃的行数（该行处有源帧被丢弃）
    dropped_src_frames: list[int]  # 从未被引用的源帧序号
    blend_frames: int              # 混合帧行数
    ghost_frames: int              # 权重居中（拖影明显）的混合帧行数
    stutter_ratio: float           # 重复帧占比，越大越卡顿

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class MappingResult:
    rows: list[FrameRow]
    stats: MappingStats
    src_to_out: dict[int, list[int]] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "rows": [r.to_dict() for r in self.rows],
            "stats": self.stats.to_dict(),
            "src_to_out": {str(k): v for k, v in self.src_to_out.items()},
        }


def format_timecode(frame_index: int, fps: Fraction) -> str:
    """把帧序号格式化为 SMPTE 风格时间码 HH:MM:SS:FF（非丢帧计数）。"""

    fps = Fraction(fps)
    total = max(0, int(frame_index))
    # 29.97 等分数帧率向上取整作为时间码帧位（非丢帧计数）
    fps_i = fps.numerator // fps.denominator if fps.denominator == 1 else math.ceil(float(fps))
    ff = total % fps_i
    seconds = total // fps_i
    hh, rem = divmod(seconds, 3600)
    mm, ss = divmod(rem, 60)
    return f"{hh:02d}:{mm:02d}:{ss:02d}:{ff:02d}"


def _timecode_from_seconds(t: Fraction | float, fps: Fraction) -> str:
    fps_f = float(fps)
    frame = int(math.floor(float(t) * fps_f + 1e-9))
    return format_timecode(frame, fps)


def _as_fraction(value: float | int | Fraction) -> Fraction:
    if isinstance(value, Fraction):
        return value
    # 经 str 转换可避免 0.1 之类二进制浮点的长尾
    return Fraction(str(value))


def build_mapping(
    src_fps: float | Fraction,
    src_count: int,
    dst_fps: float | Fraction,
    speed: float | Fraction = 1.0,
    method: str = "nearest",
    src_times: Sequence[float] | None = None,
) -> MappingResult:
    """构建完整的输出帧→源帧映射表。

    参数
    ----
    src_fps / src_count : 源帧率与帧数（CFR）。
    dst_fps             : 输出帧率。
    speed               : 播放速度，>1 加速、<1 慢放。
    method              : nearest（重复/丢帧）或 blend（混合）。
    src_times           : 可选的每帧 PTS（秒），用于 VFR 素材；给出后 src_fps 仅用于时间码。
    """

    if method not in METHODS:
        raise ValueError(f"unknown method {method!r}, expected one of {METHODS}")
    if src_count <= 0:
        raise ValueError("src_count must be positive")
    if float(dst_fps) <= 0 or float(speed) <= 0:
        raise ValueError("dst_fps and speed must be positive")

    src_fps_f = _as_fraction(src_fps)
    dst_fps_f = _as_fraction(dst_fps)
    speed_f = _as_fraction(speed)

    if src_times is not None:
        if len(src_times) != src_count:
            raise ValueError("len(src_times) must equal src_count")
        uniform = False
        times = [float(t) for t in src_times]
        src_duration = times[-1] + 1.0 / float(src_fps_f)
    else:
        uniform = True
        # 均匀帧率下全部用 Fraction 精确推导
        src_duration = src_count / src_fps_f

    out_duration = src_duration / speed_f
    n_out = max(1, math.floor(float(dst_fps_f * out_duration)))

    rows: list[FrameRow] = []
    src_to_out: dict[int, list[int]] = {}
    used_src: set[int] = set()
    duplicate_count = 0
    max_run = run = 0
    drop_rows = 0
    exact_count = 0
    blend_count = 0
    ghost_count = 0
    prev_src: int | None = None

    for n in range(n_out):
        t_out = Fraction(n) / dst_fps_f
        t_src = t_out * speed_f

        if uniform:
            x = t_src * src_fps_f  # 源帧坐标（可为分数）
            if method == "nearest":
                idx = int(x + Fraction(1, 2))
                idx = min(max(idx, 0), src_count - 1)
                idx2, weight = None, 0.0
            else:
                i0 = min(int(x), src_count - 1)
                i1 = min(i0 + 1, src_count - 1)
                idx, idx2 = i0, i1
                weight = float(x - int(x)) if i1 != i0 else 0.0
            src_time = float(x) / float(src_fps_f)
        else:
            # VFR：在实际 PTS 序列上二分定位
            ts = float(t_src)
            pos = _bisect_left(times, ts)  # 第一个 PTS >= ts 的位置
            if method == "nearest":
                # 在 pos-1（左侧帧）与 pos（右侧帧）之间选更近者
                if pos == 0:
                    idx = 0
                elif pos >= src_count:
                    idx = src_count - 1
                elif abs(times[pos - 1] - ts) <= abs(times[pos] - ts):
                    idx = pos - 1
                else:
                    idx = pos
                idx2, weight = None, 0.0
            else:
                # 精确命中某帧 PTS 时锚定该帧；否则取插入位左右两帧
                if pos < src_count and abs(times[pos] - ts) < _EPS:
                    i0 = pos
                else:
                    i0 = min(max(pos - 1, 0), src_count - 1)
                i1 = min(i0 + 1, src_count - 1)
                idx, idx2 = i0, i1
                span = times[i1] - times[i0]
                weight = (ts - times[i0]) / span if span > 0 else 0.0
            src_time = ts

        # 行类型判定（duplicate/drop 优先，反映可感知的运动异常）
        if method == "blend":
            kind = "blend"
            blend_count += 1
            if 0.2 <= weight <= 0.8:
                ghost_count += 1
            run = 0
        elif prev_src is not None and idx == prev_src:
            kind = "duplicate"
            duplicate_count += 1
            run += 1
            max_run = max(max_run, run)
        else:
            if prev_src is not None and idx - prev_src > 1:
                kind = "drop"
                drop_rows += 1
            else:
                kind = "exact"
                exact_count += 1
            run = 0

        prev_src = idx
        used_src.add(idx)
        if idx2 is not None:
            used_src.add(idx2)
        src_to_out.setdefault(idx, []).append(n)

        rows.append(
            FrameRow(
                out_index=n,
                out_time=float(t_out),
                out_timecode=_timecode_from_seconds(t_out, dst_fps_f),
                src_time=src_time,
                src_timecode=_timecode_from_seconds(src_time, src_fps_f),
                src_index=idx,
                src_index_2=idx2,
                blend_weight=round(weight, 6),
                kind=kind,
            )
        )

    dropped = [i for i in range(src_count) if i not in used_src]
    stats = MappingStats(
        src_fps=float(src_fps_f),
        dst_fps=float(dst_fps_f),
        speed=float(speed_f),
        method=method,
        src_frame_count=src_count,
        out_frame_count=n_out,
        src_duration=float(src_duration),
        out_duration=float(out_duration),
        exact_frames=exact_count,
        duplicate_frames=duplicate_count,
        max_duplicate_run=max_run,
        drop_frames=drop_rows,
        dropped_src_frames=dropped,
        blend_frames=blend_count,
        ghost_frames=ghost_count,
        stutter_ratio=round(duplicate_count / n_out, 6),
    )
    return MappingResult(rows=rows, stats=stats, src_to_out=src_to_out)


def _bisect_left(sorted_list: list[float], value: float) -> int:
    """标准库 bisect 的本地实现，避免在模块顶部再引一个名字（行为与 bisect_left 相同）。"""

    lo, hi = 0, len(sorted_list)
    while lo < hi:
        mid = (lo + hi) // 2
        if sorted_list[mid] < value:
            lo = mid + 1
        else:
            hi = mid
    return lo
