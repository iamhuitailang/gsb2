"""纯 Python 的 ISO-BMFF 盒子解析层。

只实现抢救 fMP4 所需的最小子集:
- 顶层盒子遍历(支持 32 位 / 64 位 largesize,识别被截断的盒子)
- moov 中的 mvhd / trak(mdhd/hdlr/tkhd) / mvex(trex)
- moof 中的 mfhd / traf(tfhd/tfdt/trun)

解析器不抛异常表示"文件坏了",而是返回带 status 的结构,
让上层决定如何报告与抢救。
"""

from __future__ import annotations

import struct
from dataclasses import dataclass, field

# 容器盒子:子盒子紧跟在自身盒子头之后
CONTAINER_TYPES = {
    b"moov", b"trak", b"mdia", b"minf", b"stbl", b"dinf",
    b"mvex", b"moof", b"traf", b"edts", b"udta", b"mfra",
}

# tfhd flags
TFHD_BASE_DATA_OFFSET = 0x000001
TFHD_SAMPLE_DESC = 0x000002
TFHD_DEFAULT_SAMPLE_DURATION = 0x000008
TFHD_DEFAULT_SAMPLE_SIZE = 0x000010
TFHD_DEFAULT_SAMPLE_FLAGS = 0x000020
TFHD_DURATION_IS_EMPTY = 0x010000
TFHD_DEFAULT_BASE_IS_MOOF = 0x020000

# trun flags
TRUN_DATA_OFFSET = 0x000001
TRUN_FIRST_SAMPLE_FLAGS = 0x000004
TRUN_SAMPLE_DURATION = 0x000100
TRUN_SAMPLE_SIZE = 0x000200
TRUN_SAMPLE_FLAGS = 0x000400
TRUN_SAMPLE_CTS_OFFSET = 0x000800


class BoxError(Exception):
    """盒子结构无法按 fMP4 解释时抛出。"""


@dataclass
class Box:
    type: bytes
    offset: int           # 盒子头在文件中的绝对偏移
    header_size: int      # 8 或 16(largesize)
    size: int             # 盒子声明的完整大小
    data: bytes           # 盒子载荷(不含头);截断时为实际能读到的部分
    children: list["Box"] = field(default_factory=list)

    @property
    def end(self) -> int:
        return self.offset + self.size

    @property
    def payload_start(self) -> int:
        return self.offset + self.header_size

    def find(self, box_type: bytes) -> "Box | None":
        for child in self.children:
            if child.type == box_type:
                return child
        return None

    def find_all(self, box_type: bytes) -> list["Box"]:
        return [c for c in self.children if c.type == box_type]


@dataclass
class TruncatedBox:
    """声明的盒子体超出文件末尾 —— 崩溃写了一半的盒子。"""

    type: bytes
    offset: int
    header_size: int
    declared_size: int          # 盒子头里声称的大小(0 表示 open-ended)
    available_payload: bytes    # 实际能读到的字节(不含头)

    @property
    def end(self) -> int:
        return self.offset + self.header_size + len(self.available_payload)


@dataclass
class TopLevel:
    """顶层扫描结果。"""

    boxes: list[Box]
    truncated: TruncatedBox | None
    trailing_bytes: int  # 连一个完整盒子头都凑不齐的尾部字节数


def _iter_boxes(buf: bytes, start: int, end: int) -> list:
    """遍历一层盒子,容器自动递归;遇到截断返回已解析部分 + TruncatedBox。"""
    result: list = []
    off = start
    while off < end:
        if end - off < 8:
            return result  # 残余不足一个盒子头,由调用方统计 trailing
        size, btype = struct.unpack(">I4s", buf[off:off + 8])
        header = 8
        if size == 1:  # largesize
            if end - off < 16:
                raise BoxError(f"@{off}: largesize 盒子头被截断")
            size = struct.unpack(">Q", buf[off + 8:off + 16])[0]
            header = 16
        if size == 0:  # box extends to EOF
            size = end - off
        if size < header:
            raise BoxError(f"@{off}: 盒子 {btype!r} 声明大小 {size} 小于盒子头")
        box_end = off + size
        if box_end > end:
            payload = buf[off + header:end]
            result.append(TruncatedBox(btype, off, header, size, payload))
            return result
        payload = buf[off + header:box_end]
        box = Box(type=btype, offset=off, header_size=header, size=size, data=payload)
        if btype in CONTAINER_TYPES:
            box.children = _iter_boxes(buf, off + header, box_end)
        result.append(box)
        off = box_end
    return result


def parse_top_level(data: bytes) -> TopLevel:
    """扫描整个文件的顶层盒子。"""
    boxes = _iter_boxes(data, 0, len(data))
    truncated = None
    if boxes and isinstance(boxes[-1], TruncatedBox):
        truncated = boxes.pop()
        # 截断盒子的残片属于"半个盒子",不算无主残余字节
        consumed = len(data)
    else:
        consumed = boxes[-1].end if boxes else 0
    return TopLevel(
        boxes=boxes,
        truncated=truncated,
        trailing_bytes=len(data) - consumed,
    )


# ---------- 具体盒子字段解析 ----------

def _version_flags(box: Box) -> tuple[int, int]:
    return box.data[0], int.from_bytes(box.data[1:4], "big")


@dataclass
class TkhdInfo:
    track_id: int
    width: float
    height: float


def parse_tkhd(box: Box) -> TkhdInfo:
    version = box.data[0]
    p = 4
    p += 8 if version == 1 else 4           # creation_time
    p += 8 if version == 1 else 4           # modification_time
    track_id = struct.unpack(">I", box.data[p:p + 4])[0]
    p += 4                                  # track_id
    p += 4                                  # reserved
    p += 8 if version == 1 else 4           # duration
    p += 8                                  # reserved
    p += 2 + 2 + 2                          # layer / alt_group / volume
    p += 2                                  # reserved
    p += 36                                 # matrix
    width, height = struct.unpack(">II", box.data[p:p + 8])
    return TkhdInfo(track_id, width / 65536.0, height / 65536.0)


@dataclass
class MdhdInfo:
    timescale: int
    duration: int          # 媒体时长(timescale 单位);0 表示未知
    version: int


def parse_mdhd(box: Box) -> MdhdInfo:
    version = box.data[0]
    p = 4
    if version == 1:
        p += 16
        timescale = struct.unpack(">I", box.data[p:p + 4])[0]
        duration = struct.unpack(">Q", box.data[p + 4:p + 12])[0]
    else:
        p += 8
        timescale = struct.unpack(">I", box.data[p:p + 4])[0]
        duration = struct.unpack(">I", box.data[p + 4:p + 8])[0]
    return MdhdInfo(timescale, duration, version)


def parse_hdlr(box: Box) -> str:
    # version/flags(4) + pre_defined(4) + handler_type(4)
    handler = box.data[8:12]
    return {b"vide": "video", b"soun": "audio", b"hint": "hint"}.get(
        handler, handler.decode("latin1", "replace")
    )


@dataclass
class TrexInfo:
    track_id: int
    default_sample_duration: int
    default_sample_size: int
    default_sample_flags: int


def parse_trex(box: Box) -> TrexInfo:
    # version/flags(4) + track_id(4) + desc_idx(4) + duration/size/flags(各4)
    track_id, desc_idx, dur, size, flags = struct.unpack(">IIIII", box.data[4:24])
    return TrexInfo(track_id, dur, size, flags)


@dataclass
class MfhdInfo:
    sequence_number: int


def parse_mfhd(box: Box) -> MfhdInfo:
    return MfhdInfo(struct.unpack(">I", box.data[4:8])[0])


@dataclass
class TfhdInfo:
    track_id: int
    flags: int
    default_sample_duration: int | None
    default_sample_size: int | None
    default_sample_flags: int | None
    base_data_offset: int | None


def parse_tfhd(box: Box) -> TfhdInfo:
    version, flags = _version_flags(box)
    p = 4
    track_id = struct.unpack(">I", box.data[p:p + 4])[0]
    p += 4
    base_data_offset = None
    if flags & TFHD_BASE_DATA_OFFSET:
        base_data_offset = struct.unpack(">Q", box.data[p:p + 8])[0]
        p += 8
    if flags & TFHD_SAMPLE_DESC:
        p += 4
    dur = struct.unpack(">I", box.data[p:p + 4])[0] if flags & TFHD_DEFAULT_SAMPLE_DURATION else None
    if flags & TFHD_DEFAULT_SAMPLE_DURATION:
        p += 4
    size = struct.unpack(">I", box.data[p:p + 4])[0] if flags & TFHD_DEFAULT_SAMPLE_SIZE else None
    if flags & TFHD_DEFAULT_SAMPLE_SIZE:
        p += 4
    sflags = struct.unpack(">I", box.data[p:p + 4])[0] if flags & TFHD_DEFAULT_SAMPLE_FLAGS else None
    return TfhdInfo(track_id, flags, dur, size, sflags, base_data_offset)


@dataclass
class TfdtInfo:
    base_media_decode_time: int
    version: int


def parse_tfdt(box: Box) -> TfdtInfo:
    version = box.data[0]
    if version == 1:
        value = struct.unpack(">Q", box.data[4:12])[0]
    else:
        value = struct.unpack(">I", box.data[4:8])[0]
    return TfdtInfo(value, version)


@dataclass
class TrunSample:
    duration: int | None
    size: int | None
    flags: int | None
    cts_offset: int | None


@dataclass
class TrunInfo:
    flags: int
    data_offset: int | None
    samples: list[TrunSample]


def parse_trun(box: Box) -> TrunInfo:
    version, flags = _version_flags(box)
    p = 4
    count = struct.unpack(">I", box.data[p:p + 4])[0]
    p += 4
    data_offset = None
    if flags & TRUN_DATA_OFFSET:
        data_offset = struct.unpack(">i", box.data[p:p + 4])[0]
        p += 4
    if flags & TRUN_FIRST_SAMPLE_FLAGS:
        p += 4
    samples: list[TrunSample] = []
    signed_cts = version == 0 and bool(flags & TRUN_SAMPLE_CTS_OFFSET)
    for _ in range(count):
        duration = struct.unpack(">I", box.data[p:p + 4])[0] if flags & TRUN_SAMPLE_DURATION else None
        if flags & TRUN_SAMPLE_DURATION:
            p += 4
        size = struct.unpack(">I", box.data[p:p + 4])[0] if flags & TRUN_SAMPLE_SIZE else None
        if flags & TRUN_SAMPLE_SIZE:
            p += 4
        sflags = struct.unpack(">I", box.data[p:p + 4])[0] if flags & TRUN_SAMPLE_FLAGS else None
        if flags & TRUN_SAMPLE_FLAGS:
            p += 4
        cts = None
        if flags & TRUN_SAMPLE_CTS_OFFSET:
            cts = (
                struct.unpack(">i", box.data[p:p + 4])[0]
                if signed_cts
                else struct.unpack(">I", box.data[p:p + 4])[0]
            )
            p += 4
        samples.append(TrunSample(duration, size, sflags, cts))
    return TrunInfo(flags, data_offset, samples)
