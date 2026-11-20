# 本地三维模型查看器（TypeScript + WebGL2）

一个完全运行在本机的 OBJ 网格 / MTL 材质查看器：读取模型文件、检查结构与各类读取问题、
直接预览材质与光照效果，并能把显示参数保存为项目文件后完整恢复。

- 纯 TypeScript + 原生 WebGL2，不依赖任何三维引擎
- 不发起外部网络请求，模型、材质、贴图全部来自本地文件
- Vite 开发 / 构建，Vitest 单元测试，无框架 DOM

## 功能一览

| 需求 | 实现 |
| --- | --- |
| OBJ / MTL 读取与问题定位 | 自研解析器，所有问题带**文件名 + 行号 + 原始行内容**，可用部分照常渲染 |
| 结构栏 | 对象 (`o`) / 组 (`g`) 两级树，稳定 ID 驱动选择，重名自动加 `#2` 序号，不会选错 |
| 节点操作 | 单独隐藏 / 显示、聚焦（镜头适配包围盒）、颜色覆盖与清除 |
| 视图交互 | 左键旋转、右键（或中键）平移、滚轮缩放，DPR 自适应 |
| 选中信息 | 包围盒 min/max/中心/尺寸、顶点数、三角面数、材质分布 |
| 显示模式 | 材质预览、线框（去重边）、法线（顶点法线线段） |
| 光照环境 | 摄影棚 / 日光 / 夜晚三套环境光与主光方向 |
| 贴图缺失 | 材质面板与状态栏明确提示，视口中用「贴图缺失」棋盘格占位 |
| 项目文件 | 保存为 `.mvproj.json`（内嵌源文件与贴图），再打开恢复结构、相机、显示模式与全部覆盖项 |
| 异常容错 | 缺失材质、无效面、越界/零/负索引、不支持指令、缺失贴图均逐条告警且不阻断查看 |

## 快速开始

```bash
npm install
npm run generate:samples   # 生成内置样例到 public/samples/（首次必须执行）
npm run dev                # 启动本地开发服务器，终端会打印 http://127.0.0.1:xxxx 地址
```

浏览器打开终端给出的地址后：

1. 点击左上角 **🧪 载入示例**（或直接访问 `/?sample=1`）查看内置样例；
2. 左侧「读取警告」面板会列出样例中故意制造的全部问题；
3. 在结构树中选择对象 / 组，右侧查看包围范围与统计，并可隐藏、聚焦、改色；
4. 顶部切换 **材质 / 线框 / 法线** 模式与 **光照环境**；
5. 点击 **💾 保存项目** 得到 `<模型名>.mvproj.json`，之后用 **📁 打开项目** 完整恢复。

也可以把 OBJ / MTL / 贴图文件直接**拖入窗口**，或用 **📂 打开文件** 多选载入。
OBJ 通过 `mtllib` 声明按文件名（basename）匹配同批次载入的 MTL；贴图同理按 basename 匹配。

### 其他命令

```bash
npm run build     # 类型检查 + 生产构建到 dist/
npm run preview   # 本地预览生产构建
npm test          # 运行单元测试（33 个用例）
npm run check     # 仅 TypeScript 类型检查
```

## 内置样例位置与内容

样例由 `scripts/generate-samples.mjs` 生成（生成物在 `.gitignore` 中，可用命令随时恢复）：

```
public/samples/
├── sample-model.obj      # 3 个对象、多个组与材质，含一组故意制造的异常
├── sample-material.mtl   # 5 个材质（含透明材质与缺失贴图材质）
└── checkerboard.png      # 存在的棋盘格贴图（脚本内置 PNG 编码器，零依赖生成）
```

样例覆盖的正常内容：

- `CubeA`（两个同名对象，验证重名消歧与稳定 ID），各含两个组与不同材质；
- `Pyramid` 金字塔，含 `TransparentGlass` 半透明玻璃材质；
- `CheckerMat` 材质真实加载 `checkerboard.png` 贴图。

样例故意制造的异常（警告面板会逐条给出 `文件:行号`）：

| 行内容特征 | 告警代码 | 说明 |
| --- | --- | --- |
| `usemtl NotDefinedAnywhere` | `MTL_MATERIAL_NOT_FOUND` | 材质未在任何 MTL 中定义，回退默认灰色材质 |
| `f 21 0 22` | `OBJ_FACE_INDEX_OUT_OF_RANGE` | 零索引按 OBJ 规范视为非法，该面跳过 |
| `f 9 10 999` | `OBJ_FACE_INDEX_OUT_OF_RANGE` | 顶点索引越界，该面跳过，其他面保留 |
| `f 20 21` | `OBJ_FACE_INVALID` | 面顶点不足 3 个 |
| `f x y z` | `OBJ_FACE_INVALID` | 顶点引用无法解析 |
| `curv ...` | `OBJ_UNSUPPORTED_STATEMENT` | 不支持的 OBJ 指令，该行忽略 |
| `v not-a-number 0 0` | `OBJ_VERTEX_INVALID` | 顶点坐标非法，该顶点忽略 |
| `map_Kd does-not-exist.png` | `TEXTURE_FILE_MISSING` | 贴图文件未载入，棋盘格占位并在材质面板标注 |

## 项目文件格式

保存得到的是单个 JSON 文件（`<模型名>.mvproj.json`），内嵌 OBJ/MTL 文本与贴图 dataUrl，
可独立拷贝、重新打开，不依赖原始路径：

```jsonc
{
  "format": "webgl-model-viewer-project",
  "version": 1,
  "sources": { "objFileName": "...", "objText": "...", "mtlFiles": [...], "textures": [...] },
  "camera": { "target": [..], "distance": .., "yaw": .., "pitch": .. },
  "displayMode": "material | wireframe | normal",
  "environment": "studio | daylight | night",
  "nodeOverrides": { "o:0/g:0": { "hidden": true, "colorOverride": "#ff8800" } },
  "materialOverrides": { "RedPlastic": { "diffuse": "#abcdef", "opacity": 0.8 } },
  "selectedNodeId": "o:0/g:0"
}
```

节点覆盖项以与名字无关的**稳定 ID**（`o:<对象序号>/g:<组序号>`）为键，重新解析后会校验
ID 与材质名是否仍存在，自动丢弃失效条目。重新打开项目时相机姿态原样恢复，
切换模型不会把镜头推到不可见的位置。

## 目录结构

```
src/
├── core/
│   ├── math.ts          # Vec3 / Mat4 / 包围盒
│   ├── types.ts         # 全部共享类型
│   ├── obj-parser.ts    # OBJ 语法解析（带行号告警）
│   ├── mtl-parser.ts    # MTL 材质解析
│   ├── build-scene.ts   # 索引校验、三角化、法线生成、场景树与稳定 ID
│   ├── orbit-camera.ts  # 轨道相机（旋转/平移/缩放/聚焦/序列化）
│   ├── files.ts         # 本地文件与样例读取
│   └── project.ts       # 项目文件打包/解析/覆盖项对账
├── render/
│   ├── shaders.ts       # GLSL ES 3.00 着色器
│   ├── textures.ts      # 贴图加载与缺失占位贴图
│   └── renderer.ts      # WebGL2 渲染器（三模式 + 环境 + 包围盒）
├── ui/                  # 结构树、警告、详情、材质面板（无框架 DOM）
├── app.ts               # 应用主控与加载管线
└── main.ts              # 入口
tests/                   # Vitest 单元测试（含样例端到端冒烟测试）
scripts/generate-samples.mjs
```

## 支持范围与约定

- 支持多边形面（按三角扇展开）、正/负索引、`v/vt/vn` 三种引用组合、`d`/`Tr` 透明度；
- 缺失法线时按面自动计算几何法线；
- 不支持但常见的标准指令（`s`、`illum`、`Ke` 等）静默接受，其余未知指令逐条告警；
- 齐次坐标 `v` 的第 4 分量不参与渲染，会显式提示；
- 凹多边形按 OBJ 通用约定做扇面三角化。
