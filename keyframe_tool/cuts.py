"""裁切计划与执行。

两种模式：
- fast（快速 / 流复制 -c copy）：不重新编码，速度快但首帧只能从关键帧开始，
  实际范围会向前后的关键帧扩张，这正是「播放器看着对、文件多一截」的来源。
- accurate（逐帧精确 / 重编码）：trim 滤镜按显示时间精确切，首帧即用户指定帧，
  代价是整段重编码。

时间约定：页面给的 in/out 是显示时间（时间线从 0 开始）。
经实测，ffmpeg 的输入级 -ss 与 trim/atrim 滤镜都按「相对流起点的显示时间」
工作，而非容器绝对 pts——因此裁切命令直接使用显示时间，源轨的非零起点
（start_time）由 ffmpeg 在流内部扣除，天然不会被当成用户额外加的偏移。
times.to_pts 仍用于探测阶段把 ffprobe 的绝对 pts 换算成显示时间。
"""

from __future__ import annotations

import os
from dataclasses import dataclass

from . import times
from .ffmpeg_utils import FFmpegError, run_ffmpeg
from .probe import FrameInfo, ProbeResult, frame_containing_display

MIN_FRAMES = 2  # 成品至少要两帧，单帧/空区间直接拒绝
# 快速裁切 seek 用的回退量（秒）：落在 GOP 内部以避开非零起点下的关键帧边界判定。
# 实测含音轨时阈值更高（10ms 仍可能误回退，100ms 稳定）；0.1s 小于本工具测试素材的
# 最短 GOP（0.5s），且 seek 落点仍在该 GOP 内，实际首帧不变，只是避开了边界。
SEEK_EPS = 0.1


class CutValidationError(ValueError):
    """区间本身不合法：空区间、太短、超出素材范围等。"""


@dataclass
class CutPlan:
    mode: str
    target_in_display: float
    target_out_display: float
    target_in_idx: int
    target_out_idx: int           # 半开区间，目标为 [in_idx, out_idx)
    actual_in_display: float
    actual_out_display: float
    actual_in_idx: int
    actual_out_idx: int
    has_audio: bool
    note: str
    seek_epsilon: float = 0.0      # 快速裁切实际 -ss 相对关键帧显示时间的回退量

    def to_dict(self) -> dict:
        d = self.__dict__.copy()
        for k in (
            "target_in_display", "target_out_display",
            "actual_in_display", "actual_out_display",
        ):
            d[k] = round(d[k], 6)
        return d


def _snap_range(pr: ProbeResult, in_display: float, out_display: float) -> tuple[FrameInfo, FrameInfo]:
    """把显示时间吸附到帧，并做区间合法性校验。"""
    frames = pr.frames
    duration = frames[-1].display_time + frames[-1].duration
    if in_display < -times.EPS or out_display < -times.EPS:
        raise CutValidationError("入点/出点不能为负（显示时间从 0 开始）")
    if in_display > duration + times.EPS or out_display > duration + times.EPS:
        raise CutValidationError(f"裁切区间超出素材显示时长 {times.hms(duration)}")
    # 用「时间落在哪一帧的展示区间」吸附，落在帧边界时归属前一帧，
    # 与逐帧裁切的半开区间语义一致（最近邻会在边界上误吸到下一帧）。
    f_in = frame_containing_display(frames, in_display)
    f_out = frame_containing_display(frames, out_display)
    if f_out.idx < f_in.idx:
        raise CutValidationError("出点早于入点，这是空区间，无法裁切")
    if f_out.idx == f_in.idx:
        raise CutValidationError(
            f"入点与出点吸附到同一帧（第 {f_in.idx} 帧），区间为空，无法裁切"
        )
    if f_out.idx - f_in.idx + 1 < MIN_FRAMES:
        raise CutValidationError("区间太短：成品不足两帧，请拉大入出点间隔")
    return f_in, f_out


def build_plan(pr: ProbeResult, mode: str, in_display: float, out_display: float) -> CutPlan:
    if mode not in ("fast", "accurate"):
        raise CutValidationError(f"未知裁切模式: {mode}")
    f_in, f_out = _snap_range(pr, in_display, out_display)
    frames = pr.frames
    has_audio = pr.audio is not None

    if mode == "accurate":
        # 重编码：trim 按显示时间精确切，实际范围 == 目标范围（半开区间）
        return CutPlan(
            mode="accurate",
            target_in_display=f_in.display_time,
            target_out_display=f_out.display_time + f_out.duration,
            target_in_idx=f_in.idx,
            target_out_idx=f_out.idx + 1,
            actual_in_display=f_in.display_time,
            actual_out_display=f_out.display_time + f_out.duration,
            actual_in_idx=f_in.idx,
            actual_out_idx=f_out.idx + 1,
            has_audio=has_audio,
            note="重编码逐帧裁切，首帧即指定帧，范围不扩张",
        )

    # fast：起点回退到 <= 入点的最近关键帧；没有前导关键帧（开头之前）就用第一帧
    start_key = next(
        (f for f in reversed(frames) if f.is_keyframe and f.display_time <= f_in.display_time + times.EPS),
        frames[0],
    )
    # seek epsilon 必须落在当前 GOP 内部：取 SEEK_EPS 与「到下一关键帧距离的一半」的较小值，
    # 保证不会因为 epsilon 越过下一个关键帧而 seek 到错误的 GOP。
    next_key = next(
        (f for f in frames if f.is_keyframe and f.display_time > start_key.display_time + times.EPS),
        None,
    )
    if next_key is not None:
        gap = next_key.display_time - start_key.display_time
        seek_epsilon = min(SEEK_EPS, gap * 0.5)
    else:
        seek_epsilon = min(SEEK_EPS, start_key.duration)  # 末个 GOP：不超过一帧
    # 流复制在出点按包截断：最后一个 pts < out 的帧会被保留，实际边界以读回为准
    note_parts = ["流复制不重编码，首帧回退到前一个关键帧，范围向前扩张"]
    if start_key.idx != f_in.idx:
        note_parts.append(
            f"多出 {f_in.idx - start_key.idx} 帧（{times.ms(f_in.display_time - start_key.display_time)}）"
        )
    note_parts.append("出点按包截断，实际尾帧以执行后读回为准")
    return CutPlan(
        mode="fast",
        target_in_display=f_in.display_time,
        target_out_display=f_out.display_time + f_out.duration,
        target_in_idx=f_in.idx,
        target_out_idx=f_out.idx + 1,
        actual_in_display=start_key.display_time,
        actual_out_display=f_out.display_time + f_out.duration,
        actual_in_idx=start_key.idx,
        actual_out_idx=f_out.idx + 1,
        seek_epsilon=seek_epsilon,
        has_audio=has_audio,
        note="；".join(note_parts),
    )


def execute(pr: ProbeResult, plan: CutPlan, output_path: str) -> dict:
    """按计划执行裁切，返回 ffmpeg 日志信息。失败抛 FFmpegError。"""
    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)

    if plan.mode == "fast":
        # ffmpeg 输入级 -ss 按「相对流起点的显示时间」工作（实测带 1.3s 非零起点的
        # 素材，传绝对 pts 会整体 seek 过头）。但当 seek 时刻恰好等于某关键帧的显示
        # 时间时，ffmpeg 在非零起点下会回退到再前一个关键帧；落在 GOP 内部则总能
        # 正确回退到该 GOP 的前导关键帧。这里把起点加 1ms 极小 epsilon，使落点处于
        # GOP 内部，实际首帧仍是同一个关键帧，却避开关键帧边界判定。
        # 不能加 -copyts：ffmpeg 8 下它与输入级 -ss 组合会使 seek 失效（从头开始）。
        # -avoid_negative_ts make_zero 把输出时间线归零，成品仍从 0 开始。
        ss = plan.actual_in_display + plan.seek_epsilon
        duration = plan.actual_out_display - plan.actual_in_display
        args = ["-ss", f"{ss:.6f}", "-i", pr.path, "-t", f"{duration:.6f}",
                "-map", "0:v:0", "-c", "copy"]
        if plan.has_audio:
            args += ["-map", "0:a:0", "-c:a", "copy"]
        else:
            args += ["-an"]
        args += ["-avoid_negative_ts", "make_zero", output_path]
    else:
        # 重编码：trim/atrim 滤镜的时间同样是「相对流起点的显示时间」
        # （实测带 1.3s 起点的素材，传绝对 pts 会切到错误画面）。
        # 视频额外用 start_frame/end_frame 按显示顺序帧号卡死边界（半开区间），
        # 比时间戳更无歧义；音频没有帧号概念，用显示时间交给 atrim。
        # 源轨起点由滤镜按流内部时间处理，只扣一次，不会被二次计算。
        if plan.has_audio:
            in_a = plan.target_in_display
            out_a = plan.target_out_display
            args = ["-i", pr.path, "-filter_complex",
                    f"[0:v:0]trim=start_frame={plan.target_in_idx}:end_frame={plan.target_out_idx},"
                    "setpts=PTS-STARTPTS[v];"
                    f"[0:a:0]atrim=start={in_a:.6f}:end={out_a:.6f},asetpts=PTS-STARTPTS[a]",
                    "-map", "[v]", "-map", "[a]",
                    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
                    "-pix_fmt", "yuv420p",
                    "-c:a", "aac", "-b:a", "192k", output_path]
        else:
            args = ["-i", pr.path, "-filter_complex",
                    f"[0:v:0]trim=start_frame={plan.target_in_idx}:end_frame={plan.target_out_idx},"
                    "setpts=PTS-STARTPTS[v]",
                    "-map", "[v]", "-an",
                    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
                    "-pix_fmt", "yuv420p", output_path]

    ok, log = run_ffmpeg(args)
    if not ok or not os.path.isfile(output_path) or os.path.getsize(output_path) == 0:
        raise FFmpegError(f"ffmpeg 裁切失败:\n{log}")
    return {"log_tail": log[-1200:], "output": output_path}
