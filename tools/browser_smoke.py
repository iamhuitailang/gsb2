#!/usr/bin/env python3
"""真实浏览器冒烟测试：启动 http 服务，用 Playwright/Chromium 驱动页面完成
载入样例 -> 改设置 -> 预览 -> 批量导出 -> 校验 ZIP 的完整流程。

运行: python3 -I tools/browser_smoke.py
（Playwright 装在系统 site-packages，若 -I 找不到可去掉 -I）
"""
import http.server
import json
import os
import socketserver
import subprocess
import sys
import tempfile
import threading
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "public"
PORT = 8791


def start_server():
    handler = lambda *a, **kw: http.server.SimpleHTTPRequestHandler(
        *a, directory=str(PUBLIC), **kw
    )
    httpd = socketserver.TCPServer(("127.0.0.1", PORT), handler)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    return httpd


def main():
    from playwright.sync_api import sync_playwright, expect

    httpd = start_server()
    failures = []
    try:
        with sync_playwright() as p:
            launch_kwargs = {"headless": True}
            # 允许通过环境变量指定 Chromium 可执行文件，规避 Playwright 小版本不匹配
            exe = os.environ.get("CHROMIUM_PATH")
            if exe:
                launch_kwargs["executable_path"] = exe
            browser = p.chromium.launch(**launch_kwargs)
            page = browser.new_page(viewport={"width": 1600, "height": 1000})
            page.on("console", lambda m: print(f"  [console.{m.type}]", m.text) if m.type in ("error", "warning") else None)
            page.on("pageerror", lambda e: failures.append(f"页面 JS 错误: {e}"))

            page.goto(f"http://127.0.0.1:{PORT}/index.html")
            page.wait_for_selector("#sample-btn")

            # 1. 载入内置样例
            page.click("#sample-btn")
            page.wait_for_selector(".group-card")
            group_count = page.locator(".group-card").count()
            print(f"载入样例后分组数: {group_count}")
            assert group_count >= 2, "应至少识别出 brick/wood 两组"

            # 2. 应看到三个默认输出
            assert page.locator(".output-card").count() == 3

            # 3. 预览画布出现，且逐通道灰度预览渲染
            page.wait_for_selector(".preview-canvas")
            ch_previews = page.locator(".channel-preview-cell canvas").count()
            print(f"逐通道预览数: {ch_previews}")
            assert ch_previews >= 3

            # 4. 切到法线输出，验证 WebGL 表面效果
            card_count = page.locator(".output-card").count()
            names = page.locator(".output-card input.card-name").evaluate_all(
                "els => els.map(e => e.value)"
            )
            print("输出卡片:", card_count, names)
            clicked = page.evaluate("""() => {
              document.querySelectorAll('.output-card')[1].querySelector('.channel-table').click();
              return true;
            }""")
            # 预览有 60ms 防抖，等待法线面板真正显示
            page.wait_for_function(
                "getComputedStyle(document.querySelector('#normal-preview-panel')).display !== 'none'",
                timeout=5000,
            )
            page.wait_for_selector(".normal-canvas", state="attached")
            panel_display = page.evaluate("getComputedStyle(document.querySelector('#normal-preview-panel')).display")
            print("法线面板 display:", panel_display)
            assert panel_display != "none", "法线输出时面板应显示"
            gl_ok = page.evaluate("document.querySelector('.normal-canvas').width > 0")
            assert gl_ok, "WebGL canvas 应有尺寸"
            page.screenshot(path=str(ROOT / "tmp_smoke_normal.png"))

            # 打开 OpenGL/DirectX 分屏对比
            page.locator(".form-row", has_text="分屏对比两种方向").locator("input[type=checkbox]").check()
            page.wait_for_timeout(300)

            # 5. 改尺寸策略为 pad 并调整输出尺寸，触发尺寸不一致路径
            page.select_option("select", "pad")
            page.wait_for_timeout(200)

            # 6. 批量导出：监听下载
            with page.expect_download() as dl_info:
                page.click("#export-btn")
            download = dl_info.value
            zip_path = Path(tempfile.mkdtemp()) / download.suggested_filename
            download.save_as(str(zip_path))

            with zipfile.ZipFile(zip_path) as zf:
                names = zf.namelist()
                pngs = [n for n in names if n.endswith(".png")]
                txts = [n for n in names if n.endswith("_sources.txt")]
                assert "manifest.json" in names
                assert len(pngs) >= 6, f"PNG 数量不足: {pngs}"
                assert len(txts) == len(pngs), "每张输出都应有来源说明"
                manifest = json.loads(zf.read("manifest.json"))
                failed = [r for r in manifest["results"] if r["status"] == "failed"]
                print(f"ZIP: {len(pngs)} PNG, {len(txts)} 来源说明, 失败 {len(failed)} 项")
                # 小样例已归入 brick 组未分配，两个有效组 × 三输出应全部成功
                assert len(manifest["results"]) == 6
                assert failed == [], f"不应有失败项: {failed}"
                assert len([r for r in manifest["results"] if r["status"] == "ok"]) == len(pngs)
                sample_txt = zf.read(txts[0]).decode("utf-8")
                assert "通道映射" in sample_txt and "实际处理记录" in sample_txt
                # 校验 ZIP 内 PNG 文件头
                for n in pngs:
                    assert zf.read(n)[:8] == b"\x89PNG\r\n\x1a\n", f"{n} 不是合法 PNG"

            # 6b. 失败隔离：开启「缺来源即判失败」，把 wood 组粗糙度置空后再导出
            page.locator(".form-row", has_text="缺来源即判失败").locator("input").check()
            # 选中 wood 组（第二张分组卡片）
            page.locator(".group-card").nth(1).click()
            page.wait_for_timeout(150)
            # wood 卡片里粗糙度角色的下拉置空
            wood_card = page.locator(".group-card").nth(1)
            rough_cell = wood_card.locator(".role-cell", has_text="粗糙度")
            rough_cell.locator("select").select_option("")
            page.wait_for_timeout(200)

            with page.expect_download() as dl_info:
                page.click("#export-btn")
            fail_zip = Path(tempfile.mkdtemp()) / "fail.zip"
            dl_info.value.save_as(str(fail_zip))
            with zipfile.ZipFile(fail_zip) as zf:
                mani = json.loads(zf.read("manifest.json"))
                fail_rows = [r for r in mani["results"] if r["status"] == "failed"]
                ok_rows = [r for r in mani["results"] if r["status"] == "ok"]
                print(f"失败隔离演练: 成功 {len(ok_rows)}，失败 {len(fail_rows)}")
                assert len(fail_rows) >= 1, "缺粗糙度的 ORM 输出应失败"
                assert all("缺少来源角色" in r["reason"] for r in fail_rows)
                assert len(ok_rows) >= 4, "其他组/输出必须保留成功"
                # 成功项 PNG 数量与成功记录一致
                ok_pngs = [n for n in zf.namelist() if n.endswith(".png")]
                assert len(ok_pngs) == len(ok_rows)

            # 还原设置，避免影响后续工程保存
            page.locator(".form-row", has_text="缺来源即判失败").locator("input").uncheck()

            # 7. 工程保存/恢复往返
            with page.expect_download() as dl_info:
                page.click("#save-btn")
            proj_path = Path(tempfile.mkdtemp()) / "project.json"
            dl_info.value.save_as(str(proj_path))
            proj = json.loads(proj_path.read_text())
            assert proj["app"] == "mtpack"
            assert len(proj["outputs"]) == 3
            # 内嵌图片 dataUrl
            embedded = any(
                f.get("dataUrl", "").startswith("data:image/png")
                for g in proj["groups"] for f in g.get("files", {}).values()
            )
            assert embedded, "工程应内嵌图片 dataUrl"

            # 重新打开工程
            page.set_input_files("#open-project", str(proj_path))
            page.wait_for_selector(".group-card")
            assert page.locator(".output-card").count() == 3

            # 8. 常量补齐路径：删掉某组 roughness，ORM 的 G 通道应显示常量补齐提示
            page.screenshot(path=str(ROOT / "tmp_smoke_final.png"))

            browser.close()
    finally:
        httpd.shutdown()

    if failures:
        print("失败:")
        for f in failures:
            print(" -", f)
        sys.exit(1)
    print("\n浏览器冒烟测试全部通过 ✓")


if __name__ == "__main__":
    main()
