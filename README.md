# 批量音频响度检查与校正工具

整理播客、游戏对白等成批音频时，快速看出音量是否一致，并按目标响度导出校正版本。
全部处理在本地完成（分析引擎为本机 ffmpeg），源文件永不修改。

## 环境要求

- Python 3.8+（仅用标准库）
- 本机安装 `ffmpeg` / `ffprobe`（如 `brew install ffmpeg`）
- 生成样音需要 `numpy` 和 `soundfile`（`pip install numpy soundfile`）

## 快速开始

```bash
# 生成样音（7 个响度/峰值差异明显的文件，输出到 samples/）
python3 make_samples.py

# 1. 导入并分析（mybatch 为批次目录，状态存于 mybatch/batch.json）
python3 loudness_tool.py add mybatch samples/*.wav

# 2. 查看分析结果：整体响度、真峰值、时长、与目标偏差
python3 loudness_tool.py list mybatch

# 3. 分析失败的文件可单独重试（省略参数则重试全部失败项）
python3 loudness_tool.py retry mybatch 8

# 4. 分组并设置不同目标（如播客 -16 LUFS，游戏素材 -23 LUFS）
python3 loudness_tool.py group mybatch podcast 3 4 5
python3 loudness_tool.py target mybatch --group podcast --lufs -16 --peak -1.0
python3 loudness_tool.py target mybatch --group default --lufs -23 --peak -1.5

# 5. 预览校正计划：会削波的文件提前预警，并给出安全目标建议
python3 loudness_tool.py plan mybatch

# 6. 导出校正版本 + CSV 报告（有削波风险会中止，提示降低目标）
python3 loudness_tool.py export mybatch
```

导出于 `mybatch/export/`：`NNN_原名_norm.wav`（24-bit WAV，编号与报告 ID 对应）和
`report.csv`（源指标、目标、增益、导出后实测指标一一对应）。

## 分析指标说明

| 指标 | 含义 |
|---|---|
| 整体响度 Integrated Loudness (LUFS) | EBU R128 / ITU-R BS.1770 标准：K 加权 + 门限门控的整文件响度，人耳感知的"音量大小"。多声道按标准能量求和，双声道素材结果正确 |
| 真峰值 True Peak (dBFS) | 过采样后的样本间峰值，比采样峰值更能反映回放/转码时的真实削波风险。0 dBFS 为满幅 |
| LRA (LU) | 响度范围，反映文件内部响度起伏（对白类通常 2-6 LU） |
| 与目标差 (LU) | 当前响度减目标响度，即校正所需增益；整批看这一列即可判断音量是否一致 |

## 边界情况处理

- **静音文件**：真峰值 `-inf`，响度显示 `-inf` 并标记"静音"，**不会**被当成正常响度参与校正，导出时跳过
- **短音频（<400ms）**：ebur128 无完整 400ms 分析块，自动退化为整体 RMS 经验估计并在报告标记 `loudness_is_estimate=yes`
- **短音频（<3s）**：整体响度可测量但门控统计不充分，标记"仅供参考"
- **削波预警**：`plan`/`export` 用 `源真峰值 + 增益` 预测导出峰值，超过上限即预警并给出该文件/该组的安全目标；`export` 默认中止，确认风险后可 `--allow-clip` 强制导出

## 批次持久化

`batch.json` 记录文件清单、分组、目标参数、分析结果和导出历史。重新打开（再次对同一
批次目录执行任何命令）直接读取已存结果，不重复分析，结果一致。源文件以绝对路径引用，
不会被复制或修改。

## 样音说明（`make_samples.py` 生成）

| 文件 | 特点 |
|---|---|
| `podcast_ep01_voice.wav` | 类语音，约 -16 LUFS，立体声 |
| `podcast_intro_music_loud.wav` | 片头音乐，偏响且峰值接近 0 dBFS |
| `podcast_ep02_voice_quiet.wav` | 对白，约 -28 LUFS，明显偏轻 |
| `game_dialogue_hot_peaks.wav` | 响度中等但瞬态峰值顶到 0 dBFS（触发削波预警） |
| `game_sfx_stereo_unbalanced.wav` | 左右声道不平衡的立体声音效 |
| `silence_3s.wav` | 纯静音（验证不误判） |
| `short_beep_0.2s.wav` | 0.2 秒短音（验证 RMS 估计路径） |
