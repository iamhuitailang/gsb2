"""FastAPI 应用入口。

启动顺序：建目录 -> 连接数据库 -> 启动任务调度器（含重启恢复）。
前端构建产物（frontend/dist）若存在则挂载到根路径，实现单端口访问；
开发时前端由 Vite 提供（/api 走代理）。
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import config, db, storage
from .routers import files, misc, tasks
from .runner import runner

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("video_tool")

FRONTEND_DIST = Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"


@asynccontextmanager
async def lifespan(app: FastAPI):
    storage.ensure_dirs()
    await db.connect()
    await runner.start()
    logger.info("data directory: %s", config.DATA_DIR)
    try:
        yield
    finally:
        await runner.shutdown()
        await db.close()


app = FastAPI(
    title="本地视频裁切与转码工具",
    version="1.0.0",
    lifespan=lifespan,
)

# 本地工具，放开常见开发端口；生产部署可通过环境变量收紧
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:4173",
        "http://127.0.0.1:4173",
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(RequestValidationError)
async def validation_handler(request, exc: RequestValidationError):
    """参数校验错误统一成中文提示。"""
    detail = "; ".join(
        f"{'.'.join(str(x) for x in e['loc'] if x != 'body')}: {e['msg']}"
        for e in exc.errors()
    )
    return JSONResponse(status_code=422, content={"detail": detail or "请求参数不合法"})


app.include_router(files.router)
app.include_router(tasks.router)
app.include_router(misc.router)


@app.get("/api/health")
async def health():
    return {
        "status": "ok",
        "max_concurrent_tasks": config.MAX_CONCURRENT_TASKS,
        "running_tasks": len(runner.running_task_ids()),
        "ffmpeg": config.FFMPEG_BIN,
        "ffprobe": config.FFPROBE_BIN,
    }


# 前端构建产物放在最后挂载，避免吞掉 /api 路由
if FRONTEND_DIST.exists():
    app.mount(
        "/",
        StaticFiles(directory=str(FRONTEND_DIST), html=True),
        name="frontend",
    )

    @app.exception_handler(404)
    async def spa_fallback(request, exc):
        """非 /api 的未知路径回退到 index.html（刷新/深链不白屏）。"""
        if request.url.path.startswith("/api/"):
            return JSONResponse({"detail": "资源不存在"}, status_code=404)
        return FileResponse(FRONTEND_DIST / "index.html")
