# 法线贴图调试台 · Normal Map Debug Bench

浏览器内的 WebGL + TypeScript 法线贴图（Normal Map）调试台，用来定位一类常见问题：
**同一张凹凸贴图贴到对称道具的镜像另一半时，亮边有时会变成暗边。**

根因是镜像 UV 岛的切线基是**左手系**（UV 三角形有向面积为负）。若管线没有按
UV 有向面积修正、直接复用普通半的切线基，法线图的 Y 分量会被解释到反方向，
高光随之翻转。本工具把这条数学链路完整可视化并可量化对照。

## 运行

```bash
npm install
npm run dev        # 启动开发服务器（自动开浏览器）
npm run build      # 类型检查 + 生产构建到 dist/
npm test           # Node 内置 test runner，17 个纯逻辑单测
python3 -I scripts/e2e-smoke.py   # 可选：无头 Chromium 端到端冒烟（需 Playwright）
npm run generate:samples          # 可选：导出 PPM 纹理快照到 public/samples/
```

运行时零第三方依赖，仅 devDependencies 用 Vite 与 TypeScript。

## 六条需求如何落地

1. **普通 UV / 镜像 UV 对半 + 同一张图、同一盏灯**
   - 左右两个独立 WebGL 视口分别只渲染普通半（右手基）与镜像半（左手基），
     第三个「整体对照」视口把两半同框，共享同一张法线纹理与同一个方向光。
   - 内置两张过程化纹理：`flat`（处处 `(128,128,255)` 平法线）与
     `directional`（沿 v 起伏的棱 + 圆鼓包 + 斜槽，定向凹凸）。

2. **选中点的表面法线与贴图坐标轴**
   - 点击任一面拾取，侧栏显示世界空间 `T（沿 u，红）/ B（沿 v，绿）/ N（表面法线，蓝）`、
     UV 有向面积符号、手性、贴图法线与最终着色；3D 视口同步画三色 gizmo。
   - 支持旋转、三轴不等比缩放与单轴翻转。切向/法线统一走
     `inverse-transpose` 法线矩阵（仅归一化、不重新正交化），
     保证法线始终垂直于「变换后的切平面」，负缩放轴也能给出正确基底方向。

3. **两种绿通道约定，切换不重导模型**
   - `OpenGL (+Y↑)` 与 `DirectX (+Y↓)` 切换只改 fragment shader 的 `uFlipG` uniform，
     几何与切线基完全不动；顶部 badge 明确当前生效约定。
   - 第 7 组可单独查看原始纹理的 R/G/B/A 通道字节与高度场，并给出选中 UV 的原始 RGBA
     与「生效 Y」数值，原始字节不被约定切换修改。

4. **硬边 / 镜像接缝放大检查、重合顶点方向冲突、缺方向面标记**
   - 橙色线标折痕硬边，洋红线标镜像接缝；整体视口可拖拽放大。
   - 每个三角面独立持顶点（接缝拆点），工具会量化统计**重合空间顶点是否携带不同贴图方向**。
   - UV 三点重合（有向面积≈0）等无法决定方向的面：3D 中以屏幕空间红色斜纹标出、
     侧栏列表面板与报告中均单独列出。

5. **状态保存 / 复现 / 报告**
   - 模型姿态、贴图约定、灯位、选中点等全量状态自动落 `localStorage`，
     刷新或重开后一键复现；也可导出/导入 JSON 快照。
   - 接缝对照报告记录相邻两侧各自的 `T/B/N、手性、UV、原始字节、贴图法线、世界法线、
     Lambert、高光、最终颜色`，可在页面预览并下载 `.txt` / `.json`。

6. **正确与刻意设错两套接缝示例**
   - `correct`：镜像半按 UV 有向面积取左手系，两半凹凸体感一致。
   - `broken-seam`：镜像半的 `B（沿 v 贴图轴）`被整体翻向，模拟未处理镜像的切线基，
     同一张图的亮边在镜像半变成暗边。
   - 另有 `degenerate`：挂一片 UV 三点重合的面，验证缺方向面的标记与报告。

## 目录结构

```
src/
  core/           纯逻辑，可在 Node 单测中直接 import
    math.ts         向量/矩阵、法线矩阵(inverse-transpose)
    tangent.ts      逐面切线基、手性、镜像判定、约定解码
    geometry.ts     折面网格、边/重合顶点/接缝分类、三套预设
    textures.ts     过程化法线纹理、通道采样
    world.ts        世界网格、射线拾取、CPU 着色（与 GLSL 同源）
    report.ts       接缝对照报告
    state.ts        状态类型与默认值
    persistence.ts  localStorage 持久化
  webgl/          WebGL1 渲染（视口、着色器、接缝叠色、gizmo）
  ui/             轨道控制、通道 2D 预览、样式
tests/            node:test 单测（切线基、法线矩阵、预设、着色翻转、报告）
scripts/          纹理快照生成、无头浏览器冒烟
```

## 关键公式

逐面切线基（`src/core/tangent.ts`）：

```
det = du1·dv2 − du2·dv1            // 镜像 UV 时 det < 0
T = (dp1·dv2 − dp2·dv1) / det
B = (dp2·du1 − dp1·du2) / det
handedness = sign(dot(cross(T, B), N))   // 镜像半为 −1（左手系）
```

法线变换（非均匀缩放 / 负缩放）：`worldNormal = normalize(inverse(transpose(M)) · objectNormal)`。
