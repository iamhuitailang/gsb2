"""Playwright E2E（二）：工程保存/打开往返、PNG 序列 ZIP、透明 WebM，
并用 zipfile / ffprobe / ffmpeg 校验帧数、尺寸、帧率、时长与 alpha。"""
import json
import os
import struct
import subprocess
import sys
import zipfile
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "tests" / "output"
OUT.mkdir(parents=True, exist_ok=True)
URL = "http://127.0.0.1:8123/index.html"


def png_ihdr(data: bytes):
    assert data[:8] == b"\x89PNG\r\n\x1a\n", "不是合法 PNG"
    w, h = struct.unpack(">II", data[16:24])
    bit_depth = data[24]
    color_type = data[25]
    return w, h, bit_depth, color_type


def png_alpha_stats(png_path: Path):
    """用 ffmpeg 解成 raw rgba，返回 (角点alpha, 非透明像素数, 最大alpha)。"""
    proc = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(png_path), "-pix_fmt", "rgba", "-f", "rawvideo", "-"],
        capture_output=True, check=True)
    raw = proc.stdout
    # 从 IHDR 读尺寸
    w, h, _, _ = png_ihdr(png_path.read_bytes())
    assert len(raw) == w * h * 4, (len(raw), w * h * 4)
    corner = raw[3]
    nontransparent = 0
    max_a = 0
    for i in range(3, len(raw), 4 * 37):  # 抽样加速
        a = raw[i]
        max_a = max(max_a, a)
        if a > 10:
            nontransparent += 1
    return corner, nontransparent, max_a


def ffprobe(path: Path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)],
        capture_output=True, text=True, check=True).stdout
    return json.loads(out)


def main():
    errors = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel="chrome", headless=True)
        ctx = browser.new_context(viewport={"width": 1500, "height": 940}, accept_downloads=True)
        page = ctx.new_page()
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" and "favicon" not in m.text else None)

        page.goto(URL, wait_until="networkidle")
        page.wait_for_function("window.__APP_READY__ === true")
        page.wait_for_timeout(1000)

        # ---------- 1. 保存工程 ----------
        with page.expect_download(timeout=15000) as di:
            page.click("#btnSave")
        dl = di.value
        proj_path = OUT / dl.suggested_filename
        dl.save_as(str(proj_path))
        print("saved project:", proj_path.name)
        raw = json.loads(proj_path.read_text())
        proj = raw.get("project", raw)
        assert proj["app"] == "motion-title-studio"
        assert len(proj["children"]) >= 10
        assert proj["fps"] == 30 and proj["duration"] == 6

        # ---------- 2. 改坏状态后打开工程，验证往返 ----------
        page.evaluate("() => { App.state.project.fps = 12; App.state.project.duration = 2; }")
        page.set_input_files("#projectFileInput", str(proj_path))
        page.wait_for_timeout(600)
        fps_dur = page.evaluate("[App.state.project.fps, App.state.project.duration]")
        print("reopened fps/duration:", fps_dur)
        assert fps_dur == [30, 6], "打开工程未恢复帧率时长"
        rows = page.locator(".layer-row").count()
        assert rows >= 13

        # ---------- 3. 导出 PNG 序列 ----------
        page.click("#btnExportSeq")
        page.wait_for_selector("#exportModal:not([hidden])")
        with page.expect_download(timeout=180000) as di2:
            page.click("#btnDoExport")
        dl2 = di2.value
        zip_path = OUT / dl2.suggested_filename
        dl2.save_as(str(zip_path))
        print("saved zip:", zip_path.name, f"{zip_path.stat().st_size/1e6:.1f} MB")

        with zipfile.ZipFile(zip_path) as z:
            names = sorted(n for n in z.namelist() if n.endswith(".png"))
            print("png count:", len(names), "first:", names[0], "last:", names[-1])
            assert len(names) == 180, f"应为 180 帧，实际 {len(names)}"
            assert names[0] == "frames/frame_0001.png"
            assert names[-1] == "frames/frame_0180.png"
            assert any("README" in n for n in z.namelist())
            z.extractall(OUT / "seq")

        f1 = OUT / "seq" / "frames" / "frame_0001.png"
        f90 = OUT / "seq" / "frames" / "frame_0090.png"
        f180 = OUT / "seq" / "frames" / "frame_0180.png"
        w, h, bd, ct = png_ihdr(f1.read_bytes())
        print("PNG IHDR:", w, h, "bit", bd, "colortype", ct)
        assert (w, h) == (1920, 1080)
        assert ct == 6, "PNG 必须是 RGBA 带 alpha"

        c1, n1, max1 = png_alpha_stats(f1)
        c90, n90, max90 = png_alpha_stats(f90)
        c180, n180, max180 = png_alpha_stats(f180)
        print(f"frame1 cornerAlpha={c1} paintedSamples={n1} maxA={max1}")
        print(f"frame90 cornerAlpha={c90} paintedSamples={n90} maxA={max90}")
        print(f"frame180 cornerAlpha={c180} paintedSamples={n180} maxA={max180}")
        assert max1 == 0, "第 1 帧示例动画开始前应为全透明"
        assert c90 == 0 and n90 > 100, "第 90 帧角点透明且有大量内容"
        assert c180 == 0 and n180 > 100, "结尾帧角点透明且有停留内容"

        # ---------- 4. 通过本地 ffmpeg 服务导出透明视频 ----------
        page.click("#exportClose")
        page.wait_for_timeout(300)
        page.click("#btnExportVideo")
        page.wait_for_selector("#exportModal:not([hidden])")
        # 应探测到本地 ffmpeg 引擎
        page.wait_for_selector("text=已连接本地编码服务", timeout=8000)
        with page.expect_download(timeout=240000) as di3:
            page.click("#btnDoExport")
        dl3 = di3.value
        webm_path = OUT / "e2e_video.webm"
        dl3.save_as(str(webm_path))
        print("saved video:", dl3.suggested_filename, f"{webm_path.stat().st_size/1e6:.2f} MB")

        info = ffprobe(webm_path)
        v = next(s for s in info["streams"] if s["codec_type"] == "video")
        dur = float(info["format"]["duration"])
        rate = v.get("r_frame_rate", "?")
        pix = v.get("pix_fmt", "?")
        print(f"webm: codec={v['codec_name']} {v['width']}x{v['height']} fps={rate} pix={pix} duration={dur:.2f}s")
        assert v["width"] == 1920 and v["height"] == 1080
        num, den = rate.split("/")
        fps = int(num) / int(den)
        assert abs(fps - 30) < 0.5, f"helper 输出帧率应为精确 30/1，实际 {rate}"
        assert 5.9 < dur < 6.1, f"helper 输出时长应精确 6s，实际 {dur}"

        # alpha 以 BlockAdditional 存储时 ffprobe 可能仍报 yuv420p，
        # 因此在真实 Chrome 里播放并用 requestVideoFrameCallback 抓帧读 alpha。
        # headless 下直接设 currentTime 可能不跳转，所以走真实播放。
        alpha_check = page.evaluate(
            """async () => {
                const v = document.createElement('video');
                v.src = '/tests/output/e2e_video.webm?ts=' + Date.now();
                v.muted = true;
                const captured = [];
                let best = { nz: 0, corner: 255, t: 0 };
                const draw = () => {
                    if (!v.videoWidth) return;
                    const c = document.createElement('canvas');
                    c.width = v.videoWidth; c.height = v.videoHeight;
                    const x = c.getContext('2d');
                    x.drawImage(v, 0, 0);
                    const corner = x.getImageData(2, 2, 1, 1).data[3];
                    const d = x.getImageData(0, 0, c.width, c.height).data;
                    let nz = 0;
                    for (let i = 3; i < d.length; i += 4 * 97) if (d[i] > 10) nz++;
                    captured.push({ t: v.currentTime, corner, nz });
                    // 结尾停留段：有内容且角点透明
                    if (v.currentTime > 4 && nz > best.nz) best = { nz, corner, t: v.currentTime };
                };
                await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = rej; });
                let done;
                const finished = new Promise(r => (done = r));
                const t0 = performance.now();
                function cb() {
                    draw();
                    if (performance.now() - t0 < 5200 && !v.ended) {
                        v.requestVideoFrameCallback(cb);
                    } else {
                        draw();
                        done();
                    }
                }
                v.requestVideoFrameCallback(cb);
                await v.play();
                await finished;
                return { frames: captured.length, best, sample: captured.filter(f => f.t > 4).slice(-3) };
            }""")
        print("chrome alpha decode:", alpha_check)
        assert alpha_check["frames"] >= 30
        assert alpha_check["best"]["nz"] > 100, "结尾停留帧缺少内容"
        assert alpha_check["best"]["corner"] == 0, "结尾帧角点应为透明 alpha=0"

        # ---------- 5. MOV(ProRes4444) 编码接口也应带 alpha ----------
        zip_bytes = zip_path.read_bytes()
        resp = page.request.post(
            f"http://127.0.0.1:8123/api/encode?fps=30&fmt=mov",
            data=zip_bytes, headers={"Content-Type": "application/zip"})
        assert resp.ok, f"mov encode failed {resp.status}"
        mov_path = OUT / "e2e_video.mov"
        mov_path.write_bytes(resp.body())
        minfo = ffprobe(mov_path)
        mv = next(s for s in minfo["streams"] if s["codec_type"] == "video")
        print("mov pix_fmt:", mv.get("pix_fmt"), "duration:", minfo["format"].get("duration"))
        assert "yuva" in mv.get("pix_fmt", "")

        print("page errors:", errors)
        assert not errors
        browser.close()

    print("\nEXPORT E2E OK")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        import traceback
        traceback.print_exc()
        sys.exit(1)
