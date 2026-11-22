# proxylink — 本地代理素材挂接与时间位置校验工具

剪片时常用低清代理（proxy）代替原素材预览，剪完再切回原片输出。
本工具解决其中最容易出错的环节：**确认代理与原片的时间位置对应正确**，
在代理起点偏移、缺尾、同名文件挂错等情况下给出明确信号，而不是静默错位。

## 功能与需求对照

| # | 需求 | 实现 |
|---|------|------|
| 1 | 登记原片/低清副本，显示分辨率、时长、视频流；同名文件不同目录可区分 | `register` / `media show`，ffprobe 探针；素材 ID 用绝对路径，同名不同目录是不同记录 |
| 2 | 标定对应时间点，查看首尾匹配；起点偏/缺尾时标出不可定位区间 | `calibrate`（1 点偏置或 2 点帧率缩放）、`status` 输出首部/尾部偏差与可靠区间（秒+帧） |
| 3 | 多个剪辑点；切换原片/代理保持同一画面；进度保持，超范围明确停止 | `cut`、`session seek/switch/tick`，播放头双端时间同时维护，越界即 `stopped` 并给原因 |
| 4 | 重启保留关联与标记；文件移动可重挂接；候选不符特征给明确信号 | `.proxylink/state.json` 持久化；`relink find/do`，7 项特征逐项比对，不符默认拒绝 |
| 5 | 导出原片时间位置剪辑点清单，回显每个点的代理与时间换算溯源 | `export --format json|csv|md`，每点含来源代理、代理时间码、锚点、走时比 |
| 6 | 内置带画面计数标记的原片、正常代理、缺段代理，脚本生成 | `gen` 命令；PIL 渲染帧号烧录 + ffmpeg 编码，不依赖 drawtext |

## 环境要求

- Python ≥ 3.10（仅标准库 + Pillow）
- `ffmpeg` / `ffprobe` 在 PATH 中
- 安装：`pip install -e .`（之后可直接用 `proxylink` 命令）；不安装则用
  `PYTHONPATH=. python3 -m proxylink.cli ...`

## 30 秒上手

```bash
# 1. 生成带帧号标记的测试素材，并自动登记/挂接/标定
proxylink gen ./media --register --duration 10 --fps 24

# 2. 查看素材（分辨率/时长/视频流/音频流/文件签名）
proxylink media list
proxylink media show original.mp4

# 3. 查看缺尾代理的可靠区间
proxylink links               # gen --register 已自动建好 3 条挂接，列出 link id
proxylink status <link_id>

# 4. 标定（也可事后手动做）：原片 2.0s 的画面 = 代理 0.0s 的画面
proxylink calibrate <link_id> --anchor 2.0=0.0

# 5. 剪辑点（可按原片或代理时间录入）、播放头切换
proxylink cut add <link_id> 1.5 --side proxy --label 开场
proxylink session seek <link_id> 3.0 --side original
proxylink session switch          # 切到代理，仍指向同一画面；越界则退出码 2
proxylink session tick 1.0        # 播放推进 1 秒，到边界明确停止

# 6. 文件移动后的重挂接
proxylink check
proxylink relink find proxy_short.mp4 /new/disk/footage
proxylink relink do <media_id> /new/disk/footage/proxy_short.mp4

# 7. 导出带溯源的剪辑点清单
proxylink export --format md -o cuts.md

# 8. 浏览器双画面核对（仅监听 127.0.0.1）
proxylink serve
```

## 时间码格式

- 秒：`12.5`
- 时钟：`00:00:12.5`
- 帧时间码：`00:00:00:12`（末段为帧号，按素材 fps 换算）
- 所有换算结果自动吸附到最近帧边界，避免两端落在不同画面上

## 标定模型与可靠区间

单对锚点修正起点偏移（默认走时比 1.0）；两对锚点同时求走时比，
走时比与两个素材的 fps 之比偏差超过 2% 会被拒绝（防止标错画面）。

代理从原片中段截取时，原片时间线两端出现不可定位区间：

- **缺头**：原片 `0 .. 代理首帧对应时间` 的画面代理里没有
- **缺尾**：代理末帧之后的原片画面不存在
- `status` 同时给出秒数和帧数；在这些区间内 `locate`、剪辑点录入、
  `session switch/tick` 都会明确报错/停止，不会返回一个看似正常的错位时间

## 重挂接的特征比对

候选文件必须通过 7 项检查：文件大小、首尾块 SHA256、宽、高、编码、
帧率、时长（容差 0.1s 或 2 帧）。任一硬特征不符即拒绝并逐项列出
期望值/实际值；确认人工判断无误后才可用 `--force` 绕过（Web 上为 409）。
同名文件不会被自动当作同一素材。

## 画面计数标记怎么用

生成的每支视频中央烧录 `ORIG nnnnnn`，表示该帧对应的**原片帧号**：

- 正常代理第 36 帧与原片第 36 帧都显示 `ORIG 000036`
- 缺头代理第 0 帧显示 `ORIG 000029`（即原片 1.208s 处，24fps）
- 左上角 `F=` 是该文件自身帧号，标签区分 ORIGINAL / NORMAL / SHORT / HEAD-SHIFT

在 Web UI 双画面里切换后，两边大字帧号相同即证明挂接正确。

## 安全说明

- Web 服务只绑定 `127.0.0.1`，不对外暴露
- 状态文件采用临时文件 + 原子替换写入
- 处理外来下载的素材目录时，建议脚本与素材分目录存放，并用
  `python3 -I` 运行，避免素材目录中的同名模块被导入

## 项目结构

```
proxylink/
  timecode.py   时间码解析/帧吸附
  media.py      ffprobe 探针、文件签名、候选校验
  mapping.py    标定、双向换算、可靠区间、越界停止
  store.py      数据模型与 state.json 持久化
  project.py    高层操作（CLI 与 Web 共用）
  gen_media.py  带帧号标记的测试素材生成
  webui.py      本地 Web 界面（含 Range 支持）
  cli.py        命令行入口
tests/          37 个单元/集成/Web 冒烟测试
```

## 运行测试

```bash
python3 -m unittest discover -s tests -v
```

纯逻辑测试不依赖 ffmpeg；集成与 Web 测试会生成约 2–3 秒的短视频，
全套约 30 秒。
