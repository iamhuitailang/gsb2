"""配置文件（JSON）与 PNG 序列导出；导出后可回读校验像素完全一致。"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass

import numpy as np

from .model import FrameParams
from .rawio import RawFile
from .render import render_crop
from .png import write_png

CONFIG_VERSION = 1


@dataclass
class ExportResult:
    out_dir: str
    config_path: str
    png_files: list[str]
    params: FrameParams
    source_sha256: str


def save_config(path: str, source_path: str, params: FrameParams,
                crop: tuple[int, int, int, int] | None = None,
                extra: dict | None = None) -> str:
    cfg = {
        "version": CONFIG_VERSION,
        "source": os.path.abspath(source_path),
        "params": params.to_dict(),
        "crop": list(crop) if crop else None,
        "source_sha256": None,
    }
    if extra:
        cfg.update(extra)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    return path


def load_config(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    if cfg.get("version") != CONFIG_VERSION:
        raise ValueError(f"配置版本不兼容: {cfg.get('version')}")
    cfg["params"] = FrameParams.from_dict(cfg["params"])
    return cfg


def export_png_sequence(source_path: str, params: FrameParams, out_dir: str,
                        frame_indices: list[int],
                        crop: tuple[int, int, int, int] | None = None,
                        tag: str = "") -> ExportResult:
    """导出指定完整帧的 PNG 序列 + 参数配置 + manifest。

    导出只读取源文件；行尾填充字节永远不会进入 PNG（PNG 只含有效像素）。
    """
    os.makedirs(out_dir, exist_ok=True)
    png_files: list[str] = []
    with RawFile(source_path, params) as rf:
        scan = rf.scan
        bad = [i for i in frame_indices if i >= scan.complete_frames]
        if bad:
            raise ValueError(
                f"帧 {bad} 不是完整帧（该参数下只有 {scan.complete_frames} 个完整帧）")
        sha = rf.sha256()
        manifest_frames = []
        for i in frame_indices:
            planes = rf.read_planes(i)
            rgb, miss, (cw, ch) = render_crop(params, planes, crop, zoom=1)
            name = f"frame_{i:04d}{('_' + tag) if tag else ''}.png"
            dst = os.path.join(out_dir, name)
            write_png(dst, rgb)
            png_files.append(dst)
            manifest_frames.append({
                "frame": i, "png": name, "size": [cw, ch],
                "missing_pixels": int(miss.sum()),
            })

    cfg_path = os.path.join(out_dir, "export_config.json")
    save_config(cfg_path, source_path, params, crop, extra={
        "source_sha256": sha,
        "exported_frames": manifest_frames,
        "frame_size_bytes": scan.frame_size,
        "complete_frames": scan.complete_frames,
        "note": "PNG 只包含有效像素字节；行尾填充不写入图像，见 params.stride_*",
    })
    with open(os.path.join(out_dir, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump({"frames": manifest_frames, "source_sha256": sha},
                  f, ensure_ascii=False, indent=2)
    return ExportResult(out_dir, cfg_path, png_files, params, sha)


def verify_export(config_path: str) -> dict:
    """按导出配置重新打开源文件并逐像素比对，确认回读结果一致。"""
    cfg = load_config(config_path)
    params: FrameParams = cfg["params"]
    crop = tuple(cfg["crop"]) if cfg.get("crop") else None
    with RawFile(cfg["source"], params) as rf:
        if cfg.get("source_sha256"):
            actual = rf.sha256()
            if actual != cfg["source_sha256"]:
                raise ValueError("源文件 SHA256 与导出时不一致，文件已被改动")
        mismatches = []
        for item in cfg["exported_frames"]:
            i = item["frame"]
            planes = rf.read_planes(i)
            rgb, _, _ = render_crop(params, planes, crop, zoom=1)
            png_rgb = _read_png_flat(
                os.path.join(os.path.dirname(config_path), item["png"]))
            if not np.array_equal(rgb, png_rgb):
                mismatches.append(i)
    return {"ok": not mismatches, "mismatched_frames": mismatches,
            "checked": [x["frame"] for x in cfg["exported_frames"]]}


def _read_png_flat(path: str) -> np.ndarray:
    """最小 PNG 读取器（仅支持本工具导出的 8-bit truecolor PNG）。"""
    import struct
    import zlib
    with open(path, "rb") as f:
        data = f.read()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("不是 PNG 文件")
    pos, width, height = 8, 0, 0
    idat = bytearray()
    while pos < len(data):
        length = struct.unpack(">I", data[pos:pos + 4])[0]
        ctype = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + length]
        if ctype == b"IHDR":
            width, height, bit, color = struct.unpack(">IIBB", body[:10])
            if bit != 8 or color != 2:
                raise ValueError("verify 仅支持 8-bit RGB PNG")
        elif ctype == b"IDAT":
            idat.extend(body)
        pos += 12 + length
    raw = zlib.decompress(bytes(idat))
    stride = width * 3
    out = np.zeros((height, width, 3), np.uint8)
    for r in range(height):
        line_start = r * (stride + 1)
        if raw[line_start] != 0:
            raise ValueError("不支持的 PNG filter")
        out[r] = np.frombuffer(raw[line_start + 1:line_start + 1 + stride],
                               dtype=np.uint8).reshape(width, 3)
    return out
