# sebalign — 本地多档分段对齐与切换预览工具

检查同一份源视频切出的多档清晰度分段，换清晰度后是否还从**正确的画面**接下去。
全程本机运行：仅依赖 Python 标准库与本机 ffmpeg/ffprobe，不需要网络、不装第三方包。

## 解决什么问题

同一条源时间线被切成多档不同分辨率的分段后，两档切点不一致、某档缺段、
索引写了文件却打不开，都会让“换档”接到错误画面。本工具：

1. 从带编号的本地源短片生成两档分辨率分段，切点可配、自动吸附到源帧；
   每段记录源时间范围、序号、**ffprobe 实测时长**与**实际首帧**（画面编号 + 像素哈希 + 缩略图）。
2. 横向比对两档，标出三类问题：边界不重合、片段缺失、索引写了但文件打不开。
3. 本地浏览器预览：可计划换档时刻，也可播放中手动换档。当前点接不过去时，
   明确显示“继续旧档到哪个共享边界才能换”或“为什么中止”。
4. 声音始终来自**一条连续 master 音轨**，画面切换不切声音；HUD 对照随源生成的
   拍点编号与画面编号。切换若会退回已播画面会被拒绝并记录，绝不悄悄重播。
5. 重新打开工作区时对每个分段实读核验（时长漂移、首帧哈希变化、档内衔接断裂、
   文件缺失），不照读生成时写下的估计时间。
6. 自带 `demo` 一键生成“顺利换档”和“系统性错位 + 坏文件”两套例子。

## 快速开始

```bash
# 1. 一键生成两套例子（源片 + 两个工作区 + 报告），全部素材很小（整套 < 1MB）
python3 -m sebalign demo demo_data

# 2. 看横向比对与实读核验
python3 -m sebalign compare demo_data/workspace_bad
python3 -m sebalign verify  demo_data/workspace_good

# 3. 浏览器预览（仅监听 127.0.0.1；端口被占自动顺延）
python3 -m sebalign serve demo_data/workspace_good
python3 -m sebalign serve demo_data/workspace_bad
```

预览页操作：空格 播放/暂停，`S` 立即换档，`1/2` 直接切档；
下方时间线可填“计划换档”时刻；所有切换尝试（含 wait/abort）都进页面日志与
工作区 `switch_log.json`。

## 用自己的源片

把带编号的源短片放进一个目录（按自然序，如 `clip1.mp4 clip2.mp4 clip10.mp4`），
要求帧率一致、分辨率不限：

```bash
# 两档各自的切分点（全局源秒，逗号分隔；会自动吸附到最近源帧）
python3 -m sebalign build ./my_src ./ws_out \
  --name-a low  --width-a 320 --height-a 180 --cuts-a "3,6,9,12" \
  --name-b high --width-b 960 --height-b 540 --cuts-b "3,6,9,12"

python3 -m sebalign compare ./ws_out     # 横向比对
python3 -m sebalign verify  ./ws_out     # 重新打开后的实读核验
python3 -m sebalign report  ./ws_out     # 导出 CSV 索引 + JSON/Markdown 报告
python3 -m sebalign serve   ./ws_out     # 本地预览
```

只想生成样例源片（自带画面编号、拍点标记和节拍音）：

```bash
python3 -m sebalign init-samples ./src
```

## 工作区结构

```
workspace/
├── manifest.json          # 分段索引：源范围/序号/实测时长/首帧标签/像素哈希
├── segment_index.csv      # 人读索引（report 子命令导出）
├── report.md / report.json# 比对 + 核验报告
├── switch_log.json        # 所有换档尝试（成功/等待/中止），失败不静默
├── low/  high/            # 各档分段（无音频，纯视频）
├── thumbs/                # 每段实际首帧 PNG
└── audio/master.m4a       # 唯一声音来源：覆盖全片的一条连续音轨
```

## 换档安全模型（sebalign/switching.py）

- **共享边界**：两档在同一源时刻（一帧容差内）都有分段起点，且首帧画面编号
  （`src片/帧号`）一致。只有共享边界允许 `switch_now`。
- **wait**：当前在分段内部，给出最近的前方共享边界与等待秒数，继续旧档到点再换。
- **abort**：边界首帧不一致、目标段不可读、之后再无共享边界等；明确给出原因。
- **重播闸**：边界切换从目标段段头开播，段头严格早于当前源位置即拒绝
  （播放器侧与服务端各有一道，见 `assert_no_replay`）。

## 重新打开时核验了什么（sebalign/verify.py）

不读 manifest 的估计值当事实，而是对每个文件重新 ffprobe / 解码首帧：

| 状态 | 含义 |
|---|---|
| `ok` | 实测时长与索引差 < 1.5 帧，首帧像素哈希一致，档内衔接连续 |
| `missing` / `unreadable` | 索引写了但文件不存在或 ffprobe 打不开 |
| `duration_drift` | 实测时长与索引相差超过一帧 |
| `first_frame_changed` | 首帧像素哈希变了，文件开头被替换 |
| `gap` | 档内上一段源终点与本段源起点不连续 |

## 测试

```bash
python3 -m unittest discover -s tests -v
```

- `test_switching` / `test_compare_verify`：纯逻辑，不需要 ffmpeg；
- `test_end_to_end`：真实 ffmpeg 生成 → 构建 → 比对 → 核验 → 预览 API
  （含路径穿越防护），素材刻意压到 50 帧、160×90，整套约 15 秒跑完。

## 设计约束与边界

- 分段全部重编码（非 stream copy），切点精确落在帧边界，避免关键帧对齐漂移；
- 源片帧率必须一致（不一致会直接报错，无法建立统一源时间线）；
- 预览服务只绑定 `127.0.0.1`，所有 `/media/` 路径都被限制在工作区内；
- 样例画面用纯 Python 绘制 RGB 帧管道给 ffmpeg，不依赖 drawtext 字体配置。
