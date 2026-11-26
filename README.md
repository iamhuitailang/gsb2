# rawframe — 原始视频帧布局检查工具

拿到只有宽高和“可能的像素格式”的原始帧文件（.raw / .yuv），播放器直接打开颜色
全错时，用本工具按字节核对布局：平面起点、行填充、色度采样覆盖、末帧截断、尾部
垃圾，并支持两组解释参数并排比较。

- 纯 Python 3.10+，仅依赖 numpy；GUI 用标准库 tkinter，PNG 用标准库 zlib 手写
- 源文件**只读打开**，任何参数调整、错误解释都不会写回源文件（有测试守护）
- 支持格式：三平面 `i420` (IYUV)、交错色度 `nv12`、`rgba`
- 色彩：BT.601，limited / full 两种范围可切换

## 快速开始

```bash
# 1. 生成程序合成的演示样例（彩条/单像素/行填充/末帧截断/错行宽）
./rawframe-cli generate demo_data

# 2. 启动双面板 GUI（可直接带上样例目录）
./rawframe-gui demo_data

# 3. 命令行查看平面布局、完整帧数、像素字节溯源
./rawframe-cli info demo_data/padded_i420_16x8.raw \
    --width 16 --height 8 --fmt i420 --stride-y 20 --stride-uv 12 \
    --pixel 3 2

# 4. 导出完整帧 PNG 序列 + 参数配置，再逐像素回读校验
./rawframe-cli export demo_data/padded_i420_16x8.raw \
    --width 16 --height 8 --fmt i420 --stride-y 20 --stride-uv 12 \
    /tmp/export --frames 0,1
./rawframe-cli verify /tmp/export/export_config.json

# 测试
python3 -I run_tests.py
```

入口脚本都以 `python -I`（隔离模式）运行：禁用用户站点包和当前目录隐式导入，
避免样例目录中伪造的 `json.py` 之类模块被加载。

## GUI 操作说明

- 顶部：打开文件、生成样例、帧索引、裁剪框 `x0,y0,x1,y1`、整数倍放大、导出
- 左右两个面板各持有一组独立解释参数（宽/高/格式/stride/范围），改完点“应用”
- 同一帧索引并排渲染，顶部给出两组解释的**平均绝对色差**：参数相同时应为 0，
  认错布局时色差会明显变大
- 在任一面板点选像素，两个面板同时显示该像素的 Y/U/V 或 RGBA 来自文件的
  **帧内偏移、绝对偏移、实际字节值**；NV12 显示 U/V 交错对的 2 字节
- YUV 画面叠加黄色色度块网格；奇数宽/高时边缘非 2 对齐的色度块用红框标出
  真实覆盖范围（最右/最下采样可能只覆盖 1 个亮度像素）
- 截断帧可以打开预览，文件里缺失的像素用青色覆盖；溯源文本中缺失字节显示“缺”

## 六项需求的对应实现

1. **按宽高/帧数/每行字节解释，显示平面起点** — `rawframe/layout.py` 的
   `planes_of()` 纯算术计算每个平面的 offset/stride/行尾填充；`info` 与 GUI
   状态行直接展示。帧大小 = 最后一个平面终点。
2. **两组参数同帧比较 + 像素点选溯源** — GUI 双 `InterpretationPanel`；
   `trace_pixel()` 给出每个分量在帧内的精确字节位置，`RawFile.read_trace()`
   读出真实值（含 NV12 交错对、RGBA 四字节）。
3. **裁剪预览 + 奇数色度覆盖** — 渲染走“先全帧后裁剪”，所有预览方式共用同一
   套像素→字节映射；`chroma_coverage()` 处理奇数宽高边缘，GUI 红框可视化。
4. **行填充/末帧截短/尾部诊断** — `RawFile._scan()` 报告完整帧数、剩余字节、
   截断帧首个缺失字节的绝对偏移与人类可读位置（精确到平面/行/采样，并区分
   “行尾填充”）；缺失全为填充时标注图像仍完整。源文件始终 `rb` 打开。
5. **PNG 序列导出 + 配置回读一致** — `rawframe/config.py` 导出 PNG、
   `export_config.json`（含源文件 SHA256、stride、裁剪框）和 manifest；
   `verify` 重新打开源文件逐像素比对。PNG 只含有效像素，行尾填充永不入图，
   配置里保留 stride 以便区分。
6. **内置样例** — `rawframe/samples.py` 生成：
   - 三格式 8 色彩条（i420/nv12/rgba，同内容可交叉解释）
   - 灰底红/蓝单像素（测 2×2 色度共享与 U/V 认反）
   - 奇数宽高 15×7 彩条（测边缘色度覆盖）
   - 每行 +4 字节 0xEE 填充（测 stride 错设斜切）
   - 3 完整帧 + 半帧截断 + 8 字节 0xAB 尾部
   - 物理宽 18 的 NV12（故意按 16 宽解释看斜切）

## 目录结构

```
rawframe/
  model.py    数据模型与参数校验（FrameParams/PlaneGeom/TraceEntry/FileScan）
  layout.py   纯算术布局：平面几何、帧大小、像素溯源、缺字节定位
  rawio.py    只读文件 IO、完整帧扫描、平面读取（含缺失掩码）、SHA256
  color.py    BT.601 YUV↔RGB（limited/full）
  render.py   渲染、裁剪、放大、缺数据覆盖、色差、PPM(tkinter 显示)
  png.py      纯标准库 PNG 编码器
  samples.py  内置样例生成
  config.py   配置保存/加载、PNG 导出、回读校验
  cli.py      命令行（generate/info/export/verify/show-config）
  gui.py      tkinter 双面板 GUI
tests/        38 个单元测试（布局/IO/色彩/渲染/样例/导出回读）
run_tests.py  测试入口（隔离模式）
```

## 设计取舍

- **最近邻色度上采样**：4:2:0 的每个色度采样直接映射到它覆盖的 2×2（边缘
  1×2/2×1/1×1）亮度块，和溯源显示的覆盖矩形严格一致，避免插值后“看到的颜色”
  和“字节来源”对不上。
- **截断帧零填充 + 掩码**：缺字节按 0 参与渲染但同时输出 `_present` 掩码，
  青色只用于显示，不改变任何溯源数据。
- **剩余字节统一报“部分帧”**：文件尾部多余字节既可能是垃圾也可能是截断的
  下一帧，工具不替用户猜测，给出完整帧数 + 位置诊断由人判断。
