"""公交刷卡汇总归档查询服务。"""

from __future__ import annotations

from urllib.parse import quote

from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.responses import HTMLResponse, Response
from fastapi.staticfiles import StaticFiles

from .storage import DuplicateFile, ImportError_, Storage, to_csv_bytes

app = FastAPI(title="公交刷卡归档查询", version="1.0.0")
storage = Storage()

app.mount("/static", StaticFiles(directory=__file__.rsplit("/", 1)[0] + "/static"), name="static")


@app.get("/", response_class=HTMLResponse)
def index() -> HTMLResponse:
    with open(__file__.rsplit("/", 1)[0] + "/static/index.html", encoding="utf-8") as f:
        return HTMLResponse(f.read())


@app.post("/api/import")
async def import_file(file: UploadFile = File(...)) -> dict:
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="上传文件为空")
    try:
        result = storage.import_file(file.filename or "未命名文件", raw)
    except DuplicateFile as exc:
        raise HTTPException(
            status_code=409,
            detail={
                "message": "同一天同一份文件已存在，未重复入库",
                "existing_version": exc.existing,
            },
        )
    except ImportError_ as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"message": "导入成功", "version": result}


@app.get("/api/query")
def query(
    start_date: str = Query(..., description="开始业务日期 YYYY-MM-DD"),
    end_date: str = Query(..., description="结束业务日期 YYYY-MM-DD"),
    route: str | None = Query(None, description="可选，线路名称"),
) -> dict:
    try:
        return storage.query(start_date, end_date, route)
    except ImportError_ as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.get("/api/export")
def export(
    start_date: str,
    end_date: str,
    route: str | None = None,
    level: str = Query("station", pattern="^(station|line)$"),
) -> Response:
    try:
        result = storage.query(start_date, end_date, route)
    except ImportError_ as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    payload = to_csv_bytes(result, level)
    suffix = "线路汇总" if level == "line" else "站点明细"
    filename = f"上车人数_{suffix}_{start_date}_{end_date}.csv"
    return Response(
        content=payload,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}"},
    )


@app.get("/api/versions")
def versions(biz_date: str | None = None) -> list[dict]:
    return storage.list_versions(biz_date)


@app.get("/api/routes")
def routes() -> list[str]:
    return storage.list_routes()
