"""把取景时间表编译成 ffmpeg 表达式 / sendcmd 指令。

预览(drawbox)和成片(crop)共用同一个 crop_x(t) 表达式, 因此两者逐帧
严格一致; 表达式过长时自动回退到 sendcmd 逐帧指令文件。
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Optional

from .ffmpegutil import fmt_float
from .model import even2

# ffmpeg 单条表达式保守长度上限, 超出则改用 sendcmd
EXPR_MAX_CHARS = 60_000


def crop_px(schedule: dict[str, Any]) -> tuple[int, int]:
    return int(schedule["crop"]["width_px"]), int(schedule["crop"]["height_px"])


def sample_kf(schedule: dict[str, Any], t: float) -> dict[str, float]:
    """在关键帧之间线性插值, 返回 t 时刻归一化裁框。"""
    kfs = schedule["keyframes"]
    if t <= kfs[0]["t"]:
        return dict(kfs[0]["crop"])
    if t >= kfs[-1]["t"]:
        return dict(kfs[-1]["crop"])
    for a, b in zip(kfs, kfs[1:]):
        if a["t"] <= t <= b["t"]:
            span = b["t"] - a["t"]
            p = 0.0 if span <= 0 else (t - a["t"]) / span
            return {k: a["crop"][k] + (b["crop"][k] - a["crop"][k]) * p for k in a["crop"]}
    return dict(kfs[-1]["crop"])


def crop_x_expr(schedule: dict[str, Any]) -> str:
    """crop 滤镜 x 参数表达式 (像素), 按帧号 n 分段线性。

    必须用 n 而不是连续时间 t: 输出帧的 pts 与规划器的 帧号/fps 时间网格
    可能相差半个帧周期, 用 t 做分支判断会整段错位; n 与规划器逐帧对齐。
    硬切段在关键帧处直接跳变 (相邻关键帧同帧号不同值)。
    """
    width = int(schedule["width"])
    fps = float(schedule["fps"])
    kfs = schedule["keyframes"]
    # 段按帧号升序; 嵌套 if 从最后一段往里包, 保证小帧号先命中内层
    segs: list[tuple[int, str]] = []
    for a, b in zip(kfs, kfs[1:]):
        x0 = a["crop"]["x"] * width
        x1 = b["crop"]["x"] * width
        n0, n1 = int(round(a["t"] * fps)), int(round(b["t"] * fps))
        span_f = n1 - n0
        if span_f <= 0:
            seg = fmt_float(x0)
        else:
            per_frame = (x1 - x0) / span_f
            seg = f"{fmt_float(x0)}+{fmt_float(per_frame)}*(n-{n0})"
        segs.append((n1, seg))
    # 最后一段的兜底值 (帧号超出所有关键帧时)
    expr = fmt_float(kfs[-1]["crop"]["x"] * width)
    for n1, seg in reversed(segs):
        expr = f"if(lt(n,{n1}),{seg},{expr})"
    return expr


def build_crop_filter(schedule: dict[str, Any], cmd_dir: str | Path) -> tuple[str, Optional[Path]]:
    """返回 (crop 滤镜描述, sendcmd 文件路径或 None)。"""
    crop_w, crop_h = crop_px(schedule)
    expr = crop_x_expr(schedule)
    if len(expr) <= EXPR_MAX_CHARS:
        return f"crop=w={crop_w}:h={crop_h}:x='{expr}':y=0", None

    # sendcmd 回退: 逐帧下发 x 坐标 (按帧号时间网格)
    cmd_path = Path(cmd_dir) / "crop_commands.txt"
    lines: list[str] = []
    fps = float(schedule["fps"])
    n = int(schedule["frames"])
    for fi in range(n):
        c = sample_kf(schedule, fi / fps)
        x = even2(c["x"] * int(schedule["width"]))
        lines.append(f"{fi / fps:.6f} crop x {x};")
    cmd_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return (
        f"sendcmd=f={cmd_path}:crop=w={crop_w}:h={crop_h}:x=0:y=0",
        cmd_path,
    )


def drawbox_preview_filter(schedule: dict[str, Any], color: str = "yellow@0.9", thickness: int = 4) -> str:
    """在横版原片上画出竖版取景框, 与成片共用同一套关键帧数据。

    drawbox 求值器不支持帧号 n (只支持 t), 因此这里用帧网格时间常量
    n/fps 配合 t 分支, 分支边界与 crop 的 n 分支严格等价。
    """
    crop_w, crop_h = crop_px(schedule)
    expr = _crop_x_drawbox_expr(schedule)
    return (
        f"drawbox=x='{expr}':y=0:w={crop_w}:h={crop_h}:"
        f"color={color}:t={thickness}"
    )


def _crop_x_drawbox_expr(schedule: dict[str, Any]) -> str:
    """drawbox 版 crop_x: 用 t 与帧网格时间 (n/fps) 比较, 数值与 crop_x_expr 相同。"""
    width = int(schedule["width"])
    fps = float(schedule["fps"])
    kfs = schedule["keyframes"]
    segs: list[tuple[float, str]] = []
    for a, b in zip(kfs, kfs[1:]):
        x0 = a["crop"]["x"] * width
        x1 = b["crop"]["x"] * width
        n0, n1 = int(round(a["t"] * fps)), int(round(b["t"] * fps))
        t0, t1 = n0 / fps, n1 / fps
        span_f = n1 - n0
        if span_f <= 0:
            seg = fmt_float(x0)
        else:
            # 用 t 反推帧内进度: (t - t0) * fps = n - n0
            per_sec = (x1 - x0) / (t1 - t0) if t1 > t0 else 0.0
            seg = f"{fmt_float(x0)}+{fmt_float(per_sec)}*(t-{fmt_float(t0)})"
        segs.append((t1, seg))
    expr = fmt_float(kfs[-1]["crop"]["x"] * width)
    for t1, seg in reversed(segs):
        expr = f"if(lt(t,{fmt_float(t1)}),{seg},{expr})"
    return expr


def track_box_expressions(tracks_doc: dict[str, Any], colors: dict[str, str]) -> list[str]:
    """预览里把每个关注框也画出来 (编号方块用各自颜色)。

    drawbox 只有 x/y 支持逐帧表达式且只认 t (不认 n), w/h 必须是常量;
    框的显隐改用 enable 表达式 (null 关键帧区间关闭)。分支边界一律用
    帧网格时间 n/fps, 与 crop 表达式对齐。
    """
    width = int(tracks_doc["width"])
    height = int(tracks_doc["height"])
    fps = float(tracks_doc["fps"])
    out: list[str] = []
    for tr in tracks_doc["tracks"]:
        color = colors.get(tr["id"], "cyan@0.8")
        kfs = sorted(tr["keyframes"], key=lambda k: k["t"])

        first = next(k["rect"] for k in kfs if k["rect"])
        last = next(k["rect"] for k in reversed(kfs) if k["rect"])

        def const_at(index: int, key: str, scale: float) -> str:
            # null 帧取最近的非 null 关键帧值 (该区间由 enable 关闭, 位置不参与显示)
            r = kfs[index]["rect"]
            if r is not None:
                return fmt_float(r[key] * scale)
            j = index - 1
            while j >= 0 and kfs[j]["rect"] is None:
                j -= 1
            if j < 0:
                j = index + 1
                while j < len(kfs) and kfs[j]["rect"] is None:
                    j += 1
            return fmt_float(kfs[j]["rect"][key] * scale)

        def chain(key: str, scale: float) -> str:
            # drawbox 只认 t: 用帧网格时间 n/fps 作分支边界, 与 crop 的 n 分支等价
            segs: list[tuple[float, str]] = []
            for i, (a, b) in enumerate(zip(kfs, kfs[1:])):
                n0 = int(round(a["t"] * fps))
                n1 = int(round(b["t"] * fps))
                t0, t1 = n0 / fps, n1 / fps
                if a["rect"] is None or b["rect"] is None:
                    seg = const_at(i, key, scale)
                else:
                    v0, v1 = a["rect"][key] * scale, b["rect"][key] * scale
                    per_sec = 0.0 if t1 <= t0 else (v1 - v0) / (t1 - t0)
                    seg = f"{fmt_float(v0)}+{fmt_float(per_sec)}*(t-{fmt_float(t0)})"
                segs.append((t1, seg))
            expr = const_at(len(kfs) - 1, key, scale)
            for t1, seg in reversed(segs):
                expr = f"if(lt(t,{fmt_float(t1)}),{seg},{expr})"
            return expr

        x_expr, y_expr = chain("x", width), chain("y", height)
        w = fmt_float(last["w"] * width)
        h = fmt_float(last["h"] * height)
        # null 区间: 帧号 [n0, n1) 对应时间 [n0/fps, n1/fps), drawbox 用 t 判断
        null_terms = []
        for a, b in zip(kfs, kfs[1:]):
            if a["rect"] is None:
                n0 = int(round(a["t"] * fps))
                n1 = int(round(b["t"] * fps))
                null_terms.append(
                    f"between(t\\,{fmt_float(n0 / fps)}\\,{fmt_float((n1 - 1) / fps)})"
                )
        if kfs[-1]["rect"] is None:
            null_terms.append(f"gte(t\\,{fmt_float(int(round(kfs[-1]['t'] * fps)) / fps)})")
        enable = f":enable='not({'+'.join(null_terms)})'" if null_terms else ""
        out.append(
            f"drawbox=x='{x_expr}':y='{y_expr}':w={w}:h={h}:"
            f"color={color}:t=3{enable}"
        )
    return out


def safe_zone_expressions(zones: list[dict[str, Any]], width: int, height: int) -> list[str]:
    out = []
    for z in zones:
        r = z["rect"]
        x, y, w, h = r["x"] * width, r["y"] * height, r["w"] * width, r["h"] * height
        out.append(
            f"drawbox=x={fmt_float(x)}:y={fmt_float(y)}:w={fmt_float(w)}:h={fmt_float(h)}:"
            f"color=red@0.55:t=4"
        )
    return out
