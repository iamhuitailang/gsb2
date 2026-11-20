# maptiler — 大地图切片工具

把超大底图按游戏需要切成瓦片，支持多缩放层级、重叠边缘、区域增量重切、
可视化预览（接缝检查 / 缺失瓦片标注），并可用索引清单还原完整地图。
纯本地运行，**不需要地图服务**。

## 环境

- Python 3.10+，依赖仅 [Pillow](https://pypi.org/project/Pillow/)
- 预览页为纯静态 HTML，浏览器直接打开即可（推荐 Chrome / Edge / Safari）

## 快速开始

```bash
# 生成示例地图（1531x1129，非整倍数尺寸、带透明区域）
python3 tools/make_sample_map.py            # -> assets/sample_map.png

# 预计切片数量与输出体积（不落盘）
python3 -m maptiler estimate assets/sample_map.png --tile 256x256 --overlap 16 --levels 3

# 切片：输出瓦片 + manifest.json + preview.html
python3 -m maptiler slice assets/sample_map.png -o out \
    --tile 256x256 --overlap 16 --levels 3 --edge pad

open out/preview.html                       # 浏览器打开预览
```

## 切片坐标规则

- **源图坐标**：level 0 的像素坐标，原点左上，x 向右，y 向下。
- **层级**：level `l` 的缩放比为 `1/2^l`，层级图尺寸为
  `ceil(W/2^l) x ceil(H/2^l)`。层级坐标 × `2^l` = 源图坐标。
- **网格**：设瓦片 `tile_w x tile_h`，重叠 `overlap`，则步长
  `step = tile_size - overlap`。瓦片 `(l, col, row)` 在层级图中的左上角为
  `(col*step_x, row*step_y)`，覆盖 `tile_w x tile_h`。
  列数 `cols = ceil((level_w - tile_w) / step_x) + 1`（`level_w <= tile_w` 时为 1），行数同理。
- **边缘**：地图边缘不足整块时——
  - `--edge pad`（默认）：瓦片恒为整块，越界部分补透明；
  - `--edge crop`：瓦片贴边裁切，边缘瓦片尺寸更小。
- **文件名**：`tiles/<level>/<col>_<row>.png`，只由坐标决定，内容不变则文件字节不变。
- **重叠**：`overlap` 为相邻瓦片共享的边缘宽度（四边对称），用于避免游戏渲染接缝。
  重叠区像素是两瓦片各自完整渲染的同一源图区域，内容一致。

坐标换算（双向）：

```bash
# 瓦片 -> 源图位置
python3 -m maptiler locate assets/sample_map.png --tile 256x256 --overlap 16 --tile-id 0,3,2

# 源图点 -> 覆盖它的瓦片（重叠区会命中多块）
python3 -m maptiler locate assets/sample_map.png --tile 256x256 --overlap 16 --point 725,500 --level 0
```

## 区域增量重切

地图局部修改后，只重新生成与该区域相交的瓦片（含重叠影响范围）：

```bash
python3 -m maptiler slice assets/sample_map_v2.png -o out \
    --tile 256x256 --overlap 16 --levels 3 --edge pad --region 700,450,300,300
```

- `--region x,y,w,h` 为源图（level 0）坐标；
- 未变化区域的瓦片**文件名与文件字节都保持稳定**（内容哈希一致则不重写，mtime 也不变）；
- 切片参数（瓦片尺寸/重叠/层级/边缘模式）必须与已有清单一致。

## 预览

`slice` 会在输出目录生成 `preview.html`（清单已内嵌，双击即可打开）：

- 左侧切换缩放层级，滑杆/滚轮连续缩放，拖拽平移；
- **接缝检查**：蓝色瓦片边界 + 黄色重叠区高亮，可显示瓦片坐标；
- **缺失瓦片**：清单中有但文件加载失败的瓦片以红色斜纹标出，并列入左侧"缺失瓦片"清单；
- 点击画布任意位置，查看命中瓦片的坐标、源图位置与内容哈希。

## 索引清单与还原

`manifest.json` 记录源图信息、切片参数、每层网格和每块瓦片的
坐标/源图矩形/sha256。

```bash
# 重新导入清单：校验瓦片存在且内容一致（缺失/不符会逐条列出）
python3 -m maptiler verify out/manifest.json

# 按清单把瓦片拼回完整地图（重叠区像素一致，直接覆盖；pad 越界透明边自动裁剪）
python3 -m maptiler restore out/manifest.json --level 0 -o restored.png
```

## 目录结构

```
maptiler/            # 切片核心与 CLI（python3 -m maptiler）
preview/             # 预览页模板（slice 时内嵌清单后拷入输出目录）
tools/make_sample_map.py   # 示例地图生成器
assets/sample_map.png      # 示例地图：1531x1129，非整倍数尺寸，含透明区域
```
