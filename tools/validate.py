#!/usr/bin/env python3
"""校验 GSB2 关卡编辑器导出的 JSON 数据。

用法:
  python3 tools/validate.py <level.json> [<level2.json> ...]

校验内容:
  - 顶层格式字段（format/version/关卡尺寸/tileSize）
  - 图层：id 唯一、cellSize 合法、tiles 长度 == cols*rows、图块编号在图集范围内
  - 图层顺序（数组顺序即渲染顺序）与非空统计
  - 图集：图块 id 唯一、碰撞形状合法、标签为已知标签
退出码: 全部通过 0，任一文件失败 1。
"""
import json
import sys

VALID_SHAPES = {"none", "full", "half-top", "half-bottom",
                "half-left", "half-right", "slope-up", "slope-down"}
KNOWN_TAGS = {"solid", "one-way", "hazard", "ladder", "water", "decoration"}


def validate(path):
    errors = []
    warnings = []
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        return [f"无法读取/解析: {e}"], warnings, None

    def err(msg):
        errors.append(msg)

    if data.get("format") != "gsb2-level":
        err(f"format 应为 'gsb2-level'，实际为 {data.get('format')!r}")
    if data.get("version") != 1:
        err(f"version 应为 1，实际为 {data.get('version')!r}")
    for field in ("width", "height", "tileSize"):
        v = data.get(field)
        if not isinstance(v, int) or isinstance(v, bool) or v < 1:
            err(f"{field} 必须是正整数，实际为 {v!r}")
    layers = data.get("layers")
    if not isinstance(layers, list) or not layers:
        err("layers 必须是非空数组")
    tileset = data.get("tileset")
    defined_ids = set()
    if not isinstance(tileset, dict) or not isinstance(tileset.get("tiles"), list):
        err("tileset.tiles 必须是数组")
    else:
        for t in tileset["tiles"]:
            tid = t.get("id")
            if not isinstance(tid, int):
                err(f"图块 id 非法: {tid!r}")
                continue
            if tid in defined_ids:
                err(f"图块 id 重复: {tid}")
            defined_ids.add(tid)
            shape = t.get("collision")
            if shape not in VALID_SHAPES:
                err(f"图块 {tid} 碰撞形状非法: {shape!r}")
            for tag in t.get("tags", []):
                if tag not in KNOWN_TAGS:
                    warnings.append(f"图块 {tid} 含未知标签 {tag!r}")
    if errors:
        return errors, warnings, None

    seen_layer_ids = set()
    stats = []
    for i, layer in enumerate(layers):
        where = f"图层[{i}]「{layer.get('name', '?')}」"
        lid = layer.get("id")
        if not lid:
            err(f"{where} 缺少 id")
        elif lid in seen_layer_ids:
            err(f"{where} id 重复: {lid}")
        seen_layer_ids.add(lid)

        cs = layer.get("cellSize")
        if not isinstance(cs, int) or cs < 1:
            err(f"{where} cellSize 非法: {cs!r}")
            continue
        cols, rows = layer.get("cols"), layer.get("rows")
        tiles = layer.get("tiles")
        if not isinstance(cols, int) or not isinstance(rows, int) or cols < 0 or rows < 0:
            err(f"{where} cols/rows 非法")
            continue
        if not isinstance(tiles, list) or len(tiles) != cols * rows:
            err(f"{where} tiles 长度 {len(tiles) if isinstance(tiles, list) else '?'} "
                f"与 cols*rows ({cols * rows}) 不符")
            continue
        origin = layer.get("origin", [0, 0])
        if not (isinstance(origin, list) and len(origin) == 2
                and all(isinstance(v, (int, float)) for v in origin)):
            err(f"{where} origin 应为 [x, y] 数值数组")

        nonempty = 0
        colliding = 0
        for t in tiles:
            if not isinstance(t, int) or isinstance(t, bool) or t < 0:
                err(f"{where} 含非法图块编号: {t!r}")
                break
            if t:
                nonempty += 1
                if t not in defined_ids:
                    warnings.append(f"{where} 使用了图集中未定义的编号 {t}")
                else:
                    shape = next(x["collision"] for x in tileset["tiles"] if x["id"] == t)
                    if shape != "none":
                        colliding += 1
        stats.append((i, layer.get("name"), cs, cols, rows, nonempty, colliding))

    if errors:
        return errors, warnings, None

    summary = [f"关卡「{data.get('name')}」 {data['width']}×{data['height']} 格"
               f"（{data['width'] * data['tileSize']}×{data['height'] * data['tileSize']}px），"
               f"{len(layers)} 个图层（数组顺序即渲染顺序，先底后顶）:"]
    for i, name, cs, cols, rows, nonempty, colliding in stats:
        summary.append(f"  [{i}] {name}: 格子 {cs}px, {cols}×{rows}, "
                       f"非空 {nonempty} 格, 含碰撞 {colliding} 格")
    summary.append(f"图集定义 {len(defined_ids)} 个图块")
    return [], warnings, "\n".join(summary)


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    ok = True
    for path in argv[1:]:
        errors, warnings, summary = validate(path)
        print(f"== {path}")
        if errors:
            ok = False
            for e in errors:
                print(f"  错误: {e}")
        for w in warnings:
            print(f"  警告: {w}")
        if summary:
            print(summary)
        if not errors:
            print("  ✓ 校验通过")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
