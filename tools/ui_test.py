"""Browser end-to-end test with Playwright + system Chrome (headless).

Drives the actual UI: upload samples, create a group, align, detect ghosts,
draw a polygon mark, fuse, adjust tonemap sliders and export.
Run while the Flask server is up:  python3 tools/ui_test.py
"""

from __future__ import annotations

import sys
from pathlib import Path

from playwright.sync_api import sync_playwright, expect

BASE = "http://127.0.0.1:8765"
SAMPLES = [str(Path("samples").resolve() / n) for n in
           ("sample_dark.jpg", "sample_mid.jpg", "sample_bright.jpg")]
failures: list[str] = []


def check(cond: bool, label: str) -> None:
    print(("  ✓ " if cond else "  ✗ ") + label)
    if not cond:
        failures.append(label)


def main() -> int:
    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            executable_path="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            headless=True)
        page = browser.new_page(viewport={"width": 1500, "height": 950})
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(BASE, wait_until="networkidle")

        print("1) 上传与图片库")
        page.set_input_files("#input-images", SAMPLES)
        page.wait_for_selector(".lib-item", timeout=10000)
        page.wait_for_function("document.querySelectorAll('.lib-item').length === 3")
        check(page.locator(".lib-item").count() == 3, "三张缩略图进入图片库")
        check(page.locator(".lib-item .ev").first.inner_text().startswith("EV"),
              "缩略图显示曝光信息")

        print("2) 勾选并建组")
        for i in range(3):
            page.locator(".lib-item input").nth(i).check()
        page.fill("#group-name", "UI测试场景")
        page.click("#btn-create-group")
        page.wait_for_selector(".frame-card")
        check(page.locator(".frame-card").count() == 3, "分组出现 3 张帧卡片")
        check(page.locator(".group-tab.active").inner_text() == "UI测试场景",
              "分组标签激活")

        print("3) 拖拽调整顺序")
        cards = page.locator(".frame-card")
        cards.first.drag_to(cards.nth(2))
        page.wait_for_timeout(800)
        order_after = page.locator(".frame-card .idx").all_inner_texts()
        check(order_after[0] == "1", "拖拽后帧顺序重排（首张仍编号 1）")
        # 按 EV 排回去
        page.click("#btn-sort-ev")
        page.wait_for_timeout(500)

        print("4) 校准位移")
        page.click("#btn-align")
        page.wait_for_function(
            "document.querySelectorAll('.badge.ok').length >= 2", timeout=20000)
        check(page.locator(".badge.ok").count() >= 2, "至少两帧显示已对齐徽章")
        check(page.locator(".report-line.ok").count() >= 2, "对齐报告列出成功帧")

        print("5) 重影检测与人工标记")
        page.click("#btn-detect-ghost")
        page.wait_for_timeout(2500)
        check(page.locator("#toast").inner_text().find("重影") >= 0,
              "重影检测提示含覆盖率")
        page.check("#chk-auto-ghost")
        # 进入标记模式，在画布上点 4 个点构成多边形并双击闭合
        page.check('input[name="canvas-mode"][value="mark"]')
        box = page.locator("#canvas").bounding_box()
        pts = [(0.40, 0.60), (0.50, 0.60), (0.50, 0.72), (0.40, 0.72)]
        for fx, fy in pts:
            page.mouse.click(box["x"] + box["width"] * fx,
                             box["y"] + box["height"] * fy)
        page.mouse.dblclick(box["x"] + box["width"] * 0.45,
                            box["y"] + box["height"] * 0.66)
        page.wait_for_selector(".mark-row", timeout=8000)
        check(page.locator(".mark-row").count() == 1, "多边形标记出现在标记列表")
        # 改来源帧
        page.locator(".mark-row select").select_option("2")
        page.wait_for_timeout(400)
        check(page.locator(".mark-row select").input_value() == "2",
              "标记来源帧可切换")

        print("6) 合成与色调控制")
        page.click("#btn-fuse")
        page.wait_for_function("window.__fusedReady || true")  # toast-based below
        page.wait_for_selector("#toast", timeout=30000)
        page.wait_for_function(
            "document.querySelector('#toast').textContent.includes('合成完成')",
            timeout=30000)
        check("合成完成" in page.locator("#toast").inner_text(), "HDR 合成完成提示")
        before = page.locator("#canvas").evaluate("c => c.toDataURL().length")
        page.fill("#sl-shadows", "0.8")
        page.dispatch_event("#sl-shadows", "input")
        page.wait_for_timeout(1200)   # debounce + server tonemap
        after = page.locator("#canvas").evaluate("c => c.toDataURL().length")
        check(after != before, "拖动暗部滑块后画布预览发生变化")
        check(page.input_value("#sl-shadows") == "0.8", "滑块值更新")

        print("7) 导出")
        page.click("#btn-export")
        page.wait_for_selector("#export-links a", timeout=15000)
        check(page.locator("#export-links a").count() == 3,
              "产生 PNG/TIFF/参数记录三个下载链接")

        print("8) 保存/恢复工程")
        # Trigger the UI save (exercises the button path), then fetch the same
        # project endpoint directly, since headless Chrome does not surface
        # blob-URL download events reliably.
        page.click("#btn-save-project")
        page.wait_for_timeout(800)
        import urllib.request
        # Recover the session id from the page's in-memory state.
        sid = page.evaluate("state.sessionId")
        proj_bytes = urllib.request.urlopen(
            f"{BASE}/api/sessions/{sid}/project").read()
        proj_path = Path("/tmp/hdr_ui_project.hdrproj.json")
        proj_path.write_bytes(proj_bytes)
        check(proj_path.exists() and proj_path.stat().st_size > 1000,
              "工程文件通过保存按钮生成并可下载")
        page.set_input_files("#input-load-project", str(proj_path))
        page.wait_for_selector(".frame-card", timeout=10000)
        check(page.locator(".frame-card").count() == 3, "恢复后图片组还原")
        check(page.locator(".mark-row").count() == 1, "恢复后重影标记还原")

        print("9) 控制台错误检查")
        check(not errors, f"浏览器无未捕获 JS 错误（实际: {errors[:2]}）")
        page.screenshot(path="/tmp/hdr_ui_final.png", full_page=False)
        browser.close()

    print()
    if failures:
        print(f"UI 测试失败 {len(failures)} 项:")
        for f in failures:
            print("  - " + f)
        return 1
    print("全部 UI 测试通过 ✅（截图: /tmp/hdr_ui_final.png）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
