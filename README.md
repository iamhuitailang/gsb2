# Shader Lab · 本地着色器试验台

一个完全离线运行的 WebGL 着色器实验工具：左边写 GLSL，右边实时看结果，
编译失败时保留上一次能用的画面而不是闪成空白。前端使用 **TypeScript + 原生 WebGL 1
（GLSL ES 1.00）**，零运行时第三方依赖。

## 浏览器要求

- 支持 **WebGL 1.0** 的现代浏览器：Chrome / Edge / Firefox / Safari（含 macOS Safari 14+）
- 需要支持 `ES2020` 语法（2020 年之后发布的浏览器版本均可）
- 无需联网、无需任何外部服务或 CDN；所有资源（含内置纹理）都在本地生成
- 开发服务器只监听 `127.0.0.1`，不暴露到局域网

## 快速开始

```bash
npm install        # 仅安装构建工具（vite / typescript），运行时无依赖
npm run dev        # 打开 http://127.0.0.1:5173
```

构建与本地预览构建产物：

```bash
npm run build      # 先做 TypeScript 严格类型检查，再打包到 dist/
npm run preview    # 本地静态预览 dist/
```

> 也可以把 `dist/` 目录放到任意静态服务器上，或直接用浏览器打开其中的
> `index.html`（部分浏览器对 `file://` 有限制时，请用 `npm run preview`）。

## 功能一览

### 1. 双预览共用同一份参数

- **全屏图形**：一个覆盖整个画布的三角形，片元着色器逐像素运行
- **纹理网格**：32×32 细分的 XZ 平面网格，带真实位置 / 法线 / UV，自动绕 Y 轴旋转
- 两种模式编译链接的是**同一份片元着色器、同一套 uniform 值**，切换模式不改参数

### 2. 编译失败不丢画面

- 编辑器左侧行号槽把出错行标红，画布下方列出完整错误，点击可跳转
- 编译失败时引擎**不会替换旧的 GPU 程序**，画布继续显示上一次成功的结果
- 修好代码后（停止输入约 350ms）自动重新编译并恢复

### 3. 侧栏参数与值保留

着色器里声明的 uniform 会自动生成控件：

| GLSL 声明 | 控件 |
| --- | --- |
| `uniform float` | 滑块 + 数值框 |
| `uniform int` / `bool` | 数值框 / 开关 |
| `uniform vec3/vec4`（名字含 color） | 取色器 |
| `uniform vec2/vec3/vec4` | 分分量数值框 |
| `uniform sampler2D` | 纹理上传 / 内置纹理 / 缩略图 |

支持行尾注解决定取值范围与默认值：

```glsl
uniform float uStrength; // @range(0, 2, 0.01) @default(0.8)
uniform vec3 uColor;     // @default(1.0, 0.5, 0.2)
```

重新编译后，**同名且同类型的 uniform 保留原值**；新增的取注解默认值，
删除的参数随旧声明一起移除。

### 4. 时间控制与可复现画面

- 播放 / 暂停按钮，时间线可拖动（拖动会自动暂停），也可直接输入固定秒数
- 时间完全由应用层传入着色器的 `uTime`，**设成相同时间 + 相同参数必然得到相同画面**
- 分辨率预设只改变画布内部像素数；uniform 数值含义不变，`uResolution` 会同步更新，
  做宽高比修正的着色器在任何尺寸下行为一致

### 5. 工程保存 / 重开 / 导出

- **保存工程**：下载 `.shaderlab.json`，包含两份源码、全部参数（纹理以 dataURL 内嵌）、
  预览设置和时间设置
- **打开工程**：载入同类 JSON 文件即可还原整个工作区
- **导出 PNG**：把当前画布内容导出为图片用于对照
- 编辑内容还会自动写入浏览器 `localStorage`，刷新页面后自动恢复

### 6. 内置示例

工具栏「载入示例」提供：

1. **纹理：UV 流动** — `sampler2D`、tiling、滚动与 tint
2. **光照：Blinn-Phong** — 法线 / 高光 / 轨道光源，网格模式下使用真实顶点法线
3. **后处理：色差扫描线** — 两 pass 渲染，后处理通过内置 `uScene` 采样场景纹理
4. **错误处理演示（故意写错）** — 观察行号标红、错误跳转与上一帧保留

## 着色器编写约定

你只需要写片元着色器的**声明和 `main()` 函数体**，引擎自动注入 precision 与内置变量：

```glsl
uniform float uTime;        // 秒；由时间线控制，暂停即静止
uniform vec2  uResolution;  // 画布内部像素尺寸
varying vec2 vUv;           // 0..1 屏幕 / 网格 UV
varying vec3 vNormal;       // 网格世界法线（全屏模式为 +Z）
varying vec3 vWorldPos;     // 网格世界坐标（全屏模式为裁剪空间 xy）
```

后处理 pass 额外自动提供：

```glsl
uniform sampler2D uScene;   // 主 pass 渲染出的场景纹理
```

后处理源码留空或取消勾选「后处理」即恢复单 pass。后处理编译失败时主 pass 不受影响，
画布继续显示未经后处理的场景画面，错误定位在 `post.frag` 编辑器里。保留名（`uTime`、
`uResolution`、`uMVP`、`uModel`、`uScene`）不会出现在侧栏。

## 目录结构

```
src/
├── main.ts               入口：自动恢复 / 载入默认示例
├── App.ts                主控：编译调度、主循环、工程读写
├── types.ts              全部共享类型
├── styles.css            暗色主题样式
├── state/                状态仓库、工程文件 IO
├── ui/                   零依赖 UI（编辑器、侧栏、时间线、预览面板）
├── webgl/                渲染引擎、GLSL、矩阵、几何、纹理、uniform 解析
└── examples/             内置示例工程
```
