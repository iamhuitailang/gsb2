"""浏览器自动化领取：打开模拟资料站页面，逐页点击下载并归档实际文件。

去重维度为 资料编号 + 版本：入库表里已存在的版本直接跳过，
因此重复领取同一月份/门店范围不会产生重复文件。
"""
import hashlib
import sqlite3
import threading
from pathlib import Path

from playwright.sync_api import Error as PWError
from playwright.sync_api import sync_playwright

from . import config, db


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


class HarvestWorker:
    def __init__(self, run_id: int, month: str, store: str, headless: bool | None = None):
        self.run_id = run_id
        self.month = month
        self.store = store
        self.base_url = f"http://{config.HOST}:{config.PORT}"
        self.headless = config.HEADLESS if headless is None else headless
        self.stats = {"total_seen": 0, "downloaded": 0, "skipped": 0, "errors": 0}

    def _log(self, conn, action: str, message: str, doc_no=None, version=None) -> None:
        db.add_event(conn, self.run_id, action, message, doc_no, version)

    def _launch(self, pw):
        """优先驱动系统安装的 Google Chrome，未安装时回退到 Playwright 自带 Chromium。"""
        try:
            return pw.chromium.launch(channel="chrome", headless=self.headless)
        except PWError:
            return pw.chromium.launch(headless=self.headless)

    def run(self) -> dict:
        conn = db.get_conn()
        try:
            with sync_playwright() as pw:
                self._log(conn, "start",
                          f"启动浏览器，打开资料站（月份={self.month or '全部'}，"
                          f"门店={self.store or '全部'}，无头={self.headless}）")
                browser = self._launch(pw)
                page = browser.new_page(accept_downloads=True)
                try:
                    self._drive(page, conn)
                finally:
                    browser.close()
            db.finish_run(conn, self.run_id, "done", self.stats)
            self._log(conn, "done",
                      f"领取完成：共发现 {self.stats['total_seen']} 条，"
                      f"下载 {self.stats['downloaded']} 条，"
                      f"跳过 {self.stats['skipped']} 条，"
                      f"失败 {self.stats['errors']} 条")
        except Exception as exc:  # noqa: BLE001 - 任何失败都要落库并展示
            self.stats["errors"] += 1
            self._log(conn, "error", f"领取中断：{type(exc).__name__}: {exc}")
            db.finish_run(conn, self.run_id, "failed", self.stats)
        finally:
            conn.close()
        return self.stats

    # ---------- 页面驱动 ----------

    def _drive(self, page, conn) -> None:
        # 1. 打开资料站，在页面上选择月份/门店并点击查询（真实表单操作）
        page.goto(f"{self.base_url}/portal/", wait_until="networkidle")
        if self.month:
            page.select_option("select#month", self.month)
        if self.store:
            page.select_option("select#store", self.store)
        page.click("button[type=submit]")
        page.wait_for_load_state("networkidle")

        page_no = 1
        while True:
            total_pages = int(page.get_attribute("#page-info", "data-total-pages") or "1")
            rows = page.locator("tr[data-doc-no]")
            count = rows.count()
            self._log(conn, "page", f"浏览第 {page_no}/{total_pages} 页，本页 {count} 条报表")

            # 2. 逐条处理本页报表：已入库则跳过，否则点击页面上的下载按钮
            for i in range(count):
                self._handle_row(page, rows.nth(i), conn)

            if page_no >= total_pages:
                break
            page.click("a.next-page")
            page.wait_for_load_state("networkidle")
            page_no += 1

    def _handle_row(self, page, row, conn) -> None:
        doc_no = row.get_attribute("data-doc-no")
        version = row.get_attribute("data-version")
        filename = row.get_attribute("data-filename")
        self.stats["total_seen"] += 1

        existing = db.inbox_has(conn, doc_no, version)
        if existing is not None:
            self.stats["skipped"] += 1
            self._log(conn, "skip",
                      f"已存在相同资料编号+版本，跳过下载（入库记录 #{existing['id']}）",
                      doc_no, version)
            return

        report = db.get_report(conn, doc_no, version)
        # 3. 点击该行的“下载附件”按钮，捕获浏览器真实下载事件
        try:
            with page.expect_download(timeout=30000) as dl_info:
                row.locator("a.download-btn").click()
            download = dl_info.value

            stored = (
                config.INBOX_DIR
                / report["store_code"]
                / report["month"]
                / doc_no
                / version
                / filename
            )
            stored.parent.mkdir(parents=True, exist_ok=True)
            download.save_as(str(stored))

            size = stored.stat().st_size
            sha = _sha256(stored)
            if sha != report["source_sha"]:
                self.stats["errors"] += 1
                self._log(conn, "error",
                          "下载文件校验失败：SHA256 与资料站原件不一致，已删除残留文件",
                          doc_no, version)
                stored.unlink(missing_ok=True)
                return

            try:
                db.insert_inbox(conn, {
                    "doc_no": doc_no,
                    "version": version,
                    "month": report["month"],
                    "store_code": report["store_code"],
                    "store_name": report["store_name"],
                    "title": report["title"],
                    "filename": filename,
                    "stored_path": str(stored.relative_to(config.INBOX_DIR.parent.parent)),
                    "file_size": size,
                    "file_sha": sha,
                    "is_current": report["is_current"],
                    "source_url": f"/portal/download/{doc_no}/{version}",
                    "received_at": db.now_str(),
                })
                conn.commit()
            except sqlite3.IntegrityError:
                # 并发领取同一版本时另一任务已入库：按跳过处理
                conn.rollback()
                self.stats["skipped"] += 1
                self._log(conn, "skip",
                          "下载完成但入库时发现该版本已被其他任务领取，按跳过处理",
                          doc_no, version)
                return
            self.stats["downloaded"] += 1
            self._log(conn, "download",
                      f"已下载并归档：{stored.relative_to(config.INBOX_DIR)}（{size} 字节，校验通过）",
                      doc_no, version)
        except Exception as exc:  # noqa: BLE001
            self.stats["errors"] += 1
            self._log(conn, "error",
                      f"下载失败：{type(exc).__name__}: {exc}", doc_no, version)


def start_harvest(month: str, store: str, headless: bool | None = None) -> int:
    """创建领取任务并在后台线程中跑浏览器自动化，返回 run_id。"""
    conn = db.get_conn()
    try:
        run_id = db.create_run(conn, month, store)
    finally:
        conn.close()

    worker = HarvestWorker(run_id, month, store, headless=headless)
    threading.Thread(target=worker.run, name=f"harvest-{run_id}", daemon=True).start()
    return run_id
