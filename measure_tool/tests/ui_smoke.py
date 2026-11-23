"""用 Playwright 驱动真实浏览器验证前端交互（临时脚本，不放进包）。"""
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

OUT = Path(__file__).resolve().parent.parent / "output"


def main() -> int:
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            executable_path="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            args=["--no-sandbox"],
        )
        page = browser.new_page(viewport={"width": 1500, "height": 950})
        errors = []
        page.on("pageerror", lambda e: errors.append(f"PAGEERROR: {e}"))
        page.on("console", lambda m: errors.append(f"CONSOLE.{m.type}: {m.text}")
                if m.type == "error" else None)

        page.goto("http://127.0.0.1:8765/", wait_until="networkidle")

        # 1. 加载演示 A
        page.click('[data-demo="a"]')
        page.wait_for_function("state.imageId !== null", timeout=8000)
        page.wait_for_selector("#canvas")
        page.wait_for_timeout(800)

        # 2. 一键标定
        page.click("#btn-demo-calib")
        page.wait_for_function("state.calib !== null", timeout=8000)
        quality = page.inner_text("#calib-quality")
        assert "mm/px" in quality, quality

        # 3. 触发分析（调一次阈值滑块）
        page.fill("#threshold", "128")
        page.dispatch_event("#threshold", "input")
        page.wait_for_function("state.analysis !== null", timeout=8000)
        page.wait_for_function("state.components.length > 0", timeout=8000)
        counts = page.inner_text("#seg-counts")

        # 4. 点击矩形板（用包围盒中心，经 displayScale 换算）
        clicked = page.evaluate("""() => {
            const comp = state.components.find(c =>
                c.kind === 'outer' && c.bbox[2] > 200);
            if (!comp) return null;
            const [x, y, w, h] = comp.bbox;
            const cx = x + w / 2, cy = y + h / 2;
            const r = document.getElementById('canvas').getBoundingClientRect();
            return { x: r.left + cx * state.displayScale,
                     y: r.top + cy * state.displayScale, id: comp.comp_id };
        }""")
        assert clicked, "未找到可点击的零件"
        page.mouse.click(clicked["x"], clicked["y"])
        page.wait_for_function(
            "Object.keys(state.measurements).length > 0", timeout=8000)
        page.wait_for_timeout(500)
        measure_text = page.inner_text("#measurement")

        page.screenshot(path=str(OUT / "ui_measurement.png"), full_page=False)

        # 5. 快照 + 调阈值 + 对比
        page.on("dialog", lambda d: d.accept("快照A"))
        page.click("#btn-snapshot")
        page.wait_for_function("state.snapshots.length >= 1", timeout=8000)
        page.fill("#threshold", "200")
        page.dispatch_event("#threshold", "input")
        page.wait_for_timeout(600)
        page.on("dialog", lambda d: d.accept("当前"))
        page.click("#btn-diff")
        page.wait_for_selector("#diff-panel:not(.hidden)", timeout=8000)
        diff_text = page.inner_text("#diff-content")
        page.screenshot(path=str(OUT / "ui_diff.png"), full_page=False)

        browser.close()

    print("seg counts:", counts)
    print("measurement has 外宽:", "外宽" in measure_text,
          "| 含孔口径说明:", "含孔" in measure_text,
          "| 填充面积:", "实际填充面积" in measure_text)
    print("diff panel has 孔去向:", ("孔" in diff_text and ("仍作为单独的孔" in diff_text or "零件" in diff_text)))
    if errors:
        print("BROWSER ERRORS:")
        for e in errors:
            print(" ", e)
        return 1
    print("NO BROWSER ERRORS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
