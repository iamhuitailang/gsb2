# 时间标注台 · 采访录音标注

在浏览器里给采访录音做**时间标注**：在波形上框出说话片段、声音事件和听不清的地方，给区间加备注和置信状态，最后按标注导出片段清单（JSON / CSV）。不需要联网，也不做语音识别——所有时间点由人工拖出来。

- 纯前端、零运行时依赖（原生 ES 模块 + Web Audio + Canvas），音频不上传
- **时间单位统一为「秒」**（seconds），存盘精度为毫秒（3 位小数）；界面显示为 `mm:ss.mmm`（超过 1 小时为 `h:mm:ss.mmm`）

---

## 快速开始

```bash
npm start                  # 启动本地静态服务器，默认 http://127.0.0.1:4173/
```

打开页面会自动载入内置示例：一段 28 秒的「采访」录音（浏览器内实时合成，无需下载或生成文件）+ 对应的 11 个标注区间。也可以点「打开 → 载入内置示例」重新载入，或直接把自己的音频拖进页面。

> 只支持 `npm start` 这类 HTTP 访问；直接双击 `index.html`（`file://`）会因 ES 模块和 Web Audio 的限制而无法使用。

其他命令：

```bash
npm test                   # 运行核心逻辑测试（node:test，无需安装依赖）
npm run verify             # 生成示例 WAV + 跑全部测试（推荐）
npm run generate:samples   # 可选：把示例音频落盘为 WAV（public/samples/）
node scripts/serve.mjs --port 8080 --host 0.0.0.0   # 指定端口/监听地址
```

环境要求：Node.js ≥ 20（仅用于起静态服务器和跑测试）；浏览器需支持 Web Audio、Canvas、IndexedDB（Chrome / Edge / Safari / Firefox 近期版本均可）。

> 应用本身不依赖 `public/samples/` 里的文件——示例音频由 `public/js/demo/synth.js` 在浏览器内实时合成。`npm run generate:samples` 只是把同一份合成器输出为 WAV，方便用其他播放器核对。

---

## 功能与操作

### 1. 在波形上创建、移动、拉伸区间

| 操作 | 方式 |
| --- | --- |
| 创建 | 在波形空白处**拖动**（双击空白处直接建 1 秒区间；`N` 在播放头建 1 秒） |
| 移动 | 按住区间**拖动** |
| 拉伸 | 拖动区间**左右边缘**（光标变为 `col-resize`） |
| 删除 | 选中后按 `Delete`，或列表里的 ✕ |
| 分割 | 播放头位于区间内时按 `S` |
| 复制 | 属性面板的 ⧉ 按钮 |

- 区间以**音频时间（秒）**保存，缩放、滚动、窗口大小变化都只影响像素映射，标注时间不会漂移；放大到采样级仍能精确对位。
- 拖动时有**吸附**（区间边界、播放头、0 点和音频结尾），按住 `Alt` 临时关闭吸附。
- 重叠区间自动分配到不同泳道；空白处有极淡红色底提示。

### 2. 标注类型与说话人、区间列表

- 点工具栏或状态栏的「类型与说话人」维护标注类型（名称、颜色）和说话人（名称、颜色）。
- **区间允许重叠**；列表按开始时间排序，可按类型/说话人筛选。
- 点列表项会选中并**跳转到该区间的开始位置**；播放时命中区间在列表和波形上同时**高亮**。
- 列表项上的 ▶ / ↻ 可直接播放 / 循环试听单个区间。

### 3. 备注与置信状态、改名同步

- 属性面板可为每个区间设置**置信状态**：`确定` / `存疑` / `听不清`；存疑与听不清在波形上用虚线轮廓区分，并带列表徽标。
- 每个区间有独立**备注**字段（最长 4000 字），适合记录「疑似某词、待复核」。
- 修改说话人或标注类型**名称**后，所有引用它的区间会立即显示新名称；**区间的 `start` / `end` 时间原样保留**（数据模型只存引用 ID，改名不触碰时间字段）。

### 4. 快捷键与边界试听

- `空格` 播放/暂停；`←` / `→` 后退/前进（`Shift` 1 秒，`Alt` 10 毫秒）；`↑` / `↓` 跳到上/下个区间；`Home` / `End` 到首尾。
- `[` `]` 调起点 ±10ms（`Alt` 100ms），`{` `}` 调终点，`,` `.` 整体平移；时间框里也可直接输入 `12.345` 或 `1:02.345`。
- 拖动区间边界时自动**循环试听**边界附近的 0.6 秒，松开即停；`L` 可对选中区间持续循环。
- `+` / `−` 缩放，`0` 适合窗口，`⌘/Ctrl+滚轮` 以光标为锚点缩放，`Shift+滚轮` 横向滚动。
- 完整列表见页面右上角「快捷键」。

### 5. 保存、导出、导入

| 动作 | 说明 |
| --- | --- |
| 保存工程 | 导出 `.gsb2.json`，含标注、类型/说话人、视图和**内嵌音频**（本机音频 ≤ 16 MB 时以 data URL 内嵌），重新打开即可继续编辑 |
| 导出 JSON | `*.annotations.json`：每个区间含 `start`/`end`（秒）、`startTimecode`、`label`、`speaker`、`confidence`、`note` |
| 导出 CSV | UTF-8、CRLF，表头：`id,start_seconds,end_seconds,duration_seconds,start_timecode,end_timecode,label,speaker,confidence,note` |
| 导入 JSON / CSV | 覆盖当前标注；缺类型/说话人会自动补建，CSV 支持中英文表头，也可只用 `*_timecode` 列 |

- 编辑内容自动保存到浏览器 IndexedDB；本机音频按内容哈希存本地，不上传。
- 若打开工程时音频未内嵌且本机没有缓存，界面会标明「音频未载入」，用「打开 → 加载音频文件」补选即可，标注仍完整恢复。

### 6. 内置示例

示例音频由 `public/js/demo/synth.js` 在浏览器内实时合成：28 秒、16-bit PCM 单声道、44.1 kHz 的「采访」，并附带 11 个标注区间（`demoProject()`）。它刻意覆盖：

- 两位说话人交替说话；
- **重叠**：15.2–16.6 s 两人同时说话（两个区间落在不同泳道）；
- **空白**：如 0–1.2 s、17.1–18.0 s、24.7–25.5 s 等多段无标注区间；
- **听不清**：18.0–19.4 s 的低语片段（置信状态「听不清」+ 备注）；
- 声音事件：杯碟声、椅子挪动声、翻纸声；
- 「存疑」置信状态与备注示例。

运行 `npm run generate:samples` 可以把**同一份合成器输出**落盘为 `public/samples/demo-interview.wav` 与 `demo-project.json`，便于用外部播放器或脚本核对；应用本身不读取这两个文件。

---

## 数据格式

### 工程文件（`.gsb2.json`，可继续编辑）

```json
{
  "format": "gsb2.project",
  "version": 1,
  "timeUnit": "seconds",
  "name": "示例：采访录音（含重叠与空白）",
  "audio": { "fileName": "demo-interview.wav", "duration": 28, "sampleRate": 44100, "channels": 1, "source": "sample" },
  "labels": [{ "id": "label_speech", "name": "说话", "color": "#f0b35a" }],
  "speakers": [{ "id": "spk_guest", "name": "受访者", "color": "#34d399" }],
  "regions": [
    {
      "id": "reg_demo_002",
      "start": 5.4,
      "end": 9.6,
      "labelId": "label_speech",
      "speakerId": "spk_guest",
      "confidence": "certain",
      "note": "受访者介绍工作经历。"
    }
  ],
  "view": { "start": 0, "pxPerSecond": 52 }
}
```

### 导出 JSON（`*.annotations.json`）

在工程结构上增加了扁平化的展示字段，便于脚本直接消费：

```json
{
  "format": "gsb2.project",
  "kind": "annotation-export",
  "timeUnit": "seconds",
  "project": { "name": "示例", "durationSeconds": 28 },
  "annotations": [
    {
      "id": "reg_demo_002",
      "start": 5.4,
      "end": 9.6,
      "startSeconds": 5.4,
      "endSeconds": 9.6,
      "durationSeconds": 4.2,
      "startTimecode": "00:05.400",
      "endTimecode": "00:09.600",
      "labelId": "label_speech",
      "label": "说话",
      "speakerId": "spk_guest",
      "speaker": "受访者",
      "confidence": "certain",
      "confidenceLabel": "确定",
      "note": "受访者介绍工作经历。"
    }
  ]
}
```

`confidence` 取值：`certain`（确定）/ `uncertain`（存疑）/ `inaudible`（听不清）。

---

## 时间单位与精度

- **唯一时间单位：秒**。所有 JSON 字段、CSV 列、内部计算、快捷键步长（0.01 s）都以秒为准。
- 存盘前四舍五入到**毫秒**（`roundSeconds`，3 位小数），避免浮点尾差；界面与 `*_timecode` 列按毫秒显示。
- 界面显示使用 `mm:ss.mmm`，解析输入时支持 `12.345`、`12.345s`、`12.345秒`、`1:02.345`、`1:02:03.456`。
- 最短区间 0.02 秒（`MIN_REGION_SECONDS`），避免零长度区间导致无法再次选中。

---

## 项目结构

```
public/
  index.html            页面骨架
  styles.css            界面样式
  js/
    app.js              应用控制器：装配 UI、快捷键、导入导出、自动保存
    storage.js          IndexedDB：音频 Blob 与草稿
    core/
      time.js           时间格式化/解析、毫秒取整、区间夹取
      model.js          ProjectStore（撤销/重做、区间/类型/说话人 CRUD、文档校验）
      layout.js         重叠泳道分配、覆盖/重叠/空白统计、分割
      view.js           秒↔像素映射、缩放锚点、视口约束
      export.js         JSON/CSV 导出、CSV 解析、JSON/CSV 导入
    audio/
      engine.js         Web Audio 播放、循环、边界试听
      peaks.js          波形峰值与包络
    demo/
      synth.js          示例音频合成器与示例标注（纯函数，Node 也可用）
      index.js          把合成结果包成 WAV Blob，走统一加载流程
    ui/
      timeline.js       波形/标尺/总览绘制与指针交互
scripts/
  generate-samples.mjs  把示例音频落盘为 WAV（可选）
  verify.mjs            生成样例并跑测试
  serve.mjs             零依赖静态服务器
tests/                  node:test 核心逻辑测试
```

## 已知边界

- 不支持在线语音识别，也不自动切分说话人；时间点全部人工标注。
- 示例音频为程序合成的模拟人声，仅用于演示交互，不包含真实语义。
- 超长录音（数小时）会按块计算波形峰值，长音频建议用 WAV/MP3 中较低码率以加快解码。
- 工程文件内嵌音频上限 16 MB；超过时仍会保存在本浏览器 IndexedDB，换机器请另行拷贝音频。
- 音频解码依赖浏览器自身的解码器（Web Audio `decodeAudioData`），个别编码（如部分 DRM/特殊封装）可能不受支持。
