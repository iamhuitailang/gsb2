# chroma_lab

4:2:0 色度抽样/还原实验工具。研究"红蓝细线压成视频色度分辨率后, 放回来红边偏半格"的问题:
把**颜色损失**(低通滤波丢细节)和**错位**(压缩/还原两端取样位置约定不一致)分开建模和观察。

依赖: Python 3 + numpy + matplotlib + Pillow

## 用法

```bash
# 交互式查看器 (不带参数用内置演示图, 127x95 奇数尺寸)
python3 -m chroma_lab view [图片] [--down left] [--up center] [--nearest]

# 导出还原图 + 原始通道阵列
python3 -m chroma_lab export [图片] -o 输出目录 [--down left] [--up center]

# 重新打开导出的阵列, 核对取样位置和尺寸标记
python3 -m chroma_lab arrays 输出目录

# 批量生成程序对比图 + 指标 (整体色偏 / 边缘亚像素偏移)
python3 -m chroma_lab batch -o 输出目录
```

## 取样位置约定 (siting)

| 约定 | 样本位置 (相对 2x2 亮度块左上角) | 对应 |
|---|---|---|
| `center` | (0.5, 0.5) 块正中央 | JPEG / MPEG-1 |
| `left` | (0.0, 0.5) 水平靠左、垂直居中 | MPEG-2 |
| `topleft` | (0.0, 0.0) 左上角对齐 | - |

压缩端和还原端选不同约定, 色度就整体错半格 —— 查看器里按 `d`/`u` 分别切换两端约定即可看到。

## 查看器快捷键

- `d` / `u`: 切换压缩端 / 还原端取样约定
- `m`: 双线性 ↔ 最近邻插值
- `g`: 开关取样网格
- `r`: 重置缩放, `h`: 帮助
- **点击**原图/还原图/亮度图任意像素: 显示该输出像素引用了哪些色度样本
  (索引、位置、权重、数值) 和对应亮度, 并把误差分解为"颜色损失"和"错位"两部分

## 模块

- `chroma_lab/core.py` — 色彩空间转换、抽样/还原、逐像素来源追踪
- `chroma_lab/testimages.py` — 测试图: 红蓝细线、锐利斜边、同亮度红蓝交界 (97,0,0)|(0,0,255)
- `chroma_lab/metrics.py` — 整体色偏、MAE、梯度质心法亚像素边缘偏移
- `chroma_lab/viewer.py` — 交互查看器
- `chroma_lab/store.py` — 导出/核对通道阵列
- `chroma_lab/batch.py` — 批量对比图
