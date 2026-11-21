"""任务链编辑与试玩工具核心包。

模块划分:
- conditions: 条件表达式 DSL 的词法/语法解析、求值与引用提取
- model:      任务图数据模型、工程文件读写、运行时数据导出/导入
- analysis:   图结构诊断 (循环依赖、入口、结局可达性、互斥死路、影响分析)
- simulator:  玩家行为模拟与逐步状态差分
- cli:        命令行入口
- server:     本地 HTTP 服务, 供 web 编辑器调用
"""

from .conditions import (
    ConditionError,
    ConditionEvalError,
    ConditionSyntaxError,
    evaluate,
    extract_references,
    lint_condition,
    parse,
)
from .model import Project, Quest, Reward, load_project, save_project
from .analysis import Issue, analyze_project, downstream_impact, compare_projects
from .simulator import Simulator

__all__ = [
    "ConditionError",
    "ConditionSyntaxError",
    "ConditionEvalError",
    "evaluate",
    "parse",
    "lint_condition",
    "extract_references",
    "Project",
    "Quest",
    "Reward",
    "load_project",
    "save_project",
    "Issue",
    "analyze_project",
    "downstream_impact",
    "compare_projects",
    "Simulator",
]
