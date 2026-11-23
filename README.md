# 本地无缝音频接续验证工具（audio_stitch_check）

把一段 WAV 在指定采样点切成多段、分别用有损编码（默认 MP3，另有 AAC/m4a、
裸 ADTS），再用两种方式拼回去，对着未压缩原音逐采样核对接缝，定位
"交界处那一下空白" 到底是编码填充、帧取整漂移，还是仅仅是编码失真。

只依赖 Python 标准库、numpy 和本机 `ffmpeg`/`ffprobe`；matplotlib 为可选项，
缺失时自动退化为 ASCII 表格。

## 安装与运行

```bash
# ffmpeg 需在 PATH 上（本仓库在 ffmpeg 8.1 + libmp3lame 下验证）
pip install -r requirements.txt
export PYTHONPATH=$PWD          # 或在仓库根目录直接运行
python3 -m audio_stitch_check --help
python3 -m unittest discover -s tests -v   # 16 个端到端测试
```

## 解决的核心问题与判定原则

**编码失真 ≠ 丢了一段时间。** 工具把接缝附近的现象分成四类：

| 分类 | 含义 |
|---|---|
| `aligned` | 采样级对齐，无插入时间；幅度差异只是编码失真 |
| `silence_gap` | 接缝处出现参考音里不存在的数字静音段（填充造成的真实时间空白） |
| `source_silence` | 参考音在该切点本来就是静音——**不会**被误算成编码塞入的空白 |
| `drift` | 内容整体平移但没有对应静音段（帧取整/填充漂移） |
| `unverifiable` | 相关置信度不足，无法下结论 |

对齐用归一化互相关测量，并专门处理了持续音的整周期别名问题（在相关峰中
取绝对滞后最小的候选，再做亚周期细对齐）。静音判定同时使用自适应阈值和
精确零样本扫描两路证据。

## 填充信息的两个独立来源与信任级

1. **ffprobe 包级 side data**（`skip_samples` / `discard_padding`）——ffmpeg
   解码器实际剥掉的样本数，是操作性数值；
2. **MP3 LAME/Xing tag 手工解析**——编码器自己写进文件的 delay/padding，
   独立于 ffmpeg 解码状态（如 LAME 标称 576，ffmpeg 管线值 1105，两者之和
   相同，因为帧样本总数一致、切分点不同，工具会同时展示）。

信任级分三档，每条缝和每段都带标注，结论随之下放：

- `reliable`：首尾填充都能读到（MP3、Opus）；
- `partial`：只有一端有信息（AAC/m4a 只有 1024 头部 priming，尾填未知），
  涉及未知端的长度与偏移明确标为估计；
- `none`：完全读不到（裸 ADTS）。此时 `naive` 与 `trimmed` 诚实保持相同，
  并对头部 priming 做互相关经验估计（标记为估计值而非事实），所有结论在
  JSON/CSV 里带 `padding_trust=none` 和说明文字。

注意：ffmpeg 8.1 解码时**必然**剥填充且没有关闭开关，因此 `naive`（含填充
直拼）音轨是用 side data 报告的填充数以数字静音样本重建的——对普通素材，
编码器 priming 区本就是静音，报告中对此有明确说明。

## 命令一览

```bash
# 0. 生成程序化样例（持续音 / 接缝旁短脉冲 / 混合+真实静音 / 立体声）
python3 -m audio_stitch_check samples /tmp/demo/samples

# 1. 切分+逐段编码+填充探测（cuts 为 0 基切点采样号，逗号分隔）
python3 -m audio_stitch_check create in.wav /tmp/demo/proj \
    --cuts 12960,26400,61200,81600 --codec mp3

# 2. 每段源长度/解码长度/首尾填充 + 三条音轨总览
python3 -m audio_stitch_check info /tmp/demo/proj

# 3. 放大某条接缝到采样点（参考/naive/trimmed/corrected 四条，火花线+逐样本值）
python3 -m audio_stitch_check seam /tmp/demo/proj 0 --radius 24
python3 -m audio_stitch_check seam /tmp/demo/proj 0 --png seam0.png   # 可选

# 4. 全量分析，落 CSV / JSON / 三条 WAV
python3 -m audio_stitch_check analyze /tmp/demo/proj

# 5. 边界有歧义时调整某段保留范围（段内源相对坐标），其他接缝与总长自动更新
python3 -m audio_stitch_check adjust /tmp/demo/proj 2 --keep-start 100 --keep-end 34000
python3 -m audio_stitch_check undo /tmp/demo/proj      # 撤销最近一次调整

# 6. 导出校正 WAV + 核对清单（含回读校验：长度、声道数、各段范围首尾）
python3 -m audio_stitch_check export /tmp/demo/proj /tmp/demo/corrected.wav
```

## 产物说明

```
<workdir>/
  project.json              # 全部状态（含 undo 栈），可重新加载
  segNN_source.wav          # 切出的源段
  segNN.mp3 / .m4a / .aac   # 压缩段
  segNN_decoded.wav         # 解码段
  reference.wav             # 未压缩原音副本
  reports/
    segments.csv            # 每段源长/解码长/首尾填充/信任级/保留范围
    seams.csv               # 每条缝：参考位置、构建位置、实测偏移、分类…
    analysis.json           # 完整机器可读结果
    naive.wav               # 含填充直拼
    trimmed.wav             # 去填充后拼
    corrected.wav           # 按用户保留范围拼
<export>.checklist.json     # 每段实际使用范围、各缝采样点、回读校验结果
```

## 程序化样例与"静音不误算"保障

`samples` 生成四类确定性素材：持续音（考验周期信号对齐）、切点旁 20 采样的
短脉冲（考验空白计时）、含 100 ms **真实**静音块且各段长度不等的混合素材、
以及其立体声版本。`tests/test_stitch.py` 中断言真实静音块在 trimmed 结果里
始终分类为 `source_silence`、永不出现 `silence_gap` 误报。
