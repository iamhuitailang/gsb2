"""ISO BMFF (MP4/MOV) tkhd 显示矩阵读写。

ffmpeg 8 移除了旧的 rotate 元数据标签与 display_matrix bsf, 而真实手机素材
普遍在 tkhd box 的 3x3 matrix 字段里携带旋转/镜像信息。这里实现一个只依赖
标准库的最小 box 解析器, 用于:
  1. 给自带测试素材写入旋转矩阵 (模拟手机录像);
  2. 读取/清除任意 MP4 的显示矩阵 (导出复检时确认播放器不会再多转一次)。

定点格式: 矩阵每个元素是 16.16 有符号定点 (除最后一个 w=1.0=0x10000)。
"""

from __future__ import annotations

import struct

CONTAINERS = {
    b"moov", b"trak", b"mdia", b"minf", b"stbl",
    b"edts", b"dinf", b"mvex", b"moof", b"traf",
}


class BoxError(RuntimeError):
    pass


def _iter_boxes(data: bytes, start: int, end: int):
    p = start
    while p + 8 <= end:
        size = struct.unpack(">I", data[p:p + 4])[0]
        typ = data[p + 4:p + 8]
        hdr = 8
        if size == 1:  # largesize
            size = struct.unpack(">Q", data[p + 8:p + 16])[0]
            hdr = 16
        elif size == 0:  # 延伸到文件尾
            size = end - p
        if size < hdr or p + size > end:
            raise BoxError(f"box {typ!r} 尺寸异常 @ {p}")
        yield p, size, typ, hdr
        p += size


def _find_tkhd(data: bytes) -> tuple[int, int, int]:
    """返回第一个 trak 的 (tkhd_offset, size, header_len)。"""
    for mo in _iter_boxes(data, 0, len(data)):
        if mo[2] != b"moov":
            continue
        for tr in _iter_boxes(data, mo[0] + 8, mo[0] + mo[1]):
            if tr[2] != b"trak":
                continue
            for box in _iter_boxes(data, tr[0] + 8, tr[0] + tr[1]):
                if box[2] == b"tkhd":
                    return box[0], box[1], box[3]
    raise BoxError("未找到 tkhd box")


def _matrix_offset(data: bytes, tkhd_off: int, hdr: int) -> int:
    ver = data[tkhd_off + hdr]
    # version+flags=4; v0 后固定字段 36 字节到矩阵, v1 为 48 字节
    # v0: c/m(8) id/res(8) dur(4) res(8) layer/alt/vol/res(8) = 36
    # v1: c/m(16) id/res(8) dur(8) res(8) layer/alt/vol/res(8) = 48
    return tkhd_off + hdr + 4 + (36 if ver == 0 else 48)


def read_matrix(path: str) -> tuple[float, ...]:
    with open(path, "rb") as f:
        data = f.read()
    off, _sz, hdr = _find_tkhd(data)
    moff = _matrix_offset(data, off, hdr)
    vals = struct.unpack(">9i", data[moff:moff + 36])
    return tuple(v / 65536.0 for v in vals)


def write_rotation(path: str, cw_deg: int, flip: bool = False) -> None:
    """写入显示矩阵。cw_deg 为顺时针角度 (0/90/180/270), flip 为水平镜像。

    BMFF 矩阵作用于 y 轴朝下的图像坐标系。角度->纯旋转矩阵值的映射已经过
    ffmpeg autorotate 实测核对; flip 时左乘水平镜像矩阵 H=(-1,0;0,1),
    组合后行列式为 -1, 读取端据此识别镜像。
    """
    rot = {
        0: (1, 0, 0, 1),
        90: (0, 1, -1, 0),
        180: (-1, 0, 0, -1),
        270: (0, -1, 1, 0),
    }[cw_deg % 360]
    if not flip:
        a, b, c, d = rot
    else:
        # H * R: H=(-1,0;0,1) -> 对 R 的第一行取负
        ra, rb, rc, rd = rot
        a, b, c, d = -ra, -rb, rc, rd
    # 布局 [a b u; c d v; x y w], 前 8 个元素从浮点系数转 16.16 定点,
    # 最后一个 w 固定为 1.0 的定点表示 0x10000
    fixed = [int(round(v * 65536)) for v in (a, b, 0, c, d, 0, 0, 0)]
    vals = tuple(fixed) + (0x10000,)
    with open(path, "rb") as f:
        data = bytearray(f.read())
    off, _sz, hdr = _find_tkhd(data)
    moff = _matrix_offset(data, off, hdr)
    data[moff:moff + 36] = struct.pack(">9i", *vals)
    with open(path, "wb") as f:
        f.write(data)


def clear_matrix(path: str) -> None:
    """把显示矩阵重置为单位矩阵 (去除旋转/镜像提示)。"""
    write_rotation(path, 0, flip=False)
