# MTPack — 游戏材质贴图通道打包整理工具

把颜色（Albedo）、法线（Normal）、粗糙度（Roughness）、AO、金属度（Metallic）等
贴图按自定义规则打包到输出图的指定通道，全程在浏览器本地完成，不需要在图片软件之间
反复手工导通道。零依赖、零构建，双击 `public/index.html` 或用任意静态服务器打开即可。

## 功能与需求对应

| 能力 | 说明 |
| --- | --- |
| 每通道指定来源与取色方式 | 每个输出通道可选择来源角色（颜色/法线/粗糙度/AO/金属度/自定义）与取色方式（R/G/B/A、亮度 Rec.709、RGB 均值） |
| 常量补齐与预览 | 来源缺失或显式选择常量时，用 0–255 常量补齐，界面显示灰度色块与逐通道灰度预览 |
| 尺寸不一致处理 | 拉伸 / 居中裁切 / 留边（自定义 RGBA 填充色）三种策略，预览上叠加留边区或裁切区提示 |
| 逐通道预览 | 合成结果之外，单独显示每个通道处理后的灰度图与来源说明，反转、强度、补齐都能直接看到 |
| 通道反转与强度 | 任意通道可单独反转、调强度（0–4） |
| 法线方向即时对比 | OpenGL/glTF（+Y）与 DirectX/Unity（-Y）一键切换，WebGL 球面同光照分屏对比表面效果，另带法线强度与光源方位角 |
| 批量处理 | 多组材质 × 多个输出一次性处理；同名文件自动追加序号，绝不互相覆盖 |
| 失败隔离 | 单个组/输出失败不影响其他项；失败原因写入界面日志与 `manifest.json`，成功项完整保留 |
| 工程保存/恢复 | 导出 JSON 工程，可选择内嵌图片（dataUrl）；重新打开后完整恢复通道映射，未内嵌的图片提示重新指定 |
| 导出物 | ZIP 内含每张输出 PNG、同名 `*_sources.txt` 来源说明、汇总 `manifest.json` |
| 内置样例 | 砖块/木纹两套颜色/法线/灰度贴图，外加一张 128×128 的尺寸不一致样例演示三种处理策略 |

## 支持的格式

- **输入**：PNG、JPG/JPEG、WebP、BMP、GIF（实际解码能力以浏览器为准；GIF 取首帧）
- **输出**：PNG（8bit RGBA，浏览器原生编码或内置 `CompressionStream` 编码器）
- **工程文件**：JSON（`.json`）
- **批量打包**：ZIP（STORE 方式，纯 JS 实现，无第三方依赖）

> 16bit PNG、EXR、TGA、TIFF 等格式当前版本不支持，浏览器解码时会被忽略或报错。

## 目录结构

```
public/
  index.html              页面入口
  css/styles.css          样式
  js/
    core.js               纯逻辑：通道取值、尺寸几何、分组匹配、ZIP、工程默认值（可 Node 单测）
    image.js              图像：加载、重采样、通道合成、法线变换、PNG 编码
    batch.js              批量处理、来源说明、工程序列化/恢复
    preview.js            预览渲染与 WebGL 法线球面
    app.js                界面与状态管理
  samples/                内置样例（生成物，见下）
tools/
  generate_samples.py     纯标准库样例生成器（含自己的 PNG 编码器）
  browser_smoke.py        Playwright 浏览器端到端冒烟测试
tests/
  core.test.js            纯逻辑单测
  png.test.js             PNG 编码往返（Python 解码校验）
  e2e.test.js            完整管线端到端测试（内置 Canvas shim）
  helpers/canvas-shim.js  Node 用最小 Canvas/2D 实现
```

## 使用方式

无需安装依赖。三种运行方式任选：

```bash
# 1. 直接双击 public/index.html（样例数据已 base64 内嵌，file:// 也能载入）

# 2. 本地静态服务器
npm run serve              # 然后访问 http://localhost:8080

# 3. 重新生成样例素材（public/samples 是生成物，可随时复现）
npm run generate:samples
```

### 典型流程

1. 点「载入贴图（可多选）」选择一套材质的多张图，工具按文件名后缀自动分组
   （如 `brick_albedo.png`、`brick_normal.png`、`brick_roughness.png` 归为 `brick` 组）；
   也可以点「载入内置样例」快速体验。
2. 在左侧「输出与通道映射」里调整每个输出通道的来源、取色方式、反转、强度；
   缺来源的通道选择常量补齐。
3. 中间栏可手工调整每个角色对应的文件（含尺寸不一致的样例）。
4. 右侧实时查看合成结果、逐通道灰度、法线球面效果。
5. 「批量导出 ZIP」得到 PNG + 每张图的来源说明 + manifest；
   「保存工程」留存配置，下次「打开工程」恢复。

### 文件名分组规则

默认后缀（可在工程 JSON 的 `roleSuffixes` 中扩展，匹配不区分大小写，取最长后缀）：

| 角色 | 识别后缀 |
| --- | --- |
| 颜色 | `_albedo` `_basecolor` `_color` `_diffuse` `_diff` |
| 法线 | `_normal` `_norm` `_nrm` `_n` |
| 粗糙度 | `_roughness` `_rough` `_r` |
| AO | `_ao` `_ambientocclusion` `_occlusion` |
| 金属度 | `_metallic` `_metal` `_m` |

识别不出角色的文件单独成组并放在「未分配」，可在界面手工指定角色；
同组同角色出现多个文件时保留先到者，后来者进未分配并给出警告。

## 测试

```bash
npm test                   # Node 原生 test runner，26 个用例（纯逻辑 + PNG 往返 + 端到端管线）
```

浏览器冒烟测试（需要本机有 Playwright 与 Chromium）：

```bash
python3 tools/browser_smoke.py
# 若 Playwright 小版本与缓存浏览器不匹配，可显式指定可执行文件：
CHROMIUM_PATH=/path/to/chrome-headless-shell python3 tools/browser_smoke.py
```

## 内置样例说明

`public/samples/` 由 `tools/generate_samples.py` 确定性生成（固定随机种子）：

- `brick_*`（256×256）：砖墙颜色、法线、粗糙度、AO、金属度
- `wood_*`（256×256）：木纹颜色、法线、粗糙度、AO
- `mismatch/brick_albedo_small.png`（**128×128**）：与同组 256 贴图尺寸不一致，
  用来演示留边/裁切/拉伸三种策略的实际效果
- `sample-data.js`：全部样例的 base64 内嵌副本，保证 `file://` 直接打开页面也能载入
- `MANIFEST.json`：样例清单与尺寸

## 隐私

所有图片处理都在浏览器内存与 Canvas 中完成，工程文件和导出 ZIP 均在本地生成，
不发起任何网络请求。
