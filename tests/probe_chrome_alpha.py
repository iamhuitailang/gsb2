"""在真实 Chrome 中验证编码出的视频是否带透明通道（ffprobe 对 BlockAdditional alpha 不可靠）。"""
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "tests" / "output"

files = sys.argv[1:] or ["t_vp9.webm", "t_vp8.webm", "t_qtrle.mov", "t_prores.mov"]

with sync_playwright() as pw:
    browser = pw.chromium.launch(channel="chrome", headless=True)
    page = browser.new_page()
    page.goto("http://127.0.0.1:8123/index.html", wait_until="domcontentloaded")
    for name in files:
        p = OUT / name
        if not p.exists():
            print(name, "missing")
            continue
        url = "http://127.0.0.1:8123/tests/output/" + name
        res = page.evaluate(
            """async (url) => {
                const v = document.createElement('video');
                v.src = url; v.muted = true; v.crossOrigin = 'anonymous';
                await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = rej; });
                v.currentTime = 0;
                await new Promise(r => { v.onseeked = r; });
                const c = document.createElement('canvas');
                c.width = v.videoWidth; c.height = v.videoHeight;
                const x = c.getContext('2d');
                x.drawImage(v, 0, 0);
                const corner = x.getImageData(2, 2, 1, 1).data;
                const d = x.getImageData(0, 0, c.width, c.height).data;
                let nz = 0;
                for (let i = 3; i < d.length; i += 4 * 193) if (d[i] > 10) nz++;
                return { w: v.videoWidth, h: v.videoHeight, cornerAlpha: corner[3], nz };
            }""",
            url,
        )
        print(name, res)
    browser.close()
