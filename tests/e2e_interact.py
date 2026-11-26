"""Playwright E2E（三）：真实交互链路验证 + 关键面板截图。"""
import sys
from playwright.sync_api import sync_playwright

URL = "http://127.0.0.1:8123/index.html"
SHOT = "tests/screenshots"


def main():
    errors = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel="chrome", headless=True)
        page = browser.new_page(viewport={"width": 1500, "height": 940})
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" and "favicon" not in m.text else None)
        page.goto(URL, wait_until="networkidle")
        page.wait_for_function("window.__APP_READY__ === true")
        page.wait_for_timeout(900)

        # ---------- 选中“强调条”矩形，检查器截图（验证重复标签修复） ----------
        page.locator(".layer-row", has_text="强调条").first.click()
        page.wait_for_timeout(250)
        page.screenshot(path=f"{SHOT}/inspector_rect.png")
        # 不应出现被挤压成竖排的重复“圆角”标签：num-field 内不应有“圆角”tag
        dup = page.evaluate("""() => {
            const tags = [...document.querySelectorAll('.num-field .tag')].map(e=>e.textContent.trim());
            return tags.filter(t => t.includes('圆角') || t.includes('描边') || t.includes('模糊')).length;
        }""")
        assert dup == 0, "数字框内仍有重复中文标签"

        # ---------- 文字图层检查器 ----------
        page.locator(".layer-row", has_text="主标题").first.click()
        page.wait_for_timeout(200)
        page.screenshot(path=f"{SHOT}/inspector_text.png")
        assert page.locator("textarea").first.is_visible()

        # ---------- 关键帧：在 1.0s 给透明度打点并改值 ----------
        page.evaluate("App.setTime(1.0)")
        page.wait_for_timeout(100)
        page.click('button[aria-label="opacity 关键帧开关"]')
        page.wait_for_timeout(200)
        # 此时 1.0s 应有关键帧；拖动透明度 slider 到 42
        op = page.locator('.insp-row:has(label.field-label:text("透明度")) input[type=range]')
        op.fill("42")
        op.dispatch_event("input")
        page.wait_for_timeout(100)
        op.evaluate("el => el.blur()")
        page.wait_for_timeout(300)
        val = page.evaluate("""() => {
            const id = App.state.selection[0];
            const l = Gfx.Model.findById(App.state.project.children, id).layer;
            const k = Gfx.Model.kfAt(l.keys.opacity, 1.0, 30);
            return k >= 0 ? l.keys.opacity[k].v : null;
        }""")
        print("opacity kf value @1s:", val)
        assert val is not None and abs(val - 42) < 1

        # ---------- 选中一个已有关键帧，改缓动 ----------
        # 主标题 opacity 原本有 0.25/0.8 两个关键帧；点时间线上 0.25s 附近的菱形
        dia = page.locator(".kf-diamond").first
        box = dia.bounding_box()
        page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
        page.wait_for_timeout(250)
        page.screenshot(path=f"{SHOT}/kf_editor.png")
        assert page.locator(".kf-editor select").count() >= 1, "关键帧编辑器未出现缓动下拉"
        page.select_option(".kf-editor select", "easeOutBack")
        page.wait_for_timeout(150)
        ease = page.evaluate("App.state.selectedKey")
        ease_val = page.evaluate("""(sk) => {
            const l = Gfx.Model.findById(App.state.project.children, sk.layerId).layer;
            return l.keys[sk.prop].find(k=>k.id===sk.kfId).ease;
        }""", ease)
        print("easing after select:", ease_val)
        assert ease_val == "easeOutBack"

        # ---------- 时间线拖拽关键帧改时间 ----------
        before = page.evaluate("""(sk) => {
            const l = Gfx.Model.findById(App.state.project.children, sk.layerId).layer;
            return l.keys[sk.prop].find(k=>k.id===sk.kfId).t;
        }""", ease)
        d = page.locator(f'.kf-diamond[data-kf-id="{ease["kfId"]}"]')
        b = d.bounding_box()
        page.mouse.move(b["x"] + b["width"] / 2, b["y"] + b["height"] / 2)
        page.mouse.down()
        page.mouse.move(b["x"] + 90, b["y"] + b["height"] / 2, steps=8)
        page.mouse.up()
        page.wait_for_timeout(300)
        after = page.evaluate("""(sk) => {
            const l = Gfx.Model.findById(App.state.project.children, sk.layerId).layer;
            return l.keys[sk.prop].find(k=>k.id===sk.kfId).t;
        }""", ease)
        print(f"kf drag: {before:.3f} -> {after:.3f}")
        assert after > before + 0.4, "拖拽关键帧未显著改变时间"

        # ---------- 画布拖动移动新矩形（关闭自动关键帧，测静态 x/y） ----------
        page.check("#autoKey")  # already checked -> ensure? use uncheck
        page.uncheck("#autoKey")
        page.click('[data-add="rect"]')
        page.wait_for_timeout(200)
        page.evaluate("App.setTime(0.5)")
        rect_id = page.evaluate("App.state.selection[0]")
        cv = page.locator("#overlayCanvas").bounding_box()
        scale = cv["width"] / 1920
        # 新矩形默认在画布中心 960,540
        sx = cv["x"] + 960 * scale
        sy = cv["y"] + 540 * scale
        page.mouse.move(sx, sy)
        page.mouse.down()
        page.mouse.move(sx + 120 * scale, sy + 80 * scale, steps=10)
        page.mouse.up()
        page.wait_for_timeout(200)
        xy = page.evaluate("""(id) => {
            const l = Gfx.Model.findById(App.state.project.children, id).layer;
            return [l.x, l.y];
        }""", rect_id)
        print("rect after canvas drag:", xy)
        assert abs(xy[0] - 1080) < 6 and abs(xy[1] - 620) < 6, f"画布拖动位移不正确: {xy}"

        # ---------- 隐藏图层后导出顺序排除它 ----------
        order0 = page.evaluate("App.getExportOrder().length")
        # 点第一行（新矩形）的眼睛
        page.locator(".layer-row.selected .layer-flag").first.click()
        page.wait_for_timeout(200)
        order1 = page.evaluate("App.getExportOrder().length")
        print("export order visible count:", order0, "->", order1)
        assert order1 == order0 - 1

        # ---------- 锁定后画布拖不动 ----------
        page.locator(".layer-row.selected .layer-flag").nth(1).click()
        page.wait_for_timeout(200)
        xy0 = page.evaluate("""(id) => Gfx.Model.findById(App.state.project.children, id).layer.x""", rect_id)
        page.mouse.move(sx + 120 * scale, sy + 80 * scale)
        page.mouse.down()
        page.mouse.move(sx + 260 * scale, sy + 200 * scale, steps=6)
        page.mouse.up()
        page.wait_for_timeout(150)
        xy1 = page.evaluate("""(id) => Gfx.Model.findById(App.state.project.children, id).layer.x""", rect_id)
        assert xy1 == xy0, "锁定图层仍可被画布拖动"

        # ---------- 编组按钮 ----------
        page.keyboard.press("Escape")
        # 选两个普通图层后编组
        page.locator(".layer-row", has_text="星形左").first.click()
        page.keyboard.down("Meta")
        page.locator(".layer-row", has_text="星形右").first.click()
        page.keyboard.up("Meta")
        page.click("#btnGroup")
        page.wait_for_timeout(250)
        grp = page.evaluate("App.state.selection.length === 1 && Gfx.Model.findById(App.state.project.children, App.state.selection[0]).layer.type === 'group'")
        assert grp, "编组未生效"
        page.screenshot(path=f"{SHOT}/grouped.png")

        # ---------- 安全区/三分线开关不报错 ----------
        page.click("#btnSafe")
        page.click("#btnThirds")
        page.wait_for_timeout(150)
        page.click("#btnSafe")
        page.click("#btnThirds")

        print("console errors:", errors)
        assert not errors
        browser.close()
    print("\nINTERACT E2E OK")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        import traceback
        traceback.print_exc()
        sys.exit(1)
