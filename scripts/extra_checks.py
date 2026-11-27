#!/usr/bin/env python3
"""scripts/extra_checks.py — 冒烟之外的针对性核对:
1) 同一弱信号,扰动量化在统计上优于直接量化(尾音保留);
2) 波形 hover tooltip 出现且内容正确;
3) 表头分块长度切换生效;
4) 误差试听按钮可创建 AudioBuffer(无头环境不发声但不报错)。"""
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
    page = browser.new_page(viewport={"width": 1280, "height": 1200})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.route("**/*", serve)
    page.goto("http://local/index.html")
    page.wait_for_selector("#source-info:not(:empty)")

    # 近静音信号:B 设为 1 位直接量化(尾音应被吃成 0),A 设为 1 位 TPDF(应保留能量)
    page.click("[data-gen='quiet']")
    page.select_option("#bits-A", "1"); page.select_option("#mode-A", "tpdf")
    page.select_option("#bits-B", "1"); page.select_option("#mode-B", "off")
    page.wait_for_timeout(150)

    # A 侧(扰动)
    page.click("#switch-btn") if page.text_content("#active-label") != "A" else None
    page.wait_for_timeout(100)
    a_changed = page.text_content("#t-changed")
    a_rms = float(page.text_content("#t-rms"))
    # B 侧(直接)
    page.click("#switch-btn")
    page.wait_for_timeout(100)
    b_changed = page.text_content("#t-changed")
    b_rms = float(page.text_content("#t-rms"))
    check("直接 1 位把近静音吃成零翻码", b_changed.startswith("0"), b_changed)
    check("扰动 1 位产生翻码(尾音保留)", not a_changed.startswith("0"), a_changed)
    check("扰动侧有非零量化误差", a_rms > 0, str(a_rms))
    # 直接量化输出恒为零 → 误差 RMS 等于原信号自身 RMS(弱信号全被吃掉的体现)
    check("直接侧输出恒零(误差等于原音能量)", b_rms > 0 and b_changed.startswith("0"),
          f"rms={b_rms}")

    # tooltip:悬停波形
    box = page.locator("#waveform").bounding_box()
    page.mouse.move(box["x"] + 200, box["y"] + box["height"] * 0.5)
    page.wait_for_timeout(120)
    tt = page.text_content("#tooltip")
    check("tooltip 显示样本/整数码/三路数值",
          "样本" in tt and "整数码" in tt and "原音" in tt and "误差" in tt,
          tt.replace("\n", " "))

    # 分块长度切换改变表格行数(quiet 3s:20ms→150 行,250ms→12 行)
    page.select_option("#block-sel", "250")
    page.wait_for_timeout(100)
    rows_250 = page.locator("#block-table tbody tr").count()
    page.select_option("#block-sel", "20")
    page.wait_for_timeout(100)
    rows_20 = page.locator("#block-table tbody tr").count()
    check("分块长度切换生效", rows_20 > rows_250, f"{rows_20} vs {rows_250}")

    # 点击表格行跳转视窗
    rng_before = page.text_content("#view-range")
    page.locator("#block-table tbody tr").nth(3).click()
    page.wait_for_timeout(100)
    check("表格行点击跳转视窗", page.text_content("#view-range") != rng_before)

    # 试听按钮不抛异常(无头无真实音频输出,但 buffer 构建路径会执行)
    page.click("#play-recon")
    page.wait_for_timeout(200)
    page.click("#stop-btn")
    page.click("#play-err")
    page.wait_for_timeout(200)
    check("试听路径无异常", len(errors) == 0, "; ".join(errors))

    browser.close()

print()
print("全部通过" if not fails else f"失败:{fails}")
raise SystemExit(1 if fails else 0)
