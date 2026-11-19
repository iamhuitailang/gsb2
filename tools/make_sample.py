#!/usr/bin/env python3
"""生成示例关卡 sample/level.json 与 sample/sample-level.js（编辑器内置加载用）。

用法: python3 tools/make_sample.py
"""
import json
import os

# 图块编号（与 js/tileset.js 中 TILE_DEFS 一致）
GRASS, DIRT, STONE, BRICK, WOOD, METAL = 1, 2, 3, 4, 5, 6
SPIKES, WATER, LADDER, CLOUD, CRATE = 7, 8, 9, 10, 11
SLOPE_UP, SLOPE_DOWN, MOUNTAIN, FLOWER = 12, 13, 14, 15

TILE_SIZE = 16
W, H = 60, 20  # 关卡尺寸（基准格）


def make_layer(name, cell_size, lid):
    cols = W * TILE_SIZE // cell_size
    rows = H * TILE_SIZE // cell_size
    return {
        "id": lid,
        "name": name,
        "cellSize": cell_size,
        "origin": [0, 0],
        "cols": cols,
        "rows": rows,
        "visible": True,
        "opacity": 1,
        "tiles": [0] * (cols * rows),
    }


def put(layer, x, y, tid):
    if 0 <= x < layer["cols"] and 0 <= y < layer["rows"]:
        layer["tiles"][y * layer["cols"] + x] = tid


def fill(layer, x0, y0, x1, y1, tid):
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            put(layer, x, y, tid)


def build():
    bg = make_layer("背景", 32, "layer-bg")
    terrain = make_layer("地形", 16, "layer-terrain")
    deco = make_layer("装饰", 16, "layer-deco")

    # ---- 背景层（32px 格子）：远山与云 ----
    for x in (2, 3, 9, 10, 11, 18, 24, 25):
        put(bg, x, 6, MOUNTAIN)
    for x in (4, 12, 13, 21, 27):
        put(bg, x, 7, MOUNTAIN)
    for (x, y) in [(3, 1), (10, 2), (16, 1), (22, 2), (27, 1)]:
        put(bg, x, y, CLOUD)

    # ---- 地形层（16px 格子）----
    fill(terrain, 0, 15, W - 1, 15, GRASS)          # 地表草皮
    fill(terrain, 0, 16, W - 1, H - 1, DIRT)        # 地下泥土
    fill(terrain, 28, 15, 31, H - 1, 0)             # 水坑（挖空）
    fill(terrain, 28, 17, 31, 18, WATER)            # 坑内水体
    fill(terrain, 28, 19, 31, 19, SPIKES)           # 坑底尖刺
    fill(terrain, 10, 13, 12, 14, STONE)            # 石块障碍
    put(terrain, 18, 11, BRICK)                     # 悬浮砖块
    put(terrain, 19, 11, BRICK)
    put(terrain, 21, 11, BRICK)
    fill(terrain, 34, 12, 37, 12, WOOD)             # 木平台（单向）
    fill(terrain, 40, 9, 43, 9, WOOD)
    fill(terrain, 46, 6, 48, 6, WOOD)
    put(terrain, 52, 14, SLOPE_UP)                  # 斜坡
    put(terrain, 53, 13, SLOPE_UP)
    put(terrain, 54, 12, SLOPE_DOWN)
    fill(terrain, 55, 14, 57, 14, METAL)            # 金属块

    # ---- 装饰层（16px 格子）----
    put(deco, 8, 14, CRATE)
    put(deco, 9, 14, CRATE)
    put(deco, 9, 13, CRATE)
    fill(deco, 43, 10, 43, 14, LADDER)              # 通往高台的梯子
    put(deco, 5, 14, FLOWER)
    put(deco, 24, 14, FLOWER)
    put(deco, 50, 14, FLOWER)

    level = {
        "format": "gsb2-level",
        "version": 1,
        "name": "示例关卡",
        "tileSize": TILE_SIZE,
        "width": W,
        "height": H,
        "layers": [bg, terrain, deco],  # 数组顺序 = 渲染顺序（先底后顶）
        "tileset": {
            "srcSize": 32,
            "tiles": [
                {"id": 1, "name": "草地", "color": "#4caf50", "collision": "full", "tags": ["solid"]},
                {"id": 2, "name": "泥土", "color": "#8d6e63", "collision": "full", "tags": ["solid"]},
                {"id": 3, "name": "石块", "color": "#9e9e9e", "collision": "full", "tags": ["solid"]},
                {"id": 4, "name": "砖块", "color": "#c0543c", "collision": "full", "tags": ["solid"]},
                {"id": 5, "name": "木平台", "color": "#c8956c", "collision": "half-top", "tags": ["one-way"]},
                {"id": 6, "name": "金属块", "color": "#78909c", "collision": "full", "tags": ["solid"]},
                {"id": 7, "name": "尖刺", "color": "#cfd8dc", "collision": "half-bottom", "tags": ["hazard"]},
                {"id": 8, "name": "水", "color": "#2196f3", "collision": "none", "tags": ["water"]},
                {"id": 9, "name": "梯子", "color": "#a1887f", "collision": "none", "tags": ["ladder"]},
                {"id": 10, "name": "云", "color": "#eceff1", "collision": "none", "tags": ["decoration"]},
                {"id": 11, "name": "箱子", "color": "#ffb300", "collision": "full", "tags": ["solid"]},
                {"id": 12, "name": "斜坡/", "color": "#7e57c2", "collision": "slope-up", "tags": ["solid"]},
                {"id": 13, "name": "斜坡\\", "color": "#5e35b1", "collision": "slope-down", "tags": ["solid"]},
                {"id": 14, "name": "远山", "color": "#546e7a", "collision": "none", "tags": ["decoration"]},
                {"id": 15, "name": "花", "color": "#e91e63", "collision": "none", "tags": ["decoration"]},
            ],
        },
    }
    return level


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.dirname(here)
    level = build()

    json_path = os.path.join(root, "sample", "level.json")
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(level, f, ensure_ascii=False, indent=1)

    js_path = os.path.join(root, "sample", "sample-level.js")
    with open(js_path, "w", encoding="utf-8") as f:
        f.write("/* 内置示例关卡（由 tools/make_sample.py 生成，与 sample/level.json 一致） */\n")
        f.write("window.SAMPLE_LEVEL = ")
        json.dump(level, f, ensure_ascii=False)
        f.write(";\n")

    print(f"已生成 {json_path} 和 {js_path}")


if __name__ == "__main__":
    main()
