"""探测 Chrome MediaRecorder 对透明 canvas / 帧率 / 时长元数据的支持。"""
import base64
import json
import subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright

OUT = Path("tests/output")

JS = r"""
async (variant) => {
  const c = document.createElement('canvas');
  c.width = 640; c.height = 360;
  const x = c.getContext('2d', { alpha: true });
  const stream = variant === 'manual' ? c.captureStream(0) : c.captureStream(30);
  const track = stream.getVideoTracks()[0];
  const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
    ? 'video/webm;codecs=vp9' : 'video/webm';
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8e6 });
  const chunks = [];
  rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  const stopped = new Promise(r => rec.onstop = r);
  rec.start();
  const N = 45, fps = 30, ms = 1000 / fps;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) {
    const target = t0 + i * ms;
    const w = target - performance.now();
    if (w > 0) await new Promise(r => setTimeout(r, w));
    x.clearRect(0, 0, c.width, c.height);
    x.fillStyle = '#ff5500';
    x.fillRect(40 + i * 8, 120, 120, 120);
    if (variant === 'manual') track.requestFrame();
  }
  await new Promise(r => setTimeout(r, ms));
  rec.stop();
  await stopped;
  const blob = new Blob(chunks, { type: 'video/webm' });
  const buf = await blob.arrayBuffer();
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { b64: btoa(bin), mime, size: blob.size };
}
"""

for headed in (False, True):
    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel="chrome", headless=not headed)
        page = browser.new_page()
        page.goto("http://127.0.0.1:8123/index.html", wait_until="domcontentloaded")
        page.wait_for_function("window.__APP_READY__ === true")
        for variant in ("auto", "manual"):
            res = page.evaluate(JS, variant)
            tag = f"{'headed' if headed else 'headless'}_{variant}"
            vp = OUT / f"probe_{tag}.webm"
            vp.write_bytes(base64.b64decode(res["b64"]))
            info = subprocess.run(
                ["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(vp)],
                capture_output=True, text=True).stdout
            d = json.loads(info)
            s = d["streams"][0]
            print(tag, res["mime"], f"{res['size']/1024:.0f}KB",
                  "pix=", s.get("pix_fmt"), "rate=", s.get("r_frame_rate"),
                  "avg=", s.get("avg_frame_rate"), "dur=", d["format"].get("duration"),
                  "streamDur=", s.get("duration"), "nb=", s.get("nb_frames"))
        browser.close()
