"""sketchclean —— 纸面草稿本地清理工具。"""

from .params import ProcessParams, Region
from .pipeline import ProcessResult, process_array, process_file

__all__ = ["ProcessParams", "Region", "ProcessResult", "process_array", "process_file"]
