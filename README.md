# 本地图片标注工具

给小批量训练图片画**多边形**和**矩形**区域的本地工具。全部逻辑运行在浏览器里，图片不上传、不连接任何训练服务。标注结果可继续编辑，也能导出为其他工具可直接读取的 **JSON + 掩码 PNG**。

## 快速开始

```bash
npm run dev          # 启动本地服务，访问 http://127.0.0.1:5173
npm test             # 运行几何 / 模型 / 导出 / 掩码单元测试
npm run generate:samples   # 重新生成 samples/ 下的示例图片、草稿与掩码
```

无需安装任何依赖（Node.js ≥ 18，仅用于启动静态服务器和跑测试）。首次打开会自动载入三张内置示例；也可以点「载入示例」随时重新载入。

## 功能对照

| 需求 | 实现 |
| --- | --- |
| 1. 图片列表显示进度、画布缩放/平移、坐标准确 | 左侧列表显示每张图的标注数与「未标注/已标注」徽标；顶部进度条统计整体进度。滚轮以光标为锚点缩放（`0` 适应窗口、`+`/`-` 缩放、空格/中键/空白处拖拽平移）。所有坐标经 `screenToImage`/`imageToScreen` 双向换算，缩放后再画不会偏移（有单元测试覆盖）。 |
| 2. 多边形逐点绘制/撤销/闭合/移动顶点/删除；矩形调整边；不越界 | 多边形：单击加点，`Backspace` 或「撤销点」回退，双击/`Enter`/「闭合」完成；选中后拖动顶点可移动。矩形：拖拽绘制，8 个控制点调整边/角。所有输入点、顶点、矩形都会夹到 `[0, 宽] × [0, 高]`，边缘处不会产生越界坐标（`clampPoint` / `normalizeRect` / `resizeRect` 保证）。 |
| 3. 标签新建、改名、排序；改名同步；删除前提示影响范围 | 右侧标签区新建、双击或 ✎ 改名、↑↓ 排序（顺序即导出类别索引）。标注通过 `labelId` 引用标签，改名后所有图片的已有标注同步显示新名称。删除时弹出对话框，列出被多少张图、多少个标注使用，并可选择「连带删除」或「转移到其他标签」。 |
| 4. 标注可重叠；列表选中与画布高亮对应；隐藏/锁定互不影响 | 标注按添加顺序层叠绘制；列表选中项与画布高亮（白色外框 + 透明填充）双向同步；隐藏（`◉`）只让该标注不显示、不导出；锁定（`🔒`）只禁止编辑、仍然导出；两者都只作用于单个标注。 |
| 5. 保存草稿、导出 JSON 与按图掩码，重开后一致 | 「保存草稿」写 localStorage（每次修改也会自动保存）；「打开草稿」读取草稿 JSON，坐标按两位小数保存、标签按名称去重合并。导出 JSON 与掩码；重新打开后坐标与标签保持一致（测试覆盖往返一致性）。 |
| 6. 本地示例与导出可读性 | 内置三张示例（街景、仓库、航拍），含矩形、多边形、重叠区域及隐藏/锁定演示。`npm run generate:samples` 会把示例原图、`annotations.json`、`masks/*.mask.png` 与彩色预览一并写到 `samples/`，可直接核对图像尺寸和类别映射。 |

## 操作速查

| 操作 | 快捷键 / 手势 |
| --- | --- |
| 选择 / 多边形 / 矩形工具 | `V` / `P` / `R` |
| 闭合多边形 | `Enter` 或双击 |
| 撤销上一个顶点 | `Backspace` |
| 取消当前绘制 / 取消选中 | `Esc` |
| 删除选中标注 | `Delete` |
| 微调选中标注（10px） | 方向键（按住 `Shift`） |
| 缩放（以光标为锚点） | 滚轮 / `+` / `-` |
| 平移 | 空格拖拽 / 中键拖拽 / 空白处拖拽 |
| 适应窗口 | `0` |
| 保存草稿 | `Ctrl/Cmd + S` |
| 右键 | 绘制中退一个点，否则取消选中 |

## 导出格式

### `annotations.json`

```jsonc
{
  "format": "local-image-annotator/annotations",
  "version": "1.0",
  "exportedAt": "2026-11-20T03:12:45.000Z",
  "imageCount": 3,
  "annotationCount": 24,
  "categories": [
    { "id": "lbl_road", "name": "道路", "color": "#f5a623", "index": 1 },
    { "id": "lbl_vehicle", "name": "车辆", "color": "#e5484d", "index": 2 }
  ],
  "labelMap": { "道路": 1, "车辆": 2 },
  "images": [
    {
      "file": "street-scene.png",
      "imageId": "img_sample_street",
      "width": 960,
      "height": 640,
      "mask": "masks/street-scene.mask.png",
      "annotationCount": 9,
      "annotations": [
        {
          "id": "ann_sample_street_5",
          "type": "polygon",
          "category": "车辆",
          "categoryId": "lbl_vehicle",
          "categoryIndex": 2,
          "points": [[346, 432], [558, 432], [604, 470], [608, 544], [346, 544]],
          "bbox": [346, 432, 262, 112],
          "area": 25816
        },
        {
          "id": "ann_sample_street_1",
          "type": "rect",
          "category": "建筑",
          "categoryId": "lbl_building",
          "categoryIndex": 3,
          "rect": { "x": 0, "y": 150, "width": 310, "height": 250 },
          "points": [[0, 150], [310, 150], [310, 400], [0, 400]],
          "bbox": [0, 150, 310, 250],
          "area": 77500
        }
      ]
    }
  ]
}
```

约定：

- **坐标系**：图像像素坐标，原点在左上角，x 向右、y 向下，取值范围 `[0, width] × [0, height]`，保留两位小数。与显示缩放、窗口大小无关。
- **类别索引**：`categories[].index` 从 1 开始，跟随标签排序变化；`0` 固定表示背景。
- `type` 为 `polygon`（`points` 为顶点数组）或 `rect`（`rect` 为 `{x, y, width, height}`，同时给出四个角点 `points`）。
- `bbox` 统一为 `[x, y, width, height]`。
- **隐藏**（`hidden=true`）的标注不写入导出；**锁定**（`locked=true`）只限制编辑，正常导出。
- 标注可以重叠；导出数组中越靠后的标注层叠在上层（与画布绘制顺序一致）。

### 掩码 PNG

「导出掩码 ZIP」会生成：

```
annotation-masks-YYYY-MM-DD.zip
├── annotations.json
├── labels.csv                 # index,name,color
├── README.txt                 # 类别映射说明
└── masks/
    ├── street-scene.mask.png
    ├── warehouse.mask.png
    └── aerial-farm.mask.png
```

- 每张图一个 **8 位单通道灰度 PNG**，尺寸与原图完全一致。
- 像素值 = 类别索引：`0` 为背景，`1..N` 对应 `annotations.json` 的 `categories[].index`。
- 重叠区域按标注顺序绘制，**后添加的覆盖先添加的**；这与画布上的视觉层叠一致。
- 采用像素中心采样、无抗锯齿，边界可复现。

用 Python/OpenCV/PIL 读取示例：

```python
import json
import numpy as np
from PIL import Image

meta = json.load(open("annotations.json"))
name_to_index = {c["name"]: c["index"] for c in meta["categories"]}

for image in meta["images"]:
    mask = np.array(Image.open(image["mask"]))   # H×W，值 0..N
    assert mask.shape == (image["height"], image["width"])
    vehicle = mask == name_to_index["车辆"]
    print(image["file"], mask.dtype, np.unique(mask), vehicle.sum())
```

### 草稿文件

「保存草稿」写入 localStorage，格式带 `"format": "local-image-annotator/draft"`；也可以用「打开草稿」载入任意符合该结构的 JSON：

```jsonc
{
  "format": "local-image-annotator/draft",
  "version": 1,
  "savedAt": "2026-11-20T03:12:45.000Z",
  "labels": [{ "id": "lbl_x", "name": "车辆", "color": "#e5484d" }],
  "images": [
    {
      "id": "img_x",
      "name": "street-scene.png",
      "width": 960,
      "height": 640,
      "source": { "kind": "sample", "sceneId": "sample-street" },
      "annotations": [
        { "id": "ann_1", "type": "rect", "labelId": "lbl_x",
          "rect": { "x": 10, "y": 20, "width": 80, "height": 60 },
          "hidden": false, "locked": false }
      ]
    }
  ],
  "activeImageId": "img_x"
}
```

载入时会：夹紧越界坐标、丢弃悬空标签引用与退化图形（少于 3 点或零面积的图形）；同名标签按名称合并，同名图片按文件名合并去重。除了草稿文件，**导出的 `annotations.json` 也可以直接用「打开草稿」载入**（类别会按 `categories[].id/name` 映射回标签）。

> 导入的原图存在浏览器 IndexedDB 中；示例图不入库，按 `source.sceneId`（或文件名）在运行时重绘。换电脑或清理浏览器数据后，本地导入的图片需要重新选择同名文件：只要文件名与尺寸一致，就会自动绑定回原图片并保留全部标注。

## 目录结构

```
index.html              页面骨架
src/
  geometry.js           坐标换算、视图缩放、命中检测（纯函数）
  model.js              标签/图片/标注的数据操作、草稿与导出格式
  raster.js             掩码栅格化（单通道类别索引）
  png.js                零依赖 PNG 编码（含压缩降级）
  zip.js                ZIP 打包与下载
  paint.js              示例图用的光栅图元
  samples.js            三张示例场景与真值标注
  canvas.js             画布渲染与指针交互
  storage.js            localStorage + IndexedDB 持久化
  main.js               UI 状态与事件绑定
scripts/
  serve.mjs             零依赖静态服务器
  generate-samples.mjs  生成 samples/ 下的全套示例产物
tests/                  单元测试（geometry/model/raster/export）
samples/                生成后的示例素材（可用 npm run generate:samples 重建）
```

## 已知边界

- 项目面向小批量（几十至几百张）图片，所有标注常驻内存；未做超大规模虚拟列表。
- 掩码为单通道索引图（不是 RGB 调色板图），这是训练中最常见的读取方式；如需自定义颜色映射，可用 `annotations.json` 的 `categories[].color` 自行着色。
- `annotations.json` 里不包含原图像素，只记录文件名、尺寸与掩码相对路径。
