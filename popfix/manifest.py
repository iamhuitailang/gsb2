"""修补清单(manifest)。

清单是整个工具的工作底稿: 检测结果写进去, 手工调整也改它, 修复只认它。
因此它可以在原音上随时重开继续工作。区域字段:

  id           稳定编号(手工新增不与旧 id 冲突)
  start/end    样本号, 左闭右开
  channels     受影响声道
  source       auto(检测) / manual(手工)
  enabled      只修 enabled=True 的区域
  padding_ms   该区域专用处理宽度(覆盖全局 config.padding_ms)
  peak_score   检测打分(手工区域为 null)
"""

from __future__ import annotations

import json
from pathlib import Path

from .detect import DEFAULTS, detect_file

MANIFEST_VERSION = 1


def new_manifest(wav_path: str | Path, sr: int, channels: int,
                 frames: int, params: dict | None = None) -> dict:
    config = {**DEFAULTS, **(params or {})}
    return {
        "version": MANIFEST_VERSION,
        # 原样保留路径(相对或绝对), 读取时由 resolve_wav 解析,
        # 这样清单随素材目录整体移动后仍可重开
        "wav": str(wav_path),
        "sample_rate": sr,
        "channels": channels,
        "frames": frames,
        "config": config,
        "regions": [],
    }


def resolve_wav(manifest: dict, manifest_path: str | Path | None = None) -> Path:
    """解析清单记录的 wav 路径。

    优先按记录路径直接打开; 若是相对路径且打不开(常见于整个素材目录
    被挪过位置), 退回相对清单文件所在目录解析。
    """
    wav = Path(manifest["wav"])
    if wav.exists():
        return wav
    if manifest_path is not None and not wav.is_absolute():
        candidate = Path(manifest_path).resolve().parent / wav
        if candidate.exists():
            return candidate
    return wav


def load_manifest(path: str | Path) -> dict:
    path = Path(path)
    m = json.loads(path.read_text(encoding="utf-8"))
    if m.get("version") != MANIFEST_VERSION:
        raise ValueError(f"清单版本不兼容: {m.get('version')}")
    _validate(m)
    return m


def save_manifest(manifest: dict, path: str | Path) -> None:
    _validate(manifest)
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2),
        encoding="utf-8")


def _validate(m: dict) -> None:
    n = m["frames"]
    nch = m["channels"]
    for r in m["regions"]:
        if not (0 <= r["start"] < r["end"] <= n):
            raise ValueError(f"区域 {r['id']} 越界: {r['start']}..{r['end']} / {n}")
        if not r["channels"] or any(c < 0 or c >= nch for c in r["channels"]):
            raise ValueError(f"区域 {r['id']} 声道非法: {r['channels']}")


def _next_id(regions: list[dict]) -> int:
    return max((r["id"] for r in regions), default=0) + 1


def rescan(manifest: dict, wav_path: str | Path | None = None) -> dict:
    """按当前 config 参数重新检测, 替换全部区域(手工修改会被覆盖, 命令行会提示)。"""
    wav_path = wav_path or resolve_wav(manifest)
    regions = detect_file(wav_path, manifest["config"])
    manifest["regions"] = regions
    return manifest


def add_region(manifest: dict, start: int, end: int,
               channels: list[int]) -> dict:
    """手工新增选区(允许与已有区域重叠, 修复时会按区间处理)。"""
    manifest["regions"].append({
        "id": _next_id(manifest["regions"]),
        "start": int(start),
        "end": int(end),
        "channels": sorted(channels),
        "sources": list(channels),
        "peak_score": None,
        "source": "manual",
        "enabled": True,
        "padding_ms": None,
    })
    _validate(manifest)
    return manifest


def remove_region(manifest: dict, region_id: int) -> dict:
    before = len(manifest["regions"])
    manifest["regions"] = [r for r in manifest["regions"] if r["id"] != region_id]
    if len(manifest["regions"]) == before:
        raise KeyError(f"没有编号 {region_id} 的区域")
    return manifest


def trim_region(manifest: dict, region_id: int, start: int | None = None,
                end: int | None = None) -> dict:
    """修改区域边界; 传入的样本号为 None 表示保持不变。"""
    r = _find(manifest, region_id)
    if start is not None:
        r["start"] = int(start)
    if end is not None:
        r["end"] = int(end)
    r["source"] = "manual"
    _validate(manifest)
    return manifest


def set_channels(manifest: dict, region_id: int,
                 channels: list[int]) -> dict:
    r = _find(manifest, region_id)
    r["channels"] = sorted(channels)
    r["source"] = "manual"
    _validate(manifest)
    return manifest


def set_enabled(manifest: dict, region_id: int, enabled: bool) -> dict:
    _find(manifest, region_id)["enabled"] = bool(enabled)
    return manifest


def set_padding(manifest: dict, region_id: int | None,
                padding_ms: float | None) -> dict:
    """调整处理宽度。region_id 给 None 时改全局默认。"""
    if region_id is None:
        manifest["config"]["padding_ms"] = padding_ms
    else:
        _find(manifest, region_id)["padding_ms"] = padding_ms
    return manifest


def remerge(manifest: dict, gap_ms: float | None = None) -> dict:
    """按新的间隔重新合并现有区域(保留手工标记与启用状态)。"""
    if gap_ms is not None:
        manifest["config"]["merge_gap_ms"] = float(gap_ms)
    gap = int(round(manifest["config"]["merge_gap_ms"] / 1000.0
                    * manifest["sample_rate"]))
    from .detect import _merge_intervals

    raw = [(r["start"], r["end"], {
        "channels": r["channels"], "sources": [r["id"]],
        "peak_score": r["peak_score"] or 0.0,
    }) for r in manifest["regions"]]
    old = {r["id"]: r for r in manifest["regions"]}
    merged = _merge_intervals(raw, gap)
    out = []
    for idx, (s, e, info) in enumerate(merged):
        members = [old[rid] for rid in info["sources"] if rid in old]
        out.append({
            "id": idx + 1,
            "start": int(s),
            "end": int(e),
            "channels": info["channels"],
            "sources": info["sources"],
            "peak_score": round(info["peak_score"], 2),
            "source": "manual" if any(m["source"] == "manual" for m in members)
            else "auto",
            "enabled": all(m["enabled"] for m in members),
            "padding_ms": next((m["padding_ms"] for m in members
                                if m["padding_ms"] is not None), None),
        })
    manifest["regions"] = out
    return manifest


def _find(manifest: dict, region_id: int) -> dict:
    for r in manifest["regions"]:
        if r["id"] == region_id:
            return r
    raise KeyError(f"没有编号 {region_id} 的区域")
