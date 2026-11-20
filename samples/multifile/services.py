"""多文件示例：被另一个文件 import 的工具模块（跨文件调用当前无法解析）。"""
import os


def risky_helper(cmd_suffix):
    # 参数来源在本文件内不可知，按可能风险播种
    os.system("ls " + cmd_suffix)


def safe_helper(name):
    import subprocess
    subprocess.run(["echo", name])
