# FrameLab · 帧率转换与时间映射检查工具

把一批不同帧率的视频统一成指定播放速度，并逐帧检查「原始帧 ↔ 输出帧」的时间映射。
**纯本地工具**：只处理本机素材，所有转码由本地 [ffmpeg](https://ffmpeg.org/) 完成，
不发起任何网络请求，不依赖第三方 Python 包（仅标准库）。

## 功能对照

| 需求 | 实现 |
| --- | --- |
| 设置输出帧率/播放速度，显示原始帧与输出帧对应关系 | `framelab/core/mapping.py` 用 `Fraction` 精确有理数推导，Web 端逐帧对照表 |
| 重复/丢弃/混合三种转换方式，预览卡顿或拖影 | nearest（重复/丢帧，ffmpeg `fps` 滤镜）与 blend（混合，`minterpolate=mi_mode=blend`），双画面对比预览 + 卡顿占比/拖影帧统计 |
| 音画时长同步，可选保留音调 | 视频 `setpts` 与音频 `atempo`/`asetrate` 同一 speed 基准，`-shortest` 收尾；保调用 WSOLA，变调用采样率改写 |
| 定位新增/重复帧，时间码连续并跳回原素材位置 | 映射表类型筛选（精确/重复/丢帧/混合）、输出帧跳转、源帧反查、点击联动视频定位与源帧缩略图 |
| 保存项目，导出视频与时间映射清单，失败保留分析结果 | 原子写入 + `.bak` 回退；导出 MP4 + CSV/JSON 清单；分析/转码失败均落盘保留现场与日志 |
| 高帧率、低帧率、带音频短样片 | `scripts/generate_samples.py` 生成 120fps / 15fps / 30fps 带音频三条样片 |
| 只用本地素材 | 服务仅绑定 `127.0.0.1`，路径白名单 + 越界校验，无任何外部请求 |

## 环境要求

- Python 3.10+（标准库即可，无需 pip install）
- ffmpeg / ffprobe 在 PATH 中（macOS：`brew install ffmpeg`）

## 快速开始

```bash
# 1. 生成三条测试样片（已随 .gitignore 忽略，可随时重新生成）
python3 -I scripts/generate_samples.py

# 2. 启动本地 Web 界面
python3 -I run.py serve
# 打开 http://127.0.0.1:8765/
```

建议始终用 `python3 -I`（隔离模式）运行，避免当前目录/环境变量中的同名模块被误加载。

### 命令行用法

```bash
# 只分析，打印帧映射摘要（不转码）
python3 -I run.py analyze public/samples/sample_hfr_120fps.mp4 \
    --dst-fps 30 --speed 1 --method nearest

# 分析 + 导出视频与清单
python3 -I run.py export public/samples/sample_audio_30fps.mp4 \
    --dst-fps 60 --speed 1.5 --method nearest --keep-pitch

# 慢放 + 混合帧 + 变调
python3 -I run.py export clip.mp4 --dst-fps 24 --speed 0.5 \
    --method blend --no-keep-pitch --workspace .framelab_workspace
```

## 时间映射模型

- 源时间轴 `t_src`，输出时间轴 `t_out`，关系 `t_src = t_out × speed`
  - `speed=2` 加速，输出时长 = 源时长 / 2；`speed=0.5` 慢放，输出时长 ×2
- **nearest（重复/丢帧）**：输出帧取时间最近的源帧（half-up 舍入）。
  目标帧率高于源帧率时重复源帧（卡顿），低于时丢弃源帧。
- **blend（混合）**：输出帧由相邻两源帧按时间距离加权（权重 0~1），
  权重落在 0.2~0.8 区间记为「拖影帧」。
- 帧类型：`exact` 精确采样 / `duplicate` 重复上一帧 / `drop` 跨帧跳跃（有源帧被丢）/ `blend` 混合。
- 时间码为 SMPTE 风格 `HH:MM:SS:FF`（非丢帧计数，支持 29.97 等分数帧率）。

## 导出参数说明

### 视频（MP4 / H.264）

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| 容器 | MP4 + `faststart` | moov atom 前置，便于浏览器边下边播 |
| 视频编码器 | `libx264` | 可在项目 settings 中改 `video_codec` |
| CRF | `18` | 质量恒定因子，18 接近视觉无损，范围 0~51，越小质量越高 |
| preset | `medium` | 编码速度/压缩率权衡：ultrafast…medium…slow |
| 像素格式 | `yuv420p` | 最大兼容性（浏览器、移动端均可播） |
| 帧率滤镜（nearest） | `fps=fps=<dst>:round=near` | 最近邻重复/丢帧，与映射表 half-up 语义一致 |
| 帧率滤镜（blend） | `minterpolate=fps=<dst>:mi_mode=blend` | 运动补偿混合插帧 |
| 变速 | `setpts=PTS*(1/speed)` | 加速系数 <1、慢放系数 >1 |
| 收尾 | `-shortest`（仅有音频时） | 以视频时长为准，避免 AAC priming 样本拖长容器 |

实际命令示例（speed=1.5、60fps、保调）：

```
ffmpeg -y -v error -i in.mp4 \
  -vf "setpts=PTS*0.666667,fps=fps=60:round=near" \
  -c:v libx264 -crf 18 -preset medium -pix_fmt yuv420p \
  -af "atempo=0.666667" -c:a aac -b:a 192k \
  -movflags +faststart -shortest out.mp4
```

### 音频

| 模式 | 滤镜链 | 行为 |
| --- | --- | --- |
| 保留音调（默认） | `atempo=<1/speed>` | WSOLA 时域压扩，音调不变；单段限 0.5~2.0，超出自动串联（如 5× → `atempo=2.0,atempo=2.0,atempo=1.25`） |
| 变速变调 | `asetrate=44100*<speed>,aresample=44100` | 直接改播放采样率，音调随速度变化，时长天然与视频对齐 |
| 编码 | AAC 192k | 无音频轨时输出 `-an` 纯视频 |

### 时间映射清单

- **CSV**（UTF-8 BOM，Excel 直接打开不乱码）与 **JSON** 两种格式，字段：
  输出帧序号、输出时间码、输出时间(秒)、帧类型、源帧序号、混合源帧2、混合权重、源时间码、源时间(秒)。
- JSON 另含 `stats` 统计块（重复帧数、最长连续重复段、丢弃源帧清单、拖影帧数、卡顿占比等）。

## 项目与失败恢复

项目保存在 `--workspace`（默认 `.framelab_workspace/`）下，每个项目一个目录：

```
<project_id>/
  project.json        # 配置 + ffprobe 结果 + 各参数组合的映射缓存（原子写入）
  project.json.bak    # 上一个完整版本，主文件损坏时自动回退
  frames/             # 抽取的源帧 JPEG
  export/             # 导出的 MP4 与 CSV/JSON 清单
  convert.log         # 最近一次转码日志
```

- 保存采用「临时文件 → fsync → 替换」，写到一半崩溃不会损坏已有版本。
- 素材分析失败：错误写入 `analyze_error` 并落盘，项目保留、可修复后重试。
- 转码失败：已完成的分析结果、失败命令与日志全部保留，仅标记该次导出 `ok=false`。

## 测试

```bash
python3 -I -m unittest discover -s tests -v
```

- `test_mapping.py` 映射数学（帧率上下变换、变速、VFR、时间码、反查索引）
- `test_project_store.py` 持久化与 `.bak` 回退
- `test_ffmpeg_commands.py` 滤镜链方向与音频参数
- `test_end_to_end.py` 真实 ffmpeg 转码并校验输出帧率/时长/音画同步

## 目录结构

```
framelab/
  core/mapping.py        时间映射纯数学（无 ffmpeg 依赖，可独立使用）
  core/ffmpeg_tools.py   ffprobe/ffmpeg 封装与命令构建
  core/project_store.py  项目原子写入与备份回退
  core/pipeline.py       分析→映射→抽帧→导出流水线
  server.py              127.0.0.1 本地 HTTP 服务（标准库）
  cli.py                 命令行入口
  web/                   原生 HTML/CSS/JS 界面
scripts/generate_samples.py  样片生成
tests/                   单元与端到端测试
run.py                   隔离模式启动器
```

## 安全说明

- 服务只绑定 `127.0.0.1`，不监听外部网卡。
- 所有文件访问经根目录白名单校验，`../` 越界与非媒体后缀请求一律拒绝。
- 不收集、不上传任何素材或项目数据。
