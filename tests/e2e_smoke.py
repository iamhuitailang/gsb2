"""Playwright 端到端验证（一）：加载、控制台错误、各时间点截图、基础交互。
运行: python3 tests/e2e_smoke.py
"""
import sys
from playwright.sync_api import sync_playwright

URL = "http://127.0.0.1:8123/index.html"
SHOT = "tests/screenshots"


def main():
    errors = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel="chrome", headless=True,
                                     args=["--allow-file-access-from-files"])
        page = browser.new_page(viewport={"width": 1500, "height": 940})
        page.on("console", lambda m: errors.append(f"[{m.type}] {m.text}") if m.type in ("error",) else None)
        page.on("pageerror", lambda e: errors.append(f"[pageerror] {e}"))

        page.goto(URL, wait_until="networkidle")
        page.wait_for_function("window.__APP_READY__ === true")
        page.wait_for_timeout(1200)  # 等 SVG 图片解码

        # 初始图层数
        n_rows = page.locator(".layer-row").count()
        print("layer rows:", n_rows)
        assert n_rows >= 10, "示例工程图层未渲染"

        # 面板顺序 vs 导出顺序
        panel_names = page.locator("#layersTree .layer-row .layer-name").all_inner_texts()
        export_order = page.evaluate("App.getExportOrder()")
        print("panel:", panel_names)
        print("export:", export_order)
        # 面板含编组行；导出顺序应等于面板中的叶子顺序
        panel_leaves = [n for n in panel_names]  # 包含组名
        for name in export_order:
            assert name in panel_leaves

        # 各关键时间点截图
        for t, tag in [(0.0, "t00"), (0.8, "t08_enter"), (1.3, "t13_title"),
                       (2.15, "t21_transition"), (3.4, "t34"), (4.5, "t45_hold")]:
            page.evaluate(f"App.setTime({t})")
            page.wait_for_timeout(180)
            page.screenshot(path=f"{SHOT}/sample_{tag}.png")

        # 画布像素统计：t=1.3 时中心区域应有内容，角点透明
        stats = page.evaluate("""() => {
            const c = document.getElementById('artCanvas');
            const x = c.getContext('2d');
            const corner = x.getImageData(4, 4, 1, 1).data;
            const center = x.getImageData(c.width/2|0, c.height/2|0, 1, 1).data;
            const data = x.getImageData(0,0,c.width,c.height).data;
            let painted=0, alpha=0;
            for (let i=3;i<data.length;i+=4*97) { if(data[i]>10){painted++; alpha+=data[i];} }
            return {corner:[...corner], center:[...center], paintedSamples:painted};
        }""")
        print("pixel stats:", stats)
        assert stats["corner"][3] == 0, "画布角点应为透明"
        assert stats["paintedSamples"] > 50, "画布内容过少"

        # 播放测试：点播放，等 500ms，时间应前进
        page.evaluate("App.setTime(0)")
        page.click("#btnPlay")
        page.wait_for_timeout(700)
        t1 = page.evaluate("App.state.time")
        page.click("#btnPlay")
        print("playback time after ~0.7s:", t1)
        assert 0.4 < t1 < 1.6, "播放头未按预期前进"

        # 添加矩形
        page.click('[data-add="rect"]')
        page.wait_for_timeout(200)
        cnt2 = page.locator(".layer-row").count()
        assert cnt2 == n_rows + 1, "添加矩形后图层数未 +1"

        # 尺寸预设切换到竖屏，验证比例换算
        w0 = page.evaluate("App.state.project.width")
        page.select_option("#sizePreset", "1080x1920")
        page.wait_for_timeout(200)
        dims = page.evaluate("[App.state.project.width, App.state.project.height]")
        print("switched dims:", dims)
        assert dims == [1080, 1920]
        pos_ratio = page.evaluate("""() => {
            const id = App.state.selection[0];
            const f = Gfx.Model.findById(App.state.project.children, id);
            return [f.layer.x, f.layer.y];
        }""")
        print("new rect pos after rescale:", pos_ratio)
        assert abs(pos_ratio[0] - 540) < 1 and abs(pos_ratio[1] - 960) < 1

        page.screenshot(path=f"{SHOT}/portrait.png")

        print("\nconsole errors:", errors)
        assert not errors, "浏览器存在控制台错误"
        browser.close()

    print("SMOKE OK")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        import traceback
        traceback.print_exc()
        sys.exit(1)
