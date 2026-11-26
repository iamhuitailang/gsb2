"""Playwright E2E（四）：撤销重做、图片本地导入、localStorage 刷新恢复。"""
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
URL = "http://127.0.0.1:8123/index.html"
IMG = str(ROOT / "assets" / "logo-badge.svg")


def main():
    errors = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel="chrome", headless=True)
        ctx = browser.new_context(viewport={"width": 1500, "height": 940})
        page = ctx.new_page()
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" and "favicon" not in m.text else None)
        page.goto(URL, wait_until="networkidle")
        page.wait_for_function("window.__APP_READY__ === true")
        page.wait_for_timeout(800)

        # 初始撤销栈为空
        n0 = page.evaluate("App.history.undoStack.length")
        assert n0 == 0, f"初始撤销栈应为空，实际 {n0}"

        # 只聚焦再失焦一个数字框、不改值，不应产生撤销记录
        page.locator(".layer-row", has_text="主标题").first.click()
        page.wait_for_timeout(150)
        page.locator('.insp-row:has(label.field-label:text("旋转")) input').first.focus()
        page.wait_for_timeout(50)
        page.keyboard.press("Tab")
        page.wait_for_timeout(200)
        n_focus = page.evaluate("App.history.undoStack.length")
        assert n_focus == 0, f"空编辑不应入栈，实际 {n_focus}"

        # 添加矩形 -> 撤销 -> 消失 -> 重做 -> 回来
        rows0 = page.locator(".layer-row").count()
        page.click('[data-add="rect"]')
        page.wait_for_timeout(200)
        assert page.locator(".layer-row").count() == rows0 + 1
        page.click("#btnUndo")
        page.wait_for_timeout(200)
        assert page.locator(".layer-row").count() == rows0, "撤销未移除新矩形"
        page.click("#btnRedo")
        page.wait_for_timeout(200)
        assert page.locator(".layer-row").count() == rows0 + 1, "重做未恢复矩形"
        print("undo/redo OK")

        # 图片导入
        page.set_input_files("#imageFileInput", IMG)
        page.wait_for_timeout(700)
        img_info = page.evaluate("""() => {
            const id = App.state.selection[0];
            const l = Gfx.Model.findById(App.state.project.children, id).layer;
            return { type: l.type, srcPrefix: (l.src||'').slice(0,30), imgW: l.imgW };
        }""")
        print("imported image:", img_info)
        assert img_info["type"] == "image"
        assert img_info["srcPrefix"].startswith("data:image/svg+xml"), img_info["srcPrefix"]
        assert img_info["imgW"] == 240

        # 自动暂存 -> 刷新 -> 恢复（含图片 dataURL）
        page.wait_for_timeout(700)
        page.reload(wait_until="networkidle")
        page.wait_for_function("window.__APP_READY__ === true")
        page.wait_for_timeout(1000)
        restored = page.evaluate("""() => {
            const imgs = Gfx.Model.flatten(App.state.project.children)
              .map(e=>e.layer).filter(l=>l.type==='image' && (l.src||'').startsWith('data:'));
            return { count: imgs.length, name: App.state.project.name, rows: document.querySelectorAll('.layer-row').length };
        }""")
        print("after reload:", restored)
        assert restored["count"] >= 2, "刷新后未恢复内嵌图片（示例 Logo + 新导入）"
        assert restored["rows"] >= 14

        print("console errors:", errors)
        assert not errors
        browser.close()
    print("\nMISC E2E OK")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        import traceback
        traceback.print_exc()
        sys.exit(1)
