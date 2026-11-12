"""裁切/转码任务接口。"""
from __future__ import annotations

import mimetypes
from urllib.parse import quote

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from .. import db, ffmpeg_ops, storage
from ..runner import TERMINAL_STATUSES, runner
from ..schemas import CancelResponse, TaskCreate

router = APIRouter(prefix="/api/tasks", tags=["tasks"])


@router.post("")
async def create_task(payload: TaskCreate):
    file_row = await db.get_file(payload.file_id)
    if not file_row:
        raise HTTPException(status_code=404, detail="源视频文件不存在或已删除")

    try:
        params = ffmpeg_ops.validate_params(
            start_ms=payload.start_ms,
            end_ms=payload.end_ms,
            fmt=payload.format,
            video_codec=payload.video_codec,
            audio_codec=payload.audio_codec,
            crf=payload.crf,
            preset=payload.preset,
            video_bitrate=payload.video_bitrate,
            audio_bitrate=payload.audio_bitrate,
            source_duration_ms=int(file_row["duration_ms"] or 0),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    task_id = storage.new_id()
    await db.create_task_record(
        {
            "id": task_id,
            "file_id": file_row["id"],
            "status": "queued",
            "start_ms": params.start_ms,
            "end_ms": params.end_ms,
            "duration_ms": params.duration_ms,
            "format": params.format,
            "video_codec": params.video_codec,
            "audio_codec": params.audio_codec,
            "crf": params.crf,
            "preset": params.preset,
            "video_bitrate": params.video_bitrate,
            "audio_bitrate": params.audio_bitrate,
            "progress": 0,
            "output_name": None,
            "output_size": None,
            "ffmpeg_cmd": "[]",
            "error": None,
            "created_at": db.now_iso(),
            "updated_at": db.now_iso(),
            "started_at": None,
            "finished_at": None,
        }
    )
    await runner.enqueue(task_id)
    task = await db.get_task(task_id)
    return task


@router.get("")
async def list_tasks():
    return await db.list_tasks()


@router.get("/{task_id}")
async def get_task(task_id: str):
    task = await db.get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")
    return task


@router.post("/{task_id}/cancel", response_model=CancelResponse)
async def cancel_task(task_id: str):
    task = await db.get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")
    if task["status"] in TERMINAL_STATUSES:
        return CancelResponse(
            task_id=task_id, canceled=False, message="任务已结束，无需取消"
        )
    accepted = await runner.request_cancel(task_id)
    return CancelResponse(
        task_id=task_id,
        canceled=accepted,
        message="取消请求已发送，正在停止 FFmpeg 进程并清理临时文件",
    )


@router.delete("/{task_id}")
async def delete_task(task_id: str):
    """删除终态任务及其输出文件。"""
    task = await db.get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")
    if task["status"] not in TERMINAL_STATUSES:
        raise HTTPException(status_code=409, detail="任务仍在进行，请先取消")

    if task["output_name"]:
        try:
            storage.remove_path(storage.output_path(task["output_name"]))
        except ValueError:
            pass
    # 兜底清理临时目录
    storage.remove_path(storage.temp_dir(task_id))
    await db.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
    return {"deleted": task_id}


def _output_file_response(task: dict, *, inline: bool) -> FileResponse:
    if task["status"] != "succeeded" or not task["output_name"]:
        raise HTTPException(status_code=404, detail="任务没有可下载的输出")
    try:
        path = storage.output_path(task["output_name"])
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="非法输出路径") from exc
    if not path.exists():
        raise HTTPException(status_code=410, detail="输出文件已被清理")

    media_type, _ = mimetypes.guess_type(path.name)
    disposition = "inline" if inline else "attachment"
    # 下载文件名：原文件名 + 裁切标记 + 输出扩展名
    download_name = f"trimmed_{path.name}"
    headers = {
        "Content-Disposition": (
            f"{disposition}; filename*=UTF-8''{quote(download_name)}"
        )
    }
    return FileResponse(
        path,
        media_type=media_type or "application/octet-stream",
        headers=headers,
        filename=download_name,
    )


@router.get("/{task_id}/preview")
async def preview_task(task_id: str):
    """在线预览输出（支持 Range 请求，可拖动播放）。"""
    task = await db.get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")
    return _output_file_response(task, inline=True)


@router.get("/{task_id}/download")
async def download_task(task_id: str):
    task = await db.get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")
    return _output_file_response(task, inline=False)
