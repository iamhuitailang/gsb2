"""视频导出: 逐帧调用 Stabilizer.render_stabilized, 通过 ffmpeg 编码。

预览和导出共用同一个渲染函数, 因此时间位置完全一致。
原片只作为读取来源与(可选的)音轨输入, 绝不会被写入。
"""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Callable

import cv2

from .engine import Stabilizer


def ffmpeg_available() -> bool:
    try:
        subprocess.run(["ffmpeg", "-version"], capture_output=True, timeout=10)
        return True
    except Exception:
        return False


def export_video(
    stab: Stabilizer,
    output_path: str | Path,
    progress: Callable[[float, str], None] | None = None,
    should_cancel: Callable[[], bool] | None = None,
    crf: int = 20,
    matrices: list | None = None,
) -> Path:
    """导出稳定后的 H.264 MP4。若原片有音轨则直接封装 AAC/复制。

    视频帧通过 stdin 以 raw bgr24 送入 ffmpeg, 不产生中间图片。

    matrices 不为 None 时使用这份“点击导出瞬间”的矩阵快照,
    这样即使导出过程中继续拖参数, 本次导出仍严格保持同一套参数,
    不会在一个视频里混用新旧变换。
    """
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    if not ffmpeg_available():
        # 兜底: OpenCV VideoWriter(无音频)
        return _export_with_opencv(stab, output_path, progress, should_cancel)

    w, h, fps, n = stab.width, stab.height, stab.fps, stab.frame_count
    source = stab.analysis["source_path"]
    has_audio = bool(stab.analysis.get("has_audio"))

    cmd = [
        "ffmpeg", "-y",
        "-f", "rawvideo", "-pix_fmt", "bgr24",
        "-s", f"{w}x{h}", "-r", f"{fps:.6f}", "-i", "-",
    ]
    if has_audio:
        # 原片作为第二输入, 仅取音轨
        cmd += ["-i", source]

    cmd += ["-map", "0:v:0"]
    if has_audio:
        cmd += ["-map", "1:a:0?"]

    cmd += [
        "-c:v", "libx264", "-preset", "medium", "-crf", str(crf),
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
    ]
    if has_audio:
        cmd += ["-c:a", "aac", "-b:a", "192k"]

    # 视频管道在第 n 帧结束; -shortest 让音轨与视频等长
    cmd += ["-shortest", str(output_path)]

    proc = subprocess.Popen(
        cmd, stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
    )

    cap = cv2.VideoCapture(source)
    if not cap.isOpened():
        proc.kill()
        raise RuntimeError(f"导出时无法打开原片: {source}")

    try:
        for i in range(n):
            if should_cancel and should_cancel():
                raise RuntimeError("已取消导出")
            ok, frame = cap.read()
            if not ok or frame is None:
                # 与分析帧数不一致时补黑帧, 保证时间轴长度稳定
                frame = None
            if frame is not None:
                if frame.shape[1] != w or frame.shape[0] != h:
                    frame = cv2.resize(frame, (w, h))
                if matrices is not None:
                    idx = min(i, len(matrices) - 1)
                    out_frame = cv2.warpAffine(
                        frame, matrices[idx], (w, h),
                        flags=cv2.INTER_LINEAR,
                        borderMode=cv2.BORDER_CONSTANT,
                        borderValue=(0, 0, 0),
                    )
                else:
                    out_frame = stab.render_stabilized(frame, i)
            else:
                out_frame = _black_frame(w, h)
            assert proc.stdin is not None
            proc.stdin.write(out_frame.tobytes())
            if progress and (i % 3 == 0 or i == n - 1):
                progress((i + 1) / max(n, 1), f"导出帧 {i + 1}/{n}")
    except BrokenPipeError:
        err = proc.stderr.read().decode("utf-8", "ignore")[-2000:] if proc.stderr else ""
        raise RuntimeError(f"ffmpeg 管道中断:\n{err}")
    except Exception:
        # 取消或渲染异常时确保 ffmpeg 不残留
        try:
            proc.kill()
        except Exception:
            pass
        raise
    finally:
        cap.release()
        if proc.stdin:
            try:
                proc.stdin.close()
            except Exception:
                pass

    return_code = proc.wait()
    if return_code != 0:
        err = proc.stderr.read().decode("utf-8", "ignore")[-2000:] if proc.stderr else ""
        raise RuntimeError(f"ffmpeg 导出失败(exit={return_code}):\n{err}")

    if progress:
        progress(1.0, "导出完成")
    return output_path


def _black_frame(w: int, h: int):
    import numpy as np
    return np.zeros((h, w, 3), dtype=np.uint8)


def _export_with_opencv(
    stab: Stabilizer,
    output_path: Path,
    progress,
    should_cancel,
) -> Path:
    """没有 ffmpeg 时的兜底导出(mp4v, 无音轨)。"""
    target = output_path.with_suffix(".mp4")
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    writer = cv2.VideoWriter(str(target), fourcc, stab.fps, (stab.width, stab.height))
    if not writer.isOpened():
        raise RuntimeError("OpenCV VideoWriter 无法创建输出文件")
    cap = cv2.VideoCapture(stab.analysis["source_path"])
    try:
        for i in range(stab.frame_count):
            if should_cancel and should_cancel():
                raise RuntimeError("已取消导出")
            ok, frame = cap.read()
            if not ok:
                frame = _black_frame(stab.width, stab.height)
            writer.write(stab.render_stabilized(frame, i))
            if progress and i % 3 == 0:
                progress((i + 1) / stab.frame_count, f"导出帧 {i + 1}/{stab.frame_count}")
    finally:
        cap.release()
        writer.release()
    return target
