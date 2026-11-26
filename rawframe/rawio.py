"""只读原始帧 IO：扫描完整帧数、按帧读平面、按绝对偏移溯源取值。

RawFile 永远以 rb 打开源文件；工具的任何参数调整都不会写回源文件。
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass

import numpy as np

from .model import FileScan, FrameParams, TraceEntry
from .layout import frame_size, planes_of, diagnose_partial


class RawFile:
    def __init__(self, path: str, params: FrameParams):
        params.validate()
        self.path = path
        self.params = params
        self._fh = open(path, "rb")
        self._fh.seek(0, 2)
        self.file_size = self._fh.tell()
        self.frame_size = frame_size(params)
        self.scan = self._scan()

    # ---- 生命周期 ----------------------------------------------------------
    def close(self) -> None:
        if not self._fh.closed:
            self._fh.close()

    def __enter__(self) -> "RawFile":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    # ---- 扫描 --------------------------------------------------------------
    def _scan(self) -> FileScan:
        n, leftover = divmod(self.file_size, self.frame_size)
        partial = None
        if leftover:
            partial = diagnose_partial(
                self.params, n, leftover, self.frame_size)
        return FileScan(
            file_size=self.file_size,
            frame_size=self.frame_size,
            complete_frames=n,
            leftover=leftover,
            partial=partial,
        )

    # ---- 读取 --------------------------------------------------------------
    def _read_frame_bytes(self, index: int) -> bytes:
        """读取一帧的原始字节；末帧不完整时返回较短的 bytes（零填充由上层做）。"""
        if index < 0 or index > self.scan.complete_frames:
            raise IndexError(
                f"帧 {index} 不存在（完整帧 0..{self.scan.complete_frames - 1}，"
                f"另有截断帧 {self.scan.complete_frames}）")
        self._fh.seek(index * self.frame_size)
        return self._fh.read(self.frame_size)

    def read_planes(self, index: int) -> dict[str, np.ndarray]:
        """按平面返回二维 uint8 数组；不足部分用 0 填充，并附 _present 掩码。

        交错平面（NV12 的 UV、RGBA）保持交错，最后一维是 bpp。
        同时写入 planes['_present']：bool 数组，True 表示该字节真实存在。
        """
        raw = self._read_frame_bytes(index)
        present_len = len(raw)
        buf = raw + b"\x00" * (self.frame_size - present_len)
        frame_base = index * self.frame_size
        out: dict[str, np.ndarray] = {}
        present: dict[str, np.ndarray] = {}
        for g in planes_of(self.params):
            chunk = np.frombuffer(
                buf, dtype=np.uint8, count=g.size, offset=g.offset)
            # 平面内第 r 字节真实存在 ⇔ frame_base + offset + r < file_size
            limit = self.file_size - (frame_base + g.offset)
            mask1d = np.arange(g.size) < limit
            if g.bpp == 1:
                arr = chunk.reshape(g.rows, g.stride)[:, :g.cols].copy()
                mask = mask1d.reshape(g.rows, g.stride)[:, :g.cols].copy()
            else:
                arr = chunk.reshape(g.rows, g.stride)
                arr = arr[:, :g.valid_row_bytes].reshape(g.rows, g.cols, g.bpp).copy()
                mask = (mask1d.reshape(g.rows, g.stride)[:, :g.valid_row_bytes]
                        .reshape(g.rows, g.cols, g.bpp).copy())
            out[g.name] = arr
            present[g.name] = mask
        out["_present"] = present
        return out

    def read_trace(self, index: int, entries: list[TraceEntry]) -> list[dict]:
        """按溯源条目读出真实字节值；文件中不存在时 value=None。"""
        result = []
        for e in entries:
            abs_off = index * self.frame_size + e.frame_rel_offset
            vals: list[int | None] = []
            for k in range(e.length):
                if abs_off + k < self.file_size:
                    self._fh.seek(abs_off + k)
                    vals.append(self._fh.read(1)[0])
                else:
                    vals.append(None)
            result.append({"entry": e, "abs_offset": abs_off, "values": vals})
        return result

    def sha256(self) -> str:
        h = hashlib.sha256()
        self._fh.seek(0)
        for chunk in iter(lambda: self._fh.read(1 << 20), b""):
            h.update(chunk)
        return h.hexdigest()
