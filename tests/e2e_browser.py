"""端到端浏览器测试: 用缓存的 Playwright headless shell 驱动真实页面。

前置: 已安装 playwright (pip install playwright) 且下载了 chromium 内核;
内核缺失时自动跳过 (unittest/CI 里不应当成失败)。需要先启动本地服务:
    python3 noisekit/server.py --port 8765
"""

import sys
from pathlib import Path

from playwright.sync_api import sync_playwright


def _find_headless_shell() -> str | None:
    """在 Playwright 缓存目录里查找任意版本的 headless shell。"""
    base = Path.home() / "Library/Caches/ms-playwright"
    if not base.exists():
        return None
    candidates = sorted(base.glob("chromium_headless_shell-*/**/chrome-headless-shell"))
    return str(candidates[-1]) if candidates else None


HEADLESS = _find_headless_shell()
URL = "http://127.0.0.1:8765/"


def main() -> int:
    if not HEADLESS:
        print("跳过: 未找到 Playwright headless 浏览器内核")
        print("如需运行: pip install playwright && playwright install chromium")
        return 0
    failures = []
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=HEADLESS, args=["--no-sandbox"])
        page = browser.new_page()
        page.on("console", lambda m: failures.append(f"console.{m.type}: {m.text}")
                if m.type == "error" else None)
        page.on("pageerror", lambda e: failures.append(f"pageerror: {e}"))

        page.goto(URL, wait_until="networkidle")
        page.wait_for_selector("#btn-samples")

        # 1. 载入演示样音 (串行加载, 等 4 个条目都出现)
        page.click("#btn-samples")
        page.wait_for_function(
            "document.querySelectorAll('#file-list li').length === 4",
            timeout=15000,
        )
        n_files = page.eval_on_selector_all("#file-list li", "els => els.length")
        print(f"[1] 载入样音文件数: {n_files}")
        assert n_files == 4, "应载入 4 个样音"

        # 2. 分析样本 (默认区间 0.05-0.55, 纯噪声)
        page.wait_for_selector("#btn-analyze:not([disabled])", timeout=5000)
        page.click("#btn-analyze")
        page.wait_for_function(
            "document.getElementById('sample-stats').textContent.includes('平坦度')",
            timeout=8000,
        )
        stats = page.inner_text("#sample-stats")
        print(f"[2] 纯噪声样本分析: {stats[:80]}")
        assert "稳态噪声" in stats, "纯噪声样本应判定为稳态"

        # 3. 等处理完成, 检查频谱与差异视图
        page.wait_for_function(
            "document.getElementById('diff-stats').textContent.includes('RMS')",
            timeout=8000,
        )
        diff_stats = page.inner_text("#diff-stats")
        print(f"[3] 差异统计: {diff_stats}")
        # canvas 实际绘制了内容
        spec_drawn = page.eval_on_selector(
            "#spectrum", "c => c.getContext('2d').getImageData(0,0,c.width,c.height).data.some(v=>v)"
        )
        wave_drawn = page.eval_on_selector(
            "#wave-diff", "c => c.getContext('2d').getImageData(0,0,c.width,c.height).data.some(v=>v)"
        )
        print(f"[3] 频谱已绘制: {spec_drawn}, 差异波形已绘制: {wave_drawn}")
        assert spec_drawn and wave_drawn

        # 4. 调强度, 触发重新处理
        page.fill("#p-strength", "0.9")
        page.dispatch_event("#p-strength", "input")
        page.wait_for_timeout(800)
        strength = page.input_value("#p-strength")
        print(f"[4] 强度调到: {strength}")
        assert strength == "0.9"

        # 5. 切换到 04 号样音, 在含语音区间分析, 应出告警
        page.eval_on_selector_all(
            "#file-list li",
            "els => { const t = els.find(e => e.textContent.includes('04_voice')); t.click(); }",
        )
        page.wait_for_timeout(600)
        page.fill("#region-start", "1.0")
        page.fill("#region-end", "1.6")
        page.click("#btn-analyze")
        page.wait_for_function(
            "document.getElementById('banner').className.includes('danger')",
            timeout=8000,
        )
        banner = page.inner_text("#banner")
        print(f"[5] 含语音样本告警: {banner[:70]}")
        assert "语音" in banner or "敲击" in banner

        # 6. A/B 播放器实例存在且模式默认 B
        ab_mode = page.inner_text("#ab-mode")
        print(f"[6] 试听模式: {ab_mode}")
        assert "B" in ab_mode

        # 7. 回到 01, 分析后「应用到全部」, 再切到 02 应自动重算且参数一致
        page.eval_on_selector_all(
            "#file-list li",
            "els => els.find(e => e.textContent.includes('01_')).click()",
        )
        page.wait_for_timeout(500)
        page.fill("#region-start", "0.05")
        page.fill("#region-end", "0.55")
        page.click("#btn-analyze")
        page.wait_for_selector("#diff-stats", timeout=8000)
        page.fill("#p-strength", "0.72")
        page.dispatch_event("#p-strength", "input")
        page.wait_for_timeout(500)
        page.click("#btn-apply-all")
        page.wait_for_timeout(500)
        page.eval_on_selector_all(
            "#file-list li",
            "els => els.find(e => e.textContent.includes('02_')).click()",
        )
        # 02 没有噪声样本, 先分析再确认它继承了广播的强度 0.72
        page.wait_for_timeout(400)
        page.fill("#region-start", "0.05")
        page.fill("#region-end", "0.55")
        page.click("#btn-analyze")
        page.wait_for_selector("#diff-stats", timeout=8000)
        inherited = page.input_value("#p-strength")
        print(f"[7] 应用到全部后, 02 号继承强度: {inherited}")
        assert inherited == "0.72"

        browser.close()

    if failures:
        print("前端控制台错误:")
        for f in failures:
            print(" -", f)
        return 1
    print("\n全部端到端检查通过 ✓")
    return 0


if __name__ == "__main__":
    sys.exit(main())
