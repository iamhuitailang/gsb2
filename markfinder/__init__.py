"""markfinder —— 本地模板查找器。

在同一图片（或另一张图）里查找被旋转/缩放/局部遮挡的同款小标记，
支持人工复核、阈值重算不丢确认结果、位置/角度/修订记录导出。
"""

from .template import Template, load_template, save_template
from .matching import SearchParams, find_matches
from .candidates import Match, merge_candidates
from .review import ReviewStore
from .geometry import angle_diff, make_rotation_scale_matrix

__all__ = [
    "Template",
    "load_template",
    "save_template",
    "SearchParams",
    "find_matches",
    "Match",
    "merge_candidates",
    "ReviewStore",
    "angle_diff",
    "make_rotation_scale_matrix",
]

__version__ = "0.1.0"
