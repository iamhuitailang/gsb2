"""核心数据模型：帧参数、平面几何、像素溯源、文件扫描结果。"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Optional

from . import FORMATS, COLOR_RANGES


@dataclass(frozen=True)
class PlaneGeom:
    """一个平面（或交错平面）在单帧内的几何布局。

    cols/rows 是有效采样列数/行数；bpp 是每个采样占用字节数
    （NV12 的 UV 交错平面 bpp=2，RGBA bpp=4），stride 是每行实际占用字节，
    offset 是平面起点相对帧首的字节偏移。
    """

    name: str
    cols: int
    rows: int
    bpp: int
    stride: int
    offset: int

    @property
    def valid_row_bytes(self) -> int:
        return self.cols * self.bpp

    @property
    def row_padding(self) -> int:
        return self.stride - self.valid_row_bytes

    @property
    def size(self) -> int:
        return self.stride * self.rows

    @property
    def end(self) -> int:
        return self.offset + self.size


@dataclass(frozen=True)
class FrameParams:
    """一组原始帧解释参数。

    stride_y / stride_uv 传 0 表示按格式自动推导（无行填充）。
    """

    width: int
    height: int
    fmt: str = "i420"
    stride_y: int = 0
    stride_uv: int = 0
    color_range: str = "limited"  # YUV 专用：limited(BT.601 电视范围) / full

    def validate(self) -> None:
        if self.fmt not in FORMATS:
            raise ValueError(f"不支持的像素格式: {self.fmt!r}，可选 {FORMATS}")
        if self.width <= 0 or self.height <= 0:
            raise ValueError("宽高必须为正整数")
        if self.color_range not in COLOR_RANGES:
            raise ValueError(f"色彩范围必须是 {COLOR_RANGES} 之一")
        sy, suv = self.resolved_strides()
        need_y = self.width * (4 if self.fmt == "rgba" else 1)
        if sy < need_y:
            raise ValueError(f"stride_y={sy} 小于一行有效字节 {need_y}")
        if self.fmt in ("i420", "nv12"):
            cw = (self.width + 1) // 2
            need_uv = cw * (2 if self.fmt == "nv12" else 1)
            if suv < need_uv:
                raise ValueError(f"stride_uv={suv} 小于色度一行有效字节 {need_uv}")

    def resolved_strides(self) -> tuple[int, int]:
        """返回 (亮度行字节, 色度行字节)；0 表示自动推导。"""
        cw = (self.width + 1) // 2
        if self.fmt == "rgba":
            sy = self.stride_y or self.width * 4
            return sy, 0
        sy = self.stride_y or self.width
        suv = self.stride_uv or (cw * 2 if self.fmt == "nv12" else cw)
        return sy, suv

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "FrameParams":
        known = {f for f in cls.__dataclass_fields__}  # type: ignore[attr-defined]
        return cls(**{k: v for k, v in d.items() if k in known})


@dataclass(frozen=True)
class TraceEntry:
    """一个像素的某次取值来自文件的哪里。"""

    label: str            # 例如 "Y" / "U" / "V" / "R" / "UV 交错对"
    plane: str
    sample_x: int         # 平面内采样坐标（色度为色度采样坐标）
    sample_y: int
    frame_rel_offset: int  # 相对帧首的字节偏移
    length: int = 1       # 读取字节数（NV12 的 UV 对=2，RGBA=4）
    sub_offsets: tuple[int, ...] = ()  # length>1 时各通道在块内的偏移
    coverage: Optional[tuple[int, int, int, int]] = None  # 色度覆盖的亮度像素矩形 (x0,y0,x1,y1)


@dataclass
class PartialFrame:
    """末帧不完整时的诊断信息。"""

    index: int
    present_bytes: int
    first_missing_abs: int       # 文件中第一个读不到的字节绝对偏移
    location: str                # 人类可读位置，如 "平面 V 第 1 行"
    image_valid_complete: bool   # 虽然缺字节，但缺的是否全是行尾填充


@dataclass
class FileScan:
    """按给定参数扫描文件得到的布局结论。"""

    file_size: int
    frame_size: int
    complete_frames: int
    leftover: int
    partial: Optional[PartialFrame] = None

    @property
    def safe_frame_count(self) -> int:
        """可安全读取的完整帧数。"""
        return self.complete_frames
