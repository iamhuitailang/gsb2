"""程序生成的演示样例：彩条、单像素标记、末帧截断、行填充、尾部垃圾、错行宽。

所有样例同时生成 i420 / nv12 / rgba 三种物理布局（内容相同），
因此可以直接把同一个彩条分别按两种色度布局解释，观察“认反”后的颜色。
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass

import numpy as np

from .color import rgb_to_yuv_limited
from .model import FrameParams
from .layout import frame_size

# SMPTE 风格 8 色彩条（不含 alpha 时按 RGB 处理）
BAR_RGB = [
    (192, 192, 192),  # 灰
    (192, 192, 0),    # 黄
    (0, 192, 192),    # 青
    (0, 192, 0),      # 绿
    (192, 0, 192),    # 品红
    (192, 0, 0),      # 红
    (0, 0, 192),      # 蓝
    (0, 0, 0),        # 黑
]
PAD_BYTE = 0xEE  # 行填充固定字节，方便在溯源里一眼认出
TRAILER_BYTE = 0xAB


@dataclass
class SampleSpec:
    key: str
    filename: str
    params: FrameParams
    frames: int
    description: str
    extra: dict


def _bar_image(w: int, h: int, frame_index: int = 0) -> np.ndarray:
    """8 条竖彩条；偶数帧标准彩条，奇数帧整体下移一条，便于序列对比。"""
    img = np.zeros((h, w, 3), np.uint8)
    shift = frame_index % len(BAR_RGB)
    for x in range(w):
        bar = (x * len(BAR_RGB)) // w
        img[:, x] = BAR_RGB[(bar + shift) % len(BAR_RGB)]
    return img


def _marker_image(w: int, h: int) -> np.ndarray:
    """灰底 + 红/蓝两个单像素（选在非 2 对齐处，突出色度共享与 U/V 不对称）。"""
    img = np.full((h, w, 3), (90, 90, 90), np.uint8)
    img[min(h - 1, 2), min(w - 1, 3)] = (255, 0, 0)  # 红：Cr 拉高
    img[min(h - 1, 2), min(w - 1, 4)] = (0, 0, 255)  # 蓝：Cb 拉高
    return img


def _frame_planes(img: np.ndarray, fmt: str) -> dict[str, np.ndarray]:
    h, w, _ = img.shape
    cw, ch = (w + 1) // 2, (h + 1) // 2
    if fmt == "rgba":
        rgba = np.zeros((h, w, 4), np.uint8)
        rgba[:, :, :3] = img
        rgba[:, :, 3] = 255
        return {"RGBA": rgba}

    y = np.zeros((h, w), np.uint8)
    u = np.zeros((ch, cw), np.uint8)
    v = np.zeros((ch, cw), np.uint8)
    for yy in range(h):
        for xx in range(w):
            y[yy, xx] = rgb_to_yuv_limited(*img[yy, xx])[0]
    # 色度是 2x2 块的平均（奇数宽高的边缘块只平均实际存在的像素）
    for cy in range(ch):
        for cx in range(cw):
            x0, y0, x1, y1 = cx * 2, cy * 2, min(cx * 2 + 2, w), min(cy * 2 + 2, h)
            block = img[y0:y1, x0:x1].reshape(-1, 3).mean(axis=0)
            _, uv, vv = rgb_to_yuv_limited(*(int(round(c)) for c in block))
            u[cy, cx], v[cy, cx] = uv, vv
    if fmt == "i420":
        return {"Y": y, "U": u, "V": v}
    uv = np.empty((ch, cw, 2), np.uint8)
    uv[:, :, 0], uv[:, :, 1] = u, v
    return {"Y": y, "UV": uv}


def _frame_bytes(params: FrameParams, frames: list[dict[str, np.ndarray]]) -> bytes:
    """按 params 的 stride 把多帧平面序列化为真实文件字节。"""
    from .layout import planes_of
    out = bytearray()
    for planes in frames:
        for g in planes_of(params):
            arr = planes[g.name]
            for row in range(g.rows):
                out.extend(arr[row].tobytes())
                out.extend(bytes([PAD_BYTE]) * g.row_padding)
    return bytes(out)


def _write_planar(path: str, frames: list[dict[str, np.ndarray]],
                  params: FrameParams) -> None:
    with open(path, "wb") as f:
        f.write(_frame_bytes(params, frames))


def _build(params: FrameParams, images: list[np.ndarray]) -> list[dict[str, np.ndarray]]:
    return [_frame_planes(img, params.fmt) for img in images]


def generate_all(out_dir: str) -> list[SampleSpec]:
    """在 out_dir 生成全部样例并写 manifest.json，返回样例清单。"""
    os.makedirs(out_dir, exist_ok=True)
    specs: list[SampleSpec] = []
    w, h, n = 16, 8, 4  # 偶数尺寸的标准彩条
    images = [_bar_image(w, h, i) for i in range(n)]

    for fmt in ("i420", "nv12", "rgba"):
        p = FrameParams(width=w, height=h, fmt=fmt)
        fn = f"bars_{fmt}_{w}x{h}_{n}f.raw"
        _write_planar(os.path.join(out_dir, fn), _build(p, images), p)
        specs.append(SampleSpec(
            key=f"bars_{fmt}", filename=fn, params=p, frames=n,
            description=f"标准 8 色彩条，{fmt} 物理布局，{n} 帧",
            extra={"kind": "bars"}))

    # 单像素标记：i420 与 nv12 各一份，可交叉解释看色度认反
    mw, mh = 8, 6
    marker = _marker_image(mw, mh)
    for fmt in ("i420", "nv12"):
        p = FrameParams(width=mw, height=mh, fmt=fmt)
        fn = f"marker_{fmt}_{mw}x{mh}.raw"
        _write_planar(os.path.join(out_dir, fn), _build(p, [marker]), p)
        specs.append(SampleSpec(
            key=f"marker_{fmt}", filename=fn, params=p, frames=1,
            description="灰底红/蓝单像素（" + fmt +
                        "），交叉解释可复现 U/V 色度布局认反",
            extra={"kind": "marker", "marker_xy": [[3, 2], [4, 2]]}))

    # 奇数宽高彩条：验证色度覆盖范围
    ow, oh = 15, 7
    p = FrameParams(width=ow, height=oh, fmt="i420")
    fn = f"bars_odd_{ow}x{oh}.raw"
    _write_planar(os.path.join(out_dir, fn), _build(p, [_bar_image(ow, oh)]), p)
    specs.append(SampleSpec(
        key="bars_odd", filename=fn, params=p, frames=1,
        description="奇数宽高(15x7)彩条，最右/最下色度采样只覆盖 1 个亮度像素",
        extra={"kind": "bars_odd"}))

    # 行填充：stride 比有效宽度多 4 字节
    pw, ph = 16, 8
    p_pad = FrameParams(width=pw, height=ph, fmt="i420",
                        stride_y=pw + 4, stride_uv=pw // 2 + 4)
    fn = f"padded_i420_{pw}x{ph}.raw"
    _write_planar(os.path.join(out_dir, fn), _build(p_pad, images[:2]), p_pad)
    specs.append(SampleSpec(
        key="padded_i420", filename=fn, params=p_pad, frames=2,
        description="带行尾填充(每行+4字节, 0xEE)的 i420，错设 stride 会出现斜切",
        extra={"kind": "padded", "pad_byte": PAD_BYTE}))

    # 末帧截断 + 尾部垃圾：完整 3 帧 + 第 4 帧的一半 + 8 字节尾部
    p = FrameParams(width=w, height=h, fmt="i420")
    fn = f"truncated_i420_{w}x{h}.raw"
    good_bytes = _frame_bytes(p, _build(p, images[:3]))
    partial_frame = _frame_bytes(p, _build(p, [images[3]]))
    half = frame_size(p) // 2
    data = bytearray(good_bytes)
    data.extend(partial_frame[:half])
    data.extend(bytes([TRAILER_BYTE]) * 8)
    with open(os.path.join(out_dir, fn), "wb") as f:
        f.write(data)
    specs.append(SampleSpec(
        key="truncated_i420", filename=fn, params=p, frames=3,
        description="3 个完整帧 + 截断的第 4 帧 + 8 字节尾部垃圾(0xAB)",
        extra={"kind": "truncated", "trailer_bytes": 8,
               "trailer_byte": TRAILER_BYTE}))

    # 错行宽演示文件：物理上是 18 宽，若按 16 宽解释会斜切
    rw, rh = 18, 8
    p_real = FrameParams(width=rw, height=rh, fmt="nv12")
    fn = f"wrongstride_nv12_real{rw}x{rh}.raw"
    _write_planar(os.path.join(out_dir, fn),
                  _build(p_real, [_bar_image(rw, rh)]), p_real)
    specs.append(SampleSpec(
        key="wrongstride_nv12", filename=fn, params=p_real, frames=1,
        description="物理宽度 18 的 NV12；故意按 16 宽解释可看到逐行斜切",
        extra={"kind": "wrongstride", "wrong_width": 16}))

    manifest = [
        {"key": s.key, "filename": s.filename, "params": s.params.to_dict(),
         "frames": s.frames, "description": s.description, "extra": s.extra}
        for s in specs
    ]
    with open(os.path.join(out_dir, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    return specs
