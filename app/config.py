"""全局路径与运行参数。"""
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
SOURCE_DIR = DATA_DIR / "source_pdfs"      # 模拟资料站上的原始附件
INBOX_DIR = DATA_DIR / "inbox"             # 浏览器实际下载后归档的文件
DB_PATH = DATA_DIR / "app.db"

# 资料站列表每页条数（故意调小，方便演示逐页领取）
PAGE_SIZE = 2

# 模拟资料站 / 领取应用共用一个 Flask 进程
HOST = "127.0.0.1"
PORT = 8123

# 浏览器自动化是否无头（自检脚本里置为 1）
HEADLESS = False
