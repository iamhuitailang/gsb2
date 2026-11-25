"""生成本地示例短片: 轻微抖动 / 快速摇摄 / 镜头切换。

不依赖任何外部素材: 用 OpenCV 绘制纹理丰富的“虚拟布景”,
再按已知相机轨迹裁切 / 旋转输出, 因此抖动是合成上去的,
也便于验证防抖算法是否真的把已知抖动消除了。

输出:
    samples/sample_shake.mp4   轻微手持抖动
    samples/sample_pan.mp4     中段快速摇摄(前后带轻微抖动)
    samples/sample_cuts.mp4    4 个镜头硬切, 镜头内带抖动
"""

from __future__ import annotations

import math
import subprocess
from pathlib import Path
from typing import Callable

import cv2
import numpy as np

from .storage import SAMPLES_DIR

OUT_W = 1280
OUT_H = 720
FPS = 30

CLIP_FILES = {
    "shake": "sample_shake.mp4",
    "pan": "sample_pan.mp4",
    "cuts": "sample_cuts.mp4",
}

CLIP_TITLES = {
    "shake": "SLIGHT SHAKE",
    "pan": "FAST PAN",
    "cuts": "SCENE CUTS",
}


# ---------------------------------------------------------------------------
# 虚拟布景
# ---------------------------------------------------------------------------

def _hsv_bgr(h: int, s: int, v: int) -> tuple[int, int, int]:
    px = np.uint8([[[h % 180, s, v]]])
    bgr = cv2.cvtColor(px, cv2.COLOR_HSV2BGR)[0, 0]
    return int(bgr[0]), int(bgr[1]), int(bgr[2])


def build_world(ww: int, wh: int, seed: int, hue: int = 210,
                title: str = "GSB-13926") -> np.ndarray:
    """绘制一张细节丰富、适合角点 / 光流跟踪的大布景。"""
    rng = np.random.default_rng(seed)

    # 纵向渐变背景
    top = np.array(_hsv_bgr(hue, 70, 78), dtype=np.float32)
    bottom = np.array(_hsv_bgr((hue + 18) % 180, 90, 38), dtype=np.float32)
    t = np.linspace(0, 1, wh, dtype=np.float32)[:, None, None]
    img = (top[None, None, :] * (1 - t) + bottom[None, None, :] * t)
    img = np.repeat(img, ww, axis=1).astype(np.uint8)

    # 细网格 + 粗网格
    for x in range(0, ww, 40):
        cv2.line(img, (x, 0), (x, wh), (255, 255, 255), 1, cv2.LINE_AA)
    for y in range(0, wh, 40):
        cv2.line(img, (0, y), (ww, y), (255, 255, 255), 1, cv2.LINE_AA)
    for x in range(0, ww, 200):
        cv2.line(img, (x, 0), (x, wh), (255, 255, 255), 2, cv2.LINE_AA)
        cv2.putText(img, f"X{x}", (x + 6, 34), cv2.FONT_HERSHEY_SIMPLEX,
                    0.8, (235, 235, 235), 2, cv2.LINE_AA)
    for y in range(0, wh, 200):
        cv2.line(img, (0, y), (ww, y), (255, 255, 255), 2, cv2.LINE_AA)
        cv2.putText(img, f"Y{y}", (8, y - 8), cv2.FONT_HERSHEY_SIMPLEX,
                    0.8, (235, 235, 235), 2, cv2.LINE_AA)

    # “楼房”: 色块 + 密集窗户(大量稳定特征)
    n_blocks = 26
    for _ in range(n_blocks):
        bw = int(rng.integers(120, 260))
        bh = int(rng.integers(120, 320))
        x = int(rng.integers(40, ww - bw - 40))
        y = int(rng.integers(80, wh - bh - 60))
        color = _hsv_bgr(int(hue + rng.integers(-25, 25)) % 180,
                         int(rng.integers(90, 160)), int(rng.integers(90, 170)))
        cv2.rectangle(img, (x, y), (x + bw, y + bh), color, -1)
        cv2.rectangle(img, (x, y), (x + bw, y + bh), (30, 30, 30), 3)
        wx0, wy0, gap = 14, 16, 10
        cols = max(2, (bw - 20) // (wx0 + gap))
        rows = max(2, (bh - 20) // (wy0 + gap))
        for r in range(rows):
            for c in range(cols):
                wx = x + 12 + c * (wx0 + gap)
                wy = y + 12 + r * (wy0 + gap)
                lit = bool(rng.random() > 0.35)
                wc = (220, 235, 255) if lit else (60, 70, 90)
                cv2.rectangle(img, (wx, wy), (wx + wx0, wy + wy0), wc, -1)

    # 棋盘格(强角点)
    def checkerboard(cx: int, cy: int, cells: int = 8, sq: int = 18) -> None:
        size = cells * sq
        x0, y0 = cx - size // 2, cy - size // 2
        cv2.rectangle(img, (x0 - 6, y0 - 6), (x0 + size + 6, y0 + size + 6),
                      (20, 20, 20), -1)
        for r in range(cells):
            for c in range(cells):
                if (r + c) % 2 == 0:
                    cv2.rectangle(
                        img,
                        (x0 + c * sq, y0 + r * sq),
                        (x0 + (c + 1) * sq, y0 + (r + 1) * sq),
                        (245, 245, 245), -1,
                    )
        cv2.rectangle(img, (x0, y0), (x0 + size, y0 + size), (0, 0, 0), 3)

    for _ in range(7):
        checkerboard(int(rng.integers(120, ww - 120)),
                     int(rng.integers(120, wh - 120)),
                     cells=int(rng.integers(6, 10)), sq=int(rng.integers(14, 24)))

    # 高对比圆形 / 三角地标
    for _ in range(16):
        cx = int(rng.integers(80, ww - 80))
        cy = int(rng.integers(80, wh - 80))
        r = int(rng.integers(18, 46))
        color = _hsv_bgr(int(rng.integers(0, 179)), 200, 230)
        kind = rng.integers(0, 3)
        if kind == 0:
            cv2.circle(img, (cx, cy), r, color, -1, cv2.LINE_AA)
            cv2.circle(img, (cx, cy), r, (20, 20, 20), 4, cv2.LINE_AA)
        elif kind == 1:
            pts = np.array([[cx, cy - r], [cx - r, cy + r], [cx + r, cy + r]])
            cv2.fillPoly(img, [pts], color, cv2.LINE_AA)
            cv2.polylines(img, [pts], True, (20, 20, 20), 4, cv2.LINE_AA)
        else:
            cv2.drawMarker(img, (cx, cy), (255, 255, 255),
                           cv2.MARKER_CROSS, r * 2, 5)

    # 大标题与边框, 提供大块稳定结构
    cv2.rectangle(img, (60, 60), (ww - 60, 150), (0, 0, 0), -1)
    cv2.putText(img, title, (90, 128), cv2.FONT_HERSHEY_SIMPLEX,
                2.2, (0, 229, 255), 5, cv2.LINE_AA)
    cv2.rectangle(img, (24, 24), (ww - 24, wh - 24), (255, 255, 255), 6)

    # 轻微传感器噪点, 让光流更稳定自然
    noise = rng.normal(0, 3.0, img.shape).astype(np.int16)
    img = np.clip(img.astype(np.int16) + noise, 0, 255).astype(np.uint8)
    return img


# ---------------------------------------------------------------------------
# 相机轨迹与渲染
# ---------------------------------------------------------------------------

def _jitter(t: float, amp: float, seed_phase: float = 0.0) -> tuple[float, float, float]:
    """多频正弦叠加的手持抖动, 返回 (jx_px, jy_px, angle_deg)。"""
    jx = amp * (
        0.65 * math.sin(2 * math.pi * 2.1 * t + 0.3 + seed_phase)
        + 0.35 * math.sin(2 * math.pi * 5.4 * t + 2.0)
        + 0.18 * math.sin(2 * math.pi * 8.3 * t + 4.1)
    )
    jy = amp * (
        0.60 * math.sin(2 * math.pi * 2.7 * t + 2.1 + seed_phase)
        + 0.32 * math.sin(2 * math.pi * 6.3 * t + 1.1)
        + 0.16 * math.sin(2 * math.pi * 9.1 * t + 0.4)
    )
    ja = 0.055 * amp * (
        math.sin(2 * math.pi * 1.8 * t + seed_phase)
        + 0.5 * math.sin(2 * math.pi * 4.9 * t + 1.7)
    )
    return jx, jy, ja


def render_camera_frame(world: np.ndarray, cx: float, cy: float,
                        angle_deg: float,
                        out_w: int = OUT_W, out_h: int = OUT_H) -> np.ndarray:
    """从大布景中按相机中心 / 旋转角取一帧(构造 dst->src 矩阵)。"""
    theta = math.radians(angle_deg)
    ca, sa = math.cos(theta), math.sin(theta)
    # p_world = C + R * (p_out - C_out)
    a00, a01 = ca, -sa
    a10, a11 = sa, ca
    ox, oy = out_w / 2.0, out_h / 2.0
    m02 = cx - (a00 * ox + a01 * oy)
    m12 = cy - (a10 * ox + a11 * oy)
    m = np.array([[a00, a01, m02], [a10, a11, m12]], dtype=np.float32)
    return cv2.warpAffine(
        world, m, (out_w, out_h),
        flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP,
        borderMode=cv2.BORDER_CONSTANT, borderValue=(16, 16, 16),
    )


def _ease_in_out(x: float) -> float:
    return 0.5 - 0.5 * math.cos(math.pi * max(0.0, min(1.0, x)))


def _path_shake(n: int, ww: int, wh: int):
    """轻微抖动片段的逐帧相机参数。"""
    centers, angles = [], []
    for i in range(n):
        t = i / FPS
        cx = ww / 2 + 90 * math.sin(2 * math.pi * t / 13.0)
        cy = wh / 2 + 45 * math.sin(2 * math.pi * t / 9.0 + 1.0)
        jx, jy, ja = _jitter(t, amp=9.0)
        centers.append((cx + jx, cy + jy))
        angles.append(0.25 * math.sin(2 * math.pi * t / 11.0) + ja)
    return centers, angles


def _path_pan(n: int, ww: int, wh: int):
    """快速摇摄片段: 55~105 帧从左侧快速摇到右侧。"""
    centers, angles = [], []
    x0, x1 = ww * 0.30, ww * 0.72
    f_start, f_end = 55, 102
    for i in range(n):
        if i < f_start:
            k = 0.0
        elif i > f_end:
            k = 1.0
        else:
            k = _ease_in_out((i - f_start) / (f_end - f_start))
        cx = x0 + (x1 - x0) * k
        cy = wh / 2 + 30 * math.sin(i / FPS * 0.8)
        jx, jy, ja = _jitter(i / FPS, amp=4.5, seed_phase=1.7)
        centers.append((cx + jx, cy + jy))
        angles.append(ja)
    return centers, angles


def _path_shot(n: int, ww: int, wh: int, shot_idx: int):
    """切换片段中单个镜头的轨迹。"""
    centers, angles = [], []
    rng = np.random.default_rng(100 + shot_idx)
    base_x = ww * float(rng.uniform(0.42, 0.58))
    base_y = wh * float(rng.uniform(0.45, 0.55))
    drift_x = float(rng.uniform(-70, 70))
    for i in range(n):
        t = i / FPS
        cx = base_x + drift_x * (i / n) + 40 * math.sin(2 * math.pi * t / 7 + shot_idx)
        cy = base_y + 25 * math.sin(2 * math.pi * t / 5.5 + shot_idx * 2)
        jx, jy, ja = _jitter(t, amp=8.0, seed_phase=shot_idx * 2.3)
        centers.append((cx + jx, cy + jy))
        angles.append(ja + 0.3 * math.sin(2 * math.pi * t / 8 + shot_idx))
    return centers, angles


# ---------------------------------------------------------------------------
# 编码输出
# ---------------------------------------------------------------------------

def _ffmpeg_writer(path: Path, fps: int = FPS,
                   size: tuple[int, int] = (OUT_W, OUT_H)) -> subprocess.Popen:
    w, h = size
    cmd = [
        "ffmpeg", "-y",
        "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{w}x{h}",
        "-r", str(fps), "-i", "-",
        "-c:v", "libx264", "-preset", "medium", "-crf", "20",
        "-pix_fmt", "yuv420p", "-movflags", "+faststart",
        str(path),
    ]
    return subprocess.Popen(cmd, stdin=subprocess.PIPE,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def _write_clip(path: Path, frame_count: int, frame_fn: Callable[[int], np.ndarray],
                progress: Callable[[float, str], None] | None, label: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    proc = _ffmpeg_writer(path)
    try:
        for i in range(frame_count):
            frame = frame_fn(i)
            assert proc.stdin is not None
            proc.stdin.write(frame.tobytes())
            if progress and i % 10 == 0:
                progress(i / frame_count, f"{label} {i}/{frame_count}")
    finally:
        if proc.stdin:
            proc.stdin.close()
    rc = proc.wait()
    if rc != 0:
        raise RuntimeError(f"ffmpeg 生成示例素材失败: {path.name} (exit {rc})")
    return path


# ---------------------------------------------------------------------------
# 对外入口
# ---------------------------------------------------------------------------

def generate_clip(kind: str, out_dir: Path | None = None,
                  progress: Callable[[float, str], None] | None = None) -> Path:
    out_dir = out_dir or SAMPLES_DIR
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / CLIP_FILES[kind]

    if kind == "shake":
        n = 180
        ww, wh = 1900, 1180
        world = build_world(ww, wh, seed=11, hue=205, title="SLIGHT HANDHELD SHAKE")
        centers, angles = _path_shake(n, ww, wh)

        def frame_fn(i: int) -> np.ndarray:
            return render_camera_frame(world, centers[i][0], centers[i][1], angles[i])

        _write_clip(path, n, frame_fn, progress, "轻微抖动")

    elif kind == "pan":
        n = 210
        ww, wh = 2800, 1000
        world = build_world(ww, wh, seed=29, hue=150, title="FAST PAN SEQUENCE")
        centers, angles = _path_pan(n, ww, wh)

        def frame_fn(i: int) -> np.ndarray:
            return render_camera_frame(world, centers[i][0], centers[i][1], angles[i])

        _write_clip(path, n, frame_fn, progress, "快速摇摄")

    elif kind == "cuts":
        n = 240
        shot_len = 60
        ww, wh = 1900, 1180
        worlds = [
            build_world(ww, wh, seed=101 + k * 7,
                        hue=[205, 12, 140, 275][k],
                        title=f"SCENE {k + 1:02d}")
            for k in range(4)
        ]
        paths = [_path_shot(shot_len, ww, wh, k) for k in range(4)]

        def frame_fn(i: int) -> np.ndarray:
            shot = min(3, i // shot_len)
            j = i - shot * shot_len
            centers, angles = paths[shot]
            return render_camera_frame(worlds[shot], centers[j][0],
                                       centers[j][1], angles[j])

        _write_clip(path, n, frame_fn, progress, "镜头切换")
    else:
        raise ValueError(f"未知素材类型: {kind}")

    if progress:
        progress(1.0, f"已生成 {path.name}")
    return path


def generate_all(progress: Callable[[float, str], None] | None = None) -> list[Path]:
    kinds = ["shake", "pan", "cuts"]
    outputs = []
    for idx, kind in enumerate(kinds):
        def sub_progress(p: float, msg: str, idx: int = idx) -> None:
            if progress:
                progress((idx + p) / len(kinds), msg)
        outputs.append(generate_clip(kind, progress=sub_progress))
    if progress:
        progress(1.0, "全部示例素材生成完成")
    return outputs


def samples_status() -> list[dict]:
    result = []
    for kind, fname in CLIP_FILES.items():
        p = SAMPLES_DIR / fname
        result.append({
            "kind": kind,
            "file": fname,
            "title": CLIP_TITLES[kind],
            "exists": p.exists(),
            "size_kb": round(p.stat().st_size / 1024, 1) if p.exists() else 0,
            "path": str(p),
        })
    return result
