"""视频读写与编码往返检查。

颜色约定（与 :mod:`lut_tool.lut` 保持一致）
-------------------------------------------
* OpenCV 原生使用 BGR uint8；本模块在边界处统一转换，对外只暴露
  **float64 RGB、归一化 [0,1]**；
* 8-bit 量化采用标准的 ``round(255*x)`` 往返，编解码差异因此可与
  LUT 本身造成的差异区分开；
* 写出前只在最终边界钳位一次，中间处理不做隐式钳位。
"""

from __future__ import annotations

import os
from dataclasses import dataclass

import cv2
import numpy as np

# 编码器预设：名称 -> (fourcc, 容器扩展名)。
CODEC_PRESETS = {
    "mp4v": ("mp4v", ".mp4"),  # 兼容性最好，有损
    "avc1": ("avc1", ".mp4"),  # H.264 系列（若系统提供）
    "FFV1": ("FFV1", ".mkv"),  # 无损，适合精查
}


def bgr_to_rgb_float(frame_bgr: np.ndarray) -> np.ndarray:
    """OpenCV BGR uint8 -> float64 RGB [0,1]。"""
    rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
    return rgb.astype(np.float64) / 255.0


def rgb_float_to_bgr(rgb: np.ndarray) -> np.ndarray:
    """float64 RGB [0,1] -> OpenCV BGR uint8（边界处唯一钳位点）。"""
    clipped = np.clip(rgb, 0.0, 1.0)
    u8 = np.rint(clipped * 255.0).astype(np.uint8)
    return cv2.cvtColor(u8, cv2.COLOR_RGB2BGR)


def quantize_8bit(rgb: np.ndarray) -> np.ndarray:
    """仅做 8-bit 量化再反归一化，用于隔离量化误差（不经编码器）。"""
    u8 = np.rint(np.clip(rgb, 0.0, 1.0) * 255.0).astype(np.uint8)
    return u8.astype(np.float64) / 255.0


@dataclass
class VideoInfo:
    width: int
    height: int
    fps: float
    frame_count: int
    path: str


class VideoReader:
    """顺序/随机读取视频帧，输出 float64 RGB。"""

    def __init__(self, path: str):
        self.path = path
        self._cap = cv2.VideoCapture(path)
        if not self._cap.isOpened():
            raise FileNotFoundError(f"无法打开视频: {path}")
        self.width = int(self._cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        self.height = int(self._cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        self.fps = float(self._cap.get(cv2.CAP_PROP_FPS) or 30.0)
        self.frame_count = int(self._cap.get(cv2.CAP_PROP_FRAME_COUNT))

    def info(self) -> VideoInfo:
        return VideoInfo(
            self.width, self.height, self.fps, self.frame_count, self.path
        )

    def read_frame(self, index: int) -> np.ndarray:
        """随机定位读取一帧（float64 RGB）。"""
        self._cap.set(cv2.CAP_PROP_POS_FRAMES, index)
        ok, frame = self._cap.read()
        if not ok or frame is None:
            raise IndexError(f"读取第 {index} 帧失败（共 {self.frame_count} 帧）")
        return bgr_to_rgb_float(frame)

    def frames(self):
        """逐帧迭代器。"""
        self._cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
        while True:
            ok, frame = self._cap.read()
            if not ok or frame is None:
                break
            yield bgr_to_rgb_float(frame)

    def close(self) -> None:
        self._cap.release()

    def __enter__(self) -> "VideoReader":
        return self

    def __exit__(self, *exc) -> None:
        self.close()


class VideoWriter:
    """把 float64 RGB 帧序列写成视频。"""

    def __init__(self, path: str, fps: float, size: tuple[int, int], codec: str = "mp4v"):
        if codec not in CODEC_PRESETS:
            raise ValueError(f"未知编码器 {codec!r}，可选: {sorted(CODEC_PRESETS)}")
        fourcc, ext = CODEC_PRESETS[codec]
        root, existing = os.path.splitext(path)
        if not existing:
            path = root + ext
        self.path = path
        self.codec = codec
        self._writer = cv2.VideoWriter(
            path, cv2.VideoWriter_fourcc(*fourcc), fps, size
        )
        if not self._writer.isOpened():
            raise OSError(f"编码器 {codec} 无法打开输出: {path}")
        self._count = 0

    def write(self, rgb_frame: np.ndarray) -> None:
        self._writer.write(rgb_float_to_bgr(rgb_frame))
        self._count += 1

    def close(self) -> None:
        self._writer.release()

    def __enter__(self) -> "VideoWriter":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    @property
    def frames_written(self) -> int:
        return self._count


# ---------------------------------------------------------------- 编码往返
@dataclass
class RoundTripReport:
    """编码往返检查结果。

    quant_error:
        仅 8-bit 量化造成的差异（理论下限）。
    codec_error:
        实际解码帧相对 *量化后* 画面的差异，即编码器额外引入的部分。
    total_error:
        解码帧相对原始 float 画面的总差异。
    visible_frames:
        编码误差超过可见阈值的帧号及其峰值，供逐帧精查。
    """

    quant_error: dict
    codec_error: dict
    total_error: dict
    visible_frames: list[tuple[int, float]]
    visible_threshold: float

    def summary(self) -> str:
        return (
            f"量化均值差 {self.quant_error['mean_abs']:.5f} | "
            f"编码附加均值差 {self.codec_error['mean_abs']:.5f} | "
            f"总均值差 {self.total_error['mean_abs']:.5f} | "
            f"可见帧 {len(self.visible_frames)} "
            f"(阈值 {self.visible_threshold:.4f})"
        )


def _error_dict(a: np.ndarray, b: np.ndarray) -> dict:
    per_pixel = np.abs(np.asarray(a) - np.asarray(b))
    return {
        "mean_abs": float(per_pixel.mean()),
        "max_abs": float(per_pixel.max()),
        "mean_per_channel": per_pixel.reshape(-1, 3).mean(axis=0),
    }


def export_and_verify(
    frames: np.ndarray,
    out_path: str,
    fps: float,
    codec: str = "mp4v",
    *,
    visible_threshold: float = 2.0 / 255.0,
) -> tuple[str, RoundTripReport]:
    """写出短片再逐帧读回，量化编码带来的可见差异。

    返回 ``(实际文件路径, 报告)``。读回帧与预览共用同一套 RGB/[0,1]
    颜色约定，因此数值可直接比较。
    """
    frames = np.asarray(frames, dtype=np.float64)
    if frames.ndim != 4 or frames.shape[-1] != 3:
        raise ValueError("frames 形状必须是 (F, H, W, 3)")
    h, w = frames.shape[1:3]

    with VideoWriter(out_path, fps, (w, h), codec) as vw:
        for f in frames:
            vw.write(f)

    quantized = quantize_8bit(frames)

    visible: list[tuple[int, float]] = []
    codec_dicts: list[dict] = []
    total_dicts: list[dict] = []
    quant_dicts: list[dict] = []

    with VideoReader(vw.path) as reader:
        for i in range(frames.shape[0]):
            decoded = reader.read_frame(i)
            q = quantized[i]
            quant_dicts.append(_error_dict(frames[i], q))
            codec_dicts.append(_error_dict(q, decoded))
            total_dicts.append(_error_dict(frames[i], decoded))
            peak = float(np.abs(q - decoded).max())
            if peak > visible_threshold:
                visible.append((i, peak))

    def agg(dicts: list[dict], key: str) -> float:
        return float(np.mean([d[key] for d in dicts]))

    def agg_channel(dicts: list[dict]) -> np.ndarray:
        return np.mean(np.stack([d["mean_per_channel"] for d in dicts]), axis=0)

    quant_error = {
        "mean_abs": agg(quant_dicts, "mean_abs"),
        "max_abs": max(d["max_abs"] for d in quant_dicts),
        "mean_per_channel": agg_channel(quant_dicts),
    }
    codec_error = {
        "mean_abs": agg(codec_dicts, "mean_abs"),
        "max_abs": max(d["max_abs"] for d in codec_dicts),
        "mean_per_channel": agg_channel(codec_dicts),
    }
    total_error = {
        "mean_abs": agg(total_dicts, "mean_abs"),
        "max_abs": max(d["max_abs"] for d in total_dicts),
        "mean_per_channel": agg_channel(total_dicts),
    }

    return vw.path, RoundTripReport(
        quant_error=quant_error,
        codec_error=codec_error,
        total_error=total_error,
        visible_frames=visible,
        visible_threshold=visible_threshold,
    )
