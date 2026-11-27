#!/usr/bin/env python3
"""scripts/screenshots.py — 截关键场景图,供人工核对视觉效果。"""
import pathlib
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
CACHE = pathlib.Path.home() / "Library" / "Caches" / "ms-playwright"


def find_chromium():
    for rev in sorted(CACHE.glob("chromium_headless_shell-*"), reverse=True):
        exe = rev / "chrome-headless-shell-mac-arm64" / "chrome-headless-shell"
        if exe.exists():
            return str(exe)
    raise RuntimeError("no chromium found")


def serve(route):
    name = route.request.url.split("/")[-1].split("?")[0] or "index.html"
    p = ROOT / name
    if p.exists():
        ctype = {".html": "text/html", ".js": "text/javascript",
                 ".css": "text/css"}.get(p.suffix, "application/octet-stream")
        route.fulfill(status=200, content_type=ctype, body=p.read_bytes())
    else:
        route.fulfill(status=404)


with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path=find_chromium())
    page = browser.new_page(viewport={"width": 1280, "height": 1500})
    page.route("**/*", serve)
    page.goto("http://local/index.html")
    page.wait_for_selector("#source-info:not(:empty)")

    # 场景 1:组合样例 + B(2 位直接量化),全片视图,展示分段与失真色带
    page.click("[data-gen='combo']")
    page.select_option("#bits-B", "2")
    page.select_option("#mode-B", "off")
    page.click("#switch-btn")  # 切到 B
    page.select_option("#zoom-y", "1")
    page.wait_for_timeout(200)
    page.screenshot(path=str(ROOT / "scripts/shot-combo-2bit.png"), full_page=True)

    # 场景 2:A(4 位 TPDF)同样组合样例,对照扰动效果
    page.click("#switch-btn")  # 回 A
    page.wait_for_timeout(200)
    page.screenshot(path=str(ROOT / "scripts/shot-combo-dither.png"), full_page=True)

    # 场景 3:渐弱音 + 1 位直接量化,放大尾部看“尾音被吃掉”
    page.select_option("#bits-A", "1")
    page.select_option("#mode-A", "off")
    page.click("[data-gen='fade']")
    page.wait_for_timeout(200)
    # 跳到最后 0.6 秒
    page.evaluate("""() => {
      const n = document.querySelector('#waveform');
    }""")
    # 用表格最后一行跳转
    rows = page.locator("#block-table tbody tr")
    rows.nth(rows.count() - 1).click()
    page.select_option("#zoom-y", "256")
    page.wait_for_timeout(200)
    page.screenshot(path=str(ROOT / "scripts/shot-fade-1bit-tail.png"), full_page=True)

    # 场景 4:同一渐弱音切到 TPDF 1 位,尾音以噪声形式保留
    page.select_option("#mode-A", "tpdf")
    page.wait_for_timeout(200)
    page.screenshot(path=str(ROOT / "scripts/shot-fade-1bit-dither.png"), full_page=True)

    browser.close()
print("screenshots written to scripts/")
