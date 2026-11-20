"""切片核心：网格几何、坐标换算、切片生成、清单导出/校验/还原。

坐标规则（详见 README）：
- 源图坐标：level 0 像素坐标，原点左上，x 向右，y 向下。
- 层级 l 的缩放比为 1/2^l，层级图尺寸 = ceil(W/2^l) x ceil(H/2^l)。
- 瓦片 (l, col, row) 在层级图中的左上角为 (col*step_x, row*step_y)，
  其中 step = tile_size - overlap；瓦片覆盖 tile_w x tile_h（边缘按 edge 模式补透明或裁切）。
- 层级坐标 * 2^l = 源图坐标。
"""

from __future__ import annotations

import hashlib
import json
import math
import os
from dataclasses import dataclass, field, asdict
from pathlib import Path

from PIL import Image

MANIFEST_FORMAT = "maptiler-manifest/1"
TILE_DIR = "tiles"


# ---------------------------------------------------------------- 配置与网格

@dataclass
class TileConfig:
    tile_w: int = 256
    tile_h: int = 256
    overlap: int = 0          # 相邻瓦片共享边缘的像素数（四边对称）
    levels: int = 1           # 缩放层级数，level 0 为原图
    edge: str = "pad"         # pad: 边缘补透明；crop: 边缘裁切为小瓦片

    def __post_init__(self):
        if self.tile_w < 1 or self.tile_h < 1:
            raise ValueError("瓦片宽高必须 >= 1")
        if self.overlap < 0:
            raise ValueError("重叠边缘不能为负")
        if self.overlap >= self.tile_w or self.overlap >= self.tile_h:
            raise ValueError("重叠边缘必须小于瓦片宽高")
        if self.levels < 1:
            raise ValueError("层级数必须 >= 1")
        if self.edge not in ("pad", "crop"):
            raise ValueError("edge 只能是 pad 或 crop")

    @property
    def step_x(self) -> int:
        return self.tile_w - self.overlap

    @property
    def step_y(self) -> int:
        return self.tile_h - self.overlap


def level_size(src_w: int, src_h: int, level: int) -> tuple[int, int]:
    """层级 l 的图像尺寸（缩放比 1/2^l）。"""
    f = 1 << level
    return (max(1, math.ceil(src_w / f)), max(1, math.ceil(src_h / f)))


def grid_dims(level_w: int, level_h: int, cfg: TileConfig) -> tuple[int, int]:
    """该层级的瓦片列数、行数。"""
    def axis(size: int, tile: int, step: int) -> int:
        if size <= tile:
            return 1
        return math.ceil((size - tile) / step) + 1
    return axis(level_w, cfg.tile_w, cfg.step_x), axis(level_h, cfg.tile_h, cfg.step_y)


def tile_level_rect(col: int, row: int, cfg: TileConfig,
                    level_w: int, level_h: int) -> tuple[int, int, int, int]:
    """瓦片在层级图中的矩形 (x, y, w, h)。

    pad 模式：恒为 tile_w x tile_h（可能越出层级图边界，越界部分为透明）。
    crop 模式：贴边裁切，边缘瓦片更小。
    """
    x, y = col * cfg.step_x, row * cfg.step_y
    if cfg.edge == "crop":
        w = min(cfg.tile_w, level_w - x)
        h = min(cfg.tile_h, level_h - y)
    else:
        w, h = cfg.tile_w, cfg.tile_h
    return x, y, w, h


def tile_src_rect(level: int, col: int, row: int, cfg: TileConfig,
                  src_w: int, src_h: int) -> tuple[int, int, int, int]:
    """瓦片对应的源图（level 0）矩形 (x, y, w, h)，已裁剪到源图范围内。"""
    lw, lh = level_size(src_w, src_h, level)
    x, y, w, h = tile_level_rect(col, row, cfg, lw, lh)
    f = 1 << level
    sx, sy = x * f, y * f
    sw = min(w * f, src_w - sx)
    sh = min(h * f, src_h - sy)
    return sx, sy, max(0, sw), max(0, sh)


def tiles_at_point(px: float, py: float, level: int, cfg: TileConfig,
                   src_w: int, src_h: int) -> list[tuple[int, int]]:
    """源图坐标 (px, py) 在指定层级落在哪些瓦片内（重叠区会命中多块）。"""
    lw, lh = level_size(src_w, src_h, level)
    f = 1 << level
    lx, ly = px / f, py / f
    cols, rows = grid_dims(lw, lh, cfg)

    def axis(pos: float, tile: int, step: int, count: int) -> range:
        hi = min(int(pos // step), count - 1)
        lo = max(0, math.ceil((pos - tile + 1) / step))
        return range(lo, hi + 1)

    out = []
    for c in axis(lx, cfg.tile_w, cfg.step_x, cols):
        for r in axis(ly, cfg.tile_h, cfg.step_y, rows):
            out.append((c, r))
    return out


def tiles_in_region(rx: int, ry: int, rw: int, rh: int, level: int,
                    cfg: TileConfig, src_w: int, src_h: int) -> list[tuple[int, int]]:
    """源图矩形区域在指定层级覆盖到的瓦片 (col, row) 列表。"""
    lw, lh = level_size(src_w, src_h, level)
    f = 1 << level
    x0, y0 = rx / f, ry / f
    x1, y1 = (rx + rw) / f, (ry + rh) / f
    cols, rows = grid_dims(lw, lh, cfg)
    out = []
    for c in range(cols):
        tx0, tx1 = c * cfg.step_x, c * cfg.step_x + cfg.tile_w
        if tx1 <= x0 or tx0 >= x1:
            continue
        for r in range(rows):
            ty0, ty1 = r * cfg.step_y, r * cfg.step_y + cfg.tile_h
            if ty1 <= y0 or ty0 >= y1:
                continue
            out.append((c, r))
    return out


# ---------------------------------------------------------------- 清单

def tile_filename(level: int, col: int, row: int) -> str:
    """稳定的相对路径：tiles/<level>/<col>_<row>.png"""
    return f"{TILE_DIR}/{level}/{col}_{row}.png"


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _encode_png(img: Image.Image) -> bytes:
    """确定性 PNG 编码：同一像素内容恒产生同一字节流，保证瓦片内容稳定。"""
    import io
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


@dataclass
class LevelInfo:
    level: int
    scale: float
    width: int
    height: int
    cols: int
    rows: int
    tiles: int


def build_levels(src_w: int, src_h: int, cfg: TileConfig) -> list[LevelInfo]:
    out = []
    for l in range(cfg.levels):
        lw, lh = level_size(src_w, src_h, l)
        cols, rows = grid_dims(lw, lh, cfg)
        out.append(LevelInfo(l, 1.0 / (1 << l), lw, lh, cols, rows, cols * rows))
    return out


def estimate(src_w: int, src_h: int, cfg: TileConfig,
             bytes_per_pixel: float = 0.0) -> dict:
    """预计切片数量与输出体积。bytes_per_pixel<=0 时按 0.35（PNG 典型值）估算。"""
    if bytes_per_pixel <= 0:
        bytes_per_pixel = 0.35
    levels = build_levels(src_w, src_h, cfg)
    per_level = []
    total_tiles = total_bytes = 0
    for li in levels:
        if cfg.edge == "pad":
            pixels = li.tiles * cfg.tile_w * cfg.tile_h
        else:
            pixels = 0
            for c in range(li.cols):
                for r in range(li.rows):
                    _, _, w, h = tile_level_rect(c, r, cfg, li.width, li.height)
                    pixels += w * h
        b = int(pixels * bytes_per_pixel)
        per_level.append({**asdict(li), "est_bytes": b})
        total_tiles += li.tiles
        total_bytes += b
    return {"levels": per_level, "total_tiles": total_tiles, "est_bytes": total_bytes}


# ---------------------------------------------------------------- 切片

def _load_level_image(src: Image.Image, src_w: int, src_h: int, level: int) -> Image.Image:
    lw, lh = level_size(src_w, src_h, level)
    if level == 0 and (src.width, src.height) == (lw, lh):
        return src
    return src.resize((lw, lh), Image.LANCZOS)


def slice_map(src_path: str | Path, out_dir: str | Path, cfg: TileConfig,
              region: tuple[int, int, int, int] | None = None,
              manifest_path: str | Path | None = None,
              progress=None) -> dict:
    """切片并导出清单。

    region: 可选，源图坐标 (x, y, w, h)，只重新生成与其相交的瓦片；
            内容未变化的瓦片不重写（文件名与文件内容保持稳定）。
    manifest_path: 已有清单，region 模式下在其基础上更新。
    返回 manifest dict。
    """
    src_path, out_dir = Path(src_path), Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    src = Image.open(src_path).convert("RGBA")
    src_w, src_h = src.size

    old = None
    if manifest_path and Path(manifest_path).exists():
        old = json.loads(Path(manifest_path).read_text(encoding="utf-8"))
        oc = old["config"]
        if (oc["tile_w"], oc["tile_h"], oc["overlap"], oc["levels"], oc["edge"]) != \
           (cfg.tile_w, cfg.tile_h, cfg.overlap, cfg.levels, cfg.edge):
            raise ValueError("切片参数与已有清单不一致，无法做区域增量更新")
        if (old["source"]["width"], old["source"]["height"]) != (src_w, src_h):
            raise ValueError("源图尺寸与已有清单不一致")

    old_tiles = {}
    if old:
        for t in old["tiles"]:
            old_tiles[(t["level"], t["col"], t["row"])] = t

    tile_entries = []
    written = skipped = 0
    for l in range(cfg.levels):
        lw, lh = level_size(src_w, src_h, l)
        cols, rows = grid_dims(lw, lh, cfg)
        if region is not None:
            wanted = set(tiles_in_region(*region, l, cfg, src_w, src_h))
        else:
            wanted = None
        level_img = None  # 惰性生成
        for c in range(cols):
            for r in range(rows):
                key = (l, c, r)
                if wanted is not None and (c, r) not in wanted:
                    if key in old_tiles:  # 区域外：沿用旧清单条目
                        tile_entries.append(old_tiles[key])
                    continue
                if level_img is None:
                    level_img = _load_level_image(src, src_w, src_h, l)
                x, y, w, h = tile_level_rect(c, r, cfg, lw, lh)
                # 从层级图裁剪；越界部分（pad 模式）保持透明
                box = (x, y, min(x + w, lw), min(y + h, lh))
                tile = Image.new("RGBA", (w, h), (0, 0, 0, 0))
                if box[2] > box[0] and box[3] > box[1]:
                    tile.paste(level_img.crop(box), (0, 0))
                data = _encode_png(tile)
                digest = hashlib.sha256(data).hexdigest()
                rel = tile_filename(l, c, r)
                dest = out_dir / rel
                old_entry = old_tiles.get(key)
                if old_entry and old_entry["sha256"] == digest and dest.exists():
                    skipped += 1  # 内容未变：不重写，保持文件稳定
                else:
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    dest.write_bytes(data)
                    written += 1
                sx, sy, sw, sh = tile_src_rect(l, c, r, cfg, src_w, src_h)
                tile_entries.append({
                    "level": l, "col": c, "row": r, "file": rel,
                    "x": x, "y": y, "width": w, "height": h,
                    "src": [sx, sy, sw, sh], "sha256": digest,
                })
                if progress:
                    progress(l, c, r)

    tile_entries.sort(key=lambda t: (t["level"], t["row"], t["col"]))
    manifest = {
        "format": MANIFEST_FORMAT,
        "source": {
            "file": src_path.name, "width": src_w, "height": src_h,
            "sha256": _sha256_file(src_path),
        },
        "config": asdict(cfg),
        "levels": [asdict(li) for li in build_levels(src_w, src_h, cfg)],
        "tiles": tile_entries,
    }
    (out_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    manifest["_stats"] = {"written": written, "skipped": skipped}
    return manifest


# ---------------------------------------------------------------- 校验与还原

def verify_manifest(manifest_path: str | Path) -> dict:
    """重新导入清单：校验瓦片文件存在且内容（sha256）一致，返回报告。"""
    manifest_path = Path(manifest_path)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("format") != MANIFEST_FORMAT:
        raise ValueError(f"不支持的清单格式: {manifest.get('format')!r}")
    base = manifest_path.parent
    ok, missing, mismatched = [], [], []
    for t in manifest["tiles"]:
        p = base / t["file"]
        if not p.exists():
            missing.append(t)
        elif _sha256_file(p) != t["sha256"]:
            mismatched.append(t)
        else:
            ok.append(t)
    return {"total": len(manifest["tiles"]), "ok": ok,
            "missing": missing, "mismatched": mismatched, "manifest": manifest}


def restore_map(manifest_path: str | Path, level: int, out_path: str | Path) -> Path:
    """按清单把瓦片拼回该层级的完整地图（重叠区像素相同，直接覆盖即可）。"""
    manifest_path = Path(manifest_path)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    base = manifest_path.parent
    li = next(l for l in manifest["levels"] if l["level"] == level)
    canvas = Image.new("RGBA", (li["width"], li["height"]), (0, 0, 0, 0))
    for t in manifest["tiles"]:
        if t["level"] != level:
            continue
        tile = Image.open(base / t["file"]).convert("RGBA")
        # 裁剪到层级图边界内（pad 模式越界的透明边不贴回）
        w = min(t["width"], li["width"] - t["x"])
        h = min(t["height"], li["height"] - t["y"])
        if w > 0 and h > 0:
            canvas.paste(tile.crop((0, 0, w, h)), (t["x"], t["y"]))
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out_path, "PNG")
    return out_path
