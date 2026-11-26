# 多机位对齐整理工具

把几台摄像机（外加独立录音机）的素材对齐到**同一条时间线**，再逐段选择使用哪个机位。
纯浏览器应用，**零依赖、零构建、零网络请求**——所有素材只通过 `File` 对象在本机读取，
不会上传、不写原文件，刷新页面即清空。

## 快速开始

```bash
# 1. 生成样例素材（两机位短视频 + 一段不同步的参考音频，输出到 public/samples/，已被 .gitignore 忽略）
npm run generate:samples

# 2. 启动本地静态服务器
npm start            # 默认 http://localhost:5173/ ，可用 PORT=xxxx npm start 改端口

# 3. 跑核心逻辑单元测试
npm test

# 4. （可选）校验样例的音频同步精度，期望误差在 5ms 内
npm run verify:samples
```

浏览器打开后点 **「载入样例素材」** 即可一键载入 `public/samples/` 下的三个文件；
也可以点 **「导入视频/音频」** 选择自己的素材（支持多选，混选视频和音频）。

> 必须通过 `npm start` 以 http 方式打开；直接双击 `index.html`（file://）会被浏览器的
> ES Module 同源策略拦截。

## 工作流（对应需求）

### 1. 导入与音频波形同步，手动校正并记录偏移

- 导入后每个素材解码出音频，在时间线泳道里画出波形。
- 「① 音频同步」面板点 **音频同步全部**：以第一个带音轨的素材为参考机位，
  对其余素材做 **onset 能量包络 + 归一化互相关**（包络采样率 200Hz，理论精度 5ms），
  算出的结果直接写入该素材的偏移 `offset`，并给出置信度和多个候选峰值。
- 自动结果不理想时，在「② 偏移手动校正」里用 `±1 帧 / ±1ms` 按钮或直接输入秒数微调；
  也可以在时间线上拖动素材泳道左缘的**黄色手柄**。偏移随工程保存，即「记录偏移」。
- 没有音轨的素材会标注「无音轨」，只能手动对齐。

### 2. 时间线上切换机位，切点按帧对齐、预览无时间跳跃

- 双击标尺/泳道在播放头处加切点；拖动段落轨道上的**白色圆点**移动切点。
- 切点时间会吸附到**切入机位**的帧网格（不同机位各自帧率分别处理），不会出现半帧。
- 在下方段落表格里点机位按钮（或选中段后按数字键 `1-9`）切换该段机位。
- 播放引擎只有**一个权威时间线时钟**（`performance.now()` 驱动）。切换机位只更换显示的
  素材元素并把它 seek 到对应整帧，时钟从不重置，因此预览中机位变化不会产生时间跳跃；
  任意时刻只有当前段素材出声。

### 3. 帧率/时长不同、素材越界时明确显示，不补黑帧

- 每个素材按自己的 `fps` 和 `duration` 在时间线上占一个覆盖区间，区间外用斜纹提示。
- 段落轨道里，落在素材覆盖范围外的部分用**红色斜纹**标出；播放到该位置时，预览区显示
  黄黑斜纹警示卡，写明「素材尚未开始 / 已经结束 / 素材缺失」、时间线时间、映射到的素材
  时间和该机位的覆盖区间。**绝不静音填充黑帧**。
- 样例特意让 camA（25fps, 6s）比 camB（30fps, 8s）短，切到 camA 尾部即可看到越界警示。

### 4. 保存剪辑决定、导出切换清单，重开后定位原素材时间

- **保存工程**：导出 `*.multicam.json`，只含素材文件名/大小指纹、帧率、时长、偏移和切点，
  **不含媒体本体**。
- **打开工程**：选择工程 json 并**同时重新选择**对应的本地素材文件（可多选），工具按
  「文件名 + 大小」匹配。找不到的素材会保留记录并在相关段落标注「素材缺失」，不会被静默丢弃。
- **导出清单**：见下方格式说明。清单同时给出时间线时间和原素材内时间/帧号，
  因此重新打开或交给其它软件都能定位回原始素材。

### 5. 修改偏移只重算受影响切点，并对比修改前后

- 调整某素材偏移时，只有「切入该机位」的切点会平移并重新吸附帧网格，其它机位的切点不动
  （单测 `修改偏移只重算切入该机位的切点` 覆盖此行为）。
- 「修改前后对比」面板实时列出偏移变化量和每个受影响切点的修改前/后时间。
- 点 **对比修改前后（切换预览）** 在两套时间线之间来回切换，播放头的时间线时间保持不变，
  可直接 A/B 比较画面；「撤销本次偏移修改」一键回到修改前。

### 6. 样例素材

`npm run generate:samples` 用本机 ffmpeg 合成（无外部版权素材）：

| 文件 | 规格 | 点击声位置（素材本地时间） |
| --- | --- | --- |
| `camA_synctest_25fps.mp4` | 25fps，6s，蓝色画面 | 2.2 / 3.2 / 4.2 / 5.2 s |
| `camB_synctest_30fps.mp4` | 30fps，8s，绿色画面 | 3.0 / 4.0 / 5.0 / 6.0 s（整体晚 0.8s） |
| `reference_click.wav` | 纯音频，5.5s | 1.7 / 2.7 / 3.7 / 4.7 s（比 camA 早 0.5s） |

三份文件的点击声是同一条「拍板轨」，只是前置静音长度不同。同步后预期：
camB 的偏移 ≈ **-0.800s**，reference 的偏移 ≈ **+0.500s**（`npm run verify:samples` 自动校验）。

## 导出的机位切换清单（EDL）

点 **导出清单 JSON / CSV**，得到 `*.edl.json` 或 `*.edl.csv`。

### JSON 结构

```jsonc
{
  "format": "multicam-edl",
  "formatVersion": 1,
  "exportedAt": "2026-11-27T00:00:00.000Z",
  "timeline": { "start": -0.8, "end": 8, "duration": 8.8 },
  "sources": [ /* 每个素材的 fps/duration/offset/时间线覆盖区间 */ ],
  "cuts": [ /* 每个机位段落一行，字段见下 */ ]
}
```

每个段落（`cuts[i]`）字段：

| 字段 | 含义 |
| --- | --- |
| `index` | 段落序号（从 1 开始） |
| `sourceName` / `sourceId` | 使用的机位素材 |
| `kind` | `video` / `audio` |
| `fps` | 该机位帧率（音频为 null 时按 30 显示时间码） |
| `timelineStart` / `timelineEnd` / `timelineDuration` | 在统一时间线上的起止秒与时长 |
| `sourceStart` / `sourceEnd` | 对应**原素材内**的起止秒（越界为 null） |
| `sourceStartFrame` / `sourceEndFrame` | 原素材内帧号 |
| `timecodeStart` | 时间线起点的 SMPTE 风格时间码 `HH:MM:SS:FF` |
| `status` | `ok`，或 `out-of-range:before-source-start` / `out-of-range:after-source-end` / `out-of-range:source-missing` |

### CSV 列

`index, sourceName, kind, fps, timelineStart, timelineEnd, timelineDuration, sourceStart, sourceStartFrame, sourceEnd, sourceEndFrame, timecodeStart, status`

含逗号或引号的字段按标准 CSV 规则转义。**越界段不会被裁剪或补黑帧**，而是保留时间区间并在
`status` 列显式标注，交给后续剪辑软件或人工处理。

## 目录结构

```
index.html                  页面骨架
src/
  app.js                    主控制器：状态、撤销/重做、同步、对比、导入导出
  media.js                  本地 File 读取、帧率探测、音频解码（Web Audio）
  player.js                 单时钟播放引擎、帧对齐、越界警示卡
  timeline.js               Canvas 时间线：泳道/波形/段落/切点/播放头
  styles.css
  core/
    time.js                 帧率/帧网格/时间码纯函数
    model.js                工程模型、切点与偏移重算、覆盖状态（纯函数，可单测）
    sync.js                 音频包络与归一化互相关
    edl.js                  切换清单 JSON/CSV 导出
    persistence.js          工程序列化/反序列化、素材指纹匹配
scripts/
  serve.mjs                 零依赖静态服务器
  generate-samples.sh       ffmpeg 合成样例
  verify-samples.mjs        样例同步精度校验
test/core.test.js           Node 内置 test runner 的核心逻辑单测
```

## 隐私与本地数据边界

- 不引入任何第三方运行时依赖，`package.json` 无 dependencies；不加载远程字体、脚本或统计代码。
- 素材通过 `URL.createObjectURL(file)` 在本机浏览器内读取，工程文件和 EDL 通过
  `Blob` 下载到本地，**没有任何网络上传路径**。
- 工程文件只保存文件名、大小、偏移和剪辑决定，不保存素材内容；重新打开需要再次选择本地素材。
