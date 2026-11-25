"""静态 HTML 报告: 内联 SVG 时间轴 + 可选联系表 (base64), 纯标准库。"""
from __future__ import annotations

import base64
from pathlib import Path
from typing import Any

STRATEGY_COLOR = {
    "both": "#34c759",
    "speaker": "#ff9500",
    "required": "#af52de",
    "fallback": "#8e8e93",
    "manual": "#0a84ff",
    "cut": "#ff2d55",
}


def _svg_timeline(schedule: dict[str, Any], width: int = 980, height: int = 300) -> str:
    dur = float(schedule["duration"])
    W, H = width, height
    ml, mr, mt, mb = 60, 20, 30, 40
    plot_w = W - ml - mr
    plot_h = H - mt - mb
    src_w = int(schedule["width"])
    crop_w = int(schedule["crop"]["width_px"])

    def X(t: float) -> float:
        return ml + t / dur * plot_w

    def Y(crop_x_norm: float) -> float:
        # 裁框左缘在源画面中的位置 0..(src_w-crop_w)
        max_x = max(1, src_w - crop_w)
        frac = (crop_x_norm * src_w) / max_x
        return mt + (1 - frac) * plot_h

    parts = [f'<svg viewBox="0 0 {W} {H}" xmlns="http://www.w3.org/2000/svg" font-family="sans-serif" font-size="11">']
    parts.append(f'<rect width="{W}" height="{H}" fill="white"/>')
    # 网格 + 秒刻度
    for sec in range(int(dur) + 1):
        x = X(sec)
        parts.append(f'<line x1="{x:.1f}" y1="{mt}" x2="{x:.1f}" y2="{mt + plot_h}" stroke="#eee"/>')
        parts.append(f'<text x="{x:.1f}" y="{H - 12}" text-anchor="middle" fill="#666">{sec}s</text>')
    # 镜头分界
    for seg in schedule["segments"][1:]:
        x = X(float(seg["start"]))
        parts.append(f'<line x1="{x:.1f}" y1="{mt - 8}" x2="{x:.1f}" y2="{mt + plot_h}" stroke="#ff2d55" stroke-width="2" stroke-dasharray="5,4"/>')
        parts.append(f'<text x="{x + 4:.1f}" y="{mt - 12}" fill="#ff2d55">CUT</text>')
    # 裁框左缘轨迹
    kfs = schedule["keyframes"]
    pts = " ".join(f"{X(k['t']):.1f},{Y(k['crop']['x']):.1f}" for k in kfs)
    parts.append(f'<polyline points="{pts}" fill="none" stroke="#0a84ff" stroke-width="2"/>')
    # 可行域上下界
    parts.append(f'<line x1="{ml}" y1="{Y(0):.1f}" x2="{ml + plot_w}" y2="{Y(0):.1f}" stroke="#ccc"/>')
    parts.append(f'<line x1="{ml}" y1="{Y((src_w - crop_w) / src_w):.1f}" x2="{ml + plot_w}" y2="{Y((src_w - crop_w) / src_w):.1f}" stroke="#ccc"/>')
    parts.append(f'<text x="{ml - 8}" y="{Y(0) + 4:.1f}" text-anchor="end" fill="#999">右贴边</text>')
    parts.append(f'<text x="{ml - 8}" y="{Y((src_w - crop_w) / src_w) + 4:.1f}" text-anchor="end" fill="#999">左贴边</text>')
    # 策略事件点
    for ev in schedule["events"]:
        x = X(float(ev["t"]))
        color = STRATEGY_COLOR.get(ev["type"], "#333") if ev["type"] == "cut" else "#af52de"
        parts.append(f'<circle cx="{x:.1f}" cy="{mt + plot_h + 16}" r="4" fill="{color}"/>')
    parts.append("</svg>")
    return "".join(parts)


def build_report(
    schedule: dict[str, Any],
    out_path: str | Path,
    sheet_path: str | Path | None = None,
    verify_data: dict[str, Any] | None = None,
) -> None:
    svg = _svg_timeline(schedule)
    sheet_html = ""
    if sheet_path and Path(sheet_path).exists():
        b64 = base64.b64encode(Path(sheet_path).read_bytes()).decode()
        sheet_html = f'<h3>关键帧联系表</h3><img src="data:image/jpeg;base64,{b64}" style="max-width:100%;border:1px solid #ddd"/>'

    seg_rows = "".join(
        f"<tr><td>{s['start']:.2f}–{s['end']:.2f}s</td><td>{s['transition']}</td>"
        f"<td><span style='color:{STRATEGY_COLOR.get(s['dominant_strategy'], '#333')}'>●</span> {s['dominant_strategy']}</td>"
        f"<td>{', '.join(s['strategies'])}</td></tr>"
        for s in schedule["segments"]
    )
    ev_rows = "".join(
        f"<tr><td>{e['t']:.2f}s</td><td>{e['type']}</td><td>{e['detail']}</td></tr>"
        for e in schedule["events"]
    )
    warn_html = "".join(f"<li>{w}</li>" for w in schedule.get("warnings", [])) or "<li>无</li>"
    verify_html = ""
    if verify_data:
        av = verify_data.get("av", {})
        cut = verify_data.get("cut_frames", [])
        cut_rows = "".join(
            f"<tr><td>{r['t']:.2f}s (帧 {r['frame']})</td><td>{r['transition']}</td>"
            f"<td>{r['jump_px']} px</td><td>{r['strategy_after']}</td></tr>"
            for r in cut
        )
        ok = verify_data.get("frame_check", {}).get("ok", True) and av.get("ok", True)
        verify_html = f"""
        <h3>对照检查</h3>
        <p>逐帧一致性: <b style="color:{'green' if ok else 'red'}">{'通过' if ok else '失败'}</b> ·
        时长差 {av.get('duration_diff_s')}s · 原音保留: {av.get('output_has_audio')} ·
        输出 {av.get('output_size')}</p>
        <table><tr><th>切点</th><th>转场</th><th>裁框跳变</th><th>切点后策略</th></tr>{cut_rows}</table>
        """

    html = f"""<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>竖版取景报告</title>
<style>
body{{font-family:-apple-system,sans-serif;margin:24px;color:#222;background:#fafafa}}
table{{border-collapse:collapse;margin:8px 0 24px;background:#fff}}
td,th{{border:1px solid #ddd;padding:6px 10px;font-size:13px}}
h2{{margin-top:28px}} .meta{{color:#666;font-size:13px}}
</style></head><body>
<h1>竖版取景时间表报告</h1>
<p class="meta">源片 {schedule['source']} · {schedule['width']}x{schedule['height']} ·
{schedule['fps']} fps · {schedule['duration']:.1f}s · 裁框 {schedule['crop']['width_px']}x{schedule['crop']['height_px']} (9:16)</p>
<h2>取景轨迹</h2>{svg}
{verify_html}
<h2>分段策略 (界面可提前知道每段如何保留/留边)</h2>
<table><tr><th>时间</th><th>转场</th><th>主策略</th><th>出现过的策略</th></tr>{seg_rows}</table>
<h2>事件</h2>
<table><tr><th>时刻</th><th>类型</th><th>说明</th></tr>{ev_rows}</table>
<h2>硬约束告警</h2><ul>{warn_html}</ul>
{sheet_html}
</body></html>"""
    Path(out_path).write_text(html, encoding="utf-8")
