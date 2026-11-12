"""全局配置：所有路径与限制均可通过环境变量覆盖。"""
from __future__ import annotations

import os
import shutil
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

# 数据目录（数据库、上传文件、输出文件、临时文件）
DATA_DIR = Path(os.getenv("VIDEO_TOOL_DATA", str(BASE_DIR / "data"))).resolve()
DB_PATH = DATA_DIR / "app.db"
UPLOAD_DIR = DATA_DIR / "uploads"
OUTPUT_DIR = DATA_DIR / "outputs"
TEMP_DIR = DATA_DIR / "temp"

# 上传限制
MAX_UPLOAD_MB = int(os.getenv("VIDEO_TOOL_MAX_UPLOAD_MB", "2048"))
MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024

# 允许的视频扩展名（小写，带点）
ALLOWED_EXTENSIONS = {
    ".mp4", ".mov", ".m4v", ".mkv", ".avi", ".webm",
    ".flv", ".wmv", ".ts", ".mpg", ".mpeg", ".3gp", ".ogv",
}

# 同时运行的 FFmpeg 任务上限
MAX_CONCURRENT_TASKS = max(1, int(os.getenv("VIDEO_TOOL_MAX_CONCURRENCY", "2")))

# FFmpeg 可执行文件
FFMPEG_BIN = os.getenv("FFMPEG_BIN") or shutil.which("ffmpeg") or "ffmpeg"
FFPROBE_BIN = os.getenv("FFPROBE_BIN") or shutil.which("ffprobe") or "ffprobe"

# 单任务列表默认条数
TASK_LIST_LIMIT = 100
