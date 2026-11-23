"""focus_stack — 本地多焦点照片合成工具（焦点堆叠 / focus stacking）。

模块划分：
- geometry:   仿射变换、warp、覆盖区计算
- registration: ECC 配准（允许焦点呼吸造成的小幅缩放/平移）
- sharpness:  逐源清晰度（拉普拉斯方差，积分图加速）
- selection:  局部源选择、空间平滑、固定区域（pin）约束、重影度量
- fusion:     硬边界 / 柔和交界合成、来源图
- project:    工程文件保存/读取（原图引用、配准、局部选择）
- samples:    自带样例生成（形状场景 + 明显移位失败场景）
- app_* / ui: Tkinter 图形界面
"""

__version__ = "1.0.0"
