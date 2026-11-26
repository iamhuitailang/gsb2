# 抓拍标牌 拖影（motion blur）修复试验台

纯本地 Python 工具，用于对移动标牌抓拍做**拖影方向校准 + 选择性去模糊**试验。
不是"一键全图锐化"：先把拖影的长度/方向估准（参考边估计或手填），再只对选定
区域做反向滤波，并在同一缩放比例下对比原图 / 结果 / 残差，判断参数是否真的
恢复了字线。

## 功能对照

| 需求 | 实现 |
| --- | --- |
| 1. 生成含小字/边缘/噪声的图，按不同方向及长度加拖影，可打开本地图片并选一处清楚的边 | `synth.py` 生成测试板（小字、2–8 px 条宽、0°/90°/135° 校准边、棋盘细纹、噪声），默认 6 组方向/长度组合并加 `board_multi.png`；GUI「生成样例 / 打开图片」；「参考边」工具在图上拖一条**跨边**线段 |
| 2. 由参考边推测模糊长度与方向，显示依赖范围，估不稳可手填 | `estimate.py`：盒型拖影 + 软边（含传感器 σ）的解析模型，对剖面做带边界 Levenberg–Marquardt 拟合，给投影宽 `w` 与 95% 置信区间。单边只给投影并明确列出 `L=w/cosΔ` 依赖曲线；两边联合解 `w_i=L·|cos(θ−φ_i)|`；正交边会显式报告镜像歧义。GUI 显示每条边的显著区间与置信度，可改手填 |
| 3. 只处理一个选区，边沿附近可预览，控制噪点与暗边放大 | `deblur.py`：频域约束最小二乘，`noise_gain` 是**硬上限**（逐频点闭式解 λ，保证增益峰值不超过设定）；`shadow_limit`/`overshoot` 按局部对比度比例软限幅。处理块按 PSF 半径外扩，选区边界附近也有上下文。GUI「只预览该选区（含边沿余量）」 |
| 4. 同比例查看原图/结果/残差，估不同参数能恢复多少，无拖影区不应大变 | `compare.py` 三联视图共用同一 `ViewState`；`metrics.py` 给梯度恢复率、字线宽度误差、10–90% 过渡宽、边缘位置误差、无拖影区 RMS/超容差比例；`pipeline.sweep_parameters` 扫长度×噪声上限 |
| 5. 一图两处不同方向拖影分别设置，重叠时固定次序并显示实际应用范围 | `regions.py`：每区域独立参数；次序按 `(priority, seq)` 升序，**后处理者覆盖先处理者**，合成权重 `w_i=m_i·Π_{j>i}(1−m_j)`（Σw≤1，未覆盖处保持原图）；`coverage_map` 给逐像素归属与覆盖计数，GUI 彩色覆盖图切换 |
| 6. 导出结果与估计参数，用保留的干净样例核对字线宽度和边缘误差 | `export.export_result` 输出 `result.png`/`residual.png`/`coverage.png`/`params.json`（含每区域参数、重叠报告、指标）+ 可选 float `.npy`；`export.validate_pair` 对合成干净/模糊配对算字线宽度误差与边缘误差，`format_validation` 打印成表 |

## 依赖

- 必需：Python ≥ 3.10、NumPy、Pillow
- 可选：Tkinter（GUI；无显示器时用 CLI）
- 测试：pytest

```bash
python3 -m pip install numpy pillow pytest
```

> 全部数值实现（FFT 卷积、LM 拟合、erf、min/max 包络）均为 NumPy 版，不依赖
> SciPy/OpenCV。

## 快速开始

```bash
# 1) 生成样例（干净图 + 多组拖影 + 双区域图 + meta.json 真值）
python3 -m blurlab.cli synth --out out/samples

# 2) 由参考边估计长度/方向（可给多条边；每条是跨过边的线段）
python3 -m blurlab.cli estimate --image out/samples/board_blur_30deg_L9.png \
    --edge 506,162,554,162 --edge 650,116,650,164 --edge 545,300,565,320

# 3) 双区域去模糊，导出结果与参数
python3 -m blurlab.cli deblur --image out/samples/board_multi.png \
    --region 470,238,700,408 --length 13 --angle 30 \
    --region 600,296,862,486 --length 9 --angle 120 \
    --meta out/samples/meta.json --clean out/samples/board_clean.png \
    --out out/multi --metrics

# 4) 用干净样例核对字线宽度 / 边缘误差
python3 -m blurlab.cli validate --clean out/samples/board_clean.png \
    --blurred out/samples/board_blur_30deg_L9.png --meta out/samples/meta.json \
    --length 9 --angle 30 --out out/validate.json

# 5) GUI
python3 -m blurlab.gui

# 6) 无界面端到端演示 + 测试
python3 examples/demo.py
python3 runtests.py
```

## 目录

```
blurlab/
  kernel.py      # 拖影 PSF、角度/长度约定、FFT 卷积
  synth.py       # 测试图生成（小字、边缘、噪声、多方向拖影、双区域）
  profile.py     # 跨边采样、结构张量法向修正、剖面
  estimate.py    # 参考边 -> 投影宽/长度/方向 + 置信区间 + 依赖窗口/镜像歧义
  deblur.py      # 选区频域约束最小二乘、噪声增益硬上限、暗/亮过冲软限幅
  regions.py     # 多区域优先级、重叠次序、实际应用掩膜与合成
  metrics.py     # 梯度恢复率、字线宽度、边缘误差、无拖影区变化、残差统计
  pipeline.py    # 区域处理->合成->指标的端到端管线 + 参数扫描
  compare.py     # 三联同比例视图、缩放同步、比例尺
  export.py      # PNG/JSON 导出、干净/模糊配对验证
  app.py         # 无 Tk 的界面控制器（可单测）
  gui.py         # Tk 界面
  cli.py         # 无界面批处理入口
examples/        # demo.py 端到端演示，triptych.py 生成三联图
tests/           # 单元与端到端测试
```

## 约定

- **角度**：以图像 x 轴（向右）为 0°，屏幕上逆时针为正，按 180° 取模
  （线状 PSF 对称，θ 与 θ+180° 等价）。数组 y 向下，方向向量为 `(cosθ, −sinθ)`。
- **长度**：`length_px` 是拖影线段物理长度；核在 `[−L/2, L/2]` 上取
  `ceil(L)+1` 个点做双线性撒点，核中心严格居中。
- **单边只能测投影**：一条边只能定到 `w=L·|cos(θ−φ)|`。要同时得 L 与 θ，
  需要至少两条法向不同的边；仅用正交边（0°/90°）时 θ 与 −θ 不可区分，
  工具会显式报告歧义，需再加斜边。
- **残差** = 原图 − 结果；三联视图里按 ±`residual_gain` 映射成灰度（0 为 0.5 灰）。
- 所有计算在 float32/float64 下进行；导出默认量化到 8-bit PNG，同时保留 float `.npy`。
- 导出的 JSON 会清洗 NaN/Inf 为 `null`，保证是严格合法 JSON。
