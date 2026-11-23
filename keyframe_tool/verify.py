"""成品读回与核对。

原则：裁切结果一律以「重新读成品文件」为准，而不是相信 ffmpeg 命令的预期。
- 首尾视频帧映射回源片：优先用 framemd5 逐帧哈希做精确匹配（流复制时解码画面完全一致）；
  重编码有有损压缩，哈希必然不同，改用 PSNR 画面相似度在期望位置附近搜索，
  相似度不够就明确标「无法判断」，不硬凑一个帧号。
- 声音覆盖：读成品音轨包的起止，换算回源片显示时间线，给出头部/尾部缺口；
  AAC 编码器 priming 造成的小缺口单独标出。
"""

from __future__ import annotations

import json
import tempfile

from . import times
from .ffmpeg_utils import FFmpegError, ffmpeg_capture, ffprobe_json
from .probe import ProbeResult

PSNR_HIGH = 40.0    # >=40dB 视为高可信
PSNR_MEDIUM = 30.0  # 30~40 中等可信；<30 无法判断
SEARCH_WINDOW = 20  # 在期望帧号前后各搜这么多帧
AUDIO_GAP_TOL = 0.025


def _to_float(value, default=None):
    if value in (None, "N/A"):
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def probe_output(path: str) -> dict:
    """读回成品：帧数、首尾显示时间、音轨覆盖（成品自身时间线，从 0 开始）。"""
    if not __import__("os").path.isfile(path):
        raise FFmpegError(f"成品文件不存在: {path}")
    info = ffprobe_json(path, "-show_format", "-show_streams")
    streams = info.get("streams", [])
    v = next((s for s in streams if s.get("codec_type") == "video"), None)
    if v is None:
        raise FFmpegError("成品里没有视频流，裁切可能失败")
    v_start = _to_float(v.get("start_time"), 0.0) or 0.0

    vp = ffprobe_json(path, "-select_streams", "v:0", "-show_packets").get("packets", [])
    vpts = sorted(_to_float(p.get("pts_time")) for p in vp if _to_float(p.get("pts_time")) is not None)
    if not vpts:
        raise FFmpegError("成品视频读不到任何帧，源文件可能读不全")
    durations = [_to_float(p.get("duration_time"), 0.0) for p in vp]
    last_dur = next((d for d in reversed(durations) if d), 0.0)

    audio = None
    ap_pts: list[float] = []
    a = next((s for s in streams if s.get("codec_type") == "audio"), None)
    if a is not None:
        ap = ffprobe_json(path, "-select_streams", "a:0", "-show_packets").get("packets", [])
        ap_pts = sorted(_to_float(p.get("pts_time")) for p in ap if _to_float(p.get("pts_time")) is not None)
        if ap_pts:
            last_a = max(ap, key=lambda p: _to_float(p.get("pts_time"), -1))
            a_dur = _to_float(last_a.get("duration_time"), 0.0) or 0.0
            audio = {
                "codec": a.get("codec_name"),
                "sample_rate": int(a.get("sample_rate", 0) or 0),
                "display_start": round(ap_pts[0] - v_start, 6),
                "display_end": round(_to_float(last_a.get("pts_time")) + a_dur - v_start, 6),
                "nb_packets": len(ap),
            }

    return {
        "path": path,
        "nb_frames": len(vpts),
        "first_display": round(vpts[0] - v_start, 6),
        "last_display": round(vpts[-1] - v_start, 6),
        "last_frame_end": round(vpts[-1] + last_dur - v_start, 6),
        "duration": _to_float(info.get("format", {}).get("duration")),
        "audio": audio,
    }


def _extract_frame(path: str, display_index: int) -> bytes:
    """抽取显示顺序第 N 帧为 PNG（select 按显示顺序计数，B 帧也正确）。"""
    _, out, err = ffmpeg_capture(
        ["-i", path, "-vf", f"select=eq(n\\,{display_index})", "-vframes", "1",
         "-f", "image2pipe", "-c:v", "png", "-"],
        timeout=120,
    )
    if not out:
        raise FFmpegError(f"抽帧失败（第 {display_index} 帧）: {err[-300:]}")
    return out


def _psnr(png_a: bytes, png_b: bytes) -> float | None:
    """两帧 PNG 的 PSNR 平均 Y 分量；无法比较返回 None。"""
    with tempfile.TemporaryDirectory() as td:
        pa, pb = f"{td}/a.png", f"{td}/b.png"
        with open(pa, "wb") as f:
            f.write(png_a)
        with open(pb, "wb") as f:
            f.write(png_b)
        _, _, err = ffmpeg_capture(
            ["-i", pa, "-i", pb, "-lavfi", "psnr", "-f", "null", "-"],
            timeout=120,
        )
    # ffmpeg 8 形如：PSNR r:.. g:.. b:.. average:11.61 min:.. max:..
    # 旧版本形如：PSNR avg:48.21:50.10:47.33 ...
    # 整条统计可能不含空格，不能按 split() 的 token 匹配，直接在整段日志里找。
    for key in ("average:", "avg:"):
        pos = err.find(key)
        if pos >= 0:
            rest = err[pos + len(key):]
            value = ""
            for ch in rest:
                if ch.isdigit() or ch in ".+-":
                    value += ch
                else:
                    break
            try:
                return float(value)
            except ValueError:
                return None
    return None


def _output_framemd5(path: str) -> list[str]:
    """直接对成品容器跑 framemd5，保持与源片相同的解码像素格式（yuv420p）。

    注意不能把单帧抽成 PNG 再算：PNG 解码成 rgb24 后字节布局不同，
    哈希永远无法与源片的 yuv420p 哈希匹配。
    """
    _, stdout, _ = ffmpeg_capture(["-i", path, "-an", "-f", "framemd5", "-"])
    hashes: list[str] = []
    for line in stdout.decode("utf-8", "replace").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = [p.strip() for p in line.split(",")]
        if len(parts) >= 6 and parts[0].lstrip("-").isdigit():
            hashes.append(parts[-1])
    return hashes


def _map_by_md5(pr: ProbeResult, output_path: str, output_idx: int, expect_idx: int) -> dict | None:
    """哈希精确匹配：成品第 output_idx 帧的解码哈希 -> 源帧哈希表。"""
    if not pr.has_hash:
        return None
    out_hashes = _output_framemd5(output_path)
    if output_idx >= len(out_hashes):
        return None
    target = out_hashes[output_idx]
    matches = [f for f in pr.frames if f.md5 == target]
    if not matches:
        return None  # 重编码有损，哈希不同属正常，交给 PSNR
    # 源中存在重复画面时取离期望最近的一帧并标注歧义
    best = min(matches, key=lambda f: abs(f.idx - expect_idx))
    return {
        "source_idx": best.idx,
        "confidence": "exact",
        "ambiguous": len(matches) > 1,
        "detail": "framemd5 精确一致" + ("（源中有重复画面，取离期望最近的一帧）" if len(matches) > 1 else ""),
    }


def _map_by_psnr(pr: ProbeResult, frame_png: bytes, expect_idx: int) -> dict:
    """在期望帧号附近用 PSNR 搜索最相似的源帧。"""
    lo = max(0, expect_idx - SEARCH_WINDOW)
    hi = min(len(pr.frames) - 1, expect_idx + SEARCH_WINDOW)
    best_idx, best_psnr, second = None, -1.0, -1.0
    for idx in range(lo, hi + 1):
        score = _psnr(frame_png, _extract_frame(pr.path, idx))
        if score is None:
            continue
        if score > best_psnr:
            second = best_psnr
            best_idx, best_psnr = idx, score
        elif score > second:
            second = score
    if best_idx is None:
        return {"source_idx": None, "confidence": "unknown",
                "detail": "PSNR 计算失败，无法判断该帧来自源片哪里"}
    if best_psnr < PSNR_MEDIUM:
        return {"source_idx": None, "confidence": "unknown",
                "detail": f"最高相似度仅 {best_psnr:.1f}dB（<{PSNR_MEDIUM}dB），无法判断"}
    confidence = "high" if best_psnr >= PSNR_HIGH else "medium"
    detail = f"PSNR={best_psnr:.1f}dB，在源帧 {lo}~{hi} 范围内取最高"
    if best_psnr - second < 2.0 and second > 0:
        detail += "；与次优帧差距 <2dB，存在歧义"
        confidence = "medium" if confidence == "high" else confidence
    return {"source_idx": best_idx, "confidence": confidence, "detail": detail}


def map_frame(pr: ProbeResult, output_path: str, output_idx: int, expect_source_idx: int) -> dict:
    """把成品的某一帧映射回源片帧号。"""
    result = _map_by_md5(pr, output_path, output_idx, expect_source_idx)
    if result is None:
        # 重编码等原因哈希不匹配：抽帧后用 PSNR 画面相似度在期望位置附近搜索
        png = _extract_frame(output_path, output_idx)
        result = _map_by_psnr(pr, png, expect_source_idx)
    result["output_idx"] = output_idx
    result["expected_source_idx"] = expect_source_idx
    if result.get("source_idx") is not None:
        sf = pr.frames[result["source_idx"]]
        result["source_display_time"] = round(sf.display_time, 6)
        result["delta_vs_target_ms"] = round(
            (sf.display_time - pr.frames[expect_source_idx].display_time) * 1000, 1
        )
    return result


def verify_cut(pr: ProbeResult, plan_dict: dict, output_path: str) -> dict:
    """完整读回：成品范围、首尾源帧映射、声音覆盖、无法判断项。"""
    out = probe_output(output_path)
    unknowns: list[str] = []

    first_map = map_frame(pr, output_path, 0, plan_dict["actual_in_idx"])
    last_out_idx = out["nb_frames"] - 1
    last_map = map_frame(pr, output_path, last_out_idx, plan_dict["actual_out_idx"] - 1)
    for m, label in ((first_map, "首帧"), (last_map, "尾帧")):
        if m["confidence"] == "unknown":
            unknowns.append(f"{label}无法可靠映射回源片：{m['detail']}")

    # 成品实际范围（换算成源片显示时间线）
    if first_map.get("source_idx") is not None:
        actual_start_display = pr.frames[first_map["source_idx"]].display_time
    else:
        actual_start_display = None
    if last_map.get("source_idx") is not None:
        last_src = pr.frames[last_map["source_idx"]]
        actual_end_display = last_src.display_time + last_src.duration
    else:
        actual_end_display = None

    # ---- 声音覆盖核对 ----
    audio_report = None
    if pr.audio is not None:
        if out["audio"] is None:
            audio_report = {"status": "missing", "detail": "源片有声音但成品没有音轨"}
            unknowns.append("源片含音轨，成品却没有声音，需检查 ffmpeg 日志")
        else:
            # 成品时间线从 0 开始，加回实际起点换算到源片显示时间线
            base = actual_start_display if actual_start_display is not None else plan_dict["actual_in_display"]
            src_a_start = out["audio"]["display_start"] + base
            src_a_end = out["audio"]["display_end"] + base
            head_gap = src_a_start - plan_dict["target_in_display"]
            tail_gap = plan_dict["target_out_display"] - src_a_end
            notes = []
            # head_gap>0：声音晚于入点（头部缺声音）；<0：声音早于入点（随关键帧向前带出）
            if head_gap > AUDIO_GAP_TOL:
                notes.append(f"声音比入点晚 {abs(head_gap) * 1000:.1f} ms 开始，头部缺声音")
            elif head_gap < -AUDIO_GAP_TOL:
                notes.append(f"声音比入点早 {abs(head_gap) * 1000:.1f} ms 开始（随关键帧向前带出）")
            # tail_gap>0：声音早于出点结束（尾部缺声音）；<0：声音超出出点
            if tail_gap > AUDIO_GAP_TOL:
                notes.append(f"声音比出点早 {abs(tail_gap) * 1000:.1f} ms 结束，尾部缺声音")
            elif tail_gap < -AUDIO_GAP_TOL:
                notes.append(f"声音超出出点 {abs(tail_gap) * 1000:.1f} ms（随视频包一起带出）")
            if not notes:
                notes.append("声音覆盖整个要求区间")
            audio_report = {
                "status": "ok",
                "source_display_start": round(src_a_start, 6),
                "source_display_end": round(src_a_end, 6),
                "head_gap_ms": round(head_gap * 1000, 1),
                "tail_gap_ms": round(tail_gap * 1000, 1),
                "detail": "；".join(notes),
            }
    else:
        audio_report = {"status": "none", "detail": "源片无音轨，成品同样无声音"}

    return {
        "output": out,
        "first_frame": first_map,
        "last_frame": last_map,
        "actual_start_display": None if actual_start_display is None else round(actual_start_display, 6),
        "actual_end_display": None if actual_end_display is None else round(actual_end_display, 6),
        "audio": audio_report,
        "unknowns": unknowns,
    }


def plan_to_json(plan_dict: dict) -> str:
    return json.dumps(plan_dict, ensure_ascii=False, indent=2)
