# 实例化绘制与点选核对样例（WebGL2 + TypeScript）

一排共享网格的小物件，用一次实例化绘制提交很多份，但点选时要能准确说出
“选的是哪一份”。本项目用纯 WebGL2（无三维引擎）实现一套可核对的实例化
绘制 + GPU 点选样例，重点解决编号稳定、遮挡判定、镜像/非均匀缩放贴合、
DPR 一致性和本地持久化。

## 运行

```bash
npm install
npm run dev        # 开发服务器
npm run build      # 类型检查 + 生产构建
npm run preview    # 预览构建产物
npm test           # 构建 + 视锥剔除逻辑测试 + 无头浏览器冒烟测试
```

冒烟测试基于 Playwright + headless Chromium（SwiftShader 软件 WebGL2），
覆盖点选、遮挡、重排、删除、隐藏、冻结重测、DPR=2、localStorage 恢复等。

## 功能与需求对照

| 需求 | 实现方式 |
| --- | --- |
| 多批共享网格、稳定编号/颜色/变换，移动删除即时可见 | 一个 Box 网格 + 每实例属性（模型矩阵、颜色、pickId）；编号单调递增、删除不复用；每帧重传实例缓冲 |
| 点选返回最前面的可见实例（遮挡/近裁剪/互相穿过） | 独立离屏 FBO + 深度缓冲，MRT 输出实例 ID/世界坐标/局部法线，`readPixels` 回读，深度测试天然给出最前片元 |
| 旋转、非均匀缩放、镜像，命中面/命中位置，翻转后高亮贴合 | TRS 四元数组合支持负缩放；法线走 inverse-transpose；高亮用随模型矩阵的线框 + 着色器自发光；局部命中点由逆矩阵反算 |
| 隐藏/重排/删除后编号与内部顺序可区分 | 逻辑 `id` 稳定、绘制 `slot` 每帧重建；标签同时显示 `#id` 与 `sN`，面板对照展示，删除编号永不补位复用 |
| 页面缩放/视角/DPR 下光标与选中位置一致 | backing store = CSS 尺寸 × `devicePixelRatio`，ResizeObserver 重建 FBO，点选坐标做物理像素换算并翻转 Y |
| 稀疏/密集场景、批次与实画数量、本地保存 | 稀疏 11 实例/3 批、密集 125 实例/5 批；统计逻辑批次、draw call、实画数、缓冲容量/重分配；localStorage + JSON 导入导出 |

## 关键设计

### 实例属性与分块绘制

每个实例占 21 个 float：`mat4 model(16) + vec4 color/selected(4) + float pickId(1)`，
通过 `vertexAttribDivisor = 1` 按实例步进。每次 `drawElementsInstanced` 最多
提交 32 个实例（`CHUNK_CAPACITY`），超出则分多次调用，面板展示实际 draw call 数。

> WebGL2 没有 `gl_BaseInstance`，`drawElementsInstanced` 的 `baseInstance`
> 参数在 ANGLE 翻译后不会反映到 `gl_InstanceID`。因此每个分块把起始槽位
> 通过 uniform `uBaseInstance` 传入，shader 用 `uBaseInstance + gl_InstanceID`
> 手动索引实例属性，行为在各实现上一致。

### GPU 点选（离屏 FBO + MRT）

点选时在离屏 FBO 重绘一帧（禁用背面剔除，保证镜像物体的内表面也能被点中），
三个颜色附件：

1. `RGBA8`：24bit 实例 ID（rgb 三字节），背景为 0
2. `RGBA32F`（无 `EXT_color_buffer_float` 时降级 `RGBA8` 编码）：世界坐标 + 深度
3. `RGBA8`：局部法线（判定命中 ±X/±Y/±Z 面）+ 局部位置分量

深度附件 `DEPTH_COMPONENT24` 保证遮挡/互相穿过时只保留最前片元。
5×5 邻域回读用于边缘像素核对，面板网格直观展示点击点周围 25 个物理像素
各自属于哪个实例。

### 稳定身份 vs 绘制槽位

- `InstanceStore` 用 `Map<id, InstanceData>` 保存逻辑实例，`id` 只增不复用
- `drawOrder: number[]` 保存绘制顺序，重排只打乱这个数组
- 每帧 `buildDrawList` 重建 `DrawItem { id, slot, batchId }`，隐藏/删除后
  slot 即时补位，但标签上的 `#id` 不变——高亮不会跳到补位的另一份物体

### 镜像与非均匀缩放

- 缩放分量允许为负，`matFromTRS` 直接组合，负行列式即镜像
- 片元着色器对 `gl_FrontFacing === false` 翻转法线，镜像物体不会发黑
- 线框高亮复用同一模型矩阵，天然贴合翻转后的形状
- 局部命中点 = `inverse(model) × 世界命中点`，镜像后仍落在原网格局部空间

### DPR 与坐标换算

- canvas 尺寸 = CSS 尺寸 × DPR（上限 3），FBO 同步重建
- 点选输入 CSS 坐标，回读时 `physX = cssX × dpr`，Y 轴按 WebGL 左下原点翻转
- 冒烟测试在 `deviceScaleFactor: 2` 下断言物理像素 ≈ 2×CSS 像素

## 目录结构

```
src/
  main.ts       应用入口：渲染循环、指针交互、面板与持久化串联
  renderer.ts   WebGL2 渲染器：VAO/实例缓冲/分块 draw/MRT 点选 FBO
  shaders.ts    GLSL ES 3.00 主渲染、线框、点选三套 program
  store.ts      实例存储：稳定编号、绘制列表、视锥剔除、统计
  camera.ts     轨道相机与世界→屏幕投影
  geometry.ts   共享 Box 网格（位置/法线/三角形与线框索引）
  scenes.ts     稀疏/密集/追加批次场景预设
  math.ts       列主序 Mat4、四元数、TRS 组合
  labels.ts     DOM 编号标签覆盖层（#id + slot）
  panel.ts      面板状态与点选核对展示
  storage.ts    localStorage 与 JSON 导入导出
tests/
  smoke.mjs         无头浏览器端到端冒烟测试
  cull-logic.mts    视锥剔除纯逻辑测试
```

## 操作

- 左拖旋转视角 · 右键/Shift+左拖平移 · 滚轮缩放
- 单击点选（邻域核对可开关）· Delete 删除选中 · H 隐藏选中
- 冻结布局后可用“按记录坐标重测”在固定视角基准下重复核对边缘像素
