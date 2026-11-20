# 本地字幕校对工具

一个**纯前端、零依赖、纯本地运行**的字幕校对页面：边听视频边调整字幕时间与文字，
完成后导出 SRT 或 WebVTT。所有文件只在浏览器内处理，不上传任何数据。

## 本地启动

需要任意一个静态文件服务器（浏览器对 `file://` 下的 `fetch`/模块有限制，建议走 HTTP）。

### 方式一：Python（macOS 自带，无需安装）

```bash
cd <本仓库目录>
python3 -m http.server 8128
# 或 npm start
```

然后浏览器打开 <http://127.0.0.1:8128/index.html>

### 方式二：Node

```bash
npx serve .          # 或 npx http-server -p 8128
```

打开页面后：

1. 顶部「导入视频」选择 `samples/sample.mp4`（页面已默认引用该样例，可直接播放）；
2. 「导入 SRT / VTT」选择 `samples/sample.srt` 或 `samples/sample.vtt`；
3. 也可以直接把字幕/视频文件**拖入页面**。
4. `samples/malformed.srt` 是一份故意写错的样例，用于演示「坏行单独报错、不整份读空」。

## 功能与对应实现

| 需求 | 实现方式 |
| --- | --- |
| 导入 SRT/VTT，保留顺序与原文，坏行单独提示 | `js/parser.js` 逐块解析；坏块只进错误列表并标注**文件行号**，其余条目照常导入，绝不整体返回空白 |
| 列表与时间轴联动、拖动试听、缩放后精度可控 | `js/timeline.js` 用 Canvas 绘制；拖块平移、拖左右边缘改起止点，松手自动定位到该片段试听；状态栏实时显示 `ms/px`，放大即可获得毫秒级精度 |
| 倒置/重叠/空文本/超时检查，可保留有意重叠 | `js/validator.js` 输出四类问题；重叠项可「标记有意重叠」，状态写入本地存档并在重新校验后保留 |
| 按帧率或毫秒显示，导出不漂移 | 内部**统一存整数毫秒**（`js/time.js`），帧率仅用于视图层 `毫秒↔帧` 换算；导出始终由毫秒生成，反复切换/导出再导入均无累积漂移 |
| 搜索替换逐条预览；撤销重做区分文字与时间 | 搜索面板逐条高亮匹配并预览替换结果，支持单条/全部替换与正则；`js/history.js` 为文字、时间维护**两条独立撤销栈**，互不干扰 |
| 导出 SRT/VTT 再导入，时间与特殊字符一致 | `js/serializer.js`：SRT 文字原样往返；VTT 导入时反转义 `&amp;` 等实体、导出时重新转义，cue 设置一并保留 |

### 时间轴操作

- **Ctrl/⌘ + 滚轮**（或顶部按钮）缩放，缩放时鼠标指向的时间点保持不动；
- 拖动字幕块**中间**整体平移，拖动**左右边缘**调整开始/结束时间，松手自动试听；
- 单击块体选中并在左侧列表定位，**双击**时间轴空白处跳转播放位置；
- 键盘：`空格` 播放/暂停，`←/→` 微调起点（`Shift` ×10，`Alt` 平移整条），`[` `]` 调终点；
  帧模式下微调步长为 1 帧，毫秒模式下为 10ms。

### 撤销/重做快捷键

- `Ctrl/⌘+Z` 撤销文字，`Ctrl/⌘+Shift+Z` / `Ctrl/⌘+Y` 重做文字；
- 加 `Alt` 组合（如 `Ctrl/⌘+Alt+Z`）操作**时间栈**；也可直接点顶部四个独立按钮。

### 自动保存

校对过程中项目会定时写入浏览器 `localStorage`，刷新或重开页面时会提示是否恢复上次进度
（含「有意重叠」标记）。清除浏览器站点数据即可清空。

## 目录结构

```
index.html            页面结构
css/style.css         深色主题样式
js/
  time.js             毫秒/帧码/时间戳换算（内部统一整数毫秒）
  parser.js           SRT/VTT 容错解析，坏行单独报错
  serializer.js       SRT/VTT 序列化与 WebVTT 实体转义
  validator.js        倒置/重叠/空文本/超时校验
  history.js          文字、时间两条独立撤销栈
  timeline.js         Canvas 时间轴（缩放、拖拽、试听、播放头）
  app.js              状态管理、列表、搜索替换、事件装配与持久化
samples/
  sample.mp4          12 秒、25fps 样例视频（ffmpeg 生成）
  sample.srt          含特殊字符的 SRT 样例
  sample.vtt          含 cue 设置与实体的 VTT 样例
  malformed.srt       故意写错的容错演示样例
tests/
  run-tests.js        Node 纯逻辑测试（解析容错、往返、帧率无漂移、校验、双栈）
  smoke.html          浏览器端到端冒烟测试页面
  cdp-run.js          零依赖 CDP 驱动，用本机 Chrome 跑 smoke.html
```

## 测试

### 纯逻辑测试（无需浏览器）

```bash
npm test          # 等价于 node tests/run-tests.js
```

覆盖：时间戳/帧码换算、SRT/VTT 解析容错（含全坏文件不读空）、导出再导入的时间与
特殊字符往返、跨格式与帧率编辑无漂移、四类校验、有意重叠、文字/时间双栈隔离。

### 浏览器端到端测试

需要本机装有 Chrome/Edge，并先启动静态服务器：

```bash
python3 -m http.server 8128          # 终端 A
# 终端 B：
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-smoke about:blank &
npm run test:browser
```

`tests/cdp-run.js` 通过 Chrome DevTools Protocol 驱动一个零依赖 WebSocket 客户端，
打开 `tests/smoke.html` 模拟完整用户流程（导入→校验→撤销重做→搜索替换→帧编辑→
导出往返→坏文件→VTT 实体），共 37 项断言。

## 重新生成样例视频

```bash
npm run generate:samples
```

## 设计说明：为什么不会整体漂移

所有时间在内存中都是**整数毫秒**。「按帧率显示」只是把毫秒渲染成 `HH:MM:SS:FF`，
在帧模式下编辑时立即把帧四舍五入换算回毫秒存储；导出文件的时间戳永远从毫秒生成，
帧率本身不参与导出，因此无论切换多少次帧率、用什么帧率编辑，导出再导入的时间都与
内部值逐毫秒一致（测试中有专门用例验证）。
