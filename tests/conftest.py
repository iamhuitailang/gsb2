"""保证在 `python -I -m pytest` 隔离模式下也能导入仓库内的 badcol 包。"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
