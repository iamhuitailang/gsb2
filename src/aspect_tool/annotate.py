"""在帧图上标注黑边 / 有效区域 / 会被裁掉的内容 / 映射后的标记点。

纯 PIL 绘图, 输入输出都是 PNG 文件路径或 PIL Image。
"""

from __future__ import annotations

from PIL import Image, ImageDraw, ImageFont

from .geometry import GeometryPipeline, MappedPoint

# 调色板 (与项目内所有可视化保持一致)
COLOR_BLACK_BORDER = (255, 165, 0)      # 橙: 黑边区
COLOR_ACTIVE = (0, 200, 120)            # 绿: 有效画面区
COLOR_CROPPED = (255, 64, 64)           # 红: 会被裁掉的内容
COLOR_MARKER = (255, 235, 59)           # 黄: 标记点
COLOR_MARKER_LOST = (160, 160, 160)     # 灰: 映射后不可见的点


def _font(size: int = 16) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for name in ("Arial.ttf", "Helvetica.ttc", "DejaVuSans.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def annotate_plan(
    display_png: str,
    pipe: GeometryPipeline,
    out_png: str,
    points_s: list[tuple[float, float]] | None = None,
) -> None:
    """在显示平面帧上标注 fit/crop 规划与标记点映射。

    display_png: 已按显示方向抽出的帧 (D 平面)。
    points_s:    存储平面 S 上的标记点, 会经管线映射到 D / O。
    """
    im = Image.open(display_png).convert("RGB")
    draw = ImageDraw.Draw(im, "RGBA")
    font = _font(15)
    W, H = im.size
    plan = pipe.plan

    if plan.mode == "fit":
        # D 整幅都保留; 在 D 上标出最终会进入 O 的有效区 (按 O->D 反算)
        ax0, ay0, ax1, ay1 = plan.active_box
        # 把 O 的 active box 反算回 D 坐标
        d0 = pipe.plan.matrix_o_to_d
        from .geometry import mat_apply
        x0, y0 = mat_apply(d0, ax0, ay0)
        x1, y1 = mat_apply(d0, ax1, ay1)
        draw.rectangle([x0, y0, x1, y1], outline=COLOR_ACTIVE, width=3)
        draw.text((x0 + 4, y0 + 4), "active (kept in output)",
                  fill=COLOR_ACTIVE, font=font)
        draw.text((6, H - 24),
                  f"fit: full frame kept, black bars added in "
                  f"{plan.ow}x{plan.oh} output",
                  fill=(255, 255, 255), font=font)
    else:
        # crop: 红框标出会被裁掉的部分, 绿框标出保留区
        cx0, cy0, cx1, cy1 = plan.crop_box_in_d
        draw.rectangle([0, 0, W - 1, H - 1], outline=COLOR_CROPPED, width=6)
        draw.rectangle([cx0, cy0, cx1, cy1], outline=COLOR_ACTIVE, width=3)
        # 图例放在保留区顶部内侧, 避免溢出画面
        draw.rectangle([cx0 + 4, cy0 + 4, cx0 + 250, cy0 + 24],
                       fill=(0, 0, 0))
        draw.text((cx0 + 8, cy0 + 6),
                  "red=cropped  green=active",
                  fill=COLOR_CROPPED, font=font)

    # 标记点映射 (S -> D)
    if points_s:
        for i, (sx, sy) in enumerate(points_s):
            mp = pipe.map_point_s_to_o(sx, sy)
            color = COLOR_MARKER if mp.visible else COLOR_MARKER_LOST
            r = 7
            draw.ellipse([mp.dx - r, mp.dy - r, mp.dx + r, mp.dy + r],
                         outline=color, width=3)
            label = f"P{i}"
            # 标签放在圆下方, 避免与圆内文字重叠
            draw.text((mp.dx - 6, mp.dy + r + 2), label,
                      fill=color, font=font)

    im.save(out_png)


def annotate_output(
    output_png: str,
    pipe: GeometryPipeline,
    mapped: list[MappedPoint],
    out_png: str,
) -> None:
    """在输出帧上标注黑边/有效区与最终落位的标记点。"""
    im = Image.open(output_png).convert("RGB")
    draw = ImageDraw.Draw(im, "RGBA")
    font = _font(15)
    plan = pipe.plan

    # 有效区 vs 黑边
    ax0, ay0, ax1, ay1 = plan.active_box
    if plan.letterbox:
        draw.rectangle([0, 0, im.width - 1, im.height - 1],
                       outline=COLOR_BLACK_BORDER, width=4)
        draw.text((6, 6), "orange border = black-bar area",
                  fill=COLOR_BLACK_BORDER, font=font)
    draw.rectangle([ax0, ay0, ax1, ay1], outline=COLOR_ACTIVE, width=2)

    for i, mp in enumerate(mapped):
        if not mp.visible or mp.ox is None:
            continue
        color = COLOR_MARKER_LOST if mp.in_black_border else COLOR_MARKER
        r = 7
        draw.ellipse([mp.ox - r, mp.oy - r, mp.ox + r, mp.oy + r],
                     outline=color, width=3)
        draw.text((mp.ox + 9, mp.oy - 8), f"P{i}", fill=color, font=font)

    im.save(out_png)


def side_by_side(left_png: str, right_png: str, out_png: str,
                 left_title: str, right_title: str) -> None:
    """两张图横向拼接并加标题, 便于方向/画幅对比。"""
    a = Image.open(left_png).convert("RGB")
    b = Image.open(right_png).convert("RGB")
    font = _font(18)
    pad = 8
    title_h = 30
    h = max(a.height, b.height) + title_h
    w = a.width + b.width + pad * 3
    canvas = Image.new("RGB", (w, h), (28, 28, 30))
    d = ImageDraw.Draw(canvas)
    d.text((pad, 6), left_title, fill=(255, 255, 255), font=font)
    d.text((pad * 2 + a.width, 6), right_title, fill=(255, 255, 255), font=font)
    canvas.paste(a, (pad, title_h))
    canvas.paste(b, (pad * 2 + a.width, title_h))
    canvas.save(out_png)
