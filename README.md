# 渐进 JPEG 检查工具

网速慢时渐进 JPEG 会先出模糊图、半截文件又打不开——这个工具用来检查
JPEG 文件在**读到不同字节位置时画面到底是什么状态**。

纯 Python + Pillow / NumPy / Flask，提供命令行和网页两种操作方式。

## 功能

1. **结构解析**：区分普通（基线 SOF0）与渐进（SOF2）JPEG，列出全部标记段
   及每个扫描段（SOS）熵数据的字节范围 `[entropy_start, entropy_end)`。
   熵数据里的 `0xFF00` 转义字节和 `0xFFD0–D7` 重启标记不会被误当成下一段开头。
2. **按扫描段预览**：在每个完整扫描结束处截断并尝试解码，显示文件覆盖率、
   已包含的扫描段；无法解码时给出明确状态和错误信息。
3. **任意位置截断**：可截在完整段边界或某段中间，区分四种状态——
   `ok` 完整可预览 / `partial` 部分结果 / `size_only` 仅知尺寸 /
   `no_size` 连尺寸都无法确认。所有截断都作用于原始字节的副本，互不影响。
4. **同一裁区对比**：把早期预览与完整图按同一裁区缩放到同一尺寸后读出
   像素差（平均/最大/超阈值占比），并按 8×8 网格定位**最晚仍有明显变化的
   区域**。尺寸不同或缺图时直接判定不可比，不会按像素硬算。
5. **导出**：`manifest.json`（扫描清单 + 每阶段字节范围）加每个可解码阶段的
   PNG，文件名自带字节范围（`stage_003_bytes_0-6948.png`）。
   同一文件重复分析，段顺序、阶段编号、文件名完全一致。
6. **可程序生成的样例**：普通版、渐进版、段边界截短、段中间截短、
   SOF 前截短（尺寸不可知）、首段截短、基线段中截短，共 7 个文件。

## 使用

```bash
# 生成样例
python3 -m jpeg_progressive_tool.cli make-samples run/samples

# 命令行
python3 -m jpeg_progressive_tool.cli analyze run/samples/progressive.jpg
python3 -m jpeg_progressive_tool.cli probe   run/samples/progressive.jpg [--offset N]
python3 -m jpeg_progressive_tool.cli compare run/samples/progressive.jpg --offset 2514 \
    [--crop X0 Y0 X1 Y1] [--threshold 8]
python3 -m jpeg_progressive_tool.cli export  run/samples/progressive.jpg outdir

# 网页界面
python3 -m jpeg_progressive_tool.webapp --port 5000
# 打开 http://127.0.0.1:5000/ ，可选样例或上传文件
```

网页界面包含：结构/扫描段表格、按段预览按钮、任意位置截断滑块
（可吸附到段边界或截在段中间）、截断预览与完整图并排、裁区对比
（含差异热力网格）、一键导出。

## 说明

- 解码用 Pillow 的 `LOAD_TRUNCATED_IMAGES`：截短文件能解出多少算多少，
  解不出时状态栏会标明原因。
- 一个独立截短文件的最后一个扫描段没有终止标记，与"段中间截断"在字节层面
  不可区分，工具会如实标记为"截在段中间"。
- 运行产物（样例、上传、导出）默认写在 `run/` 目录下。
