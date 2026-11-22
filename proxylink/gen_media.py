"""生成带画面计数标记的测试素材。

本机 ffmpeg 若未编译 ``drawtext``（缺 freetype），统一改用 PIL 逐帧
渲染计数画面再交给 ffmpeg 编码，保证任何环境都能产出带帧号标记的素材。

产出（默认放在输出目录下）：
- ``original.mp4``        原片：1280x720，画面上烧录帧号/秒数/标签
- ``proxy_normal.mp4``    正常代理：640x360，完整时长
- ``proxy_short.mp4``     少一段的代理：640x360，只有前 8 秒（缺尾）
- ``proxy_headshift.mp4`` 起点偏移代理：从原片第 2 秒开始（缺头）

画面中央大字是该帧对应的 **原片帧号 ORIG nnnnnn**，因此用肉眼即可
核对挂接后两边是否指向同一画面。
"""

import os
import shutil
import subprocess
import tempfile

from PIL import Image, ImageDraw, ImageFont

from .errors import ProbeError

DEFAULT_DURATION = 10.0
DEFAULT_FPS = 24
ORIGINAL_SIZE = (1280, 720)
PROXY_SIZE = (640, 360)

_FONT_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans.ttf",
]


def _load_font(size):
    for path in _FONT_CANDIDATES:
        if os.path.isfile(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


def _run_ffmpeg(cmd):
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise ProbeError(f"ffmpeg 执行失败:\n{proc.stderr[-2000:]}")


def _render_frame(width, height, frame_no, origin_frame, fps, label, fonts, tmp_dir, idx):
    """渲染一帧：彩底 + 标签 + 本片段帧号 + 原片帧号大字 + 秒数。"""
    img = Image.new("RGB", (width, height))
    draw = ImageDraw.Draw(img)

    # 彩色渐变底，让画面随时间变化，避免全静态
    band = max(1, height // 8)
    for y in range(0, height, band):
        r = (y * 255) // max(height, 1)
        g = (frame_no * 4) % 255
        b = 255 - r
        draw.rectangle([0, y, width, min(y + band, height) - 1], fill=(r, g, b))

    # 顶部信息条
    draw.rectangle([0, 0, width, max(36, height // 12)], fill=(0, 0, 0))
    small, big, mid = fonts
    draw.text((8, 4), label[:max(10, width // 12)], font=small, fill=(255, 220, 60))
    draw.text((8, max(20, height // 20)), f"F={frame_no:06d}", font=small, fill=(255, 255, 255))
    seconds = (frame_no + origin_frame) / fps
    draw.text((width - width // 5, max(20, height // 20)),
              f"{int(seconds):02d}s", font=small, fill=(255, 255, 255))

    # 中央大字：对应原片帧号，这是核对挂接是否正确的关键标记
    text = f"ORIG {frame_no + origin_frame:06d}"
    bbox = draw.textbbox((0, 0), text, font=big)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    x = (width - tw) // 2
    y = (height - th) // 2
    draw.rectangle([x - 16, y - 12, x + tw + 16, y + th + 12], fill=(0, 0, 0))
    draw.text((x, y), text, font=big, fill=(255, 255, 255))

    # 底部：时间码辅助信息
    total = frame_no + origin_frame
    ff = total % round(fps)
    ss = (total // round(fps)) % 60
    mm = (total // round(fps) // 60) % 60
    draw.text((8, height - max(24, height // 16)),
              f"{mm:02d}:{ss:02d}:{ff:02d}", font=mid, fill=(220, 220, 220))

    img.save(os.path.join(tmp_dir, f"frame_{idx:06d}.png"))


def _generate_clip(path, *, size, fps, duration, label, origin_frame, add_audio=True):
    """渲染帧序列并用 ffmpeg 编码为 mp4。"""
    width, height = size
    total_frames = round(duration * fps)
    fonts = (
        _load_font(max(12, height // 24)),
        _load_font(max(28, height // 8)),
        _load_font(max(10, height // 30)),
    )

    tmp_dir = tempfile.mkdtemp(prefix="proxylink_frames_")
    try:
        for i in range(total_frames):
            _render_frame(width, height, i, origin_frame, fps, label, fonts, tmp_dir, i)

        cmd = [
            "ffmpeg", "-y",
            "-framerate", str(fps),
            "-i", os.path.join(tmp_dir, "frame_%06d.png"),
        ]
        if add_audio:
            # 1kHz 正弦音，仅用于让素材带音频流，便于演示流信息展示
            cmd += ["-f", "lavfi", "-i",
                    f"sine=frequency=1000:sample_rate=48000:duration={duration}"]
        cmd += [
            "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
            "-pix_fmt", "yuv420p",
            "-frames:v", str(total_frames),
            "-movflags", "+faststart",
        ]
        if add_audio:
            cmd += ["-c:a", "aac", "-b:a", "96k"]
        cmd.append(path)
        _run_ffmpeg(cmd)
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def generate_all(output_dir, duration=DEFAULT_DURATION, fps=DEFAULT_FPS,
                 short_duration=None, head_shift=None):
    """生成全套测试素材，返回 {逻辑名: 路径}。

    short_duration 缺省为原片的 80%（缺尾 20%），head_shift 缺省为 20%。
    """
    if short_duration is None:
        short_duration = max(0.1, duration * 0.8)
    if head_shift is None:
        head_shift = duration * 0.2
    os.makedirs(output_dir, exist_ok=True)
    paths = {}

    specs = [
        ("original", "original.mp4", ORIGINAL_SIZE, duration, 0,
         "ORIGINAL 1280x720"),
        ("normal", "proxy_normal.mp4", PROXY_SIZE, duration, 0,
         "PROXY NORMAL 640x360"),
        ("short", "proxy_short.mp4", PROXY_SIZE, short_duration, 0,
         "PROXY SHORT missing-tail"),
        ("headshift", "proxy_headshift.mp4", PROXY_SIZE,
         max(0.1, duration - head_shift), round(head_shift * fps),
         "PROXY HEAD-SHIFT missing-head"),
    ]
    for key, name, clip_size, dur, origin, label in specs:
        out = os.path.join(output_dir, name)
        _generate_clip(out, size=clip_size, fps=fps, duration=dur,
                       label=label, origin_frame=origin)
        paths[key] = out
    return paths


def generate_and_register(output_dir, base_dir=".", duration=DEFAULT_DURATION,
                          fps=DEFAULT_FPS):
    """生成素材并在项目中登记、挂接、标定，开箱即用地演示完整流程。"""
    from .project import Project

    head_shift = duration * 0.2
    paths = generate_all(output_dir, duration=duration, fps=fps)
    project = Project(base_dir)

    media = {key: project.register(path) for key, path in paths.items()}

    links = {}
    # 正常代理：单点标定 (0,0)
    lk_normal = project.create_link(media["original"].id, media["normal"].id,
                                    label="正常代理")
    project.calibrate(lk_normal.id, [(0, 0)])
    links["normal"] = lk_normal

    # 缺尾代理：单点标定 (0,0)，覆盖报告会指出尾部不可定位区间
    lk_short = project.create_link(media["original"].id, media["short"].id,
                                   label="缺尾代理")
    project.calibrate(lk_short.id, [(0, 0)])
    links["short"] = lk_short

    # 缺头代理：锚点标定为 原片第 2 秒 ↔ 代理 0 秒
    lk_head = project.create_link(media["original"].id, media["headshift"].id,
                                  label="起点偏移代理")
    project.calibrate(lk_head.id, [(head_shift, 0)])
    links["headshift"] = lk_head

    project.save()
    return {"paths": paths, "media": media, "links": links}
