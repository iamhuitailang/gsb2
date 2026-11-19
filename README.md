# GSB2 2D 关卡编辑器

一个纯本地运行的横版游戏 2D 关卡编辑器：浏览器 + Canvas 实现，无构建步骤、无外部依赖。
用于绘制地图、配置图块碰撞形状与标签，并导出 JSON 关卡数据。

## 运行

```bash
# 方式一：直接用浏览器打开 index.html（无需服务器）

# 方式二：本地静态服务器
python3 -m http.server 8000
# 然后访问 http://localhost:8000
```

首次打开会自动加载内置示例关卡（含障碍、平台、水坑尖刺、三个图层）。
编辑内容会自动保存到浏览器 localStorage，下次打开自动恢复。

## 功能一览

- **多图层 + 不同格子尺寸**：每个图层可选 8/16/32/64px 格子；图层可增删、改名（双击）、上下排序、显示/隐藏
- **编辑工具**：笔刷、橡皮、填充桶、选区/移动；图层格子按需自动扩展
- **地图边缘扩展/裁切**：「地图尺寸」对话框按边增减，已有图块坐标与碰撞数据保持对应；裁切前在画布上红色预览将被裁掉的格子
- **碰撞配置**：每个图块可设碰撞形状（完整/半格/斜坡等）与标签（实体/单向平台/伤害/梯子/水体/装饰）；可查看单格碰撞（状态栏）、当前层或全部层碰撞覆盖、关卡范围
- **撤销/重做**：一次连续笔刷算一次编辑；撤销严格作用于产生编辑的图层，切换图层不会误改
- **保存/打开**：导出/导入 JSON，包含图层顺序、图块编号、碰撞配置与关卡尺寸

## 快捷操作

| 操作 | 快捷键 |
| --- | --- |
| 笔刷 / 橡皮 / 填充桶 / 选区 | `B` / `E` / `G` / `M` |
| 撤销 / 重做 | `Ctrl/⌘+Z` / `Ctrl/⌘+Shift+Z`（或 `Ctrl+Y`） |
| 保存（导出 JSON + 本地存储） | `Ctrl/⌘+S` |
| 打开地图文件 | `Ctrl/⌘+O` |
| 平移画布 | `空格` + 拖动，或鼠标中键拖动 |
| 缩放画布 | 滚轮（以光标为中心）；`+` / `-`；`0` 复位 |
| 切换图层 | `[` / `]`，或点击图层面板 |
| 全选当前图层 | `Ctrl/⌘+A` |
| 移动选区 | 选区工具下拖动选区内部；`Esc` 取消 |
| 清除选区内容 | `Delete` / `Backspace` |
| 临时擦除 | 鼠标右键拖动 |
| 地图尺寸调整 | `R` |
| 碰撞显示切换（关/当前层/所有层） | `C` |
| 网格开关 | `Shift+G` |

## 导出格式

```jsonc
{
  "format": "gsb2-level",
  "version": 1,
  "name": "示例关卡",
  "tileSize": 16,          // 基准格子像素尺寸
  "width": 60, "height": 20, // 关卡尺寸（基准格）
  "layers": [              // 数组顺序 = 渲染顺序（先底后顶）
    {
      "id": "layer-terrain",
      "name": "地形",
      "cellSize": 16,        // 该层格子像素尺寸
      "origin": [0, 0],      // 格子 (0,0) 的世界像素坐标
      "cols": 60, "rows": 20,
      "visible": true, "opacity": 1,
      "tiles": [0, 1, 2]     // 行优先，0 = 空，其余为图块编号
    }
  ],
  "tileset": {
    "srcSize": 32,
    "tiles": [
      { "id": 1, "name": "草地", "color": "#4caf50",
        "collision": "full",   // none/full/half-top/half-bottom/half-left/half-right/slope-up/slope-down
        "tags": ["solid"] }    // solid/one-way/hazard/ladder/water/decoration
    ]
  }
}
```

碰撞数据随图块定义导出；某格的碰撞形状 = 该格图块的 `collision`，
格子世界位置 = `origin + (格子下标 × cellSize)`。

## 验证导出数据

```bash
# 校验编辑器导出的任意 JSON（结构、尺寸、图块编号、碰撞形状、标签）
python3 tools/validate.py sample/level.json
python3 tools/validate.py 你导出的关卡.json

# 重新生成内置示例关卡（sample/level.json 与 sample/sample-level.js）
python3 tools/make_sample.py

# 核心逻辑冒烟测试（撤销/重做、扩容、裁切、序列化，需 Node.js）
node tools/smoke_test.js
```

## 目录结构

```
index.html          编辑器页面
css/style.css       样式
js/tileset.js       图块定义、碰撞形状、程序化图集
js/model.js         关卡模型：图层、自动扩容、边缘扩展/裁切
js/history.js       撤销/重做（世界坐标锚定的变更记录）
js/io.js            导入/导出/校验/localStorage
js/editor.js        画布渲染、缩放平移、编辑工具
js/ui.js            面板、对话框、快捷键
js/main.js          启动
sample/level.json   示例关卡（导出格式样例）
tools/validate.py   导出数据校验器
tools/make_sample.py 示例关卡生成器
tools/smoke_test.js 核心逻辑冒烟测试
```
