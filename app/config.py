"""全局配置：两个模拟来源、场馆映射、端口、存储路径。"""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# 数据目录可用环境变量覆盖，方便测试隔离
DATA_HOME = Path(os.environ.get("DATA_HOME", ROOT / "data"))
COLLECTOR_DB = DATA_HOME / "collector.db"

# 两个模拟来源的端口（可用环境变量覆盖）
SOURCE_A_PORT = int(os.environ.get("SOURCE_A_PORT", "8101"))
SOURCE_B_PORT = int(os.environ.get("SOURCE_B_PORT", "8102"))
COLLECTOR_PORT = int(os.environ.get("COLLECTOR_PORT", "8200"))

# 演示用的样例日期（样例数据都挂在这一天）
SAMPLE_DATE = "2026-11-15"

# 每个来源的预设额度周期：
#   capacity = 一轮里允许成功的请求数；用完后返回 429，retry_after 秒后整轮重置
# 甲馆数据 2 页（第 1 页后额度即用尽，等 5 秒再拉第 2 页），乙馆数据 2 页
SOURCES = [
    {
        "id": "source-a",
        "name": "模拟来源甲",
        "port": SOURCE_A_PORT,
        "capacity": 1,
        "retry_after": 5,
    },
    {
        "id": "source-b",
        "name": "模拟来源乙",
        "port": SOURCE_B_PORT,
        "capacity": 3,
        "retry_after": 5,
    },
]

# 场馆 -> 来源
VENUES = [
    {"id": "venue-a", "name": "甲馆", "source_id": "source-a"},
    {"id": "venue-b", "name": "乙馆", "source_id": "source-b"},
]
VENUE_SOURCE = {v["id"]: v["source_id"] for v in VENUES}
SOURCE_BASE_URL = {s["id"]: f"http://127.0.0.1:{s['port']}" for s in SOURCES}

PAGE_SIZE = 2

# 其他错误（非 429）的重试间隔
ERROR_RETRY_SECONDS = 2
