#!/usr/bin/env python3
"""本地表格切格检查工具启动脚本。

安全说明：
- 本工具的项目数据目录（原图、导出）通过命令行参数指定，默认 ./slicer_project，
  与本脚本所在的代码目录完全分离；不要把外来图片放进代码目录。
- 依赖（flask、opencv 等）安装在用户 site-packages，因此不能用 `python -I`
  启动（-I 会禁用 user site）。导入路径只显式加入受信的项目根目录。

用法：
    python3 run.py [项目目录] [--port 8765] [--no-browser]
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from slicer.cli import main  # noqa: E402

if __name__ == "__main__":
    main()
