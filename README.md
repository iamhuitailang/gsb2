# 本地多轨音频编排器

一个完全运行在浏览器里的多轨音频编排（DAW 风格）页面：把录音/示例片段摆到时间线上，
调整轨道音量与自动化关键点，预览播放并离线导出一段混音 WAV。**所有音频数据只留在本机，
不经过任何网络上传。**

技术栈：TypeScript + Vite，纯浏览器 Web Audio API（`AudioContext` / `OfflineAudioContext`），
Canvas 2D 绘制时间线，localStorage + IndexedDB 持久化，无运行时第三方依赖。

## 快速开始

```bash
npm install
npm run generate-samples   # 生成 4 个本地示例音频到 public/samples/（零依赖 Node 脚本）
npm run dev                # 打开 http://127.0.0.1:5173
```

构建与预览：

```bash
npm run build      # 先 tsc 类型检查，再 vite 构建到 dist/
npm run preview    # 本地静态预览构建产物
```

端到端测试（用系统 Chrome 的 CDP，无需额外下载浏览器；需先启动 `npm run preview` 或 `npm run dev`）：

```bash
npm run preview &      # 先起静态服务在 4173 端口
npm test               # 冒烟 33 项 + 音频内容 10 项 + 滚动对齐
# 或单独运行：
npm run test:smoke     # 播放、编辑、自动化、持久化、离线导出
npm run test:audio     # 实际渲染采样：静音/独奏/自动化电平/空轨道
npm run test:scroll    # 多轨道纵向滚动时左右对齐
npm run test:screenshot   # 生成 tests/timeline-screenshot.png 人工核对
```

## 功能对照

| 需求 | 实现 |
| --- | --- |
| 轨道新增、重命名、静音、独奏 | 左侧轨道控制列：＋ 新增、点名称重命名、M 静音、S 独奏（任一轨道独奏时其余轨道自动哑音） |
| 片段移动、裁切、复制 | 拖动移动；左右边缘手柄裁切（左裁切联动源 `offset`）；右键菜单或 `D` 复制；`Alt+拖动` 直接拖出副本 |
| 吸附 / 精细摆放 | 工具栏「吸附」开关。开启时片段边缘互吸 + 网格吸附；关闭后可按 0.02s 级精细摆放，方向键微调 |
| 缩放/平移时间坐标一致 | 所有几何位置都由 `时间 × pxPerSecond + scrollTime` 唯一映射；Ctrl/⌘+滚轮以鼠标位置为锚点缩放，平移与缩放不改变片段的实际时间 |
| 音量自动化关键点 | 轨道头 `A` 展开自动化层，双击空白加点、拖动改时间/音量、右键或选中删除；分段线性 ramp，播放中平滑变化；每个轨道的关键点独立数组，互不影响 |
| 播放/暂停/跳转同步 | 一次性按绝对时间把全部片段排到同一个 `AudioContext`，由音频时钟驱动，所有轨道样本级同步；跳转即整体重排 |
| 刷新后恢复 | 编辑防抖自动写入 localStorage（工程/视图），录音 Blob 写 IndexedDB；页面隐藏/关闭前强制落盘，刷新即恢复 |
| 按项目长度导出 | `OfflineAudioContext` 渲染长度 = 工程长度；空轨道/静音片段不产生源节点（对应区域为静音）；可配置末尾淡出 |
| 导出与预览一致 | 在线播放与离线导出共用 `src/audio/scheduler.ts` 的同一套调度/增益/自动化逻辑 |
| 示例工程 | 内置两条轨道（鼓组、贝斯），含重叠、间隔、被静音的片段与多处自动化关键点 |

## 操作速查

- 空格：播放/暂停；Home/0：回到开头
- 标尺上按下拖动：scrub 跳转播放指针
- 片段：拖动移动、边缘裁切、右键菜单（复制/静音/重命名/删除）、`Alt+拖动` 复制
- 方向键：微调选中片段（Shift 加大步长）；`D` 复制；Delete/Backspace 删除
- 滚轮：横向平移；Ctrl/⌘+滚轮：以鼠标为锚点缩放；Shift+拖动空白：平移
- 自动化层：双击空白加点，拖点调整，选中后 Delete 删除点
- 素材库：选中资源 → 点轨道头 ＋ 或时间线右键放置；支持导入本地音频与麦克风录音

## 浏览器权限要求

1. **音频播放**：浏览器自动播放策略要求 `AudioContext` 必须由用户手势（点击/按键）启动。
   首次点击播放或页面任意位置后即完成初始化，之后播放不再受限。
2. **麦克风录音（可选）**：点击「开始录音」时浏览器会弹出麦克风授权；拒绝授权不影响其他功能，
   录音数据以 WAV 形式存入浏览器 IndexedDB，仅本机可访问。可用 `--use-fake-ui-for-media-stream`
   在自动化测试中绕过授权弹窗。
3. **文件导入（可选）**：通过系统文件选择器读取本地音频，不会上传。
4. **存储**：工程保存在 localStorage，录音 Blob 保存在 IndexedDB；清理浏览器站点数据会删除它们，
   重要工程请先用「导出混音 WAV」留档。
5. 建议使用最新版 Chrome/Edge（Chromium），Firefox/Safari 较新版本同样支持，
   但 `OfflineAudioContext` 与 `decodeAudioData` 的回调兜底已做兼容。

## 目录结构

```
src/
  types.ts               工程数据模型（时间单位均为秒）
  store.ts               单一状态仓库 + 防抖持久化
  sampleProject.ts       内置示例工程与示例资源描述
  main.ts                组装入口、滚动同步、生命周期落盘
  audio/
    AudioEngine.ts       在线播放引擎（播放/暂停/跳转/同步）
    scheduler.ts         在线与离线共用的工程调度核心
    exporter.ts          OfflineAudioContext 离线渲染导出
    Recorder.ts          麦克风录音 → WAV → IndexedDB
    peaks.ts             波形峰值提取（Canvas 绘制用）
    wav.ts               PCM WAV 编解码
  ui/
    timeline.ts          Canvas 时间线：绘制 + 全部鼠标/键盘交互
    trackHeaders.ts      轨道控制列
    mediaBin.ts          素材库 / 导入 / 录音
    toolbar.ts           走带、缩放、吸附、导出、工程管理
  utils/                 存储、自动化插值、通用工具
scripts/generate-samples.mjs  纯 Node 合成示例音频
tests/
  smoke.mjs              CDP 端到端冒烟测试（33 项）
  audio-content.mjs      渲染采样级验证：静音/独奏/自动化/空轨道（10 项）
  scroll-align.mjs       多轨道纵向滚动的左右对齐验证
  screenshot.mjs         截图脚本，输出 timeline-screenshot.png
```

## 数据与隐私

- 示例音频由 `scripts/generate-samples.mjs` 在本地合成（鼓组 = 振荡器+噪声，贝斯 = 锯齿波），
  不含任何外部音频文件。
- 录音、导入、工程编排数据均保存在浏览器本地存储中，页面没有任何网络上报逻辑。
