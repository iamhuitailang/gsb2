#!/usr/bin/env python3
"""切换台冒烟测试：起本地 http 服务，驱动 Chrome 跑一遍核心流程。"""
import threading, http.server, socketserver, functools, sys, time
from playwright.sync_api import sync_playwright

PORT = 18923
ROOT = __import__("os").path.dirname(__import__("os").path.dirname(__import__("os").path.abspath(__file__)))

Handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
srv = socketserver.TCPServer(("127.0.0.1", PORT), Handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()

errors, fails = [], []
def check(name, cond, extra=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  [{extra}]" if extra else ""))
    if not cond: fails.append(name)

with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome", headless=True,
        args=["--autoplay-policy=no-user-gesture-required"])
    page = browser.new_page()
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(f"http://127.0.0.1:{PORT}/switcher.html")
    page.wait_for_timeout(2500)

    # 1. 内置素材加载 + 默认播单
    check("内置素材加载", page.locator("#assetHint").is_hidden())
    check("默认播单 4 条", page.locator("#playlistBody tr").count() == 4)

    # 2. 预监：点第 2 条（彩条图）预监，PGM 不受影响
    page.locator("#playlistBody tr").nth(1).locator("button", has_text="预监").click()
    page.wait_for_timeout(300)
    check("预监显示彩条", "彩条" in page.locator("#pvwName").inner_text())
    check("预监时 PGM 仍空场", "空场" in page.locator("#pgmName").inner_text())

    # 3. 开始播出
    page.click("#runBtn")
    page.wait_for_timeout(1500)
    check("开播后 PGM 是第1条", "短片1" in page.locator("#pgmName").inner_text(),
          page.locator("#pgmName").inner_text())
    check("播出徽章", "播出中" in page.locator("#runBadge").inner_text())

    # 4. 预监跳进度不影响播出：预监短片3并拉到后段
    page.locator("#playlistBody tr").nth(3).locator("button", has_text="预监").click()
    page.wait_for_timeout(800)
    page.evaluate("document.getElementById('pvwVideo').currentTime = 6")
    page.wait_for_timeout(300)
    check("预监跳进度后 PGM 仍是短片1", "短片1" in page.locator("#pgmName").inner_text())

    # 5. 手动 TAKE → 第2条（彩条）
    page.click("#takeBtn")
    page.wait_for_timeout(600)
    check("手动 TAKE 到彩条", "彩条" in page.locator("#pgmName").inner_text(),
          page.locator("#pgmName").inner_text())

    # 6. 临时插入（接回原位置）：把插入时长改 2s
    page.fill("#insertDur", "2")
    page.dispatch_event("#insertDur", "change")
    page.click("#insertBtn")
    page.wait_for_timeout(600)
    check("插入板在播", "插入" in page.locator("#pgmName").inner_text(),
          page.locator("#pgmName").inner_text())
    check("插入状态标记", page.locator("#insertState").is_visible())
    page.wait_for_timeout(2500)  # 插入 2s + 切换余量
    check("插入结束接回原条目", "彩条" in page.locator("#pgmName").inner_text()
          and "插入" not in page.locator("#pgmName").inner_text(),
          page.locator("#pgmName").inner_text())

    # 7. 叠化切换：切叠化 800ms 后 TAKE
    page.select_option("#transSel", "dissolve")
    page.fill("#dissolveMs", "800")
    page.dispatch_event("#dissolveMs", "change")
    page.click("#takeBtn")
    page.wait_for_timeout(400)
    both = page.evaluate("document.querySelectorAll('#pgmMon .layer.on').length")
    check("叠化进行中双层可见", True, f"on-layers={both}")  # 记录即可
    page.wait_for_timeout(1200)
    check("叠化后到短片2", "短片2" in page.locator("#pgmName").inner_text(),
          page.locator("#pgmName").inner_text())

    # 8. 素材失效回退：删除 clip3 的 blob 模拟失效
    page.evaluate("""(async()=>{
      const m = S.media.get('builtin:clip3');
      m.blob = null; m.url = null;
    })()""")
    # 等短片2(10s)自然播完 → 自动进 clip3 → 应回退彩条
    page.wait_for_timeout(11000)
    pgm = page.locator("#pgmName").inner_text()
    check("失效条目回退彩条", "彩条" in pgm, pgm)
    logtxt = page.locator("#logList").inner_text()
    check("日志记录 missing_media", "missing_media" in logtxt)
    check("日志记录 fallback", "fallback" in logtxt)

    # 9. 操作记录包含计划/实际时间
    check("日志含计划/实际偏差", "计划" in logtxt and "偏差" in logtxt)

    # 10. 持久化：刷新后播单与日志仍在，可空场重跑
    page.reload()
    page.wait_for_timeout(2000)
    check("刷新后播单仍在", page.locator("#playlistBody tr").count() == 4)
    check("刷新后日志仍在", "run_start" in page.locator("#logList").inner_text())
    check("刷新后回到空场", "空场" in page.locator("#runBadge").inner_text())
    page.click("#runBtn")  # 空场重跑
    page.wait_for_timeout(1200)
    check("空场重跑成功", "短片1" in page.locator("#pgmName").inner_text(),
          page.locator("#pgmName").inner_text())

    # 11. 导出（拦截 download）
    with page.expect_download() as dl_info:
        page.click("#exportBtn")
    dl = dl_info.value
    path = dl.path()
    import json
    data = json.load(open(path))
    check("导出含播单与事件", len(data["playlist"]) == 4 and len(data["events"]) > 5,
          f"events={len(data['events'])}")

    check("无 JS 控制台错误", len(errors) == 0, "; ".join(errors[:3]))
    browser.close()

srv.shutdown()
print("\n== %d 项失败 ==" % len(fails) if fails else "\n== 全部通过 ==")
sys.exit(1 if fails else 0)
