"""用户路径验证：像真实用户一样在页面上操作，并截图留证。

流程：资料站查询/翻页 → 领取页发起自动领取 → 轮询过程 → 入库列表 → 详情预览 PDF。
用法：python scripts/verify_ui.py [--headed]
"""
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from playwright.sync_api import sync_playwright  # noqa: E402

from app import config  # noqa: E402

BASE = f"http://{config.HOST}:{config.PORT}"
SHOTS = ROOT / "data" / "screenshots"
HEADED = "--headed" in sys.argv


def shot(page, name: str) -> None:
    SHOTS.mkdir(parents=True, exist_ok=True)
    path = SHOTS / f"{name}.png"
    page.screenshot(path=str(path), full_page=True)
    print(f"  截图：{path.relative_to(ROOT)}")


def main() -> None:
    with sync_playwright() as pw:
        try:
            browser = pw.chromium.launch(channel="chrome", headless=not HEADED)
        except Exception:
            browser = pw.chromium.launch(headless=not HEADED)
        page = browser.new_page(accept_downloads=True, viewport={"width": 1280, "height": 900})

        print("[1] 资料站：筛选 2026-09 并翻页")
        page.goto(f"{BASE}/portal/", wait_until="networkidle")
        page.select_option("#month", "2026-09")
        page.click("button[type=submit]")
        page.wait_for_load_state("networkidle")
        assert page.locator("tr[data-doc-no]").count() == config.PAGE_SIZE
        shot(page, "01_portal_filtered")
        page.click("a.next-page")
        page.wait_for_load_state("networkidle")
        assert "第 2 / 2 页" in page.content()
        shot(page, "02_portal_page2")

        print("[2] 资料站：直接点下载按钮，验证浏览器真实下载")
        with page.expect_download() as info:
            page.locator("a.download-btn").first.click()
        download = info.value
        assert download.suggested_filename == "月报.pdf"
        print(f"  浏览器收到下载：{download.suggested_filename}")

        print("[3] 领取页：全量发起浏览器自动领取")
        page.goto(f"{BASE}/", wait_until="networkidle")
        shot(page, "03_inbox_before")
        page.click("button[type=submit]")
        page.wait_for_load_state("networkidle")
        assert "/harvest/runs/" in page.url

        print("[4] 等待领取完成，观察实时日志")
        for _ in range(90):
            state = page.evaluate(
                "document.getElementById('status-badge').textContent")
            if state in ("done", "failed"):
                break
            time.sleep(1)
        assert state == "done", f"领取未成功结束，状态={state}"
        body = page.inner_text("#stats")
        assert "已下载" in body and "8" in body
        shot(page, "04_harvest_run_log")

        print("[5] 入库列表：按门店查看，同名文件已分开")
        page.goto(f"{BASE}/", wait_until="networkidle")
        assert page.locator("table tr").count() >= 9  # 表头 + 8 条
        shot(page, "05_inbox_list")
        page.select_option("form[method=get] select[name=store]", "S01")
        page.wait_for_load_state("networkidle")
        text = page.inner_text("table")
        assert "望京店" in text and "三里屯店" not in text
        shot(page, "06_inbox_filtered_store")

        print("[6] 入库详情：打开实际下载的 PDF")
        page.goto(f"{BASE}/", wait_until="networkidle")
        page.locator("table a.btn.small", has_text="查看").first.click()
        page.wait_for_load_state("networkidle")
        assert "实际下载文件预览" in page.content()
        page.locator("iframe.pdf").wait_for()
        shot(page, "07_inbox_detail_pdf")

        print("[7] 再次发起同范围领取，应全部跳过")
        page.goto(f"{BASE}/", wait_until="networkidle")
        page.click("button[type=submit]")
        page.wait_for_load_state("networkidle")
        for _ in range(60):
            state = page.evaluate(
                "document.getElementById('status-badge').textContent")
            if state in ("done", "failed"):
                break
            time.sleep(1)
        assert state == "done"
        log_text = page.inner_text("#event-log")
        assert "跳过" in log_text and "已存在相同资料编号+版本" in log_text
        shot(page, "08_harvest_skipped")

        browser.close()
    print("\n全部 UI 验证通过 ✅")


if __name__ == "__main__":
    main()
