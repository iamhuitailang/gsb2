"""示例 2：变量赋值、格式化与 os.popen 传播（高危，确定风险）。"""
import os


def run_diagnostics():
    target = input("输入主机名: ")
    # 赋值与格式化不会切断污点传播
    cmd = "nslookup %s" % target
    full_cmd = f"echo 开始诊断; {cmd}"
    output = os.popen(full_cmd).read()
    return output
