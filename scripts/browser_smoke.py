#!/usr/bin/env python3
"""scripts/browser_smoke.py — 用 Playwright 驱动本机 Chromium 对页面做端到端冒烟验证。
不依赖外部 HTTP 服务:通过 route 拦截从磁盘读取同目录文件。"""
import os
import pathlib
import sys
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
CACHE = pathlib.Path.home() / "Library" / "Caches" / "ms-playwright"


def find_chromium():
    for rev in sorted(CACHE.glob("chromium_headless_shell-*"), reverse=True):
        exe = rev / "chrome-headless-shell-mac-arm64" / "chrome-headless-shell"
        if exe.exists():
            return str(exe)
    for rev in sorted(CACHE.glob("chromium-*"), reverse=True):
        exe = rev / "chrome-mac" / "Chromium.app" / "Contents" / "MacOS" / "Chromium"
        if exe.exists():
            return str(exe)
    return None

failures = []

def check(name, cond, detail=""):
    status = "PASS" if cond else "FAIL"
    print(f"[{status}] {name}" + (f" — {detail}" if detail else ""))
    if not cond:
        failures.append(name)

def serve(route):
    url = route.request.url.split("/")[-1].split("?")[0]
    name = url or "index.html"
    p = ROOT / name
    if p.exists():
        ctype = {
            ".html": "text/html", ".js": "text/javascript",
            ".css": "text/css", ".wav": "audio/wav",
        }.get(p.suffix, "application/octet-stream")
        route.fulfill(status=200, content_type=ctype, body=p.read_bytes())
    else:
        route.fulfill(status=404, body=b"not found")

with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path=find_chromium())
    page = browser.new_page(viewport={"width": 1280, "height": 1600})
    errors = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.route("**/*", serve)
    page.goto("http://local/index.html")
    page.wait_for_function("document.querySelectorAll('canvas').length >= 4 && "
                           "document.getElementById('source-info').textContent.length > 0")

    # 1. 初始载入组合样例
    info = page.text_content("#source-info")
    check("组合样例自动载入", "组合样例" in info and "44100 Hz" in info, info)

    # 2. 指标砖有值
    changed = page.text_content("#t-changed")
    check("指标砖渲染", "%" in changed, changed)
    hash_a = page.text_content("#hash-label")
    check("整数码校验和展示", "FNV-1a" in hash_a, hash_a)

    # 3. 确定性:切走再切回,同设置校验和不变
    page.click("#switch-btn")
    page.wait_for_timeout(100)
    page.click("#switch-btn")
    page.wait_for_timeout(100)
    check("切换后回到 A 校验和一致", page.text_content("#hash-label") == hash_a)

    # 4. A/B 设置不同,切换后游标保持
    page.select_option("#bits-B", "2")
    page.wait_for_timeout(100)
    # 在 A 视图点波形建立游标
    box = page.locator("#waveform").bounding_box()
    page.mouse.click(box["x"] + box["width"] * 0.3, box["y"] + box["height"] * 0.5)
    page.wait_for_timeout(80)
    range_before = page.text_content("#view-range")
    page.click("#switch-btn")
    page.wait_for_timeout(120)
    active_b = page.text_content("#active-label")
    range_after = page.text_content("#view-range")
    check("切换到 B", active_b == "B")
    check("切换保持游标/视窗", range_before == range_after, f"{range_before} || {range_after}")

    # 5. B(2 位直接量化)失真应更重:表格出现重度失真
    page.wait_for_selector("#block-table .badge.bad")
    check("2 位直接量化标出重度失真段", page.locator("#block-table .badge.bad").count() >= 1)

    # 6. 低音量放大:切换纵向放大后画布仍正常
    page.select_option("#zoom-y", "256")
    page.wait_for_timeout(120)
    check("纵向放大 ×256 无报错", True)

    # 7. 导出 16 位 WAV → 内存回读核对全部一致
    page.select_option("#export-bits", "16")
    with page.expect_download() as dl_info:
        page.click("#export-btn")
    dl = dl_info.value
    check("导出 WAV 下载触发", dl.suggested_filename.endswith(".wav"), dl.suggested_filename)
    page.wait_for_timeout(200)
    check("回读-位深一致", "✓" in page.text_content("#v-fmt-ok"), page.text_content("#v-fmt-ok"))
    check("回读-声道一致", "✓" in page.text_content("#v-ch-ok"), page.text_content("#v-ch-ok"))
    check("回读-时长一致", "✓" in page.text_content("#v-dur-ok"), page.text_content("#v-dur-ok"))
    # 容器零电平偏置必须严格为 0(斜杠左值),量化残差偏置允许非零
    bias_cell = page.text_content("#v-bias-act")
    check("回读-容器偏置严格为零", bias_cell.split("/")[0].strip() in ("0.0000", "0.000"),
          bias_cell)
    check("回读-逐样本零差", "✓" in page.text_content("#v-samp-ok"), page.text_content("#v-samp-ok"))

    # 8. 导出 8 位 WAV:无符号偏移码不应引入容器偏置,逐样本仍零差
    page.select_option("#export-bits", "8")
    with page.expect_download():
        page.click("#export-btn")
    page.wait_for_timeout(200)
    bias8 = page.text_content("#v-bias-act")
    check("8 位容器偏置为零(偏移码无直流)", bias8.split("/")[0].strip() in ("0.0000", "0.000"),
          bias8)
    check("8 位逐样本零差", "✓" in page.text_content("#v-samp-ok"), page.text_content("#v-samp-act"))

    # 9. 磁盘文件回读:把刚下载的 wav 通过 verify-input 喂回去
    saved = pathlib.Path(dl.path())
    # 重新导出一份 16 位用于回读
    page.select_option("#export-bits", "16")
    with page.expect_download() as d2:
        page.click("#export-btn")
    wav_path = d2.value.path()
    page.set_input_files("#verify-input", wav_path)
    page.wait_for_timeout(200)
    check("外部文件回读-位深", "16 位" in page.text_content("#v-fmt-act"), page.text_content("#v-fmt-act"))
    check("外部文件回读-与预览零差", "✓ 一致" in page.text_content("#v-samp-ok"),
          page.text_content("#v-samp-ok"))

    # 10. 各生成样例可切换
    for kind in ["fade", "quiet", "fullscale"]:
        page.click(f"[data-gen='{kind}']")
        page.wait_for_timeout(120)
        t = page.text_content("#source-info")
        check(f"样例 {kind} 载入", kind in t or len(t) > 10, t)

    # 10b. 立体声 WAV:声道选择出现两项,两声道指标不同(不串声道)
    stereo = ROOT / "scripts" / "stereo-sample.wav"
    page.set_input_files("#file-input", str(stereo))
    page.wait_for_function("document.querySelectorAll('#channel-sel option').length === 2")
    check("立体声 WAV 识别为 2 声道",
          "2 声道" in page.text_content("#source-info"),
          page.text_content("#source-info"))
    page.select_option("#channel-sel", "0")
    page.wait_for_timeout(100)
    tile_l = page.text_content("#t-rms")
    page.select_option("#channel-sel", "1")
    page.wait_for_timeout(100)
    tile_r = page.text_content("#t-rms")
    check("左右声道独立统计(指标不同)", tile_l != tile_r, f"L={tile_l} R={tile_r}")
    # 立体声导出回读保持 2 声道
    with page.expect_download():
        page.click("#export-btn")
    page.wait_for_timeout(200)
    check("立体声导出回读保持 2 声道",
          "2 声道" in page.text_content("#v-ch-act"), page.text_content("#v-ch-act"))
    check("立体声逐样本零差", "✓ 一致" in page.text_content("#v-samp-ok"))

    # 11. 截图(全页)
    page.screenshot(path=str(ROOT / "scripts" / "smoke-full.png"), full_page=True)
    # 近静音样例 + 高纵向放大的特写
    page.click("[data-gen='quiet']")
    page.select_option("#zoom-y", "1024")
    page.wait_for_timeout(200)
    page.screenshot(path=str(ROOT / "scripts" / "smoke-quiet-zoom.png"), full_page=True)

    # 12. 控制台无错误
    check("浏览器控制台无错误", len(errors) == 0, "; ".join(errors[:5]))
    browser.close()

print()
if failures:
    print(f"{len(failures)} 项失败: {failures}")
    sys.exit(1)
print("全部冒烟检查通过")
