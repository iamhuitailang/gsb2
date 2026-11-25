# 滚动清单本地收录试验

一个只用 Python 标准库实现控制面、用本机 `ffmpeg` 生成真实可播放短片的本地 HLS 收录实验。它模拟录制端遇到的典型问题：

- m3u8 滚动更新，只保留最近几段；
- 片段按时出现、迟到、文件先写一半、随后补完；
- 已收录片段滚出窗口后源文件被删除；
- 断档后编码器重启，epoch 变化且序号重新从 `0000` 开始；
- 收录进程中断/重启后从 SQLite 状态和 `.part` 文件继续；
- 同一段在清单中重复出现只收一次；
- 按 SHA-256 区分内容，序号归零或源文件名复用也不会覆盖旧片；
- 计算连续区间和中间缺口的节目时间；
- 导出自包含离线目录：每段区间有 `playlist.m3u8`、`preview.mp4`、章节 VTT、`index.html`、`catalog.json` 和 `收录说明.md`；
- 删除原始 `source/` 后，导出的区间仍可播放和校验。

## 1. 环境

- Python 3.11+（开发验证使用 Python 3.13）
- 真实短片和 MP4 拼接需要 `ffmpeg` / `ffprobe`：

```bash
ffmpeg -version
```

macOS 可执行：

```bash
brew install ffmpeg
```

没有 ffmpeg 时，可以用 `--fake-media` 跑完整状态机、重启和导出完整性测试；伪媒体字节不能实际播放。

## 2. 最快体验：自动演示

在仓库根目录执行：

```bash
python3 -m segment_recorder demo --root demo_work --auto --force
```

演示会：

1. 启动一个真正的收录子进程；
2. 生成 ep-0001 的 seq 0、1；
3. 让 seq 2 只露出 42% 字节，收录端保存 `.part`；
4. 在 seq 2 未完成时发送 SIGTERM，模拟收录进程中断；
5. 源端继续写完 seq 2、生成 seq 3 和 seq 5（跳过 seq 4），并把 seq 0 滚出窗口删除；
6. 重启收录子进程，从数据库和 `.part` 续收；
7. 让迟到的 seq 4 补入，随后生成 seq 6、跳过 seq 7 的 seq 8；
8. 制造断档，切换到 ep-0002，序号重新从 0 开始，并复用 `seg_0000.ts` 这类源文件名；
9. 导出离线播放目录并核对 m3u8/MP4 时长和 SHA-256。

结束后打开：

```bash
open demo_work/exports/latest/index.html 2>/dev/null || true
# 实际导出目录是 demo_work/exports/offline-<时间戳>/
python3 -m segment_recorder preview --root demo_work
```

也可以直接打开导出目录中的：

- `index.html`：浏览器预览每个连续区间；
- `range.../preview.mp4`：拼接后的离线 MP4；
- `range.../playlist.m3u8`：自包含 VOD 清单，可用 VLC/IINA/mpv 打开；
- `收录说明.md`：区间、缺口、SHA、出现次数和防覆盖说明。

### 删除原始清单后再验证

```bash
# 先找到实际导出目录
python3 -m segment_recorder verify --root demo_work

# 删除源清单和源短片
rm -rf demo_work/source

# 不依赖 source，仍应 ok=True
python3 -m segment_recorder verify --root demo_work
```

也可以让自动演示在导出后自己删除 `source/` 并复验：

```bash
python3 -m segment_recorder demo \
  --root /tmp/segment-recorder-demo \
  --auto --force --delete-source --decode
```

`--decode` 会额外调用 ffmpeg 全量解码 MP4，确认不是“文件存在但不能看”。

## 3. 可控制进度的步进演示

如果你想自己控制每一拍：

```bash
python3 -m segment_recorder demo --root demo_work --step --force
```

每个剧本节拍后按 Enter 继续；在重启收录进程前也会暂停。

## 4. 完全手动控制

也可以不用 demo 编排器，分别操作“源端剧本”和“收录端”。

### 4.1 初始化

```bash
python3 -m segment_recorder init --root demo_work --force
```

生成：

```text
demo_work/
├── source/
│   ├── playlist.m3u8
│   └── segments/
├── staging/          # ffmpeg 生成的完整母片，用来模拟慢慢写入源文件
├── archive/
│   ├── blobs/        # SHA-256 命名的已完成短片
│   ├── tmp/          # .part 断点
│   └── recorder.sqlite3
└── world_state.json
```

### 4.2 一个终端持续收录

```bash
python3 -m segment_recorder record --root demo_work --interval 0.5
```

需要中断时按 `Ctrl+C`，然后用同一条命令重启。状态在 `archive/recorder.sqlite3`，半截数据在 `archive/tmp/*.part`。

如果不想持续轮询，也可以每操作一拍执行一次：

```bash
python3 -m segment_recorder record --root demo_work --once
```

### 4.3 另一个终端逐拍推进

```bash
python3 -m segment_recorder tick --root demo_work
python3 -m segment_recorder tick --root demo_work
# ...
```

剧本节拍见下方“剧本时间线”。

### 4.4 查看状态

```bash
python3 -m segment_recorder status --root demo_work --events 30
```

会显示：

- 当前节拍和 epoch；
- 各状态片段计数；
- 连续区间；
- 中间缺口/epoch 边界；
- 最近发现、补收、保存、重复跳过、滚出窗口等事件。

### 4.5 导出和预览

```bash
python3 -m segment_recorder export --root demo_work
python3 -m segment_recorder verify --root demo_work --decode
python3 -m segment_recorder preview --root demo_work
```

启动本地 HTTP 预览服务（某些浏览器对 `file://` 下的 m3u8 有限制时使用）：

```bash
python3 -m segment_recorder preview --root demo_work --serve --port 8765
```

## 5. 剧本时间线

| Tick | 动作 | 用来验证什么 |
|---:|---|---|
| 1 | ep-0001 seq 0 完整出现 | 正常发现/保存 |
| 2 | ep-0001 seq 1 | 滚动清单累积 |
| 3 | ep-0001 seq 2 只写 42% | 半截文件、`.part`、进度显示 |
| 4 | seq 2 追加写完 | 核对前缀并补收完成 |
| 5 | seq 3 | 正常连续区间 |
| 6 | 先出现 seq 5，跳过 seq 4；seq 0 滚出窗口并删除 | 中间缺口、窗口轮换 |
| 7 | 迟到的 seq 4 补入 | 迟到段收录，缺口自动合并 |
| 8 | seq 6 | 连续区间 0-6 |
| 9 | 出现 seq 8，跳过 seq 7 | 永久中间缺口及其节目时间 |
| 10 | 源端静默/断档一拍 | 空缺时间继续累计 |
| 11 | 切到 ep-0002，seq 从 0 开始，复用 `seg_0000.ts` | 序号归零、内容身份区分、防覆盖 |
| 12 | ep-0002 seq 1 | 新连续区间 |
| 13 | ep-0002 seq 2 | 新区间 0-2 |

最终连续区间为：

1. `ep-0001` seq `0000–0006`
2. `ep-0001` seq `0008`（seq 7 是缺口）
3. `ep-0002` seq `0000–0002`

## 6. 它如何保证不重复、不覆盖、可续收

### 身份

每个片段有两层身份：

- 逻辑身份：`stream_id + epoch_id + sequence + revision`
- 内容身份：最终文件的 `SHA-256`

源 m3u8 中写有实验自定义标签：

```text
#EXT-X-EPOCH:id="ep-0002",index=2
#EXT-X-SEQUENCE:0
#EXT-X-SHA256:<完整文件哈希>
```

同时每个源短片旁边有 `seg_0000.ts.json`，记录期望大小、SHA、节目时间和是否写完。

完成后的文件保存为：

```text
archive/blobs/<sha256>.ts
```

因此：

- 同一逻辑段反复出现：数据库 `seen_count + 1`，已 `saved` 后不再复制；
- 新 epoch 的 seq 0 即使源路径仍叫 `seg_0000.ts`，SHA 不同，blob 路径也不同；
- 极端情况下同一 epoch/seq 对应不同 SHA，也会作为新 revision 入库，不会覆盖旧记录。

### 半截文件和重启

收录端不会直接写最终 blob，而是写：

```text
archive/tmp/<expected-sha>.part
```

每轮：

1. 如果 `.part` 已存在，计算其 SHA；
2. 对源文件相同长度前缀计算 SHA，确认源文件仍是追加关系而不是被重写；
3. 前缀一致则 seek 到 `.part` 末尾继续复制；
4. 复制当前可读的全部字节并 fsync；
5. 大小/SHA 满足期望值后，原子 rename 到 `archive/blobs/<sha>.ts`；
6. SQLite 提交 `saved` 状态。

进程在任何时刻被杀，重启后都能根据 SQLite 和 `.part` 继续。若源文件被截断或重写导致前缀不一致，会删除旧 `.part` 重新接收，避免把错误后缀拼进去。

## 7. 如何核对播放进度和清单时长

每个导出区间包含：

- `playlist.m3u8`：每段有精确 `#EXTINF`；
- `preview.mp4`：用 ffmpeg concat 得到的连续播放文件；
- `chapters.vtt`：每段在 MP4 时间轴上的累计起止；
- `index.html`：表格列出每段的 `cumulative_start/cumulative_end`、EXTINF 时长和节目时间；
- `catalog.json`：同样的数据可供程序核对。

`verify` 会检查：

- m3u8 中所有媒体路径都在导出目录内；
- 文件存在且非空；
- 导出副本 SHA-256 与 catalog 一致；
- `#EXTINF` 总和与 catalog 一致；
- `preview.mp4` 的 ffprobe 时长与 m3u8 总时长偏差在约 12%（至少 0.45 秒）以内；1 秒级 TS 分段会有正常的封装/音频 priming 误差；
- 加 `--decode` 时 ffmpeg 能完整解码 MP4。

## 8. 自动化测试

```bash
python3 -m unittest discover -s tests -v
```

测试使用伪媒体，不依赖 ffmpeg，覆盖：

- 半截文件产生 `.part`；
- 新 Recorder 实例模拟重启后续收；
- 同段重复轮询不增加保存记录；
- 迟到段补入；
- seq 7 缺口；
- epoch 切换和序号归零后两个 seq 0 内容均保留；
- 导出目录校验通过；
- 删除 `source/` 后导出仍校验通过。

真实可播放性建议运行一次：

```bash
python3 -m segment_recorder demo \
  --root /tmp/segment-recorder-real \
  --auto --force --delete-source --decode
```

## 9. 代码地图

```text
segment_recorder/
├── cli.py         # 命令行入口
├── world.py       # 滚动清单/短片/剧本时间线
├── media.py       # ffmpeg 短片生成、concat、探测、解码校验
├── playlist.py    # m3u8 解析和标签模型
├── storage.py     # SQLite 持久化
├── recorder.py    # 轮询、去重、.part 续收、原子入库
├── exporter.py    # 区间/缺口分析、离线目录导出和校验
└── demo.py        # 自动/步进端到端演示及子进程重启
```

## 10. 后续可替换成真实 HLS 源的位置

当前“传输层”是本地文件复制。若要接真实 HTTP HLS，主要替换 `Recorder._ingest_segment()` 中从 `source_path.open("rb")` 读取字节的部分为 HTTP Range 请求；身份、SQLite 状态、区间分析、导出和校验逻辑可以继续沿用。
