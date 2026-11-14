"""生成带中文内容的真实 PDF 月报。

不同版本内容不同，便于人工核对“真正下载到的文件”。
使用 reportlab 内置的 STSong-Light CID 字体，无需额外字体文件。
"""
from io import BytesIO
from pathlib import Path

from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfgen import canvas

_FONT = "STSong-Light"
_REGISTERED = False


def _ensure_font() -> str:
    global _REGISTERED
    if not _REGISTERED:
        pdfmetrics.registerFont(UnicodeCIDFont(_FONT))
        _REGISTERED = True
    return _FONT


def build_report_pdf(
    *,
    doc_no: str,
    version: str,
    month: str,
    store_code: str,
    store_name: str,
    title: str,
    is_current: bool,
    note: str,
) -> bytes:
    """根据月报元数据渲染一份 PDF，返回字节内容。"""
    font = _ensure_font()
    buf = BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    width, height = A4

    y = height - 25 * mm
    c.setFont(font, 18)
    c.drawCentredString(width / 2, y, title)

    y -= 12 * mm
    c.setFont(font, 10.5)
    lines = [
        f"资料编号：{doc_no}",
        f"版本：{version}（{'当前版本' if is_current else '历史版本'}）",
        f"所属月份：{month}",
        f"门店：{store_name}（{store_code}）",
    ]
    for line in lines:
        c.drawString(22 * mm, y, line)
        y -= 7 * mm

    y -= 4 * mm
    c.setFont(font, 12)
    c.drawString(22 * mm, y, "本月经营摘要")
    y -= 8 * mm
    c.setFont(font, 10.5)
    summary = [
        f"1. {store_name} {month} 月营收稳定，客流环比小幅增长。",
        f"2. 附件编号 {doc_no}，版本 {version}，由门店管理岗统一发布。",
        f"3. 说明：{note}",
    ]
    for line in summary:
        c.drawString(22 * mm, y, line)
        y -= 7 * mm

    y -= 6 * mm
    c.setFont(font, 9)
    c.drawString(22 * mm, y, "本文件为虚构资料，仅用于模拟资料站领取流程演示。")
    c.showPage()
    c.save()
    return buf.getvalue()


def write_report_pdf(path: Path, **kwargs) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(build_report_pdf(**kwargs))
    return path
