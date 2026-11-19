# 精灵图集工具（Sprite Atlas Tool）

一个给游戏项目整理贴图用的**纯离线**精灵图集工具：导入多张带透明通道的
PNG，自动裁掉透明边缘、加留白与边缘扩展，用 MaxRects 算法排成一张图集，
导出 PNG 与机器可读的位置清单，并支持工程文件往返继续调整。

- **零运行时依赖、零网络请求**：纯 HTML + CSS + 原生 JavaScript，没有任何
  CDN、npm 包或远程资源；断网可用。
- 浏览器里直接打开 `public/index.html` 即可（推荐用本地静态服务器，见下）。

## 快速开始

```bash
# 方式一：直接双击 public/index.html，或用任意静态服务器
npm run serve          # 等价于 python3 -m http.server 8080 -d public
# 然后浏览器访问 http://127.0.0.1:8080

# 生成示例 PNG 文件到 public/samples/（已随仓库生成，删除后可恢复）
npm run generate:samples   # 需要本机有 Pillow；不装也可用网页内置示例

# 排版核心单元测试（零依赖 Node）
npm test

# 浏览器端到端测试（需要本机 Chrome，完全离线）
node test/e2e.cjs
```

页面上点「载入内置示例」即可一键载入 10 张覆盖各种场景的素材；也可以
点「导入 PNG」或直接把文件/文件夹拖进窗口。

## 功能对照

| 需求 | 实现位置 / 说明 |
| --- | --- |
| 裁掉透明边缘、留白、边缘扩展 | 左侧「裁剪与留白」卡片；Alpha 阈值可调；extrude 会拉伸边缘像素并补四角 |
| 预览切换原尺寸 / 实际占用 | 预览区顶部「实际图集占用 / 原尺寸对照」分段按钮 |
| 限制宽高 / 固定宽高 / 2 的幂 | 「图集尺寸」卡片，限制模式按内容收缩并可选 POT；固定模式画布恒为指定值 |
| 可选旋转（全局 + 单张） | 全局开关 + 精灵列表每行「允许旋转」复选框；旋转在清单中以 `rotated` 记录 |
| 放不下时指出具体图片与原因 | 预览区上方红色面板：区分 `too_large`（超界）与 `no_space`（剩余空间不足），附所需尺寸、当前最大空闲矩形、占用面积 |
| 坐标可还原透明边距与旋转 | 清单每帧含 `spriteSourceSize`（原始边距）、`sourceSize`、`rotated`、`contentRect` |
| 重名不覆盖 | 导入即对重名追加 `-1/-2…` 后缀；清单键与导出文件名均唯一 |
| 增删/尺寸变化后稳定重排 | 未变化精灵优先锁定上一轮位置（列表中显示「位置保持」），变化范围在预览中高亮并给出包围矩形 |
| 导出 PNG + 机器可读清单 | 「导出图集 PNG」「导出位置清单 atlas.json」 |
| 工程往返 | 「导出工程」生成自包含 JSON（内嵌图片 dataUrl + 参数 + 布局），「导入工程」恢复后继续调整 |
| 示例素材 | 内置 Canvas 样例 + `tools/generate_samples.py` 生成的等价 PNG（10 张，含两组重名、多种长宽比与透明边距） |

## 排版规则与坐标系

- 原点在左上角，x 向右、y 向下，单位均为像素。
- **单元格尺寸** = 裁剪后内容 + 2 × (padding + extrude)。
  - `padding`（留白）：精灵之间的纯透明间隔。
  - `extrude`（边缘扩展）：把内容最外圈像素向外拉伸，防止渲染时
    纹理过滤（mipmap/线性采样）产生接缝；四角取对应角点像素。
- 装箱算法为 **MaxRects + 最佳短边适配（BSSF）**，同输入确定性输出；
  旋转只交换单元格宽高，像素旋转在渲染/导出层处理（顺时针 90°）。
- 稳定重排：上一轮位置与当前单元格尺寸一致且互不冲突的精灵直接锁定，
  其余精灵在剩余自由矩形里重新排版。

## 导出文件

导出会产生（按钮各自独立下载）：

1. `atlas.png`：RGBA 图集位图。
2. `atlas.json`：位置清单（结构见下）。
3. `sprite-atlas-project.json`：工程文件，可重新导入。
4. 可选：逐张精灵 PNG（文件名已去重，不会互相覆盖）。

### atlas.json 字段说明

顶层结构：

```json
{
  "meta": { ... },
  "frames": {
    "精灵名.png": { ... }
  }
}
```

#### `meta`

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `app` | string | 固定为 `sprite-atlas-tool` |
| `manifestVersion` | number | 清单格式版本，当前为 `1` |
| `image` | string | 关联位图文件名，`atlas.png` |
| `size.w` / `size.h` | number | 图集实际宽高（px） |
| `format` | string | 像素格式，固定 `RGBA8888` |
| `scale` | number | 缩放系数，固定 `1` |
| `settings.trim` | boolean | 是否启用透明裁剪 |
| `settings.padding` | number | 留白像素数 |
| `settings.extrude` | number | 边缘扩展像素数 |
| `settings.allowRotate` | boolean | 全局旋转开关 |
| `settings.alphaThreshold` | number | 透明判定阈值，alpha 大于该值才算不透明 |
| `settings.powerOfTwo` | boolean | 图集尺寸是否取 2 的幂 |
| `settings.sizeMode` | string | `limit`（限制最大宽高）或 `fixed`（固定宽高） |

#### `frames["名字.png"]` 每帧字段

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `frame` | `{x,y,w,h}` | **单元格**在图集中的矩形（含 padding/extrude），左上角坐标 + 宽高 |
| `rotated` | boolean | 是否顺时针旋转了 90°；为 `true` 时 `frame.w/h` 是旋转后的物理宽高 |
| `trimmed` | boolean | 该精灵是否发生过透明裁剪 |
| `spriteSourceSize` | `{x,y,w,h}` | 裁剪内容在**原始未裁剪图片**坐标系中的矩形；`x/y` 即被裁掉的左/上透明边距 |
| `sourceSize` | `{w,h}` | 原始图片完整尺寸（含全部透明边距） |
| `contentRect` | `{x,y,w,h}` | **实际像素内容**（不含 padding/extrude）在图集中的物理矩形；旋转时物理宽高已互换 |
| `cell` | `{w,h}` | 未旋转视角下的单元格尺寸（= 内容 + 2×(padding+extrude)） |

#### 如何还原一张精灵

1. 在 `atlas.png` 上按 `contentRect` 取像素（旋转时取到的是顺时针旋转后的图）。
2. 若 `rotated === true`，把取出的位图逆时针旋转 90°，恢复内容朝向。
3. 新建一张 `sourceSize.w × sourceSize.h` 的透明画布，把还原后的内容
   贴到 `(spriteSourceSize.x, spriteSourceSize.y)`，即得到与原图完全一致
   （含原始透明边距、朝向）的精灵。

### 工程文件 sprite-atlas-project.json

| 字段 | 含义 |
| --- | --- |
| `app` / `projectVersion` | 工程标识与版本（`sprite-atlas-tool-project` / `1`） |
| `createdAt` | 导出时间（ISO 8601） |
| `settings` | 当时的全部排版参数，导入后还原到左侧面板 |
| `sprites[]` | 每张精灵：`id`、原始名 `name`、去重后 `uniqueName`、`sourcePath`、`allowRotate`、原始尺寸、内嵌 `dataUrl`（PNG base64，工程自包含、可离线迁移） |
| `layout[]` | 上一轮布局 `{id,x,y,w,h,rotated}`，导入后用于稳定重排 |

## 重名规则

导入时按导入顺序对基础名（去扩展名）去重：第一次出现保持原名，之后
追加 `-1`、`-2`……若原名本身已带后缀且被占用，则在原名上继续追加
（例如 `gem-1` 冲突后变为 `gem-1-1`）。该规则同时作用于清单键和
导出文件名，因此**永远不会覆盖已有文件或说明项**。

## 目录结构

```
public/
  index.html          入口页面
  css/style.css       样式（无外部资源）
  js/
    packer.js         MaxRects 装箱核心（可在 Node 中直接 require）
    util.js           去重、下载、图片读取等工具
    samples.js        内置程序化示例素材
    app.js            主应用：导入/裁剪/预览/导出/工程往返
  samples/            generate_samples.py 的产物（.gitignore 忽略，可重新生成）
tools/
  generate_samples.py 示例 PNG 生成器（Pillow，离线）
test/
  packer.test.cjs     排版核心单元测试（npm test）
  e2e.cjs             headless Chrome 端到端测试（npm run test:e2e）
  pixel_verify.cjs    像素验证第一步：浏览器真实导出 atlas + manifest
  pixel_verify.py     像素验证第二步：按文档还原步骤逐像素比对（npm run test:pixel 串联两步）
```

## 已知边界

- 仅支持 PNG 输入（含 alpha 通道）。
- 全透明图片无法排版，会在拒绝面板中标注并从图集排除。
- 工程文件内嵌 base64 图片，精灵很多/很大时文件体积会明显增大。
