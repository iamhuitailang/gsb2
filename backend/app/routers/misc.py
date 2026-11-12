"""杂项接口：编码选项、源文件流媒体播放、临时文件清理。"""
from __future__ import annotations

import mimetypes

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from .. import config, db, ffmpeg_ops, storage
from ..runner import runner
from ..schemas import CleanupResponse

router = APIRouter(prefix="/api", tags=["misc"])


@router.get("/options")
async def get_options():
    """页面渲染格式/编码下拉框的唯一数据源。"""
    return ffmpeg_ops.options_payload()


@router.get("/media/source/{file_id}")
async def stream_source(file_id: str):
    """源视频在线播放（FileResponse 支持 HTTP Range，可拖动时间轴）。"""
    row = await db.get_file(file_id)
    if not row:
        raise HTTPException(status_code=404, detail="文件不存在或已删除")
    path = storage.upload_path(row["stored_name"])
    if not path.exists():
        raise HTTPException(status_code=410, detail="文件已被清理")
    media_type, _ = mimetypes.guess_type(path.name)
    return FileResponse(
        path,
        media_type=media_type or "application/octet-stream",
    )


@router.post("/cleanup/temp", response_model=CleanupResponse)
async def cleanup_temp():
    """清理所有临时目录（不会影响上传文件和已完成的输出）。"""
    removed = 0
    freed = 0
    if not config.TEMP_DIR.exists():
        return CleanupResponse(removed_temp=0, freed_bytes=0)
    for child in config.TEMP_DIR.iterdir():
        if not child.is_dir():
            continue
        # 正在处理的任务目录不能删
        if child.name in runner.running_task_ids():
            continue
        freed += _dir_size(child)
        storage.remove_path(child)
        removed += 1
    return CleanupResponse(removed_temp=removed, freed_bytes=freed)


def _dir_size(path) -> int:
    total = 0
    for entry in path.rglob("*"):
        if entry.is_file():
            try:
                total += entry.stat().st_size
            except OSError:
                continue
    return total
