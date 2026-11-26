# WAV 采样点级分段与复原工具

一个完全本地运行的 WAV 分段、交接校验和样本级复原验收工具。提供浏览器界面和命令行，仅依赖 Python 标准库。

核心验收口径是**采样帧连续**：

- 所有切点最终都换算成整数采样帧；
- 分段区间统一为半开区间 `[start_frame, end_frame)`；
- 相邻分段满足 `prev.end_frame == next.start_frame`；
- 因此拼接原始采样字节时不会重复样本，也不会漏掉样本；
- 导入时重新计算实际 WAV 的原始采样数据 SHA-256，不只检查文件名。

## 快速开始

```bash
# 启动本地网页工具（默认 http://127.0.0.1:8765）
python3 wav_tool.py serve

# macOS 也可以在 Finder 中双击 start-macos.command

# 或查看 CLI
python3 wav_tool.py --help

# 运行样本级单元测试
python3 -m unittest discover -s tests -v
```

浏览器打开 <http://127.0.0.1:8765>。服务只监听本机地址，处理过程不调用外部服务。选择的原始文件不会被改写；服务端只在系统临时目录保存处理副本。

## 界面操作

### 1. 选择原始 WAV

支持：

- PCM 8 / 16 / 24 / 32 bit；
- IEEE float 32 / 64 bit；
- 单声道或多声道；
- 标准 RIFF/WAVE 与常见 `WAVE_FORMAT_EXTENSIBLE` PCM/float。

页面会显示采样率、声道数、总采样帧数、时长和位宽。

### 2. 选择切点并核对实际采样点

支持三种方式：

1. 固定间隔秒数，例如每 60 秒一段；
2. 一组自定义时间点（秒，可为小数）；
3. 一组精确整数采样帧。

对于秒制切点，页面显示：

- 输入时间；
- 四舍五入后的**实际采样帧**；
- 该采样帧对应的实际时间；
- 取整误差（采样帧和毫秒）。

每个切点旁有“试听跨切点”按钮。可设置切点前/后时长，工具会从原始 WAV 精确导出 `[cut - pre, cut + post)` 短 WAV，播放器下方显示实际半开采样帧范围。

### 3. 导出

点击导出后得到 ZIP：

```text
wav_segments_with_manifest.zip
├── manifest.json
└── segments/
    ├── segment_001.wav
    ├── segment_002.wav
    └── ...
```

`manifest.json` 记录：

- 工具和清单版本；
- 原始文件名、整文件 SHA-256、WAV 参数、总采样帧数；
- 每段顺序、期望文件名；
- `start_frame` / `end_frame` / `frame_count`；
- 起止秒数；
- 导出 WAV 文件的 SHA-256：`sha256_file`；
- 去掉 WAV 头后的交错原始采样字节 SHA-256：`sha256_raw`。

### 4. 导入与逐段校对

先选择 `manifest.json`，然后可以：

- 多选所有分段 WAV；
- 选择整个交接文件夹；
- 在每个清单位置手动指定文件。

工具会逐段检查：

- 文件是否缺失；
- WAV 是否能读取；
- 声道、采样率、采样宽度/格式是否一致；
- 原始采样数据 SHA-256 是否等于清单；
- 整个 WAV 文件 SHA-256 是否一致；
- 文件名是否与清单一致。

异常定位：

- **缺段**：直接给出该段对应的来源采样帧范围和时间范围；
- **调换**：如果当前位置的文件哈希匹配清单中的另一段，会指出它实际属于第几段、真实采样点范围；双向调换会标记为 reciprocal swap；
- **同名替换**：文件名等于期望文件名但采样内容不匹配任何清单分段时，标记为 `same_name_replaced`；
- **损坏/错误 WAV**：显示读取错误。

如果所有期望内容的哈希都还在，只是位置/文件名调换，工具可以生成“按哈希识别真实位置”的纠正预览；样本可能完全一致，但当前交接顺序仍明确判定为不完整，不会静默当作正常验收。

如果确实缺段或存在未知替换，预览 WAV 保持原始总帧数和时间轴，缺失/不可信范围写零样本（静音）。页面可试听和下载该 `partial_timeline_preview.wav`，但状态仍是**部分预览，不算完整拼回**。

### 5. 与原始音频比较

可选择原始 WAV，或点击“使用上方已加载原始 WAV”。比较器会：

- 比较原始和拼回文件的总采样帧数，即每声道样本数；
- 比较采样率、声道数和采样格式；
- 解码每个声道的实际样本；
- 统计每声道不同样本数；
- 报告第一个差异的采样帧、时间、原始值和拼回值；
- 把连续差异合并成 `[start_frame, end_frame)` 区间并显示对应时间。

长度不一致时还会报告末端缺失或多出的帧区间。

## 内置样音和演示

页面顶部提供一键演示。也可以用 CLI 生成：

```bash
python3 wav_tool.py demo --case all --out demo_output
```

样音规格：

- 44.1 kHz、立体声、16-bit PCM；
- 时长 4.3 秒，固定间隔 1 秒；
- 切点采样帧：`44100, 88200, 132300, 176400`；
- 最后一段只有 0.3 秒，用来演示末段允许短于标准长度；
- 左声道 C4/C5 成分，右声道 G4/G5 成分，两侧明显不同；
- 每个切点处有衰减脉冲，且第 0 个脉冲样本被精确设置为峰值：
  - 左声道 `32767`；
  - 右声道 `-32768`。

四个一键场景：

1. **正常拼回**：全部哈希通过，比较结果逐样本一致；
2. **缺第 2 段**：定位到 `[44100, 88200)`，比较器在左右声道都报告该差异区间；
3. **第 1/2 段调换**：指出真实身份和范围，纠正位置后可逐样本一致；
4. **同名文件替换**：`segment_002.wav` 名字正确但内容是另一段音频，标记为同名替换。

## 命令行用法

### 固定间隔分段

```bash
python3 wav_tool.py split input.wav \
  --interval 60 \
  --out split_out
```

### 自定义秒点 / 精确采样点

```bash
python3 wav_tool.py split input.wav \
  --cuts 12.5,30,88.2 \
  --out custom_out

python3 wav_tool.py split input.wav \
  --cut-frames 44100,88200,132300 \
  --out frame_out
```

命令输出会列出每个切点实际落到的采样帧、实际时间和取整误差。

### 按清单校验和拼回

默认按清单中的 `segments/...` 相对路径查找：

```bash
python3 wav_tool.py verify split_out/manifest.json

python3 wav_tool.py restore split_out/manifest.json \
  -o restored.wav \
  --compare-original input.wav
```

生成带静音缺口的部分预览：

```bash
python3 wav_tool.py restore split_out/manifest.json \
  -o partial.wav \
  --partial
```

模拟第 2 段缺失或调换：

```bash
# 序号从 1 开始；none 表示该位置缺段
python3 wav_tool.py restore split_out/manifest.json \
  -o partial.wav --partial \
  --map 2=none

# 把第 2 个清单位置分配给另一个 WAV
python3 wav_tool.py verify split_out/manifest.json \
  --map 2=/path/to/other.wav
```

### 单独比较两个 WAV

```bash
python3 wav_tool.py compare input.wav restored.wav
```

退出码：

- `0`：成功且样本完全一致；
- `1`：输入/格式/切点等工具错误；
- `2`：分段校验未通过；
- `3`：比较发现样本差异。

## 设计说明

### 为什么同时记录 `sha256_file` 和 `sha256_raw`

`sha256_file` 校验交接的 WAV 文件字节，适合发现整个文件被替换。  
`sha256_raw` 只覆盖 `data` 块中的交错采样字节；即使某些软件重写了 WAV 头或元数据，只要实际采样没变，仍可证明样本连续。界面会把“整文件哈希不同但原始采样哈希一致”作为警告，而不是样本损坏。

### 为什么部分预览用静音填洞

直接把剩余分段串联会改变时间轴，可能把缺段后面的内容误听成紧邻前一段。工具选择保持清单总帧数不变，把缺失范围写成零样本，因此：

- 差异区间就是缺失/不可信来源范围；
- 试听时能听出缺口长度；
- 后续样本仍位于原始时间位置；
- 输出明确命名为 partial preview，不声称完整复原。

## 项目结构

```text
wav_tool/
├── __init__.py
├── __main__.py
├── cli.py          # 命令行
├── core.py         # WAV 解析、切点、清单、校验、拼回、比较、样音
├── server.py       # 标准库 HTTP 服务和 JSON API
└── web/
    ├── index.html
    ├── app.js
    └── styles.css
tests/
└── test_core.py    # 采样点连续性和异常定位测试
wav_tool.py         # 便捷启动器
```

## 已知边界

- 面向标准 RIFF/WAVE；大于 4 GiB 的 RF64/BWF64 暂未实现。
- 仅支持未压缩 PCM 和 IEEE float；不支持 MP3/AAC 等压缩格式（可先用 ffmpeg 转成 WAV）。
- 浏览器试听和比较由本地 Python 服务导出 WAV 区间/结果；直接双击打开 HTML 不能调用这些本地 API，请使用 `python3 wav_tool.py serve`。
