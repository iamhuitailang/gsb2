#!/usr/bin/env python3
"""端到端冒烟验证：启动 vite dev，用 Chromium 检查 WebGL 渲染、交互与控制台错误。"""
import json
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
SHOTS = ROOT / "tmp" / "shots"
SHOTS.mkdir(parents=True, exist_ok=True)


def main() -> int:
    server = subprocess.Popen(
        ["npm", "run", "dev", "--", "--port", "5199", "--no-open"],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    errors: list[str] = []
    try:
        # 等 dev server 就绪
        ready = False
        for _ in range(60):
            line = server.stdout.readline()
            if "Local:" in line:
                ready = True
                break
            if server.poll() is not None:
                print(server.stdout.read())
                return 1
        assert ready, "vite dev server 未就绪"

        with sync_playwright() as pw:
            import os
            exe = os.path.expanduser(
                "~/Library/Caches/ms-playwright/chromium-1255/chrome-mac-arm64/"
                "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
            )
            browser = pw.chromium.launch(executable_path=exe) if os.path.exists(exe) else pw.chromium.launch()
            page = browser.new_page(viewport={"width": 1500, "height": 980})
            page.on("console", lambda m: errors.append(f"console:{m.type}:{m.text}") if m.type in ("error",) else None)
            page.on("pageerror", lambda e: errors.append(f"pageerror:{e}"))

            page.goto("http://localhost:5199/", wait_until="networkidle")
            # 等三个 canvas 都完成首次布局与绘制（避免首帧时序导致的偶发零尺寸）
            page.wait_for_function(
                """() => {
                    const ids = ['glLeft', 'glRight', 'glAll'];
                    return ids.every((id) => {
                        const c = document.getElementById(id);
                        return c && c.clientWidth > 200 && c.width > 200;
                    });
                }""",
                timeout=10000,
            )
            page.wait_for_timeout(400)

            # 1. 三个 WebGL canvas 都有非空像素
            for cid in ("glLeft", "glRight", "glAll"):
                canvas = page.locator(f"#{cid}")
                box = canvas.bounding_box()
                assert box and box["width"] > 100 and box["height"] > 100, f"{cid} 尺寸异常 {box}"
                nonempty = page.evaluate(
                    """(id) => {
                        const c = document.getElementById(id);
                        const gl = c.getContext('webgl');
                        const px = new Uint8Array(c.width * c.height * 4);
                        gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
                        let lit = 0;
                        for (let i = 0; i < px.length; i += 4) {
                          if (px[i] + px[i+1] + px[i+2] > 60) lit++;
                        }
                        return { w: c.width, h: c.height, lit };
                    }""",
                    cid,
                )
                assert nonempty["lit"] > 1000, f"{cid} 几乎没有被绘制: {nonempty}"
                print(f"{cid}: {nonempty}")

            # 整体视图里应能找到镜像接缝的洋红色像素
            seam_pixels = page.evaluate(
                """() => {
                    const c = document.getElementById('glAll');
                    const gl = c.getContext('webgl');
                    const px = new Uint8Array(c.width * c.height * 4);
                    gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
                    let magenta = 0;
                    for (let i = 0; i < px.length; i += 4) {
                      // mirror 色 (242,51,217)，抗锯齿后偏暗，按“红蓝高、绿低”识别
                      if (px[i] > 150 && px[i+1] < 120 && px[i+2] > 140) magenta++;
                    }
                    return magenta;
                }"""
            )
            assert seam_pixels > 20, f"整体视图未检出镜像接缝洋红色像素: {seam_pixels}"
            print("mirror seam magenta pixels:", seam_pixels)

            page.screenshot(path=str(SHOTS / "01-correct-directional.png"), full_page=True)

            # 2. 点击左视口拾取一个面，检查选中面板出现 T/B/N
            left = page.locator("#glLeft")
            box = left.bounding_box()
            page.mouse.click(box["x"] + box["width"] * 0.45, box["y"] + box["height"] * 0.5)
            page.wait_for_timeout(300)
            info = page.locator("#selectionInfo").inner_text()
            assert "世界 T" in info and "世界 B" in info and "世界 N" in info, info
            print("selection panel ok:\n", info.splitlines()[:5])

            # 3. 切换 DirectX 约定，badge 与信息变化
            page.get_by_role("button", name="DirectX +Y↓", exact=True).click()
            page.wait_for_timeout(200)
            badge = page.locator("#conventionBadge").inner_text()
            assert "DirectX" in badge, badge
            channel_info = page.locator("#channelInfo").inner_text()
            assert "DirectX" in channel_info, channel_info
            print("convention switch ok:", badge)

            # 4. 切到刻意设错预设
            page.get_by_role("button", name="刻意设错").click()
            page.wait_for_timeout(400)
            page.screenshot(path=str(SHOTS / "02-broken-seam.png"), full_page=True)
            foot = page.locator("#viewportFoot").inner_text()
            assert "broken-seam" in foot, foot
            print("broken-seam preset ok")

            # 5. 退化预设：无效面被列出
            page.get_by_role("button", name="退化/缺方向").click()
            page.wait_for_timeout(400)
            invalid_text = page.locator("#invalidNote").inner_text()
            assert "1 个面" in invalid_text, invalid_text
            page.screenshot(path=str(SHOTS / "03-degenerate.png"), full_page=True)
            print("degenerate ok:", invalid_text)

            # 6. 轴翻转：勾选 Z 翻转，画面仍正常、无报错
            page.locator(".flip-row input").nth(2).check()
            page.wait_for_timeout(300)
            info2 = page.locator("#selectionInfo").inner_text()
            assert "世界 N" in info2

            # 7. 生成接缝报告
            page.get_by_role("button", name="生成报告").click()
            page.wait_for_timeout(200)
            report = page.locator("#reportPreview").inner_text()
            assert "法线贴图接缝对照报告" in report
            assert "Lambert" in report and "高光" in report
            print("report ok, lines:", len(report.splitlines()))

            # 8. 通道视图切到 G，canvas 更新
            page.get_by_role("button", name="G").first.click()
            page.wait_for_timeout(200)
            page.screenshot(path=str(SHOTS / "04-channel-g.png"), full_page=True)

            # 9. 保存快照并刷新，状态恢复
            page.get_by_role("button", name="保存快照").click()
            page.wait_for_timeout(400)
            stored = page.evaluate("localStorage.getItem('normal-debug-bench/state/v1')")
            assert stored and "degenerate" in stored
            page.reload(wait_until="networkidle")
            page.wait_for_timeout(600)
            after = page.evaluate("localStorage.getItem('normal-debug-bench/state/v1')")
            assert after == stored
            foot2 = page.locator("#viewportFoot").inner_text()
            assert "degenerate" in foot2
            print("persistence ok")

            browser.close()

        if errors:
            print("浏览器侧错误:")
            for e in errors:
                print(" -", e)
            return 2
        print("ALL E2E CHECKS PASSED; screenshots ->", SHOTS)
        return 0
    finally:
        server.terminate()
        try:
            server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            server.kill()


if __name__ == "__main__":
    sys.exit(main())
