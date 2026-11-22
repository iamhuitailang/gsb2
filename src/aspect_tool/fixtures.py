"""生成两份自带测试素材。

fixture A (旋转素材): 存储帧 320x240, 画面内写有 "TOP/BOTTOM/LEFT/RIGHT"
  方向字样、四个圆形标记与帧号, 再通过 tkhd 矩阵写入顺时针 90° 旋转。
  用于验证: 显示方向落实为真实帧方向后, 字样朝向正确、标记点可映射。

fixture B (拉伸/非方形像素素材): 存储帧 320x240、SAR=4:3, 画面里画
  几何正圆 (按方形像素比例预补偿), 用于验证: 转成方形像素后圆仍然是圆。
"""

from __future__ import annotations

import math
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from . import ffmpeg, mp4matrix


def _font(size: int):
    for name in ("Arial.ttf", "Helvetica.ttc", "Arial Unicode.ttf",
                 "DejaVuSans.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def _frame_rotated_upright(idx: int, n_frames: int) -> Image.Image:
    """fixture A 的"正向竖屏"画面 (240x320)。

    模拟手机竖屏场景: 用户最终看到的就是这个方向 —— TOP 字样在顶部、
    箭头朝上、四个圆标记。生成存储帧时再把它整体旋转成横向 (见
    _stored_rotated_frames), 并配 tkhd 矩阵, 与真实手机传感器流程一致。
    """
    W, H = 240, 320
    im = Image.new("RGB", (W, H), (24, 24, 30))
    d = ImageDraw.Draw(im)
    f_big, f_mid, f_small = _font(26), _font(16), _font(13)

    # 四条边不同底色, 转正后可凭颜色+字样双重判断方向
    d.rectangle([0, 0, W - 1, 24], fill=(180, 40, 40))          # 顶 红
    d.rectangle([0, H - 25, W - 1, H - 1], fill=(40, 60, 180))  # 底 蓝
    d.rectangle([0, 0, 24, H - 1], fill=(40, 150, 60))          # 左 绿
    d.rectangle([W - 25, 0, W - 1, H - 1], fill=(190, 170, 40))  # 右 黄

    d.text((W // 2 - 24, 4), "TOP", fill=(255, 255, 255), font=f_mid)
    d.text((W // 2 - 40, H - 22), "BOTTOM", fill=(255, 255, 255), font=f_mid)
    for i, ch in enumerate("LEFT"):
        d.text((5, 40 + i * 20), ch, fill=(255, 255, 255), font=f_small)
    for i, ch in enumerate("RIGHT"):
        d.text((W - 20, 40 + i * 18), ch, fill=(20, 20, 20), font=f_small)

    # 指向上方的箭头
    cx, cy = W // 2, H // 2
    d.polygon([(cx, cy - 40), (cx - 18, cy - 8), (cx - 7, cy - 8),
               (cx - 7, cy + 24), (cx + 7, cy + 24), (cx + 7, cy - 8),
               (cx + 18, cy - 8)], fill=(255, 255, 255))

    # 四个圆形标记 (正圆), 兼作圆度检查与标记点映射检查
    r = 13
    for (px, py), name in [((55, 60), "TL"), ((W - 55, 60), "TR"),
                           ((55, H - 60), "BL"), ((W - 55, H - 60), "BR")]:
        d.ellipse([px - r, py - r, px + r, py + r],
                  outline=(255, 235, 59), width=3)
        d.text((px - 10, py - 8), name, fill=(255, 235, 59), font=f_small)

    d.text((W // 2 - 30, H - 48), f"frame {idx:03d}/{n_frames}",
           fill=(210, 210, 210), font=f_small)
    return im


def _stored_rotated_frames(n_frames: int) -> list[Image.Image]:
    """生成横向存储帧 (320x240): 正向竖屏画面逆时针旋转 90°。

    配合 tkhd 顺时针 90° 矩阵, 播放器 autorotate 后还原为正向竖屏
    (该配方已用 ffmpeg autorotate 实测验证)。
    """
    return [
        _frame_rotated_upright(i, n_frames).transpose(
            Image.Transpose.ROTATE_90)
        for i in range(n_frames)
    ]


def _frame_anamorphic(idx: int, n_frames: int) -> Image.Image:
    """fixture B 的一帧: 在 320x240 存储帧上画 SAR 预补偿的正圆与网格。

    播放器以 SAR=4:3 显示时, 横向被拉宽 4/3 倍; 因此存储帧里要把圆
    横向压缩 3/4, 显示后才是正圆。
    """
    W, H = 320, 240
    im = Image.new("RGB", (W, H), (24, 24, 30))
    d = ImageDraw.Draw(im)
    f_mid, f_small = _font(18), _font(13)

    sx = 3.0 / 4.0  # 预补偿: 存储宽度方向压缩
    cx, cy = W / 2, H / 2
    radius_disp = 80.0

    def ellipse_disp(rx: float, ry: float, **kw):
        d.ellipse([cx - rx * sx, cy - ry, cx + rx * sx, cy + ry], **kw)

    # 三个同心"正圆" (显示后), 存储里是椭圆
    for rr, col in [(radius_disp, (0, 200, 120)),
                    (radius_disp * 0.66, (90, 170, 255)),
                    (radius_disp * 0.33, (255, 160, 60))]:
        ellipse_disp(rr, rr, outline=col, width=3)

    # 方形网格 (显示后), 存储里是横向压扁的格子
    for gx in range(-2, 3):
        x = cx + gx * 40 * sx
        d.line([(x, 30), (x, H - 30)], fill=(70, 70, 80), width=1)
    for gy in range(-2, 3):
        y = cy + gy * 40
        d.line([(30, y), (W - 30, y)], fill=(70, 70, 80), width=1)

    d.text((8, 8), "ANAMORPHIC 320x240 SAR=4:3 -> display 16:9",
           fill=(255, 255, 255), font=f_small)
    d.text((8, H - 22), f"frame {idx:03d}/{n_frames}",
           fill=(210, 210, 210), font=f_small)
    return im


def _encode_frames(frames: list[Image.Image], out: Path, fps: int,
                   sar: str | None = None) -> None:
    """把 PIL 帧序列编码成 H.264 MP4。"""
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        for i, fr in enumerate(frames):
            fr.save(tdp / f"f_{i:04d}.png")
        cmd = ["ffmpeg", "-y", "-loglevel", "error",
               "-framerate", str(fps), "-i", str(tdp / "f_%04d.png")]
        vf = []
        if sar:
            vf.append(f"setsar={sar}")
        if vf:
            cmd += ["-vf", ",".join(vf)]
        cmd += ["-c:v", "libx264", "-pix_fmt", "yuv420p",
                "-crf", "20", str(out)]
        subprocess.run(cmd, check=True, capture_output=True, text=True)


def generate(out_dir: str | Path, n_frames: int = 25, fps: int = 25) -> dict:
    """生成两份素材, 返回路径字典。"""
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)

    rot_path = out / "fixture_rotated.mp4"
    ana_path = out / "fixture_anamorphic.mp4"

    rot_frames = _stored_rotated_frames(n_frames)
    _encode_frames(rot_frames, rot_path, fps)
    # 写入顺时针 90° 的 tkhd 显示矩阵 (模拟手机竖屏录像, 与存储帧的
    # 逆时针旋转互为逆操作, 播放器显示时还原正向)
    mp4matrix.write_rotation(str(rot_path), 90)

    ana_frames = [_frame_anamorphic(i, n_frames) for i in range(n_frames)]
    _encode_frames(ana_frames, ana_path, fps, sar="4/3")

    return {
        "rotated": str(rot_path),
        "anamorphic": str(ana_path),
    }
