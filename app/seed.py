"""虚构演示数据：两个月、三家门店，其中一家的 9 月月报有修订版。

所有附件在资料站上的文件名都叫“月报.pdf”，用于验证入库后仍能按门店分开。
"""
import hashlib

from . import config, db
from .pdfgen import write_report_pdf

# (月份, 门店编码, 门店名称, 资料编号, 版本, 是否当前版本, 备注)
SEED: list[tuple[str, str, str, str, str, bool, str]] = [
    ("2026-09", "S01", "望京店", "WL-2026-0901", "V1.0", False,
     "原版月报，发布后发现营收口径有误，已由修订版替换。"),
    ("2026-09", "S01", "望京店", "WL-2026-0901", "V2.0", True,
     "修订版月报，修正了营收统计口径，为当前版本。"),
    ("2026-09", "S02", "三里屯店", "WL-2026-0902", "V1.0", True,
     "原版月报，当前版本。"),
    ("2026-09", "S03", "国贸店", "WL-2026-0903", "V1.0", True,
     "原版月报，当前版本。"),
    ("2026-10", "S01", "望京店", "WL-2026-1001", "V1.0", True,
     "原版月报，当前版本。"),
    ("2026-10", "S02", "三里屯店", "WL-2026-1002", "V1.0", True,
     "原版月报，当前版本。"),
    ("2026-10", "S02", "三里屯店", "WL-2026-1002", "V1.1", True,
     "补充版，增加了会员分析章节，为当前版本；原版同步保留。"),
    ("2026-10", "S03", "国贸店", "WL-2026-1003", "V1.0", True,
     "原版月报，当前版本。"),
]

FILENAME = "月报.pdf"
PUBLISHED_AT = {
    "V1.0": "{month}-05 10:00",
    "V1.1": "{month}-12 15:30",
    "V2.0": "{month}-18 09:20",
}


def seed() -> dict:
    """生成资料站原始 PDF 并写入目录表，返回统计信息。"""
    conn = db.get_conn()
    db.init_schema(conn)
    created = 0
    try:
        for month, code, name, doc_no, version, is_current, note in SEED:
            pdf = write_report_pdf(
                config.SOURCE_DIR / month / code / doc_no / version / FILENAME,
                doc_no=doc_no,
                version=version,
                month=month,
                store_code=code,
                store_name=name,
                title=f"{name}{month[5:]}月月报",
                is_current=is_current,
                note=note,
            )
            data = pdf.read_bytes()
            db.upsert_report(conn, {
                "doc_no": doc_no,
                "version": version,
                "month": month,
                "store_code": code,
                "store_name": name,
                "title": f"{name}{month[5:]}月月报",
                "filename": FILENAME,
                "source_path": str(pdf.relative_to(config.SOURCE_DIR)),
                "source_sha": hashlib.sha256(data).hexdigest(),
                "is_current": 1 if is_current else 0,
                "note": note,
                "published_at": PUBLISHED_AT[version].format(month=month),
            })
            created += 1
        conn.commit()
    finally:
        conn.close()
    return {"reports": created, "source_dir": str(config.SOURCE_DIR)}


if __name__ == "__main__":
    print(seed())
