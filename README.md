# 立体短片左右眼校对工具

在本机核对两路（左眼 / 右眼）立体短片是否存在**错拍、上下偏移、单边过度裁切**，
并把两路共有区间导出成**并排预览片**。纯本地运行，素材不上传、不依赖任何网络服务。

## 功能对照

| # | 需求 | 实现 |
|---|------|------|
| 1 | 选两路本地视频，显示分辨率/时长/可共同预览范围，默认不按文件名猜左右 | 左右眼各自独立“选择本地视频”，绝不自动配对；载入后显示分辨率、帧率、时长、帧数、文件大小；自动计算并高亮两路共同可预览区间 |
| 2 | 左右单独时间偏移 + 垂直对齐，拖时间线停在同一目标时刻，缺帧明确标出 | 每只眼独立 `timeOffset`（秒/帧两种步进）与 `verticalOffset`（px）；主时间线是统一帧网格，同一主帧映射到两眼各自本地帧；越界区画红斜纹“缺帧 MISSING”并在读数里标红 |
| 3 | 并排 / 叠加 / 交替显示，网格十字可开关，缩放两边同比例 | 三种模式；叠加含半透明 / 红蓝 / 差值；网格、十字、安全框独立开关；滚轮缩放与拖拽平移作用于共享变换，两眼始终同比例 |
| 4 | 在对应帧选一对参考点，显示横纵偏差；换素材/改偏移后可复核并提示失效 | 在同一主帧各点一下，给出 dx/dy（左眼像素 + 占比 + 归一化百分比）；换素材、改时间偏移或帧率后标记自动转红“失效·需复核”，可定位回该帧重选；改垂直偏移不失效（dy 实时变化，方便调到 0） |
| 5 | 导出两路共有区间并排视频，起止画面可与预览核对；对齐设置可单独保存 | 页面内 MediaRecorder 逐帧合成 WebM，导出对话框显示首末帧缩略图供核对；另有帧精确 ffmpeg 导出 MP4；设置可存/读 JSON，并按素材签名在本机自动保存 |
| 6 | 自带两路几何短片，一路故意晚几帧并偏高，能在界面校回来 | 内置 Canvas 几何样片（右眼晚 4 帧、偏高 16px、上下裁切），“一键校回”填入正确参数；另可用 ffmpeg 生成走真实解码链路的同名 MP4 样片 |

## 快速开始

无需安装任何依赖（本机需有浏览器；可选 Node 跑测试、ffmpeg 跑 CLI 导出与样片生成）。

```bash
# 方式 A：直接双击 index.html（file:// 即可，全部功能可用）
open index.html

# 方式 B：起一个零依赖静态服务器（支持 Range，视频 seek 更顺）
npm run serve          # 等价 python3 -I scripts/serve.py，默认 http://127.0.0.1:8123/index.html
```

1. 左眼卡片点“载入内置样片”，右眼卡片同样点“载入内置样片”。
2. 时间线上拖动或按 ← / → 逐帧，观察右眼的错拍（三角/方块相位落后）与底部黑条（偏高）。
3. 右眼卡片点“一键校回（仅内置样片）”，自动填入 `timeOffset=-0.16s`、`verticalOffset=+16`；
   也可手动用 −1帧/+1帧、↑1px/↓1px 自己校。
4. 切到“叠加 → 差值”，对齐良好时画面趋近全黑；“红蓝”看重影收敛。
5. 右栏“选一对参考点”，先点左眼某特征、再点右眼同一特征，读 dx/dy；纵向把 dy 调到 0。
6. 右上“导出并排预览片”，核对首末帧缩略图后导出 WebM。

### 键盘

- `←` / `→`：逐帧；`Shift+←/→`：跳 10 帧
- `空格`：播放/暂停；`Esc`：取消参考点拾取
- 滚轮缩放、拖拽平移、双击复位

## 两套内置样片

**Canvas 样片（默认，零依赖）**：`js/sample.js` 实时绘制 640×360@25fps、100 帧几何场景
（旋转三角、移动方块、标尺、安全框、角标、帧号）。右眼烘焙了三路故障：

- 晚 4 帧：右眼文件第 f 帧装的是场景第 f−4 帧
- 偏高 16px：整幅上移，底部留 16px 黑条
- 上下裁切：顶部多裁 10%、底部多裁 6%，再缩回原尺寸（不可逆）

**ffmpeg MP4 样片（走真实视频解码链路）**：

```bash
npm run generate:samples   # 生成 public/samples/left.mp4、right.mp4、meta.json
```

故障参数与正确校回值记录在 `public/samples/meta.json`，与 Canvas 样片完全一致。
生成后在界面里用“选择本地视频”分别载入即可。

## 两条导出路径

**页面内导出（默认，无需 ffmpeg）**：逐帧 seek、Canvas 合成后经 `canvas.captureStream` +
`MediaRecorder` 输出 WebM。起止帧即预览缩略图，所见即所得。受浏览器编码器限制为 WebM。

**ffmpeg 帧精确导出（推荐用于长素材/归档/MP4）**：

```bash
# 先用界面“保存设置 JSON”，再让 CLI 消费同一份对齐设置
python3 -I scripts/export_sbs.py \
  --left public/samples/left.mp4 \
  --right public/samples/right.mp4 \
  --settings stereo_alignment_settings.json \
  --out out/sbs.mp4
```

也可完全脱离 JSON，用命令行单独指定：`--left-time-offset`、`--right-time-offset`、
`--left-vertical`、`--right-vertical`、`--base-fps`、`--start-frame`、`--end-frame`。
输出 `.mp4`（H.264）或 `.webm`（VP9），导出后自动 ffprobe 核对尺寸与帧数。
时间模型与 `js/core.js` 完全一致：`eyeT = T − timeOffset`，垂直正值=画面下移（顶部补黑）。

## 架构

```
index.html            页面结构
css/style.css         深色三栏样式
js/
  core.js             纯逻辑核心：主帧网格、有效区间、缺帧判定、参考点偏差/失效（无 DOM，可 Node 单测）
  sample.js           内置 Canvas 几何样片 FrameSource
  video.js            本地视频 FrameSource（隐藏 <video> 逐帧 seek）
  view.js             主画布视图：三种显示模式、网格/十字/安全框、共享缩放平移、缺帧绘制、标记拾取
  export.js           MediaRecorder WebM 导出 + 首末帧缩略图
  app.js              状态管理、DOM 编排、时间线、设置存取、播放循环、自检/演示钩子
scripts/
  serve.py            零依赖静态服务器（支持 Range）
  generate_samples.py ffmpeg 几何样片生成
  export_sbs.py       ffmpeg 帧精确并排导出
  browser_test.sh     headless Chrome 自检 + 截图
tests/
  core.test.mjs       Node 单元测试（node --test）
  cases.js            浏览器端自检用例（ESM，?selftest=1 加载）
  browser-selftest.js 自检引导
```

核心时间模型：主时间线是一条 `baseFps` 帧网格；每只眼在主帧 f 的本地帧为
`round((f/baseFps − timeOffset) × eyeFps)`，落在 `[0, frameCount)` 之外即缺帧。
两眼有效区间的交集就是共同可预览/可导出范围。

## 测试

```bash
npm test              # Node 单元测试（core.js 数学，10 项）
npm run test:browser  # headless Chrome 自检（14 项）+ 截图到 tmp/shots/
```

浏览器自检覆盖：样片装载、共同区间、帧映射、缺帧标识、参考点失效与 dy 实时性、
样片校回、画布渲染、三种显示模式、并排合成、真实 MP4 元数据解码、设置 JSON 往返。
URL 参数 `?demo=samples|overlay|corrected|missing` 可直接进入对应演示状态。

## 已知边界

- 浏览器容器不提供可靠的精确帧率，本地视频帧率默认 25，可在每只眼卡片手动改
  （支持 23.976/24/25/29.97/30/50/60 等任意输入）。
- headless Chrome 对媒体解码管线支持受限，自动化测试里视频 `seeked` 事件可能不触发，
  该部分在测试中容错跳过；真实浏览器正常，帧精确性由 ffmpeg CLI 路径端到端保证。
- 页面内导出为 WebM；需要 MP4 或严格帧精确时用 `scripts/export_sbs.py`。
