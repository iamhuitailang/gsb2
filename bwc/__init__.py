"""黑白模板清理对照工具 (black-white cleanup workbench).

只依赖 numpy 与 Pillow; 连通域与形态学均为纯 numpy 实现,
连通性 4/8 全局统一, 保证统计、编号与界面标注一致。
"""

__version__ = "1.0.0"

# 前景约定: mask=True 表示墨迹(黑), False 表示纸张(白)
INK = True
PAPER = False
