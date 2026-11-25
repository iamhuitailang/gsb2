"""生成样例横片: 带编号的方块代表两个人, 含镜头硬切 / 框消失 / 安全区。

全部用 ffmpeg 原生滤镜合成 (drawtext 在本机 ffmpeg 不可用, 编号用
drawbox 拼七段数码管), 同时输出与视频严格对应的 tracks.json。
"""
from __future__ import annotations

from pathlib import Path
from typing import Optional

from .ffmpegutil import dump_json, run_ffmpeg
from .model import KF, Rect, SafeZone, Shot, Track
from .tracks import TracksDoc
from .ffmpegutil import fmt_float

WIDTH, HEIGHT, FPS = 1280, 720, 30
SHOT_LEN = 6.0
BLOCK_W, BLOCK_H = 150, 210
BOTTOM_BAND = 96          # 底部字幕带(安全区)高度

# 七段数码管: 段名 -> (x 偏移, y 偏移, w, h), 竖段加长以覆盖连接处
_SEG_GEOM = {
    "a": (18, 8, 44, 8),
    "b": (58, 16, 8, 50),
    "c": (58, 70, 8, 50),
    "d": (18, 114, 44, 8),
    "e": (14, 70, 8, 50),
    "f": (14, 16, 8, 50),
    "g": (18, 61, 44, 8),
}
_DIGIT_SEG = {
    "1": "bc", "2": "abged",
}


def _block_pos(shot: int, who: int, t_local: float) -> Optional[tuple[int, int]]:
    """返回方块左上角像素坐标; None 表示该时刻框消失。"""
    if shot == 0:
        if who == 1:
            # 1 号: 左 -> 右匀速
            x = 140 + 700 * (t_local / SHOT_LEN)
            y = 250
        else:
            # 2 号: 3~4.2s 暂时出画 (无数据), 其余时间在右侧小范围移动
            if 3.0 <= t_local < 4.2:
                return None
            x = 930 + 40 * _sin(t_local)
            y = 260
    else:
        if who == 1:
            # 限制在画面中部摆动, 避免和左下角字幕安全区的硬约束互相冲突
            x = 430 + 90 * _sin(t_local * 1.3)
            y = 240
        else:
            # 2 号: 在右侧小范围向左移动, 全程和右侧字幕安全区共处一个竖裁框
            x = 1000 - 180 * (t_local / SHOT_LEN)
            y = 250
    return int(round(x)), int(round(y))


def _sin(t: float) -> float:
    import math
    return math.sin(t * 2.0)


def _motion_expr(shot: int, who: int, axis: str) -> str:
    """把 _block_pos 的轨迹编译成 ffmpeg 表达式 (每镜头内时间从 0 起)。

    样例轨迹在镜头内均为线性 (或正弦小幅摆动), 直接写成闭式表达式,
    避免逐帧 if 链; 与 _block_pos 共用同一组参数。
    """
    if axis == "y":
        return fmt_float(_block_pos(shot, who, 0.0)[1])
    if shot == 0:
        if who == 1:
            v0 = _block_pos(0, 1, 0.0)[0]
            v1 = _block_pos(0, 1, SHOT_LEN)[0]
            return f"{fmt_float(v0)}+{fmt_float((v1 - v0) / SHOT_LEN)}*t"
        # p2: x = 930 + 40*sin(2t)
        return f"930+40*sin(2*t)"
    if who == 1:
        return "430+90*sin(1.3*t)"
    v0 = _block_pos(1, 2, 0.0)[0]
    v1 = _block_pos(1, 2, SHOT_LEN)[0]
    return f"{fmt_float(v0)}+{fmt_float((v1 - v0) / SHOT_LEN)}*t"


def _visible_enable(shot: int, who: int) -> str:
    """drawbox enable 表达式: 该方块当前是否在画 (滤镜层逗号需转义)。"""
    if shot == 0 and who == 2:
        return "enable='not(between(t\\,3.0\\,4.2))'"
    return ""


def _seven_segment_boxes(shot: int, who: int, digit: str) -> list[str]:
    """编号方块内的七段数码管, 每段一个白色 drawbox, 跟随方块移动。"""
    box_x = _motion_expr(shot, who, "x")
    box_y = _motion_expr(shot, who, "y")
    enable = _visible_enable(shot, who)
    boxes = []
    for seg, (sx, sy, sw, sh) in _SEG_GEOM.items():
        if seg not in _DIGIT_SEG[digit]:
            continue
        suffix = f":{enable}" if enable else ""
        boxes.append(
            f"drawbox=x='({box_x})+{sx}':y='({box_y})+{sy}':"
            f"w={sw}:h={sh}:color=white:t=fill{suffix}"
        )
    return boxes


def _block_box(shot: int, who: int, color: str) -> str:
    box_x = _motion_expr(shot, who, "x")
    box_y = _motion_expr(shot, who, "y")
    enable = _visible_enable(shot, who)
    suffix = f":{enable}" if enable else ""
    return (
        f"drawbox=x='{box_x}':y='{box_y}':w={BLOCK_W}:"
        f"h={BLOCK_H}:color={color}:t=fill{suffix}"
    )


def _shot_chain(shot: int) -> str:
    """单个镜头的视频滤镜链 (输入为 color 源, 时间从 0 起)。"""
    chain = ["setsar=1"]
    # 底部字幕带 + 顶部分隔线, 标识安全区
    chain.append(
        f"drawbox=x=0:y={HEIGHT - BOTTOM_BAND}:w={WIDTH}:h={BOTTOM_BAND}:"
        f"color=0x1f2d50:t=fill"
    )
    chain.append(f"drawbox=x=0:y={HEIGHT - BOTTOM_BAND - 6}:w={WIDTH}:h=6:color=red@0.7:t=fill")
    chain.append(_block_box(shot, 1, "0xe0a800"))      # 1 号 黄
    chain.append(_block_box(shot, 2, "0x2e8b57"))      # 2 号 绿
    # 编号必须在方块之后绘制, 否则会被方块填充覆盖
    chain.extend(_seven_segment_boxes(shot, 1, "1"))
    chain.extend(_seven_segment_boxes(shot, 2, "2"))
    return ",".join(chain)


def generate(out_dir: str | Path, prefix: str = "sample") -> dict[str, str]:
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    video_path = out_dir / f"{prefix}.mp4"
    tracks_path = out_dir / f"{prefix}_tracks.json"

    total = SHOT_LEN * 2
    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error"]
    # 两个 color 源 + 两段正弦音
    for _ in range(2):
        cmd += ["-f", "lavfi", "-i", f"color=c=0xf2f2f2:s={WIDTH}x{HEIGHT}:r={FPS}:d={SHOT_LEN}"]
    cmd += ["-f", "lavfi", "-i", f"sine=frequency=300:duration={SHOT_LEN}:sample_rate=48000"]
    cmd += ["-f", "lavfi", "-i", f"sine=frequency=380:duration={SHOT_LEN}:sample_rate=48000"]

    fc = (
        f"[0:v]{_shot_chain(0)}[v0];"
        f"[1:v]{_shot_chain(1)}[v1];"
        f"[v0][2:a][v1][3:a]concat=n=2:v=1:a=1[v][a]"
    )
    cmd += [
        "-filter_complex", fc, "-map", "[v]", "-map", "[a]",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart", str(video_path),
    ]
    run_ffmpeg(cmd)

    doc = _build_tracks_doc(video_path.name, total)
    dump_json(doc.to_dict(), tracks_path)
    return {"video": str(video_path), "tracks": str(tracks_path)}


def _build_tracks_doc(source: str, total: float) -> TracksDoc:
    # 每 0.25s 一个关键帧, 与滤镜表达式同一套位置函数
    step = 0.25
    tracks: list[Track] = []
    # 2 号设为必留对象 (会短暂出画又回来, 用于演示 required 约束);
    # 1 号为普通对象。必留与安全区不可兼得的极端场景由单测覆盖。
    for who, label, required in ((1, "1号", False), (2, "2号", True)):
        kfs: list[KF] = []
        n = int(total / step) + 1
        for i in range(n):
            t = round(i * step, 6)
            shot = 0 if t < SHOT_LEN else 1
            local = t - shot * SHOT_LEN
            pos = _block_pos(shot, who, local)
            if pos is None:
                kfs.append(KF(t, None))
            else:
                x, y = pos
                kfs.append(KF(t, Rect(x / WIDTH, y / HEIGHT, BLOCK_W / WIDTH, BLOCK_H / HEIGHT)))
        tracks.append(Track(id=f"p{who}", label=label, required=required, keyframes=kfs))

    shots = [
        Shot(0.0, SHOT_LEN, "cut"),
        Shot(SHOT_LEN, total, "cut"),
    ]
    # 字幕安全区放在右下角 2 号活动区域内, 竖裁框跟随 2 号时全程可同时容纳,
    # 演示可满足的硬约束; 安全区与必留人物隔得太远导致不可兼得的极端
    # 场景由单测 test_safe_zone_full_width_conflict_warns 覆盖。
    zones = [
        SafeZone(
            Rect(0.70, (HEIGHT - BOTTOM_BAND) / HEIGHT, 0.12, BOTTOM_BAND / HEIGHT),
            name="字幕安全区",
        )
    ]
    # 轮流讲话: 每人 2s 一段, 切点附近换人
    speakers = {
        "p1": [[0.0, 2.0], [4.2, 6.0], [8.0, 10.0]],
        "p2": [[2.0, 4.2], [6.0, 8.0], [10.0, 12.0]],
    }
    cfg = {
        "motion": {
            "max_speed_px_s": 360.0,
            "hysteresis_px": 42.0,
            "dwell_s": 0.45,
            "margin_frac": 0.12,
            "no_data": "hold",
        }
    }
    return TracksDoc(
        source=source, width=WIDTH, height=HEIGHT, fps=FPS, duration=total,
        tracks=tracks, shots=shots, safe_zones=zones, speakers=speakers, config=cfg,
    )
