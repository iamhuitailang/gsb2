# popfix —— 录音爆点自动定位与局部修复工具

旧录音里偶发的短促爆点（pop/click）和正常鼓点一样都是瞬态，直接上降噪
容易把鼓点一起压坏。`popfix` 把「找爆点」和「修爆点」拆开：先只定位、
允许人工确认，再对确认的区间做局部修复，区间外的样本一个都不动。

纯 Python 实现，只依赖 `numpy` 和 `soundfile`（wav 读写），滤波与插值
全部用 numpy 手写，不依赖 scipy。

## 安装

```bash
pip install numpy soundfile pytest   # 测试才需要 pytest
```

## 完整工作流

### 1. 生成测试素材（声音全部由程序合成）

```bash
python -m popfix generate work/sample
```

产出三份文件：

| 文件 | 内容 |
| --- | --- |
| `clean.wav` | 干净参考：和弦垫 + 本底噪声 + 轻/重鼓点 + 镲片，无爆点 |
| `damaged.wav` | 在干净信号上注入爆点后的受损文件 |
| `truth.json` | 每个爆点的真实位置、时长、声道，供核对用 |

合成的爆点覆盖要求的全部形态：轻重鼓点（检测不得误伤）、**连着两次的
双爆点**、**只在单边声道的爆点**、**贴文件头/文件尾的爆点**。

### 2. 自动找候选，标明时长与受影响声道

```bash
python -m popfix detect work/sample/damaged.wav -m work/sample/manifest.json
python -m popfix list -m work/sample/manifest.json
```

每个候选区域记录起止样本、时长、声道、检测分数。相邻候选按
`merge_gap_ms`（默认 40ms）自动合并，所以双爆点会并成一块。
清单 `manifest.json` 是整个流程的工作底稿，可随时在原音上重开。

手工改选区：

```bash
python -m popfix add     -m m.json 1.0 1.005 -c 0,1   # 新增(秒; 加 --in-samples 用样本号)
python -m popfix trim    -m m.json 2 -s 2.344 -e 2.356 # 改边界
python -m popfix remove  -m m.json 6                  # 删除
python -m popfix enable  -m m.json 6 --off            # 停用(保留但不修)
python -m popfix channels -m m.json 4 1               # 改受影响声道
python -m popfix remerge -m m.json 100                # 按新间隔重新合并
```

### 3. 只修确认的范围，单块可调处理宽度

```bash
python -m popfix padding -m m.json 3.0 --id 3   # 只把 3 号区的处理宽度调到 3ms
python -m popfix padding -m m.json 1.0          # 全局默认宽度 1ms
python -m popfix repair  -m m.json -o repaired.wav --slices
```

- 只修 `enabled` 的区域、且只改区域声明的声道；
- 贴文件头/尾时锚点自动退化，不越界；同一块多个爆点整块一次修完；
- 修复带收敛保护，对已修复结果重复执行不会漂移（幂等）。

### 4. 同一时间位置切原声 / 修补声 / 被移除内容

`--slices` 会为每个修复区导出三段**等长、时间对齐**的 wav 到 `slices/`：

```
region01_original.wav  region01_repaired.wav  region01_removed.wav
```

三者满足 `原声 = 修补声 + 被移除内容`，可直接逐样本对齐试听。
切片范围在修复区外再带 150ms 上下文（`--context-ms` 可调）。

### 5. 导出 wav 与清单，并对照干净参考核对

```bash
python -m popfix verify -m m.json \
    --truth work/sample/truth.json \
    --clean work/sample/clean.wav \
    --repaired repaired.wav \
    --report report.json
```

报告给出三类结论：

- **漏修 missed**：真值爆点处高频损伤仍残留超门限；
- **误伤 false_edits**：在没有爆点的位置动了样本（真值 30ms 邻域外）；
- **区外一致性**：所有修复区并集之外，修复声与原声在 PCM16 量化级别
  必须逐样本相同。

## 设计原理

**检测为什么不会把鼓点误判成爆点。** 爆点是极陡的高频瞬态，鼓点（kick）
能量集中在低频。先做一阶差分高通取高频残差，在短帧上算能量，再用
「拖尾中位数」估计该时刻之前的高频本底。鼓点来临时本底随其低频一起
抬高，分数不会爆表；爆点的高频尖峰则显著高出本底（实测鼓点分数 <100，
爆点 >300），阈值取 200。单声道按声道独立检测，所以单边爆点只标一个声道。

**修复为什么不会压坏正常声音。** 不用全局降噪，而是两步局部处理：
先用修复区两侧的外侧样本稳健拟合一条线性低频背景（床信号在几毫秒内
近似线性），再用余弦锥形窗只把**叠加在背景上的高频损伤分量**减掉——
两端短淡入淡出保证接缝连续，中央完全移除损伤，背景的缓变走势保留。

**核对为什么在高频域判漏修。** 床信号是低频正弦，在几毫秒窗口内无法从
外侧样本完美预测，这段低频拟合差异是任何局部修复都消不掉的物理残差。
因此漏修判定放在与检测器同一套高通的**高频残差域**（爆点的物理本质），
全频带残留比仅作参考列出。误伤和区外一致性仍在原始波形上严格判定。

## 模块结构

| 模块 | 职责 |
| --- | --- |
| `popfix/synth.py` | 程序化合成干净参考、爆点损伤与真值 |
| `popfix/detect.py` | 高通残差 + 拖尾中位数本底的爆点检测与合并 |
| `popfix/manifest.py` | 清单的加载/保存、手工编辑、重新合并、路径解析 |
| `popfix/repair.py` | 背景估计 + 锥形窗局部修复，对齐切片 |
| `popfix/verify.py` | 对照干净参考核对漏修/误伤/区外一致性 |
| `popfix/wavio.py` | wav 读写（soundfile 封装） |

## 测试

```bash
python -m pytest tests/
```

覆盖：合成素材的逐样本一致性、检测对全部爆点的覆盖与对鼓点的零误报、
双爆点合并、单边声道、清单各类手工编辑、修复区外逐样本不变、停用区
跳过、单块调宽、头尾与多爆点块、切片对齐恒等、修复幂等、漏修/误伤核对、
清单目录移动后重开、单声道文件。
