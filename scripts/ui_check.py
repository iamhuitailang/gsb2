#!/usr/bin/env python3
"""使用本机 Google Chrome(经 Playwright 驱动)做 UI 冒烟检查并截图。

不属于运行时依赖; 仅开发/验收使用:
    python3 scripts/ui_check.py http://127.0.0.1:8770

截图输出到 /tmp/vstab_ui_*.png。
"""

from __future__ import annotations

import json
import sys
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8780"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
SAMPLE = Path(__file__).resolve().parent.parent / "samples" / "sample_pan.mp4"

errors: list[str] = []


def _api(path, payload=None):
    if payload is None:
        return json.loads(urllib.request.urlopen(BASE + path, timeout=30).read())
    req = urllib.request.Request(
        BASE + path, data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"}, method="POST")
    return json.loads(urllib.request.urlopen(req, timeout=30).read())


def ensure_session() -> None:
    """在服务端准备一个已分析会话(摇摄片, 事件更丰富)。"""
    h = _api("/api/health")
    assert h.get("ok")
    j = _api("/api/analyze", {"path": str(SAMPLE)})
    for _ in range(240):
        job = _api(f"/api/job/{j['job_id']}")
        if job["status"] in ("done", "error"):
            assert job["status"] == "done", job.get("error")
            break
        time.sleep(0.7)
    # 预置一个不处理区间, 验证列表渲染
    _api("/api/params", {"exclusions": [{"start": 10, "end": 24}]})


def main() -> int:
    ensure_session()
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=CHROME,
                                    args=["--no-sandbox", "--force-color-profile=srgb"])
        page = browser.new_page(viewport={"width": 1680, "height": 1500},
                                device_scale_factor=1)
        page.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}")
                if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))

        page.goto(BASE, wait_until="networkidle")
        # 服务端已有 e2e 分析会话; 等待工作区与两张图
        page.wait_for_selector("#workspace:not([hidden])", timeout=15000)
        page.wait_for_function(
            "document.querySelector('#img-original').naturalWidth > 0 && "
            "document.querySelector('#img-stable').naturalWidth > 0",
            timeout=15000,
        )
        time.sleep(1.2)  # 等轨迹图绘制与图片解码
        page.screenshot(path="/tmp/vstab_ui_1_workspace.png", full_page=False)
        print("[ok] workspace rendered")

        # 逐帧: 点 3 次下一帧, 帧号应从 30(e2e 取帧不改变服务端状态, 前端默认0)推进
        before = int(page.input_value("#frame-input"))
        page.click("#btn-next")
        page.click("#btn-next")
        page.click("#btn-next")
        page.wait_for_function(
            f"Number(document.querySelector('#frame-input').value) >= {before + 3}",
            timeout=8000)
        after = int(page.input_value("#frame-input"))
        assert after == before + 3, (before, after)
        print(f"[PASS] frame stepping {before} -> {after}")

        # 切到旋转图再切回 X
        page.click('.chart-tab[data-metric="a"]')
        time.sleep(0.3)
        page.click('.chart-tab[data-metric="x"]')
        time.sleep(0.3)
        print("[PASS] chart tabs switch")

        # 在轨迹图上拖拽选择区间并添加为不处理
        box = page.locator("#traj-chart").bounding_box()
        x1 = box["x"] + box["width"] * 0.30
        x2 = box["x"] + box["width"] * 0.42
        y = box["y"] + box["height"] * 0.55
        page.mouse.move(x1, y)
        page.mouse.down()
        page.mouse.move(x2, y, steps=8)
        page.mouse.up()
        page.wait_for_selector("#range-action:not([hidden])", timeout=5000)
        page.click("#btn-range-add")
        time.sleep(0.8)  # 等参数提交与重绘
        items = page.locator("#ex-list li").count()
        # e2e 已留一个 [10,24] 区间, 再加一个 => >=2
        assert items >= 2, f"exclusion items={items}"
        print(f"[PASS] drag-add exclusion, list items={items}")

        # 拖动稳定强度滑杆(键盘改值 + input 事件)
        page.eval_on_selector("#rng-strength", """el => {
            el.value = 40; el.dispatchEvent(new Event('input', {bubbles:true}));
        }""")
        time.sleep(0.8)
        val = page.text_content("#val-strength")
        assert val == "40%", val
        print("[PASS] strength slider -> 40%")

        # 切移动端视口截图
        mobile = browser.new_page(viewport={"width": 414, "height": 896})
        mobile.goto(BASE, wait_until="networkidle")
        mobile.wait_for_selector("#workspace:not([hidden])", timeout=15000)
        time.sleep(1.5)
        mobile.screenshot(path="/tmp/vstab_ui_3_mobile.png", full_page=False)
        print("[ok] mobile screenshot")
        mobile.close()

        page.screenshot(path="/tmp/vstab_ui_2_interact.png", full_page=False)

        # 导出参数 JSON 链接存在
        assert page.locator("#btn-export-params").is_enabled()

        browser.close()

    serious = [e for e in errors if "favicon" not in e.lower()]
    if serious:
        print("BROWSER ERRORS:")
        for e in serious:
            print(" -", e)
        return 1
    print("UI CHECKS PASSED (no console errors)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
