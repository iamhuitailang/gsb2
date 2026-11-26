"""帧布局计算：平面几何、帧大小、像素字节溯源、缺字节定位。

所有计算都不触碰真实文件，纯算术，方便单元测试。
"""
from __future__ import annotations

from .model import FrameParams, PlaneGeom, TraceEntry, PartialFrame


def planes_of(p: FrameParams) -> list[PlaneGeom]:
    """返回单帧内各平面的几何（顺序即文件中的排列顺序）。"""
    p.validate()
    sy, suv = p.resolved_strides()
    h = p.height
    cw, ch = (p.width + 1) // 2, (h + 1) // 2

    if p.fmt == "i420":
        y = PlaneGeom("Y", p.width, h, 1, sy, 0)
        u = PlaneGeom("U", cw, ch, 1, suv, y.end)
        v = PlaneGeom("V", cw, ch, 1, suv, u.end)
        return [y, u, v]

    if p.fmt == "nv12":
        y = PlaneGeom("Y", p.width, h, 1, sy, 0)
        uv = PlaneGeom("UV", cw, ch, 2, suv, y.end)
        return [y, uv]

    rgba = PlaneGeom("RGBA", p.width, h, 4, sy, 0)
    return [rgba]


def frame_size(p: FrameParams) -> int:
    geoms = planes_of(p)
    return geoms[-1].end


def chroma_coverage(p: FrameParams, cx: int, cy: int) -> tuple[int, int, int, int]:
    """色度采样 (cx, cy) 覆盖的亮度像素矩形 (x0, y0, x1 不含, y1 不含)。

    奇数宽/高时，最右/最下的色度采样只覆盖一列/一行亮度像素。
    """
    x0 = cx * 2
    y0 = cy * 2
    x1 = min(x0 + 2, p.width)
    y1 = min(y0 + 2, p.height)
    return x0, y0, x1, y1


def trace_pixel(p: FrameParams, x: int, y: int) -> list[TraceEntry]:
    """返回像素 (x, y) 的取值在单帧内的字节来源。"""
    if not (0 <= x < p.width and 0 <= y < p.height):
        raise ValueError(f"像素坐标 ({x},{y}) 超出 {p.width}x{p.height}")

    geoms = {g.name: g for g in planes_of(p)}

    if p.fmt == "rgba":
        g = geoms["RGBA"]
        off = g.offset + y * g.stride + x * 4
        return [TraceEntry(
            label="RGBA", plane="RGBA", sample_x=x, sample_y=y,
            frame_rel_offset=off, length=4, sub_offsets=(0, 1, 2, 3))]

    yg = geoms["Y"]
    y_off = yg.offset + y * yg.stride + x
    entries = [TraceEntry(
        label="Y", plane="Y", sample_x=x, sample_y=y, frame_rel_offset=y_off)]

    cx, cy = x // 2, y // 2
    coverage = chroma_coverage(p, cx, cy)

    if p.fmt == "i420":
        for name in ("U", "V"):
            g = geoms[name]
            off = g.offset + cy * g.stride + cx
            entries.append(TraceEntry(
                label=name, plane=name, sample_x=cx, sample_y=cy,
                frame_rel_offset=off, coverage=coverage))
        return entries

    # nv12：U/V 交错存放在同一行，一次读 2 字节
    g = geoms["UV"]
    off = g.offset + cy * g.stride + cx * 2
    entries.append(TraceEntry(
        label="UV 交错对", plane="UV", sample_x=cx, sample_y=cy,
        frame_rel_offset=off, length=2, sub_offsets=(0, 1), coverage=coverage))
    return entries


def describe_location(p: FrameParams, frame_rel_offset: int) -> str:
    """把帧内字节偏移翻译成人类可读位置（含“行尾填充”判定）。"""
    for g in planes_of(p):
        if g.offset <= frame_rel_offset < g.end:
            rel = frame_rel_offset - g.offset
            row, col = divmod(rel, g.stride)
            if col >= g.valid_row_bytes:
                pad_idx = col - g.valid_row_bytes
                return (f"平面 {g.name} 第 {row} 行行尾填充 "
                        f"(填充第 {pad_idx + 1}/{g.row_padding} 字节)")
            sample = col // g.bpp
            if g.bpp == 2:
                return f"平面 {g.name} 第 {row} 行 采样列 {sample} 的 U/V 对"
            if g.bpp == 4:
                return f"平面 {g.name} 第 {row} 行 像素 {sample} 的 RGBA"
            return f"平面 {g.name} 第 {row} 行 采样列 {sample}"
    return "帧布局之外的偏移"


def diagnose_partial(p: FrameParams, index: int, present_in_frame: int,
                     frame_size_needed: int) -> PartialFrame:
    """为不完整的末帧生成诊断信息。"""
    first_missing_rel = present_in_frame
    # 缺字节是否全部落在行尾填充区？
    all_padding = True
    for rel in range(first_missing_rel, frame_size_needed):
        desc = describe_location(p, rel)
        if "行尾填充" not in desc:
            all_padding = False
            break
    return PartialFrame(
        index=index,
        present_bytes=present_in_frame,
        first_missing_abs=index * frame_size_needed + first_missing_rel,
        location=describe_location(p, first_missing_rel),
        image_valid_complete=all_padding,
    )
