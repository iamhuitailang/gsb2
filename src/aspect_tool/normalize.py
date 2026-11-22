"""转换编排: 诊断 -> 规划 -> 转码 -> 导出后复检。"""

from __future__ import annotations

from dataclasses import dataclass, field
from fractions import Fraction
from pathlib import Path

from . import ffmpeg, mp4matrix
from .geometry import (
    DisplayTransform, GeometryPipeline, MappedPoint,
    default_target, plan_output,
)
from .probe import VideoInfo, probe


@dataclass
class NormalizeRequest:
    input_path: str
    output_path: str
    mode: str = "fit"                     # fit | crop
    target: tuple[int, int] | None = None  # ow, oh; None 则按显示面自动
    bake_rotation: bool = True             # 把显示方向落实为真实帧方向
    square_pixels: bool = True             # 非方形像素 -> 方形像素
    rotation_override: int | None = None   # 用户确认后的顺时针角度
    flip_override: bool | None = None
    keep_audio: bool = True
    marker_points: list[tuple[float, float]] = field(default_factory=list)


@dataclass
class NormalizeResult:
    request: NormalizeRequest
    info: VideoInfo
    dt: DisplayTransform
    pipeline: GeometryPipeline
    filter_chain: str
    mapped_points: list[MappedPoint]
    verification: dict


def _resolve_transform(info: VideoInfo, req: NormalizeRequest) -> DisplayTransform:
    dt = info.display
    if req.rotation_override is not None or req.flip_override is not None:
        cw = req.rotation_override if req.rotation_override is not None else dt.cw_deg
        flip = req.flip_override if req.flip_override is not None else dt.flip
        dt = DisplayTransform(
            sw=dt.sw, sh=dt.sh, cw_deg=cw % 360, flip=flip,
            sar=dt.sar, exact_orthogonal=True,
            raw_rotation_ccw=dt.raw_rotation_ccw,
            notes=[f"用户确认方向: 顺时针 {cw}°" + (" +镜像" if flip else "")],
        )
    if not req.bake_rotation:
        # 不落实旋转: 仅保留 SAR 处理, 显示矩阵会在输出时被清除
        dt = DisplayTransform(
            sw=dt.sw, sh=dt.sh, cw_deg=0, flip=False, sar=dt.sar,
            exact_orthogonal=dt.exact_orthogonal,
            raw_rotation_ccw=dt.raw_rotation_ccw,
            notes=dt.notes + ["未落实旋转, 输出为存储像素方向"],
        )
    return dt


def run_normalize(req: NormalizeRequest) -> NormalizeResult:
    info = probe(req.input_path)

    # 方向无法确定且用户没确认 -> 不擅自转, 抛出并附原因
    if info.ambiguous and req.rotation_override is None and req.bake_rotation:
        raise AmbiguousRotationError(info.ambiguity_reasons)

    dt = _resolve_transform(info, req)
    ow, oh = req.target or default_target(dt)
    plan = plan_output(dt, ow, oh, req.mode)
    pipe = GeometryPipeline(dt, plan)

    Path(req.output_path).parent.mkdir(parents=True, exist_ok=True)
    enc = ffmpeg.normalize(
        req.input_path, dt, plan, req.output_path,
        keep_audio=req.keep_audio,
    )

    mapped = [pipe.map_point_s_to_o(x, y) for x, y in req.marker_points]
    verification = verify_output(req, info, dt, plan)

    return NormalizeResult(
        request=req, info=info, dt=dt, pipeline=pipe,
        filter_chain=enc["filter_chain"],
        mapped_points=mapped, verification=verification,
    )


class AmbiguousRotationError(RuntimeError):
    def __init__(self, reasons: list[str]):
        super().__init__("旋转信息无法确定, 请用户确认后用 --rotation 重试:\n  - "
                         + "\n  - ".join(reasons))
        self.reasons = reasons


# ---------------------------------------------------------------------------
# 导出后复检: 重新读文件, 确认不会再多转一次, 并核对比例/有效画面/时长
# ---------------------------------------------------------------------------

def verify_output(req: NormalizeRequest, src_info: VideoInfo,
                  dt: DisplayTransform, plan) -> dict:
    out = probe(req.output_path)
    checks: dict = {"ok": True, "items": []}

    def record(name: str, ok: bool, detail: str):
        checks["items"].append({"name": name, "ok": ok, "detail": detail})
        if not ok:
            checks["ok"] = False

    # 1) 输出无旋转/矩阵 (播放器不会再多转一次)
    has_rot = (out.rotation_ccw is not None and abs(out.rotation_ccw) > 1e-6)
    has_matrix = out.matrix3x3 is not None and any(
        abs(v) > 1e-6 for v in out.matrix3x3[:4])
    record("无残留旋转元数据", not (has_rot or has_matrix),
           f"rotation={out.rotation_ccw}, matrix={out.matrix3x3}")

    # 2) 方形像素
    record("输出为方形像素", out.sar == 1, f"SAR={out.sar}")

    # 3) 输出宽高与规划一致
    record("输出宽高符合规划",
           (out.stored_width, out.stored_height) == (plan.ow, plan.oh),
           f"实际 {out.stored_width}x{out.stored_height}, 规划 {plan.ow}x{plan.oh}")

    # 4) 显示比例: 输出 DAR 应等于目标画幅比
    target_ar = Fraction(plan.ow, plan.oh)
    ar_ok = abs(out.dar - target_ar) <= Fraction(1, max(1, plan.ow * plan.oh))
    record("显示比例与目标画幅一致", ar_ok,
           f"输出 DAR={out.dar}, 目标 {target_ar}")

    # 5) 有效画面: fit 模式有效区比例 == 输入显示面比例
    src_display_ar = Fraction(dt.dw, dt.dh)
    if plan.mode == "fit":
        ax0, ay0, ax1, ay1 = plan.active_box
        eff_ar = Fraction(int(round(ax1 - ax0 + 1)), int(round(ay1 - ay0 + 1)))
        eff_ok = abs(eff_ar - src_display_ar) <= Fraction(1, 100)
        record("fit 有效区保持原显示比例", eff_ok,
               f"有效区比 {eff_ar}, 原显示比 {src_display_ar}")
    else:
        record("crop 输出铺满无黑边", not plan.letterbox,
               f"letterbox={plan.letterbox}")

    # 6) 声画时长核对
    d_dur = abs(out.duration_sec - src_info.duration_sec)
    record("视频时长一致", d_dur <= 0.1,
           f"输入 {src_info.duration_sec:.3f}s -> 输出 {out.duration_sec:.3f}s")
    if src_info.has_audio:
        if out.has_audio and out.audio_duration_sec is not None:
            a_dur = abs(out.audio_duration_sec -
                        (src_info.audio_duration_sec or src_info.duration_sec))
            record("音频保留且时长一致", a_dur <= 0.15,
                   f"音频 {out.audio_duration_sec:.3f}s")
        else:
            record("音频保留且时长一致", False, "输出缺少音频流")

    # 7) 帧数一致 (逐帧转换不丢帧)
    try:
        n_in = ffmpeg.count_frames(req.input_path)
        n_out = ffmpeg.count_frames(req.output_path)
        record("帧数一致", n_in == n_out, f"输入 {n_in} 帧 -> 输出 {n_out} 帧")
    except Exception as exc:  # pragma: no cover - 探测失败不应致命
        record("帧数一致", False, f"帧统计失败: {exc}")

    checks["output_info"] = out
    return checks
