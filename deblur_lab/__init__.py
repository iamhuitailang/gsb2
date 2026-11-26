"""拖影修复试验台 (Motion deblur lab).

一个纯 Python 的本地工具: 生成带小字/边缘/噪声的合成抓拍, 按参考边/频谱估计
拖影方向与长度, 只对选区做可控的 Richardson-Lucy 修复, 并导出结果、参数与
基于保留干净样例的核对指标。

主要模块:
    ops        — 图像 IO、FFT 卷积、PSF、掩膜、采样等数值底座
    synth      — 合成场景生成与按方向/长度施加拖影
    estimate   — 频谱/梯度/参考边估计与多边约束求解
    restore    — RL 修复、选区羽化、平坦区保护、多区域确定性合成
    metrics    — 边缘宽度/位置、字线宽度、噪声/暗边、PSNR 等指标
    report     — 导出结果、参数 JSON、核对报告
    cli        — 命令行入口
    gui        — tkinter 交互界面
"""

__version__ = "1.0.0"
SCHEMA = "deblur-lab/1"
