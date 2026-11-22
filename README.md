# 采样率转换试听台 srbench

把旧音效从低采样率迁到新项目前，先在本地判断两件事：**高频有没有混叠成假低音**、
**片段时长和左右声道有没有错位**。本工具用两条处理质量路径做对照，所有结果可复现、可导出、可回读核对。

## 功能与需求对应

| # | 需求 | 实现 |
|---|------|------|
| 1 | 导入/生成不同采样率、声道数的 WAV，显示采样点数、时长、各声道波形 | `wavio.py` 自解析 RIFF（PCM 8/16/24/32、float32/64、extensible）；GUI 波形 Tab 按声道切换 |
| 2 | 转到常用目标采样率，两档质量对照，下采样检查高频是否变假低音 | 低质量=无抗混叠线性插值；高质量=Kaiser 窗多相 FIR；频谱叠加 + 混叠折叠 bin 测量 |
| 3 | 左右声道峰值不错位，片尾有一致的时长取整规则 | 两条路径共用 `ceil(n_in*up/down)`；自检覆盖峰值对齐与长度规则 |
| 4 | 同步试听 + 前后频谱对照，框选短片段看采样点位置 | afplay 播放（含 A/B 对照、框选片段播放）；频谱/声谱图 Tab；采样点对照 Tab 列出 `out[k] ← src[分数位置]` |
| 5 | 导出目标 WAV 和摘要，重新读入核对头部/时长/声道 | 导出 + `verify_export` 九项核对（头部、data 字节、帧数、声道、量化往返误差） |
| 6 | 脉冲、双声道、高频测试音，差异直观可复现 | `signals.py` 七个预设，固定种子；`selftest` 44 项确定性断言 |

## 安装

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

仅依赖 numpy / scipy / matplotlib；播放用 macOS 自带 `afplay`，无需额外音频库。

## 启动图形界面

```bash
./run.sh
# 或
.venv/bin/python -m srbench.gui_main
```

操作流程：导入 WAV 或选一个测试音 → 选目标采样率 → 执行转换 →
在「波形/框选」「频谱/声谱图」「采样点对照」「检查结论/摘要」四个 Tab 查看 → 导出并回读核对。

## 命令行（无头，可脚本化）

```bash
# 确定性自检（44 项）
.venv/bin/python -m srbench.cli selftest

# 生成测试音
.venv/bin/python -m srbench.cli generate sine_high -o /tmp/tone.wav

# 转换并导出两档 WAV + txt/json 摘要（自动回读核对）
.venv/bin/python -m srbench.cli convert /tmp/tone.wav --to 22050 48000 --outdir out --bits 24

# 只分析不导出
.venv/bin/python -m srbench.cli check /tmp/tone.wav --to 22050

# 独立回读核对一个已导出的 WAV
.venv/bin/python -m srbench.cli verify out/tone_22050_high.wav
```

## 两条处理路径

- **低质量 `low`**：线性插值，无任何抗混叠滤波。下采样时超过目标 Nyquist 的频率
  按镜像规则折叠成带内假低音（例：18kHz @48k → 22.05k 时折叠到 4050Hz）。
- **高质量 `high`**：Kaiser 窗 FIR（`kaiserord` 按 90dB 纹波反算抽头数）+
  `scipy.signal.resample_poly` 多相滤波，过渡带以目标 Nyquist 为中心。

两者输出长度用**同一条**取整规则 `n_out = ceil(n_in * up / down)`，
因此片尾行为、采样点位置映射完全可对照。实测 18kHz→22.05k：低质量假低音 -9dBFS，
高质量抑制到 -47dBFS（约 38dB 差异）。

## 目录结构

```
srbench/
  audio.py      音频数据模型（float64，(帧, 声道)）
  wavio.py      RIFF/WAV 读写与头部探测
  signals.py    脉冲/双声道/高频/扫频/噪声测试音
  resample.py   两条转换路径 + 统一取整规则 + FIR 设计
  analysis.py   频谱、声谱图、混叠、峰值对齐、区间映射
  summary.py    摘要构建/格式化 + 导出回读核对
  player.py     afplay 播放封装（淡入淡出）
  selftest.py   44 项确定性自检
  cli.py        无头命令行
  gui/          tkinter + matplotlib 界面
```

## 关键设计取舍

- **WAV 自己解析**：标准库 `wave` 不支持 24-bit 与 float，直接读 RIFF 块以覆盖全部目标格式。
- **混叠用绝对 dBFS 衡量**：高质量抗混叠会同时压低总能量，用"占总能量比例"会反而显得
  高质量更差；因此折叠 bin 一律换算到满量程参考的绝对幅度。
- **低质量路径的物理局限会被如实暴露**：例如 48k→24k（2:1）时，晚一个源采样的脉冲
  恰好落在输出采样间隙，线性插值会把它完全丢掉；高质量 FIR 因跨采样支撑而保留。
  自检把这一现象作为稳定复现的断言。
