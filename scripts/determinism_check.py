#!/usr/bin/env python3
"""scripts/determinism_check.py — 需求3:扰动固定于一次试验,重做可比对。
同种子 → 校验和逐位一致;换种子 → 校验和变化;锁定取消后重算行为受控。"""
import pathlib
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
CACHE = pathlib.Path.home() / "Library" / "Caches" / "ms-playwright"
fails = []

def check(name, cond, detail=""):
    print(f"[{'PASS' if cond else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not cond:
        fails.append(name)

def find_chromium():
    for rev in sorted(CACHE.glob("chromium_headless_shell-*"), reverse=True):
        exe = rev / "chrome-headless-shell-mac-arm64" / "chrome-headless-shell"
        if exe.exists():
            return str(exe)

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
    page = browser.new_page()
    page.route("**/*", serve)
    page.goto("http://local/index.html")
    page.wait_for_selector("#source-info:not(:empty)")

    # 用渐弱音 + A 侧 3 位 TPDF,记录校验和
    page.click("[data-gen='fade']")
    page.select_option("#bits-A", "3")
    page.select_option("#mode-A", "tpdf")
    page.wait_for_timeout(150)
    h1 = page.text_content("#hash-label")

    # 切换任何无关控件再切回,重算结果必须相同
    page.click("#switch-btn"); page.wait_for_timeout(80)
    page.click("#switch-btn"); page.wait_for_timeout(80)
    h2 = page.text_content("#hash-label")
    check("同设置重做校验和一致", h1 == h2, h1)

    # 重新载入同一信号、同设置,仍一致(种子写在控件里)
    page.click("[data-gen='fade']")
    page.wait_for_timeout(150)
    h3 = page.text_content("#hash-label")
    check("重新载入信号后同种子可复现", h1 == h3)

    # 换种子 → 校验和变化
    page.click("#reseed-A")
    page.wait_for_timeout(150)
    h4 = page.text_content("#hash-label")
    check("换种子产生不同试验", h1 != h4, f"{h1} => {h4}")

    # 手动改回原种子 → 恢复原校验和
    page.fill("#seed-A", "20261128")
    page.dispatch_event("#seed-A", "change")
    page.wait_for_timeout(150)
    h5 = page.text_content("#hash-label")
    check("填回原种子逐位恢复", h1 == h5)

    browser.close()

print()
print("全部通过" if not fails else f"失败:{fails}")
raise SystemExit(1 if fails else 0)
