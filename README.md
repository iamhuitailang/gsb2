# 本地视频画幅诊断与规范化工具

解决"短片只写了旋转信息、解码像素方向和播放器画面不一致"的问题。纯本地运行，
不上传任何素材；几何映射用有理数矩阵实现，标记点可在转换前后精确对应。

## 依赖

- ffmpeg / ffprobe（≥ 6.0，已在 8.1 验证），需在 PATH 中
- Python ≥ 3.10，依赖 `Pillow`、`numpy`

```bash
pip install Pillow numpy
```

## 它解决什么

| 概念 | 含义 |
|------|------|
| 存储宽高 (stored) | 解码出来的真实帧像素尺寸，像素可能非方形 (SAR≠1) |
| 显示宽高 (display) | 播放器应用旋转矩阵 + 像素宽高比后，屏幕上呈现的方形像素画面 |
| 旋转信息 | MP4/MOV `tkhd` 显示矩阵（ffprobe 以逆时针 `rotation` 报告） |
| fit | 保留全画面，等比缩进目标画幅，不足处补黑边 |
| crop | 等比铺满目标画幅，裁掉溢出部分 |

## 命令一览

所有命令通过模块方式运行（仓库根目录）：

```bash
PYTHONPATH=src python3 -m aspect_tool.cli <子命令> [参数]
```

### 1. 诊断：原始像素 vs 显示方向

```bash
# 读取存储/显示宽高、SAR、旋转、时长
python3 -m aspect_tool.cli probe input.mp4 --json

# 生成左右对比预览（左=原始存储像素，右=播放器显示方向），并叠加 fit/crop 规划
python3 -m aspect_tool.cli diagnose input.mp4 \
    --out-dir workdir/diag --mode crop --target 720x1280 \
    --points "60,60;260,180"
```

`--points` 是**存储平面**上的标记点，工具会把它们映射到显示平面和输出平面。

### 2. 规范化：落实方向 / 方形像素

```bash
# fit：全画面保留 + 黑边
python3 -m aspect_tool.cli normalize input.mp4 out.mp4 \
    --mode fit --target 720x1280 --points "60,60;260,180"

# crop：裁到目标画幅（会报告哪些标记点被裁掉）
python3 -m aspect_tool.cli normalize input.mp4 out.mp4 \
    --mode crop --target 1080x1920
```

转换后自动复检：无残留旋转元数据（播放器不会再多转一次）、SAR=1、宽高符合
规划、显示比例、有效画面、声画时长、帧数。

### 3. 方向无法确定时

任意角度（非 90° 倍数）、损坏矩阵等情况会被标记为歧义，转换被拒绝并提示：

```bash
python3 -m aspect_tool.cli normalize amb.mp4 out.mp4
# 错误: 旋转信息无法确定, 请用户确认后用 --rotation 重试 ...

# 用户确认方向后显式指定（顺时针角度）
python3 -m aspect_tool.cli normalize amb.mp4 out.mp4 --rotation 90
```

### 4. 同时间点逐帧比较

```bash
python3 -m aspect_tool.cli compare input.mp4 out.mp4 \
    --samples 5 --montage workdir/cmp.png
```

按帧序号精确抽帧（不用 `-ss`，避免 seek 偏差），输出平均/最大像素差、
非黑占比，并生成同帧输入（显示方向）/输出拼图。

### 5. 导出后复检 / 坐标映射查询

```bash
python3 -m aspect_tool.cli verify out.mp4          # 单独复检一个文件
python3 -m aspect_tool.cli map input.mp4 "60,60;260,180" --mode crop --target 720x1280
```

### 6. 自带测试素材与一键自检

```bash
# 生成两份素材：带方向字样的旋转视频 + 拉伸(非方形像素)测试图视频
python3 -m aspect_tool.cli fixtures --out-dir workdir/samples

# 端到端自检（生成→诊断→fit/crop→复检→圆度/方向/逐帧核对，19 项）
PYTHONPATH=src python3 scripts/selftest.py
```

## 关键设计

### 三个坐标平面与标记点映射

```
S 存储帧 (sw×sh, 可能非方形像素)
  │  旋转/翻转 (transpose/hflip)
  ▼
中间帧
  │  按 SAR 方形化 (scale + setsar=1)
  ▼
D 显示平面 (方形像素, 播放器所见)
  │  fit: scale+pad  /  crop: crop+scale
  ▼
O 输出平面 (ow×oh, SAR=1, 无旋转矩阵)
```

`geometry.py` 用 3×3 有理数仿射矩阵表达整条 S→D→O 链，支持 O→S 反查，
且与 `ffmpeg.py` 构造的滤镜链语义一致（含镜像顺序，已经过 autorotate
像素级核对）。所有几何运算不依赖 ffmpeg，可独立单测。

### 旋转角度约定（实测，非推断）

- ffprobe 的 `rotation` 是**逆时针**度数；工具内部统一换算成顺时针 `cw_deg`
- BMFF 矩阵作用在 y 轴朝下的图像坐标系，数学方向与视觉方向相反
- 角度→矩阵值、→`transpose` 滤镜的映射在 `tests/` 中用 ffmpeg autorotate
  作为权威基准固化，防止方向反转这类隐蔽回归

### 非方形像素与圆度

`fixture_anamorphic.mp4` 在 320×240 存储帧里画了 SAR 预补偿的正圆（SAR=4:3）。
方形化前圆的包围盒轴比约 0.75（椭圆），方形化后轴比 ≈1.00（正圆），
自检会量化核对，确保"转换后圆形标记保持圆形"。

## 目录结构

```
src/aspect_tool/
  geometry.py   纯几何：旋转/方形化/fit/crop 坐标映射（可单测）
  probe.py      ffprobe 读取存储/显示宽高、SAR、显示矩阵、时长
  ffmpeg.py     抽帧、滤镜链构造、转码
  mp4matrix.py  ISO BMFF tkhd 显示矩阵读写（标准库实现）
  annotate.py   黑边/有效区/裁切区/标记点可视化
  preview.py    诊断预览与圆度测量
  normalize.py  转换编排 + 导出后复检
  compare.py    同时间点逐帧比较
  fixtures.py   自带测试素材生成
  cli.py        命令行入口
scripts/selftest.py   端到端自检
tests/                  geometry / mp4matrix 单元测试
```

## 安全说明

处理来自外部的素材时，建议用 Python 隔离模式运行，避免素材目录内被放置
同名模块（如 `json.py`）劫持导入：

```bash
PYTHONPATH=src python3 -I -m aspect_tool.cli probe /path/to/input.mp4
```

脚本与素材分目录存放，路径通过参数传入，不要把工作目录切到素材目录。
