"""文件上传与列表接口。"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, UploadFile

from .. import config, db, storage
from ..media import ProbeError, probe_media

router = APIRouter(prefix="/api/files", tags=["files"])


@router.post("")
async def upload_file(request: Request, file: UploadFile):
    if not file.filename:
        raise HTTPException(status_code=400, detail="缺少文件名")

    ext = storage.safe_extension(file.filename)
    if not ext:
        raise HTTPException(
            status_code=400,
            detail=f"不支持的文件类型，允许的扩展名: "
            f"{', '.join(sorted(config.ALLOWED_EXTENSIONS))}",
        )

    # 原始文件名只做展示，绝不参与服务端路径拼接
    display_name = storage.sanitize_filename(file.filename)
    file_id = storage.new_id()
    stored_name = f"{file_id}{ext}"
    dest = storage.upload_path(stored_name)

    size = 0
    try:
        with dest.open("wb") as out:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > config.MAX_UPLOAD_BYTES:
                    out.close()
                    storage.remove_path(dest)
                    raise HTTPException(
                        status_code=413,
                        detail=f"文件超过大小限制 {config.MAX_UPLOAD_MB}MB",
                    )
                out.write(chunk)
    finally:
        await file.close()

    if size == 0:
        storage.remove_path(dest)
        raise HTTPException(status_code=400, detail="上传文件为空")

    # ffprobe 校验内容确实是可处理的媒体文件（不只信扩展名）
    try:
        probe = await probe_media(str(dest))
    except ProbeError as exc:
        storage.remove_path(dest)
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    if probe["duration_ms"] <= 0:
        storage.remove_path(dest)
        raise HTTPException(status_code=400, detail="无法读取视频时长，文件可能已损坏")

    await db.create_file_record(
        file_id=file_id,
        original_name=display_name,
        stored_name=stored_name,
        size_bytes=size,
        probe=probe,
    )
    return {
        "id": file_id,
        "original_name": display_name,
        "size_bytes": size,
        "duration_ms": probe["duration_ms"],
        "width": probe["width"],
        "height": probe["height"],
        "video_codec": probe["video_codec"],
        "audio_codec": probe["audio_codec"],
    }


@router.get("")
async def get_files():
    return await db.list_files()


@router.get("/{file_id}")
async def get_file(file_id: str):
    row = await db.get_file(file_id)
    if not row:
        raise HTTPException(status_code=404, detail="文件不存在或已删除")
    return row


@router.delete("/{file_id}")
async def delete_file(file_id: str):
    row = await db.get_file(file_id)
    if not row:
        raise HTTPException(status_code=404, detail="文件不存在或已删除")

    active = await db.tasks_using_file(file_id)
    if active:
        raise HTTPException(
            status_code=409,
            detail="该文件还有进行中的任务，请先取消或等待完成后再删除",
        )

    storage.remove_path(storage.upload_path(row["stored_name"]))
    await db.mark_file_deleted(file_id)
    return {"deleted": file_id}
