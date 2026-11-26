# 拖影修复试验台 (deblur-lab)

本地纯 Python 的移动标牌抓拍「模糊修复」试验工具。它不追求一键全图锐化，而是：

1. **先校准拖影方向 / 长度**，看清楚估计依赖哪条边、哪个频段、范围多大；
2. **只处理你框选的区域**，并在边沿附近就能看到放大预览；
3. 用几个明确的旋钮**控制噪点与暗边被放大的程度**；
4. 用**同一比例**并排看输入 / 结果 / 残差，比较不同参数能恢复多少；
5. 一张图里**两处方向不同**时分别设置，重叠处按**确定次序**应用并显示实际生效范围；
6. **导出**结果、参数、以及用**保留的干净样例**核对过的字线宽度 / 边缘误差。

依赖只有 `numpy` 与 `Pillow`；GUI 额外用标准库 `tkinter`（不需要 matplotlib / OpenCV）。

---

## 快速开始

```bash
# 1) 生成样例（clean.png 干净参考 + blurred.png 带拖影与噪声 + targets.json 目标）
python3 -m deblur_lab.cli gen --out samples

# 2) 打开交互界面（可直接载入样例）
python3 -m deblur_lab.cli gui --image samples/demo/blurred.png

# 3) 自检：端到端验证估计、修复、重叠次序、导出核对
python3 -m deblur_lab.selftest
```

样例目录 `samples/demo/` 里：

| 文件 | 内容 |
|------|------|
| `clean.png` | 无拖影的干净参考（只用于**核对**，不参与估计） |
| `blurred.png` | 两块区域分别加了不同方向/长度拖影，并叠加传感器噪声 |
| `targets.json` | 已知边与字线目标（含 1px/2px/3px/5px 细条与字形竖笔画） |
| `scene.json` | 真实参数（角度、长度、噪声 σ、区域矩形） |

`gen --batch` 会额外生成角度 × 长度网格，用于「不同参数下能恢复多少」的扫描。

---

## 界面怎么用

1. **打开图片** → 若同目录有 `scene.json`/`clean.png`，自动带上干净参考与目标。
2. **框选区域** → 在任一画面上拖一个框；每个框是一个独立区域。
3. **点参考边** → 在清楚的边附近点一下；工具会贴合到最近的强边，测量它的 10‑90 宽度，并在右侧「估计依据」里列出：
   - 用到的每条边（来源、法线角、宽度 ± 不确定度、坐标）；
   - 频谱窗口大小、频带、角度/长度 1σ、是否可信；
   - 角度/长度搜索范围与步长（这是「估计依赖哪个范围」的直接说明）。
4. 若估计**不稳**（右侧提示 / `稳定: 否`），直接在「参数」里**手填**角度、长度、次序、羽化，点「写入所选区域」。
5. **应用修复** 后，画面变成 **输入 | 修复结果 | 残差** 三栏，**同一比例**。
   - 下方「边沿预览」对所选区域中心做最近邻放大，边沿效果一眼可见。
   - 右侧读数给出 PSNR/SSIM 前后值、区域外平均变化、保留样例目标通过数、线宽与位置误差。
6. **噪点 / 暗边控制**：
   - `平坦区保护`（0–0.95）：没有真实细节的平坦区几乎不放大；
   - `噪声下限`：把微小起伏向局部均值压回的力度；
   - `前级去噪 σ` / `噪声估计 σ`：先平滑再修复、以及限幅用的噪声尺度；
   - `迭代次数`：RL 迭代步数。
7. **导出…** → 写出结果、残差、区域覆盖图、`parameters.json`、`checks.json`、`contact_sheet.png`。

> GUI 只负责交互；所有算术都在库里，同一份参数可用命令行重放与导出。

---

## 只处理一个选区、在边沿附近预览

- 每个 `Region` 是 `(rect, angle, length, order, feather)`；修复只在 `rect` 内（外加一小圈反射上下文供卷积边界使用），且通过羽化掩膜贴回，**区域外像素逐字节保持不变**。
- 「边沿预览」把所选区域中心 52×52 区域最近邻放大到 320×150，输入与结果并排。

## 两处方向不同、重叠时的次序

- 每个区域有 `order`（整数）。**开**启的区域按 `order` 升序应用，**后应用者覆盖前者**（确定性）。
- 侧栏列表用色块 + 角标显示 `order`；导出 `regions.png` 把「实际生效」的并集（已消解重叠）用半透明着色，重复覆盖像素数为 0。
- `checks.json` 里 `regions[].pixels` 是该区域**实际生效**的像素数。

## 残差与可恢复程度

- 残差 = `输入 − 结果`，以中灰为 0、`×4` 增益显示，便于看修回了什么。
- CLI `sweep` 可对角度 × 长度网格逐点测量 PSNR/SSIM/目标通过数：

```bash
python3 -m deblur_lab.cli sweep --image samples/demo/blurred.png \
    --rect 46,92,462,404 --angles 8,10,12,14,16 --lengths 12,15,17,19,21
```

## 导出与核对

一次导出（GUI「导出…」或 `cli restore`）包含：

```
result.png          修复结果
original.png        输入
residual.png        残差（有符号，中灰=0）
regions.png         区域与实际生效范围
parameters.json     所有区域 / 参数 / 每次估计的完整依据
checks.json         对保留干净样例的核对
contact_sheet.png   输入|结果|残差 同比例拼图
session.json        导出清单
```

`checks.json` 的要点：

- `before` / `after` 的 `targets.summary`：保留目标（字线宽度、边缘位置）在修复前后的**通过率**；
- `edge_detail`：逐目标的 `ref_width_px` / `test_width_px` / `width_delta_px` / `position_error_px`；
- `untouched`：结果相对**输入**在应用掩膜之外的变化（应接近 0，证明无拖影区没被动）；
- `flat_noise`：干净参考 / 输入 / 结果的平坦区噪声 σ；
- `regions[]`：每区域噪声放大倍数与 `dark_edge_gain`（暗边被放大的程度）。

---

## 估计是怎么做的（也是它的局限）

- **几何模型**：一条法线 $\phi$ 的直边，在运动长度 $L$、方向 $\theta$ 下，测得的 10‑90 宽度近似
  $W \approx g\big(L|\cos(\theta-\phi)| + t|\sin(\theta-\phi)|\big)$，
  其中 $g(\cdot)$ 是「阶跃 ⊛ 盒 $W$ ⊛ 高斯 $\sigma$」的 10‑90 宽度（查表）；
- **多边联合**：在 $(0°..180°, 1..45px)$ 网格上用加权平方残差求解，给出代价面与角度/长度边缘分布，1σ 由代价上升 1.0 的宽度给出；
- **频谱**：用加窗 FFT 的**方向调制**找拖影方向（沿运动轴的谱“凹槽”最强），沿该轴找凹槽间距定长度；
- **依赖说明**：`dependencies` 里记录了每条边的测量、法线差、频谱窗/带/可信度、搜索范围/步长、以及代价最小值，便于判断这次估计到底依赖了什么。

**局限**：只有一条边时 $(\theta, L)$ 本身不可唯一确定——此时工具会用频谱补方向，并明确标注 `稳定: 否`，提示手填。像素级小字、低对比边、强噪声都会让频谱项变差，这也会如实反映在不确定度上。

---

## 模块结构

```
deblur_lab/
  ops.py       IO、FFT 卷积、PSF、掩膜、采样、局部统计
  synth.py     合成场景（小字/细条/斜边/噪声）、按方向长度加拖影、目标标注
  estimate.py  边测量、频谱估计、(角度,长度) 网格求解与不确定度
  restore.py   选区 Richardson-Lucy、平坦区保护、限幅、按次序合成
  metrics.py   PSNR/SSIM、噪声 σ、边宽/边位置、线宽、暗边放大、目标核对
  report.py    载入、残差图、覆盖图、拼图、导出
  selftest.py  端到端自检
  cli.py       命令行
  gui.py       tkinter 界面
```

## 命令行速查

```bash
python3 -m deblur_lab.cli gen      --out samples [--batch]
python3 -m deblur_lab.cli estimate --image X.png --rect x0,y0,x1,y1 [--ref x,y[,normal]]
python3 -m deblur_lab.cli restore  --image X.png \
        --region x0,y0,x1,y1,angle,length[,order[,feather]] --region ... --out out/
python3 -m deblur_lab.cli sweep    --image X.png --rect x0,y0,x1,y1 \
        --angles a1,a2 --lengths l1,l2
python3 -m deblur_lab.cli gui      [--image X.png]
python3 -m deblur_lab.selftest
```
```
